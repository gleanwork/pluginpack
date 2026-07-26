import path from "node:path";
import { stripUndefined } from "./shared.js";
import {
  error,
  readJson,
  validateBareStringSourceEntry,
  validateFrontmatter,
  validateHooksShape,
  validateMarketplaceBasics,
} from "./validation-shared.js";
import type { PluginTargetDefinition } from "./types.js";

const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

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
  manifestPaths: (pluginPath, targetConfig) => [
    path.join(
      pluginPath,
      targetConfig.marketplaceDir ?? ".claude-plugin",
      "plugin.json",
    ),
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
  marketplacePaths: (targetConfig) => [
    path.join(
      targetConfig.marketplaceDir ?? ".claude-plugin",
      "marketplace.json",
    ),
  ],

  mcpConfigPath: (pluginPath) => path.join(pluginPath, ".mcp.json"),
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

  validateOutput: async (root, issues) => {
    const marketplacePath = path.join(
      root,
      ".claude-plugin",
      "marketplace.json",
    );
    const marketplace = await readJson(
      marketplacePath,
      "Marketplace manifest",
      issues,
    );
    if (!marketplace) {
      return;
    }
    validateMarketplaceBasics(marketplace, issues);
    const plugins = Array.isArray(marketplace.plugins)
      ? marketplace.plugins
      : [];
    if (plugins.length === 0) {
      error(issues, 'Marketplace "plugins" must be a non-empty array.');
      return;
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
      const manifest = await readJson(
        path.join(pluginDir, ".claude-plugin", "plugin.json"),
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
  },

  installSnippet: {
    userConfigurable: true,
    build: ({ repository, pluginName, marketplaceName }) => ({
      kind: "command",
      snippet: `/plugin marketplace add ${repository}\n/plugin install ${pluginName}@${marketplaceName}`,
      note: `Once the marketplace is added, "claude plugin install ${pluginName}@${marketplaceName}" also works as a standalone shell command — but marketplace add itself is slash-only, with no shell equivalent.`,
    }),
    citation: {
      claim:
        "/plugin marketplace add is slash-only; claude plugin install works as a standalone shell command once a marketplace is already added",
      documentationUrl:
        "https://code.claude.com/docs/en/plugins-reference#cli-commands-reference",
      verifiedAt: "2026-07-25",
    },
  },

  citations: [
    {
      claim:
        "claude plugin validate --strict treats missing version/description/author.name as errors",
      documentationUrl: "https://code.claude.com/docs/en/plugins-reference",
      verifiedAt: "2026-07-26",
    },
  ],
};
