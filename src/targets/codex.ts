import path from "node:path";
import { isSafeRelativePath, toPosix } from "../fs.js";
import { stripUndefined } from "./shared.js";
import {
  error,
  pathExistsSync,
  readJson,
  validateFrontmatter,
  validateHooksShape,
  validateMarketplaceBasics,
  validateReferencedManifestPaths,
} from "./validation-shared.js";
import type { ValidationIssue } from "../types.js";
import type { PluginTargetDefinition } from "./types.js";

const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const sourceKinds = new Set(["local", "url", "git-subdir", "npm"]);

/**
 * Resolves a marketplace entry's local plugin directory, or `null` when the
 * entry points somewhere pluginpack's own output doesn't contain (a remote
 * `url`/`git-subdir`/`npm` source, added via the `entry` passthrough for a
 * plugin this build doesn't itself emit). `null` means "nothing local left
 * to validate," not "invalid" — shape validation already happened in
 * `validateCodexEntry`.
 */
function resolveLocalPluginDir(root: string, source: unknown): string | null {
  if (typeof source === "string") {
    return path.join(root, source);
  }
  if (
    source &&
    typeof source === "object" &&
    (source as Record<string, unknown>).source === "local" &&
    typeof (source as Record<string, unknown>).path === "string"
  ) {
    return path.join(root, (source as Record<string, unknown>).path as string);
  }
  return null;
}

/**
 * Validates one Codex marketplace entry. `source` may be a bare string (a
 * local relative path — the only shape pluginpack itself ever emits) or a
 * structured object with an inner `source` discriminator (`"local"`,
 * `"url"`, `"git-subdir"`, `"npm"`) for entries an author adds via the
 * `entry` passthrough to describe a plugin hosted elsewhere. Every entry,
 * regardless of source shape, must carry `policy.installation`,
 * `policy.authentication`, and `category` — see `citations`.
 */
function validateCodexEntry(
  entry: Record<string, unknown>,
  index: number,
  root: string,
  issues: ValidationIssue[],
): string | null {
  if (!entry || typeof entry !== "object") {
    error(issues, `plugins[${index}] must be an object.`);
    return null;
  }
  if (typeof entry.name !== "string" || !pluginNamePattern.test(entry.name)) {
    error(
      issues,
      `plugins[${index}].name must be lowercase and use only alphanumerics, hyphens, and periods.`,
    );
    return null;
  }
  const { name } = entry;
  if (typeof entry.source === "string") {
    if (!isSafeRelativePath(entry.source)) {
      error(issues, `${name}: source must be a safe relative path.`);
    } else if (
      !entry.source.startsWith("http") &&
      !pathExistsSync(path.join(root, entry.source))
    ) {
      error(issues, `${name}: source directory is missing: ${entry.source}`);
    }
  } else if (entry.source && typeof entry.source === "object") {
    const source = entry.source as Record<string, unknown>;
    if (typeof source.source !== "string" || !sourceKinds.has(source.source)) {
      error(
        issues,
        `${name}: source.source must be one of ${[...sourceKinds].join(", ")}.`,
      );
    } else if (source.source === "local" && typeof source.path !== "string") {
      error(issues, `${name}: a "local" source requires a "path".`);
    } else if (
      (source.source === "url" || source.source === "git-subdir") &&
      typeof source.url !== "string"
    ) {
      error(issues, `${name}: a "${source.source}" source requires a "url".`);
    } else if (source.source === "npm" && typeof source.package !== "string") {
      error(issues, `${name}: an "npm" source requires a "package".`);
    }
  } else {
    error(issues, `${name}: source must be a string or a structured object.`);
  }
  const policy = entry.policy as Record<string, unknown> | undefined;
  if (!policy || typeof policy.installation !== "string") {
    error(
      issues,
      `${name}: entry is missing required field "policy.installation".`,
    );
  }
  if (!policy || typeof policy.authentication !== "string") {
    error(
      issues,
      `${name}: entry is missing required field "policy.authentication".`,
    );
  }
  if (typeof entry.category !== "string" || !entry.category) {
    error(issues, `${name}: entry is missing required field "category".`);
  }
  return name;
}

