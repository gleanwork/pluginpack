import { promises as fs } from "node:fs";
import path from "node:path";
import { exists } from "../fs.js";
import { stripUndefined } from "./shared.js";
import {
  error,
  readJson,
  validateBareStringSourceEntry,
  validateFrontmatter,
  validateHooksShape,
} from "./validation-shared.js";
import type { PluginTargetDefinition } from "./types.js";

// Confirmed against the actual JSON Schema on antigravity.google/docs/cli/plugins:
// { "properties": { "name": {...}, "description": {...} }, "required": ["name"],
//   "additionalProperties": false } — no other field, including "version", is
// permitted at all. A strict validator rejects the whole manifest for an extra
// key, it doesn't just ignore it.
const antigravityNamePattern = /^[a-zA-Z0-9-_]+$/;
const ALLOWED_MANIFEST_KEYS = new Set(["name", "description"]);

export const antigravity: PluginTargetDefinition = {
  name: "antigravity",

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

  // Only name (required) and description (optional) — no version. Antigravity
  // has no marketplace to track a version in either; this is a real
  // capability gap for this target, not something to work around by
  // relocating the field elsewhere.
  buildPluginManifest: ({ metadata, pluginName, pluginConfig }) =>
    stripUndefined({
      name: pluginName,
      description: pluginConfig.description ?? metadata?.description,
    }),
  manifestPaths: (pluginPath) => [path.join(pluginPath, "plugin.json")],

  // No marketplace/registry concept exists for Antigravity.
  buildMarketplaceEntry: () => undefined,
  buildMarketplaceManifest: () => ({}),
  marketplacePaths: () => [],

  mcpConfigPath: (pluginPath) => path.join(pluginPath, "mcp_config.json"),
  // Root-level hooks.json, not a hooks/ directory — the Plan 1 fix. Confirmed
  // on both antigravity.google/docs/ide/plugins and .../docs/cli/plugins:
  // "Hooks — Configured via hooks.json at the plugin root."
  hooksPath: (pluginPath) => path.join(pluginPath, "hooks.json"),

  validateManifest: (manifest, pluginName, issues) => {
    if (
      typeof manifest.name !== "string" ||
      !antigravityNamePattern.test(manifest.name)
    ) {
      error(
        issues,
        `${pluginName}: plugin.json "name" must match ^[a-zA-Z0-9-_]+$.`,
      );
    }
    for (const key of Object.keys(manifest)) {
      if (!ALLOWED_MANIFEST_KEYS.has(key)) {
        error(
          issues,
          `${pluginName}: plugin.json has field "${key}", which Antigravity's schema (additionalProperties: false) does not allow. Only "name" and "description" are permitted.`,
        );
      }
    }
  },
  // No marketplace entries exist for this target; implemented defensively in
  // case that ever changes, using the same shared shape most other targets use.
  validateMarketplaceEntry: (entry, index, root, issues) =>
    validateBareStringSourceEntry(
      entry,
      index,
      root,
      issues,
      antigravityNamePattern,
    ),

  validateOutput: async (root, issues) => {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const pluginDirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(root, entry.name));
    if (pluginDirs.length === 0) {
      error(
        issues,
        "Antigravity output must contain at least one plugin directory.",
      );
      return;
    }
    for (const pluginDir of pluginDirs) {
      const manifest = await readJson(
        path.join(pluginDir, "plugin.json"),
        "Antigravity plugin manifest",
        issues,
      );
      if (!manifest) {
        continue;
      }
      const pluginName = path.basename(pluginDir);
      antigravity.validateManifest(manifest, pluginName, issues);
      if (manifest.name && manifest.name !== pluginName) {
        error(
          issues,
          `${pluginName}: manifest name must match plugin directory name.`,
        );
      }
      const mcpConfigPath = path.join(pluginDir, "mcp_config.json");
      if (await exists(mcpConfigPath)) {
        await readJson(mcpConfigPath, `${pluginName} MCP config`, issues);
      }
      await validateFrontmatter(pluginDir, pluginName, "antigravity", issues);
      await validateHooksShape(pluginDir, pluginName, "hooks.json", issues);
    }
  },

  installSnippet: {
    userConfigurable: true,
    build: ({ repository, pluginPath }) => ({
      kind: "command",
      snippet: `git clone ${repository} plugin-source && cd plugin-source && agy plugin install ${pluginPath}`,
    }),
    citation: {
      claim: "agy plugin install <local-path> syntax (no git-URL support)",
      documentationUrl: "https://antigravity.google/docs/cli/plugins",
      verifiedAt: "2026-07-25",
    },
  },

  citations: [
    {
      claim:
        "plugin.json schema (name required, description optional, additionalProperties: false)",
      documentationUrl: "https://antigravity.google/docs/cli/plugins",
      verifiedAt: "2026-07-25",
    },
    {
      claim: "hooks.json lives at the plugin root, not in a hooks/ directory",
      documentationUrl: "https://antigravity.google/docs/ide/plugins",
      verifiedAt: "2026-07-25",
    },
    {
      claim: "agents/ is a supported component (subagent definition templates)",
      documentationUrl: "https://antigravity.google/docs/cli/plugins",
      verifiedAt: "2026-07-25",
    },
  ],
};
