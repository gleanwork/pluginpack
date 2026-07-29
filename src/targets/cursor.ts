import path from "node:path";
import { stripUndefined, titleCase } from "./shared.js";
import {
  error,
  readJson,
  validateBareStringSourceEntry,
  validateFrontmatter,
  validateHooksShape,
  validateMarketplaceBasics,
  validateReferencedManifestPaths,
} from "./validation-shared.js";
import type { PluginTargetDefinition } from "./types.js";

const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * Top-level `plugin.json` keys per the vendored Cursor plugin schema
 * (`tests/fixtures/cursor/plugin.schema.json`, `additionalProperties: false`).
 * Mirrored here so the shipped `validateOutput` catches a stray/misspelled
 * key without requiring the dev-only ajv schema check.
 */
const KNOWN_MANIFEST_KEYS = new Set([
  "name",
  "displayName",
  "description",
  "version",
  "author",
  "publisher",
  "homepage",
  "repository",
  "license",
  "logo",
  "keywords",
  "category",
  "tags",
  "commands",
  "agents",
  "skills",
  "rules",
  "hooks",
  "mcpServers",
]);

/**
 * The manifest fields that point at a component, per the vendored Cursor
 * plugin schema (`tests/fixtures/cursor/plugin.schema.json`) — the single
 * source of truth for which componentDirs get a manifest pointer, replacing
 * two lists (this target's `defaultComponents` and a separate hardcoded list
 * in the old manifest builder) that could independently drift apart.
 */
const POINTABLE_COMPONENTS = ["rules", "agents", "skills", "commands", "hooks"];

/** Cursor agent-plugin target. Verified against the vendored schemas in `tests/fixtures/cursor/`. */
export const cursor: PluginTargetDefinition = {
  name: "cursor",

  defaultComponents: [
    "skills",
    "agents",
    "rules",
    "hooks",
    "scripts",
    "assets",
  ],

  resolvePluginPath: (pluginName, pluginConfig) =>
    pluginConfig.path ?? pluginName,

  buildPluginManifest: ({
    metadata,
    version,
    pluginName,
    pluginConfig,
    componentDirs,
    mcpServers,
  }) => {
    const manifest: Record<string, unknown> = {
      name: pluginName,
      displayName:
        pluginConfig.displayName ??
        metadata?.displayName ??
        titleCase(pluginName),
      version: pluginConfig.version ?? version,
      description: pluginConfig.description ?? metadata?.description,
      author: metadata?.author,
      homepage: metadata?.homepage,
      repository: metadata?.repository,
      license: metadata?.license,
      logo: metadata?.logo,
      keywords: metadata?.keywords,
      category: metadata?.category,
      tags: metadata?.tags,
    };
    for (const component of POINTABLE_COMPONENTS) {
      if (componentDirs.has(component)) {
        manifest[component] = `./${component}/`;
      }
    }
    if (mcpServers) {
      manifest.mcpServers = "./.mcp.json";
    }
    return stripUndefined(manifest);
  },
  manifestPaths: (pluginPath, targetConfig) => [
    path.join(
      pluginPath,
      targetConfig.marketplaceDir ?? ".cursor-plugin",
      "plugin.json",
    ),
  ],

  buildMarketplaceEntry: ({ pluginName, pluginPath, pluginConfig, manifest }) =>
    stripUndefined({
      name: pluginName,
      source: pluginPath,
      description:
        pluginConfig.description ??
        (manifest?.description as string | undefined),
    }),

  buildMarketplaceManifest: ({ project, version, plugins }) =>
    stripUndefined({
      name: project.config.name,
      owner: project.config.metadata?.owner ?? project.config.metadata?.author,
      metadata: {
        description: project.config.metadata?.description,
        keywords: project.config.metadata?.keywords,
      },
      plugins,
      version,
    }),
  marketplacePaths: (targetConfig) => [
    path.join(
      targetConfig.marketplaceDir ?? ".cursor-plugin",
      "marketplace.json",
    ),
  ],

  mcpConfigPath: (pluginPath) => path.join(pluginPath, ".mcp.json"),
  hooksPath: (pluginPath) => path.join(pluginPath, "hooks", "hooks.json"),

  validateManifest: (manifest, pluginName, issues) => {
    if (
      typeof manifest.name !== "string" ||
      !pluginNamePattern.test(manifest.name)
    ) {
      error(
        issues,
        `${pluginName}: plugin.json must have a kebab-case "name".`,
      );
    }
    for (const key of Object.keys(manifest)) {
      if (!KNOWN_MANIFEST_KEYS.has(key)) {
        error(issues, `${pluginName}: plugin.json has unknown field "${key}".`);
      }
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
      ".cursor-plugin",
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
      const pluginName = cursor.validateMarketplaceEntry(
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
        path.join(pluginDir, ".cursor-plugin", "plugin.json"),
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
      cursor.validateManifest(manifest, pluginName, issues);
      await validateReferencedManifestPaths(
        pluginDir,
        pluginName,
        manifest,
        ["logo", ...POINTABLE_COMPONENTS, "mcpServers"],
        issues,
      );
      await validateHooksShape(
        pluginDir,
        pluginName,
        "hooks/hooks.json",
        issues,
      );
      await validateFrontmatter(pluginDir, pluginName, "cursor", issues);
    }
  },

  installSnippet: {
    userConfigurable: true,
    build: ({ repository }) => ({
      kind: "url",
      snippet: repository,
      note: 'Paste into Cursor\'s Dashboard → Plugins → Team Marketplaces → "Import from Repo."',
    }),
    citation: {
      claim:
        "no CLI marketplace-add command exists; Import from Repo is GUI-only",
      documentationUrl: "https://cursor.com/docs/plugins",
      verifiedAt: "2026-07-25",
    },
  },

  citations: [
    {
      claim: "plugin.json and marketplace.json field shapes",
      documentationUrl: "https://cursor.com/docs/reference/plugins.md",
      verifiedAt: "2026-07-26",
    },
  ],
};