/** OpenAI Codex CLI plugin target — see `citations` for source facts. */
export const codex: PluginTargetDefinition = {
  name: "codex",

  defaultComponents: ["skills", "hooks", "scripts", "assets"],

  resolvePluginPath: (pluginName, pluginConfig, targetConfig) =>
    pluginConfig.path ??
    toPosix(path.join(targetConfig.pluginRoot ?? "plugins", pluginName)),

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
      version: pluginConfig.version ?? version,
      description: pluginConfig.description ?? metadata?.description,
      author: metadata?.author,
      homepage: metadata?.homepage,
      repository: metadata?.repository,
      license: metadata?.license,
      keywords: metadata?.keywords,
    };
    if (componentDirs.has("skills")) {
      manifest.skills = "./skills/";
    }
    if (componentDirs.has("hooks")) {
      manifest.hooks = "./hooks/hooks.json";
    }
    if (mcpServers) {
      manifest.mcpServers = "./.mcp.json";
    }
    return stripUndefined(manifest);
  },
  manifestPaths: (pluginPath) => [
    path.join(pluginPath, ".codex-plugin", "plugin.json"),
  ],

  // Author-supplied `policy`/`category` land here via the per-plugin `entry`
  // passthrough (see engine.ts's deepMerge) — pluginpack has no way to infer
  // installation/authentication policy on its own, so the base entry stays
  // guess-free and validateOutput errors clearly if they're never supplied.
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

  buildMarketplaceManifest: ({ project, plugins }) =>
    stripUndefined({
      name: project.config.name,
      interface: {
        displayName:
          project.config.metadata?.displayName ?? project.config.name,
      },
      plugins,
    }),
  marketplacePaths: () => [path.join(".agents", "plugins", "marketplace.json")],

  mcpConfigPath: (pluginPath) => path.join(pluginPath, ".mcp.json"),
  hooksPath: (pluginPath) => path.join(pluginPath, "hooks", "hooks.json"),

  validateManifest: (manifest, pluginName, issues) => {
    if (typeof manifest.name !== "string" || !manifest.name) {
      error(
        issues,
        `${pluginName}: plugin.json is missing required field "name".`,
      );
    }
  },
  validateMarketplaceEntry: validateCodexEntry,

  validateOutput: async (root, issues) => {
    const marketplacePath = path.join(
      root,
      ".agents",
      "plugins",
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
      const pluginName = codex.validateMarketplaceEntry(
        entry,
        index,
        root,
        issues,
      );
      if (!pluginName) {
        continue;
      }
      const pluginDir = resolveLocalPluginDir(root, entry.source);
      if (!pluginDir) {
        continue;
      }
      const manifest = await readJson(
        path.join(pluginDir, ".codex-plugin", "plugin.json"),
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
      codex.validateManifest(manifest, pluginName, issues);
      await validateReferencedManifestPaths(
        pluginDir,
        pluginName,
        manifest,
        ["skills", "hooks", "mcpServers"],
        issues,
      );
      await validateHooksShape(
        pluginDir,
        pluginName,
        "hooks/hooks.json",
        issues,
      );
      await validateFrontmatter(pluginDir, pluginName, "codex", issues);
    }
  },

  installSnippet: {
    userConfigurable: true,
    build: ({ repository }) => ({
      kind: "command",
      snippet: `codex plugin marketplace add ${repository}`,
      note: "Installs the marketplace; individual plugins are then installed from Codex's plugin picker.",
    }),
    citation: {
      claim: "codex plugin marketplace add syntax",
      documentationUrl: "https://learn.chatgpt.com/codex/developer-commands",
      verifiedAt: "2026-07-25",
    },
  },

  citations: [
    {
      claim:
        'plugin.json requires only "name"; version/description/author etc. are optional',
      documentationUrl: "https://developers.openai.com/codex/plugins/build",
      verifiedAt: "2026-07-26",
    },
    {
      claim:
        "marketplace entries require policy.installation, policy.authentication, and category",
      documentationUrl: "https://developers.openai.com/codex/plugins/build",
      verifiedAt: "2026-07-26",
    },
    {
      claim:
        'a marketplace entry\'s source is a bare string only for local plugins; url/git-subdir/npm sources are structured objects with an inner "source" discriminator',
      documentationUrl: "https://developers.openai.com/codex/plugins/build",
      verifiedAt: "2026-07-26",
    },
    {
      claim:
        "marketplace.json's top level is { name, interface, plugins }, with no owner field",
      documentationUrl: "https://developers.openai.com/codex/plugins/build",
      verifiedAt: "2026-07-26",
    },
  ],
};
