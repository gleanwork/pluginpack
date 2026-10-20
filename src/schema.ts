import { z } from "zod";
import { isSafeRelativePath } from "./fs.js";

/**
 * A path written to or read from disk relative to a root — rejects absolute
 * paths and `..` escapes so a config can't write or read outside it.
 */
const safeRelativePath = z
  .string()
  .refine(
    isSafeRelativePath,
    'must be a safe relative path (no absolute paths or ".." segments)',
  );

const authorSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});

const metadataSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  owner: authorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  logo: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const rootPluginSchema = metadataSchema.extend({
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

const sourceSchema = z.object({
  plugins: z.string().optional(),
  skills: z.string().optional(),
  partials: z.string().optional(),
  rootPlugin: rootPluginSchema.optional(),
});

/**
 * Opt-in generated session-start hook that nudges the user when the
 * installed plugin is older than the latest git tag of `repository`
 * (defaults to `metadata.repository`). Only claude and cursor support hooks.
 */
const updateCheckSchema = z.object({
  repository: z.string().min(1).optional(),
});

/** One authored plugin source mapped to an emitted plugin for a target. */
const emittedPluginSchema = z
  .object({
    // Canonical since 0.11: a direct path to one shared authored plugin.
    source: safeRelativePath.optional(),
    // Legacy 0.10 composition model. Kept readable for one migration window.
    from: z.array(z.string().min(1)).min(1).optional(),
    path: safeRelativePath.optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    displayName: z.string().optional(),
    manifest: z.record(z.string(), z.unknown()).optional(),
    // Deep-merged into this plugin's generated marketplace entry (the object in
    // the marketplace `plugins` array), letting a config supply target-specific
    // entry fields a target can't derive — e.g. Codex `policy`/`category`.
    entry: z.record(z.string(), z.unknown()).optional(),
    // Canonical selection names. `components` is the legacy include-only name.
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
    components: z.array(z.string()).optional(),
    // Applied after reading `source`, so it can add or replace target files.
    overrides: safeRelativePath.optional(),
    updateCheck: z.literal(false).optional(),
  })
  .superRefine((plugin, ctx) => {
    if (Boolean(plugin.source) === Boolean(plugin.from)) {
      ctx.addIssue({
        code: "custom",
        message: 'set exactly one of "source" or legacy "from"',
      });
    }
    if (plugin.components && (plugin.include || plugin.exclude)) {
      ctx.addIssue({
        code: "custom",
        message:
          'legacy "components" cannot be combined with "include" or "exclude"',
      });
    }
  });

/**
 * Content kinds that only mean something inside a client's extension
 * namespace, so the standalone `agent-plugins` target (which has no client
 * profile) can't ship them.
 */
export const CLIENT_ONLY_CONTENT_KINDS = [
  "agents",
  "commands",
  "rules",
  "hooks",
];

/** One target's output configuration: where it's written, and which plugins it emits. */
const targetSchema = z.object({
  outDir: z.string().min(1),
  // codex only: "agent-plugins" (default) emits Agent Plugins packages;
  // "legacy" emits the .codex-plugin layout. See docs/adr/0001.
  format: z.enum(["agent-plugins", "legacy"]).optional(),
  marketplaceDir: safeRelativePath.optional(),
  pluginRoot: safeRelativePath.optional(),
  version: z.string().optional(),
  // The repo this target's output lives in, for install-snippet generation
  // (falls back to metadata.repository) — the same "which repo" question
  // updateCheck.repository answers, asked by a different feature.
  repository: z.string().min(1).optional(),
  plugins: z.record(z.string(), emittedPluginSchema),
  manifest: z.record(z.string(), z.unknown()).optional(),
  ignoredDiffPaths: z.array(z.string()).optional(),
  updateCheck: updateCheckSchema.optional(),
  // Files emitted verbatim at the output repo root (relative to outDir), keyed
  // by output path → source path (relative to the config root). Managed like
  // any other emitted file, so a repo-root README/LICENSE is authored once in
  // the source repo and synced to every target instead of hand-maintained.
  rootFiles: z.record(safeRelativePath, safeRelativePath).optional(),
  // Canonical since 0.11: every file below this directory is emitted at the
  // generated repository root. Replaces the per-file rootFiles map.
  repositoryFiles: safeRelativePath.optional(),
});

/**
 * The root `pluginpack.config.ts` schema.
 *
 * Deliberately not `.strict()`: zod's default `z.object()` silently drops
 * unknown keys rather than erroring, which is the right tradeoff pre-1.0 — it
 * lets a future minor version add an optional config field without that
 * being a breaking change for existing configs. The cost is a typo'd key
 * failing silently instead of loudly; that's an accepted tradeoff, not an
 * oversight. Adding `.strict()` later would itself be a breaking change for
 * anyone currently typo-ing successfully, so this needs to be a deliberate
 * decision made once, not toggled casually.
 */
const configSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    source: sourceSchema.optional(),
    metadata: metadataSchema.optional(),
    targets: z.object({
      claude: targetSchema.optional(),
      copilot: targetSchema.optional(),
      cursor: targetSchema.optional(),
      antigravity: targetSchema.optional(),
      codex: targetSchema.optional(),
      "agent-plugins": targetSchema.optional(),
    }),
  })
  .superRefine((config, ctx) => {
    // updateCheck emits a session-start hook; only claude and cursor run hooks.
    for (const target of [
      "copilot",
      "antigravity",
      "codex",
      "agent-plugins",
    ] as const) {
      if (config.targets[target]?.updateCheck) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", target, "updateCheck"],
          message:
            "updateCheck is only supported for the claude and cursor targets",
        });
      }
    }
    for (const [target, targetConfig] of Object.entries(config.targets)) {
      if (target !== "codex" && targetConfig?.format) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", target, "format"],
          message: "format is only supported for the codex target",
        });
      }
    }
    const agentPlugins = config.targets["agent-plugins"];
    for (const [pluginName, plugin] of Object.entries(
      agentPlugins?.plugins ?? {},
    )) {
      const selected = plugin.include ?? plugin.components ?? [];
      const clientOnly = selected.filter((kind) =>
        CLIENT_ONLY_CONTENT_KINDS.includes(kind),
      );
      if (clientOnly.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", "agent-plugins", "plugins", pluginName],
          message: `${clientOnly.join(", ")} only exist inside a client extension namespace; the agent-plugins target can't include them`,
        });
      }
    }
  });

/** A source plugin's own `plugin.pluginpack.json`, if it has one. */
const sourcePluginManifestSchema = metadataSchema.extend({
  name: z.string().optional(),
  description: z.string().optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  additionalFiles: z.record(safeRelativePath, safeRelativePath).optional(),
});

/** Shipping files owned by an authored plugin's `mcp/` directory. */
const mcpManifestSchema = z.object({
  files: z.record(safeRelativePath, safeRelativePath).optional(),
});

export { configSchema, mcpManifestSchema, sourcePluginManifestSchema };

export type Author = z.infer<typeof authorSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export type SourceConfig = z.infer<typeof sourceSchema>;
export type EmittedPluginConfig = z.infer<typeof emittedPluginSchema>;
export type UpdateCheckConfig = z.infer<typeof updateCheckSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;
export type PluginpackConfig = z.infer<typeof configSchema>;
export type SourcePluginManifest = z.infer<typeof sourcePluginManifestSchema>;
export type McpManifest = z.infer<typeof mcpManifestSchema>;
