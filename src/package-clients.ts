import path from "node:path";
import { exists, toPosix, walkFiles } from "./fs.js";
import {
  PACKAGE_CLIENT_CONTENT_KINDS,
  PACKAGE_CLIENT_NAMES,
  type PackageClientName,
} from "./schema.js";
import {
  buildCodexMarketplaceEntry,
  codexMarketplace,
  validateCodexEntry,
} from "./targets/codex.js";
import { stripUndefined } from "./targets/shared.js";
import {
  error,
  readJson,
  validateBareStringSourceEntry,
  validateFrontmatter,
  validateMarketplaceBasics,
} from "./targets/validation-shared.js";
import type { ValidationIssue } from "./types.js";
import type {
  Citation,
  MarketplaceEntryContext,
  MarketplaceManifestContext,
} from "./targets/types.js";

/**
 * A client an `agent-plugins` package carries a profile and a marketplace
 * for: its extension namespace, where its client-only files go inside the
 * package, and its marketplace file at the repository root. One package can
 * list several clients, so the same `plugin.json`, `mcp.json` and `skills/`
 * serve all of them. See docs/adr/0002.
 */
export type PackageClient = {
  name: PackageClientName;
  /** The client's reverse-domain extension namespace and directory. */
  namespace: string;
  /**
   * Plugin-relative path for one source file of a content kind this client
   * loads from its extension directory, or `undefined` when the file isn't
   * one of this client's kinds. Throws for a file of one of its kinds that
   * the client can't load.
   */
  placeContent: (
    relativePath: string,
    pluginName: string,
  ) => string | undefined;
  /** Output-relative path of the client's marketplace file. */
  marketplacePath: string;
  buildMarketplaceEntry: (
    ctx: MarketplaceEntryContext,
  ) => Record<string, unknown>;
  buildMarketplaceManifest: (
    ctx: MarketplaceManifestContext,
  ) => Record<string, unknown>;
  /**
   * Validates the client's marketplace (when present) and its extension
   * directory in each package. Returns the paths it owns.
   */
  validate: (
    root: string,
    packageDirs: string[],
    issues: ValidationIssue[],
  ) => Promise<string[]>;
  citations: Citation[];
};

/** Lowercase, digits, hyphens and periods (Agent Plugins plugin names). */
const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const codexClient: PackageClient = {
  name: "codex",
  namespace: "com.openai",
  placeContent: () => undefined,
  marketplacePath: path.join(".agents", "plugins", "marketplace.json"),
  buildMarketplaceEntry: (ctx) =>
    buildCodexMarketplaceEntry(ctx, "agent-plugins"),
  buildMarketplaceManifest: (ctx) =>
    codexMarketplace.buildMarketplaceManifest(ctx) as Record<string, unknown>,
  validate: async (root, packageDirs, issues) => {
    const marketplacePath = path.join(root, codexClient.marketplacePath);
    if (!(await exists(marketplacePath))) {
      return [];
    }
    const marketplace = await readJson(
      marketplacePath,
      "Codex marketplace",
      issues,
    );
    if (!marketplace) {
      return [marketplacePath];
    }
    validateMarketplaceBasics(marketplace, issues);
    for (const [index, entry] of marketplaceEntries(
      marketplace,
      "Codex",
      issues,
    )) {
      const name = validateCodexEntry(entry, index, root, issues);
      if (!name) {
        continue;
      }
      const source = localSourcePath(entry.source);
      if (source !== undefined) {
        await requireListedPackage(
          root,
          source,
          name,
          "Codex",
          packageDirs,
          issues,
        );
      }
    }
    return [marketplacePath];
  },
  // The Codex layout facts are the codex target's; the same docs back them.
  citations: codexMarketplace.citations,
};

const copilotKinds = PACKAGE_CLIENT_CONTENT_KINDS.copilot;

