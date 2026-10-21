import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildPackageManifest,
  packageLayout,
  placeClientFields,
  validatePackage,
} from "../agent-plugins.js";
import { exists, toPosix } from "../fs.js";
import {
  configuredClients,
  PACKAGE_CLIENTS,
  type PackageClient,
} from "../package-clients.js";
import {
  CLIENT_ONLY_CONTENT_KINDS,
  PACKAGE_CLIENT_CONTENT_KINDS,
} from "../schema.js";
import { error, pluginScanPaths } from "./validation-shared.js";
import type { ValidationIssue } from "../types.js";
import type { PluginTargetDefinition } from "./types.js";

/**
 * No single client profile: every top-level manifest field must be portable.
 * Client data goes under `manifest.extensions["<namespace>"]` explicitly,
 * because a package listing several clients can't guess which one a field
 * belongs to.
 */
const noProfile = {};

/**
 * Agent Plugins target: one portable package per plugin under
 * `plugins/<name>/`. With no `clients`, it writes packages only — no
 * marketplace (the specification defines none) and no client files. With
 * `clients`, each package also carries those clients' files in their
 * extension directories, and each client gets its own marketplace file, so
 * one build serves every listed client. See docs/adr/0002.
 */
export const agentPlugins: PluginTargetDefinition = {
  name: "agent-plugins",

  forConfig: (targetConfig) => {
    const clients = configuredClients(targetConfig.clients);
    return clients.length === 0
      ? agentPlugins
      : withClients(agentPlugins, clients);
  },

  // scripts/ ships by default: an MCP command such as ./scripts/server.sh
  // points into it.
  defaultComponents: ["skills", "scripts", "assets"],

  resolvePluginPath: (pluginName, pluginConfig, targetConfig) =>
    pluginConfig.path ??
    toPosix(path.join(targetConfig.pluginRoot ?? "plugins", pluginName)),

  buildPluginManifest: buildPackageManifest,
  finalizeManifest: (manifest, pluginName) =>
    placeClientFields(manifest, noProfile, pluginName),
  manifestPaths: (pluginPath) => [
    path.join(pluginPath, packageLayout.manifest),
  ],

  buildMarketplaceEntry: () => undefined,
  buildMarketplaceManifest: () => ({}),
  marketplacePaths: () => [],

  mcpConfigPath: (pluginPath) => path.join(pluginPath, packageLayout.mcp),
  mcpDialect: "agent-plugins",
  // Hooks are a client-only content kind for this target. The schema rejects
  // selecting them; a hooks file from additionalFiles lands here without
  // clients (validate reports it) and goes through placeFile with them.
  hooksPath: (pluginPath) => path.join(pluginPath, "hooks", "hooks.json"),

  validateManifest: () => {},
  validateMarketplaceEntry: () => null,

  // Validates every package, then each client's marketplace and extension
  // directory. Output carries no config, so a client is validated when its
  // marketplace or extension directory is present.
  validateOutput: async (root, issues) => {
    const pluginDirs = await findPackages(root);
    if (pluginDirs.length === 0) {
      error(
        issues,
        "Agent Plugins output must contain at least one package (a directory with a plugin.json).",
      );
    }
    for (const pluginDir of pluginDirs) {
      await validatePackage(pluginDir, path.basename(pluginDir), issues);
      await rejectClientOnlyContent(pluginDir, issues);
    }
    const owned = pluginDirs.flatMap((pluginDir) =>
      pluginScanPaths(root, pluginDir),
    );
    for (const client of Object.values(PACKAGE_CLIENTS)) {
      owned.push(...(await client.validate(root, pluginDirs, issues)));
    }
    return owned;
  },

  installSnippet: {
    userConfigurable: false,
    unsupportedReason:
      "Agent Plugins defines no marketplace or install command. Install the package directory with each client's own flow — for example, VS Code installs a plugin directly from a Git repository URL.",
    citation: {
      claim:
        "the specification leaves installation and marketplaces to each client; VS Code can install a plugin directly from a Git repository",
      documentationUrl:
        "https://code.visualstudio.com/docs/agent-customization/agent-plugins",
      verifiedAt: "2026-10-02",
    },
  },

  citations: [
    {
      claim:
        "a package is plugin.json (closed schema, $schema required) + skills/ + mcp.json at fixed locations; client-specific data lives under reverse-domain extension namespaces",
      documentationUrl: "https://agent-plugins.org/specification",
      verifiedAt: "2026-10-02",
    },
  ],
};

/**
 * The definition for a config that lists clients: client-only content kinds
 * the clients load become defaults and are placed in each client's extension
 * directory, and each client gets a marketplace.
 */
function withClients(
  base: PluginTargetDefinition,
  clients: PackageClient[],
): PluginTargetDefinition {
  const clientKinds = clients.flatMap(
    (client) => PACKAGE_CLIENT_CONTENT_KINDS[client.name],
  );
  return {
    ...base,
    defaultComponents: [
      ...new Set([...base.defaultComponents, ...clientKinds]),
    ],
    placeFile: (relativePath, pluginName) => {
      const kind = relativePath.split("/")[0];
      if (!CLIENT_ONLY_CONTENT_KINDS.includes(kind)) {
        return [relativePath];
      }
      const placed = clients
        .map((client) => client.placeContent(relativePath, pluginName))
        .filter((path): path is string => path !== undefined);
      // The schema rejects selecting such a kind, but a file can still get
      // here (e.g. through plugin.pluginpack.json additionalFiles).
      if (placed.length === 0) {
        throw new Error(
          `Target "agent-plugins" plugin "${pluginName}": "${relativePath}" is ${kind} content, and pluginpack doesn't place ${kind} for any of the listed clients (${clients.map((client) => client.name).join(", ")}). Remove it, or list a client pluginpack places ${kind} for.`,
        );
      }
      return placed;
    },
    clientMarketplaces: () =>
      clients.map((client) => ({
        client: client.name,
        path: client.marketplacePath,
        buildEntry: client.buildMarketplaceEntry,
        buildManifest: client.buildMarketplaceManifest,
      })),
  };
}

/**
 * Finds every package below `root` — a directory with a `plugin.json` —
 * skipping dot-directories and `node_modules`, and not descending into a
 * package once found. A `plugin.json` that doesn't parse or doesn't declare
 * the Agent Plugins schema still counts, so `validatePackage` reports it
 * instead of the package being skipped.
 */
async function findPackages(root: string): Promise<string[]> {
  if (await exists(path.join(root, packageLayout.manifest))) {
    return [root];
  }
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules"
    ) {
      found.push(...(await findPackages(path.join(root, entry.name))));
    }
  }
  return found.sort();
}

async function rejectClientOnlyContent(
  pluginDir: string,
  issues: ValidationIssue[],
): Promise<void> {
  for (const kind of CLIENT_ONLY_CONTENT_KINDS) {
    try {
      await fs.access(path.join(pluginDir, kind));
    } catch {
      continue;
    }
    error(
      issues,
      `${path.basename(pluginDir)}: "${kind}/" has no meaning outside a client extension namespace; the standalone agent-plugins target can't ship it.`,
    );
  }
}
