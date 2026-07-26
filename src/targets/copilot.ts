import path from "node:path";
import { exists, toPosix, walkFiles } from "../fs.js";
import { stripUndefined } from "./shared.js";
import {
  error,
  readJson,
  validateBareStringSourceEntry,
  validateFrontmatter,
  validateMarketplaceBasics,
  validateReferencedManifestPaths,
} from "./validation-shared.js";
import type { ValidationIssue } from "../types.js";
import type { PluginTargetDefinition } from "./types.js";

const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Kebab-case, letters/numbers/hyphens only, per the Copilot plugin.json field reference. */
const copilotNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** GitHub Copilot agent-plugin target — see `citations` for source facts. */
export const copilot: PluginTargetDefinition = {
  name: "copilot",

  defaultComponents: ["skills", "agents", "hooks", "scripts", "assets"],

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
      category: metadata?.category,
      tags: metadata?.tags,
    };
    if (componentDirs.has("agents")) {
      manifest.agents = "agents/";
    }
    if (componentDirs.has("skills")) {
      manifest.skills = "skills/";
    }
    if (componentDirs.has("hooks")) {
      manifest.hooks = "hooks/hooks.json";
    }
    if (mcpServers) {
      manifest.mcpServers = ".mcp.json";
    }
    return stripUndefined(manifest);
  },
  // Mirrored at both the plugin root and .github/plugin/, since published
  // plugins use the latter (see citations) — shipping only one risks the
  // manifest not being found at all.
  manifestPaths: (pluginPath) => [
    path.join(pluginPath, "plugin.json"),
    path.join(pluginPath, ".github", "plugin", "plugin.json"),
  ],

  buildMarketplaceEntry: ({
    pluginName,
    pluginPath,
    pluginConfig,
    metadata,
    mcpServers,
    pluginFiles,
    manifest,
  }) =>
    stripUndefined({
      name: pluginName,
      source: `./${pluginPath}`,
      description:
        pluginConfig.description ??
        (manifest?.description as string | undefined) ??
        metadata?.description,
      version:
        pluginConfig.version ?? (manifest?.version as string | undefined),
      skills: [
        ...new Set(
          [...pluginFiles.keys()]
            .filter((file) => file.startsWith("skills/"))
            .map((file) => `./skills/${file.split("/")[1]}`),
        ),
      ].sort(),
      mcpServers: mcpServers ? ".mcp.json" : undefined,
    }),

  buildMarketplaceManifest: ({ project, version, plugins }) =>
    stripUndefined({
      name: project.config.name,
      metadata: stripUndefined({
        description: project.config.metadata?.description,
        version,
        keywords: project.config.metadata?.keywords,
      }),
      owner: project.config.metadata?.owner ?? project.config.metadata?.author,
      plugins,
    }),
  // Copilot reads the marketplace from both locations; mirror it at both.
  marketplacePaths: () => [
    path.join(".claude-plugin", "marketplace.json"),
    path.join(".github", "plugin", "marketplace.json"),
  ],

  mcpConfigPath: (pluginPath) => path.join(pluginPath, ".mcp.json"),
  hooksPath: (pluginPath) => path.join(pluginPath, "hooks", "hooks.json"),

  validateManifest: (manifest, pluginName, issues) => {
    if (
      typeof manifest.name !== "string" ||
      !copilotNamePattern.test(manifest.name)
    ) {
      error(
        issues,
        `${pluginName}: plugin.json must have a kebab-case "name".`,
      );
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
    if (
      !(await exists(path.join(root, ".github", "plugin", "marketplace.json")))
    ) {
      error(
        issues,
        "Copilot output must mirror the marketplace at .github/plugin/marketplace.json.",
      );
    }
    const plugins = Array.isArray(marketplace.plugins)
      ? marketplace.plugins
      : [];
    if (plugins.length === 0) {
      error(issues, 'Marketplace "plugins" must be a non-empty array.');
      return;
    }
    for (const [index, entry] of plugins.entries()) {
      const pluginName = copilot.validateMarketplaceEntry(
        entry,
        index,
        root,
        issues,
      );
      if (!pluginName) {
        continue;
      }
      const pluginDir = path.join(root, entry.source);
      // .github/plugin/ is the authoritative copy; the root copy is only
      // checked for presence, not re-parsed.
      const manifest = await readJson(
        path.join(pluginDir, ".github", "plugin", "plugin.json"),
        `${pluginName} plugin manifest`,
        issues,
      );
      if (!(await exists(path.join(pluginDir, "plugin.json")))) {
        error(
          issues,
          `${pluginName}: plugin.json must also be mirrored at the plugin root.`,
        );
      }
      if (manifest) {
        copilot.validateManifest(manifest, pluginName, issues);
        await validateReferencedManifestPaths(
          pluginDir,
          pluginName,
          manifest,
          ["agents", "skills", "hooks", "mcpServers"],
          issues,
        );
      }
      await validateAgentFileNames(pluginDir, pluginName, issues);
      await validateFrontmatter(pluginDir, pluginName, "copilot", issues);
    }
  },

  installSnippet: {
    userConfigurable: true,
    build: ({ repository, pluginName, marketplaceName }) => ({
      kind: "command",
      snippet: `copilot plugin marketplace add ${repository}\ncopilot plugin install ${pluginName}@${marketplaceName}`,
      note: "VS Code automatically discovers plugins installed this way (from ~/.copilot/installed-plugins/).",
    }),
    citation: {
      claim: "copilot plugin marketplace add / copilot plugin install syntax",
      documentationUrl:
        "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing",
      verifiedAt: "2026-07-25",
    },
  },

  citations: [
    {
      claim: "plugin.json is a required manifest file for every plugin",
      documentationUrl:
        "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference",
      verifiedAt: "2026-07-25",
    },
    {
      claim:
        "real published plugins locate plugin.json at .github/plugin/plugin.json, not the plugin root",
      documentationUrl:
        "https://github.com/github/copilot-advanced-security-plugin/blob/main/.github/plugin/plugin.json",
      verifiedAt: "2026-07-26",
    },
    {
      claim: "agent files must be named NAME.agent.md",
      documentationUrl:
        "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating",
      verifiedAt: "2026-07-25",
    },
    {
      claim:
        "manifest field paths (agents/skills/hooks/mcpServers) and marketplace.json shape",
      documentationUrl:
        "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference",
      verifiedAt: "2026-07-25",
    },
  ],
};

async function validateAgentFileNames(
  pluginDir: string,
  pluginName: string,
  issues: ValidationIssue[],
): Promise<void> {
  const agentsDir = path.join(pluginDir, "agents");
  if (!(await exists(agentsDir))) {
    return;
  }
  const files = await walkFiles(agentsDir);
  for (const file of files) {
    if (!file.endsWith(".agent.md")) {
      error(
        issues,
        `${pluginName}: agent file "${toPosix(path.relative(pluginDir, file))}" must be named NAME.agent.md for Copilot to discover it.`,
      );
    }
  }
}