const copilotClient: PackageClient = {
  name: "copilot",
  namespace: "com.github.copilot",
  placeContent: (relativePath, pluginName) => {
    const [kind, ...rest] = relativePath.split("/");
    if (!copilotKinds.includes(kind) || rest.length === 0) {
      return undefined;
    }
    let file = rest.join("/");
    // Copilot derives an agent's ID from NAME.agent.md and ignores other
    // files, so an agent in any extension the frontmatter checks treat as
    // an agent (.md, .markdown, .mdc) is renamed on the way in, and any
    // other file fails rather than ship where Copilot skips it.
    if (kind === "agents" && !file.endsWith(".agent.md")) {
      const agentExtension = /\.(md|markdown|mdc)$/.exec(file);
      if (!agentExtension) {
        throw new Error(
          `Target "agent-plugins" plugin "${pluginName}": "${relativePath}" isn't an agent file Copilot can load. Copilot loads only agents/NAME.agent.md; use a .md, .markdown or .mdc agent, or move the file out of agents/.`,
        );
      }
      file = `${file.slice(0, agentExtension.index)}.agent.md`;
    }
    return toPosix(path.join("com.github.copilot", kind, file));
  },
  marketplacePath: path.join(".github", "plugin", "marketplace.json"),
  // An Agent Plugins entry needs only name and source: Copilot finds the
  // components at the package's fixed locations, so no component paths.
  buildMarketplaceEntry: ({ pluginName, pluginPath, pluginConfig, manifest }) =>
    stripUndefined({
      name: pluginName,
      source: `./${pluginPath}`,
      description:
        pluginConfig.description ??
        (manifest?.description as string | undefined),
      version:
        pluginConfig.version ?? (manifest?.version as string | undefined),
    }),
  buildMarketplaceManifest: ({ project, targetConfig, version, plugins }) => {
    // clients.copilot.manifest is merged after this builder runs, so an
    // owner set there counts too.
    const overridden = targetConfig.clients?.copilot?.manifest?.owner;
    const owner =
      project.config.metadata?.owner ?? project.config.metadata?.author;
    if (!owner && !overridden) {
      throw new Error(
        'Target "agent-plugins" client "copilot": Copilot\'s marketplace requires an owner. Set metadata.owner (or metadata.author), or targets["agent-plugins"].clients.copilot.manifest.owner, in pluginpack.config.ts.',
      );
    }
    return stripUndefined({
      name: project.config.name,
      owner: owner
        ? stripUndefined({ name: owner.name, email: owner.email })
        : undefined,
      metadata: stripUndefined({
        description: project.config.metadata?.description,
        version,
      }),
      plugins,
    });
  },
  validate: async (root, packageDirs, issues) => {
    const owned: string[] = [];
    const marketplacePath = path.join(root, copilotClient.marketplacePath);
    if (await exists(marketplacePath)) {
      owned.push(marketplacePath);
      const marketplace = await readJson(
        marketplacePath,
        "Copilot marketplace",
        issues,
      );
      if (marketplace) {
        validateMarketplaceBasics(marketplace, issues, { requireOwner: true });
        for (const [index, entry] of marketplaceEntries(
          marketplace,
          "Copilot",
          issues,
        )) {
          const name = validateBareStringSourceEntry(
            entry,
            index,
            root,
            issues,
            pluginNamePattern,
          );
          if (name) {
            await requireListedPackage(
              root,
              entry.source as string,
              name,
              "Copilot",
              packageDirs,
              issues,
            );
          }
        }
      }
    }
    for (const packageDir of packageDirs) {
      await validateCopilotAgents(packageDir, issues);
    }
    return owned;
  },
  citations: [
    {
      claim:
        "for Agent Plugins 1.0 plugins, Copilot CLI reads client-specific components from com.github.copilot/ (agents/, commands/, rules/, hooks/hooks.json, lsp.json)",
      documentationUrl:
        "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference",
      verifiedAt: "2026-10-20",
    },
    {
      claim:
        "agent files are NAME.agent.md; the agent ID comes from the file name",
      documentationUrl:
        "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference",
      verifiedAt: "2026-10-20",
    },
    {
      claim:
        "the marketplace is read from marketplace.json, .plugin/marketplace.json, .github/plugin/marketplace.json, or .claude-plugin/marketplace.json, in that order; name, owner, and plugins are required, and each entry requires only name and source",
      documentationUrl:
        "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference",
      verifiedAt: "2026-10-20",
    },
    {
      claim:
        "a root plugin.json declaring the Agent Plugins schema takes precedence over legacy manifests; skills/ and mcp.json are fixed locations",
      documentationUrl:
        "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference",
      verifiedAt: "2026-10-20",
    },
  ],
};

