import path from "node:path";
import { stripUndefined } from "./shared.js";
import {
  error,
  pluginScanPaths,
  readJson,
  validateBareStringSourceEntry,
  validateFrontmatter,
  validateHooksShape,
  validateMarketplaceBasics,
} from "./validation-shared.js";
import type { PluginTargetDefinition } from "./types.js";

const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Plugin-relative files Claude Code reads from a plugin, whoever wrote them. */
const NATIVE_FILES = [
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
];

/**
 * Claude Code agent-plugin target. `validateManifest`'s required fields
 * (`version`, `description`, `author.name`) were verified directly against
 * `claude plugin validate --strict` — a minimal manifest with only `name`
 * fails that check, so pluginpack's existing stricter validation matches the
 * real CLI rather than over-constraining it.
 */
export const claude: PluginTargetDefinition = {
  name: "claude",

  defaultComponents: ["skills", "agents", "hooks", "scripts", "assets"],

  resolvePluginPath: (pluginName, pluginConfig, targetConfig) =>
    pluginConfig.path ??
    path.join(targetConfig.pluginRoot ?? "plugins", pluginName),

  buildPluginManifest: ({ metadata, version, pluginName, pluginConfig }) =>
    stripUndefined({
      name: pluginName,
      version: pluginConfig.version ?? version,
      description: pluginConfig.description ?? metadata?.description,
      author: metadata?.author,
      homepage: metadata?.homepage,
      repository: metadata?.repository,
      license: metadata?.license,
      keywords: metadata?.keywords,
    }),
  manifestPaths: (pluginPath) => [
    path.join(pluginPath, ".claude-plugin", "plugin.json"),
  ],

  buildMarketplaceEntry: ({ pluginName, pluginPath, pluginConfig, manifest }) =>
    stripUndefined({
      name: pluginName,
      source: `./${pluginPath}`,
      description:
        pluginConfig.description ??
        (manifest?.description as string | undefined),
    }),

  buildMarketplaceManifest: ({ project, version, plugins }) =>
    stripUndefined({
      $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
      name: project.config.name,
      version,
      description: project.config.metadata?.description,
      owner: project.config.metadata?.owner ?? project.config.metadata?.author,
      plugins,
    }),
  marketplacePaths: () => [path.join(".claude-plugin", "marketplace.json")],

  mcpConfigPath: (pluginPath) => path.join(pluginPath, ".mcp.json"),
  mcpDialect: "claude",
  hooksPath: (pluginPath) => path.join(pluginPath, "hooks", "hooks.json"),

  validateManifest: (manifest, pluginName, issues) => {
    for (const field of ["name", "version", "description"]) {
      if (typeof manifest[field] !== "string" || !manifest[field]) {
        error(
          issues,
          `${pluginName}: plugin.json is missing required field "${field}".`,
        );
      }
    }
    const author = manifest.author as Record<string, unknown> | undefined;
    if (!author || typeof author.name !== "string" || !author.name) {
      error(issues, `${pluginName}: plugin.json is missing "author.name".`);
    }
  },
  validateMarketplaceEntry: (entry, index, root, issues) =>
    validateBareStringSourceEntry(
      entry,
      index,
      root,
      issues,
      pluginNamePattern,
    ),

  validateOutput: async (root, issues, context) => {
    const marketplaceDir = ".claude-plugin";
    const marketplacePath = path.join(root, marketplaceDir, "marketplace.json");
    const ownedPaths = [marketplacePath];
    const marketplace = await readJson(
      marketplacePath,
      "Marketplace manifest",
      issues,
    );
    if (!marketplace) {
      return ownedPaths;
    }
    validateMarketplaceBasics(marketplace, issues);
    const plugins = Array.isArray(marketplace.plugins)
      ? marketplace.plugins
      : [];
    if (plugins.length === 0) {
      error(issues, 'Marketplace "plugins" must be a non-empty array.');
      return ownedPaths;
    }
    for (const [index, entry] of plugins.entries()) {
      const pluginName = claude.validateMarketplaceEntry(
        entry,
        index,
        root,
        issues,
      );
      if (!pluginName) {
        continue;
      }
      const pluginDir = path.join(root, entry.source);
      ownedPaths.push(
        ...pluginScanPaths(root, pluginDir, NATIVE_FILES, context),
      );
      const manifest = await readJson(
        path.join(pluginDir, marketplaceDir, "plugin.json"),
        `${pluginName} plugin manifest`,
        issues,
      );
      if (!manifest) {
        continue;
      }
      if (manifest.name !== pluginName) {
        error(
          issues,
          `${pluginName}: marketplace entry name does not match plugin.json name ("${manifest.name}").`,
        );
      }
      claude.validateManifest(manifest, pluginName, issues);
      await validateFrontmatter(pluginDir, pluginName, "claude", issues);
      await validateHooksShape(
        pluginDir,
        pluginName,
        "hooks/hooks.json",
        issues,
      );
    }
    return ownedPaths;
  },

  installSnippet: {
    userConfigurable: true,
    build: ({ repository, pluginName, marketplaceName }) => ({
      kind: "command",
      snippet: `claude plugin marketplace add ${repository}\nclaude plugin install ${pluginName}@${marketplaceName}`,
      note: `In an interactive Claude Code session, use "/plugin marketplace add ${repository}" then "/plugin install ${pluginName}@${marketplaceName}". The latter opens the plugin details so you can review it and choose an install scope.`,
    }),
    citation: {
      claim:
        "claude plugin marketplace add <source> and claude plugin install <plugin> are shell commands (also checked with Claude Code 2.1.284 --help); /plugin marketplace add and /plugin install remain interactive forms, with /plugin install opening the plugin details",
      documentationUrl: "https://code.claude.com/docs/en/plugins/cli-reference",
      verifiedAt: "2026-10-21",
    },
  },

  citations: [
    {
      claim:
        "native validation requires .claude-plugin/marketplace.json or .claude-plugin/plugin.json; marketplaceDir cannot relocate them",
      documentationUrl: "https://code.claude.com/docs/en/plugins-reference",
      verifiedAt: "2026-10-21",
    },
    {
      claim:
        "claude plugin validate --strict treats missing version/description/author.name as errors",
      documentationUrl: "https://code.claude.com/docs/en/plugins-reference",
      verifiedAt: "2026-10-21",
    },
  ],
};
