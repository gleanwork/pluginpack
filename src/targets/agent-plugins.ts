import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildPackageManifest,
  packageLayout,
  placeClientFields,
  validatePackage,
} from "../agent-plugins.js";
import { exists, toPosix } from "../fs.js";
import { CLIENT_ONLY_CONTENT_KINDS } from "../schema.js";
import { error } from "./validation-shared.js";
import type { ValidationIssue } from "../types.js";
import type { PluginTargetDefinition } from "./types.js";

/** No client profile: every manifest field must be portable. */
const noProfile = {};

/**
 * Standalone Agent Plugins target: one portable package per plugin under
 * `plugins/<name>/`, with no marketplace (the specification defines none)
 * and no client profile. For clients pluginpack has no dedicated target for
 * — and the strictest check that a source is portable.
 */
export const agentPlugins: PluginTargetDefinition = {
  name: "agent-plugins",

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
  // Unreachable: hooks are a client-only content kind for this target.
  hooksPath: (pluginPath) => path.join(pluginPath, "hooks", "hooks.json"),

  validateManifest: () => {},
  validateMarketplaceEntry: () => null,

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
    return pluginDirs;
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