export const PACKAGE_CLIENTS: Record<PackageClientName, PackageClient> = {
  codex: codexClient,
  copilot: copilotClient,
};

/** The configured package clients, in the stable `PACKAGE_CLIENT_NAMES` order. */
export function configuredClients(
  clients: Partial<Record<PackageClientName, unknown>> | undefined,
): PackageClient[] {
  return PACKAGE_CLIENT_NAMES.filter((name) => clients?.[name]).map(
    (name) => PACKAGE_CLIENTS[name],
  );
}

/**
 * The local path a Codex marketplace `source` points at: a bare string, or a
 * structured `{ source: "local", path }`. `undefined` for a remote source.
 */
function localSourcePath(source: unknown): string | undefined {
  if (typeof source === "string") {
    return source;
  }
  if (
    source &&
    typeof source === "object" &&
    (source as Record<string, unknown>).source === "local" &&
    typeof (source as Record<string, unknown>).path === "string"
  ) {
    return (source as Record<string, unknown>).path as string;
  }
  return undefined;
}

function marketplaceEntries(
  marketplace: Record<string, unknown>,
  client: string,
  issues: ValidationIssue[],
): [number, Record<string, unknown>][] {
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (plugins.length === 0) {
    error(issues, `${client} marketplace "plugins" must be a non-empty array.`);
  }
  return [...(plugins as Record<string, unknown>[]).entries()];
}

/**
 * A marketplace entry must point at a package in this output whose
 * `plugin.json` carries the same name.
 */
async function requireListedPackage(
  root: string,
  source: string,
  name: string,
  client: string,
  packageDirs: string[],
  issues: ValidationIssue[],
): Promise<void> {
  const dir = path.resolve(root, source);
  if (!packageDirs.some((packageDir) => path.resolve(packageDir) === dir)) {
    error(
      issues,
      `${name}: the ${client} marketplace entry's source "${source}" is not an Agent Plugins package in this output.`,
    );
    return;
  }
  const manifest = await readJson(
    path.join(dir, "plugin.json"),
    `${name} plugin manifest`,
    [],
  );
  if (manifest && manifest.name !== name) {
    error(
      issues,
      `${name}: the ${client} marketplace entry name does not match plugin.json name ("${String(manifest.name)}").`,
    );
  }
}

/**
 * Copilot agents in a package's extension directory: named NAME.agent.md,
 * with the frontmatter the copilot target requires (name, description).
 */
async function validateCopilotAgents(
  packageDir: string,
  issues: ValidationIssue[],
): Promise<void> {
  const extensionDir = path.join(packageDir, "com.github.copilot");
  if (await exists(extensionDir)) {
    await validateFrontmatter(
      extensionDir,
      `${path.basename(packageDir)} (com.github.copilot)`,
      "copilot",
      issues,
    );
  }
  const agentsDir = path.join(extensionDir, "agents");
  for (const file of await walkFiles(agentsDir)) {
    if (!file.endsWith(".agent.md")) {
      error(
        issues,
        `${path.basename(packageDir)}: agent file "${toPosix(path.relative(packageDir, file))}" must be named NAME.agent.md for Copilot to load it.`,
      );
    }
  }
}
