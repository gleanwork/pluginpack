import path from "node:path";
import { z } from "zod";
import { isSafeRelativeFilePath } from "./fs.js";

/**
 * A path written to or read from disk relative to a root — rejects absolute
 * paths and `..` escapes so a config can't write or read outside it. Every
 * field using it is a filesystem path, so a URL-shaped value gets no
 * exemption: `path.resolve` would read `https://../x` as `../x`.
 */
const safeRelativePath = z
  .string()
  .refine(
    isSafeRelativeFilePath,
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
  // Partials are inlined into shipped output, so reading them from outside the
  // project would publish files that are not part of it.
  partials: safeRelativePath.optional(),
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

/**
 * Clients an `agent-plugins` package can carry a profile and a marketplace
 * for. The full definitions (namespace, marketplace, file placement) live in
 * `src/package-clients.ts`; this module keeps only the data the config
 * schema checks.
 */
export const PACKAGE_CLIENT_NAMES = ["codex", "copilot"] as const;
export type PackageClientName = (typeof PACKAGE_CLIENT_NAMES)[number];

/**
 * The client-only content kinds each package client loads from its
 * extension directory. A kind not listed for any configured client is a
 * config error, as it is for a package with no clients.
 */
export const PACKAGE_CLIENT_CONTENT_KINDS: Record<
  PackageClientName,
  readonly string[]
> = {
  codex: [],
  copilot: ["agents"],
};

/** `targets["agent-plugins"].clients.<client>`: client-wide settings. */
const packageClientSchema = z.object({
  // Deep-merged into this client's generated marketplace file.
  manifest: z.record(z.string(), z.unknown()).optional(),
});

/** `plugins.<name>.clients.<client>`: one plugin's settings for one client. */
const pluginClientSchema = z.object({
  // Deep-merged into this plugin's entry in the client's marketplace, for
  // fields pluginpack can't derive (e.g. Codex `policy`/`category`).
  entry: z.record(z.string(), z.unknown()).optional(),
});

// Strict, unlike the rest of the config: a misspelled client name would
// otherwise drop that client's whole marketplace without a word.
const packageClientsSchema = z
  .object({
    codex: packageClientSchema.optional(),
    copilot: packageClientSchema.optional(),
  })
  .strict();
const pluginClientsSchema = z
  .object({
    codex: pluginClientSchema.optional(),
    copilot: pluginClientSchema.optional(),
  })
  .strict();

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
    // agent-plugins only: per-client settings for this plugin.
    clients: pluginClientsSchema.optional(),
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
 * namespace. The `agent-plugins` target ships one only when a configured
 * client implements it (see `PACKAGE_CLIENT_CONTENT_KINDS`).
 */
export const CLIENT_ONLY_CONTENT_KINDS = [
  "agents",
  "commands",
  "rules",
  "hooks",
];

/** One target's output configuration: where it's written, and which plugins it emits. */
const targetSchema = z.object({
  // Deliberately not safeRelativePath: an outDir may be a sibling output
  // repository ("../cursor-plugins"). The delete guard protects this
  // project's source and the outDir's .git; it knows nothing else about an
  // external repo, which the README calls out.
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
  // agent-plugins only: the clients each package carries a profile and a
  // marketplace for. See docs/adr/0002.
  clients: packageClientsSchema.optional(),
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

/** The native Claude and Cursor discovery paths are not configurable. */
export function marketplaceDirProblem(
  target: string,
  directory: string | undefined,
): string | undefined {
  const required =
    target === "claude"
      ? ".claude-plugin"
      : target === "cursor"
        ? ".cursor-plugin"
        : undefined;
  if (
    !required ||
    directory === undefined ||
    path.posix.normalize(directory).replace(/\/$/, "") === required
  ) {
    return undefined;
  }
  return target === "claude"
    ? 'Claude Code requires ".claude-plugin/". Remove marketplaceDir or set it to ".claude-plugin". Its validator reports: "No manifest found in directory. Expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json". See https://code.claude.com/docs/en/plugins-reference.'
    : 'Cursor requires ".cursor-plugin/". Remove marketplaceDir or set it to ".cursor-plugin". The host docs say "Place it at .cursor-plugin/marketplace.json". See https://cursor.com/docs/reference/plugins.';
}

/**
 * The root `pluginpack.config.ts` schema.
 *
 * Keep non-strict parsing: unknown keys are stripped, not rejected. The
 * config loader warns with their paths so typos do not fail silently.
 * Manifest and entry records intentionally preserve arbitrary keys.
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
    for (const [target, targetConfig] of Object.entries(config.targets)) {
      const problem = marketplaceDirProblem(
        target,
        targetConfig?.marketplaceDir,
      );
      if (problem) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", target, "marketplaceDir"],
          message: problem,
        });
      }
    }
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
    for (const [target, targetConfig] of Object.entries(config.targets)) {
      if (target === "agent-plugins" || !targetConfig) {
        continue;
      }
      if (targetConfig.clients) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", target, "clients"],
          message: "clients is only supported for the agent-plugins target",
        });
      }
      for (const [pluginName, plugin] of Object.entries(targetConfig.plugins)) {
        if (plugin.clients) {
          ctx.addIssue({
            code: "custom",
            path: ["targets", target, "plugins", pluginName, "clients"],
            message: "clients is only supported for the agent-plugins target",
          });
        }
      }
    }
    const agentPlugins = config.targets["agent-plugins"];
    // A key set to undefined (e.g. `copilot: flag ? {} : undefined`) isn't a
    // listed client; the build skips it the same way (configuredClients).
    const clients = listedKeys(agentPlugins?.clients) as PackageClientName[];
    const supportedKinds = new Set(
      clients.flatMap((client) => PACKAGE_CLIENT_CONTENT_KINDS[client]),
    );
    // agent-plugins writes only client marketplaces, so the shared
    // marketplace passthroughs would be dropped; point at the client ones.
    if (agentPlugins?.manifest !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["targets", "agent-plugins", "manifest"],
        message:
          'manifest isn\'t used by the agent-plugins target; set it per client in targets["agent-plugins"].clients.<client>.manifest',
      });
    }
    for (const [pluginName, plugin] of Object.entries(
      agentPlugins?.plugins ?? {},
    )) {
      if (plugin.entry !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", "agent-plugins", "plugins", pluginName, "entry"],
          message: `entry isn't used by the agent-plugins target; set it per client in targets["agent-plugins"].plugins.${pluginName}.clients.<client>.entry`,
        });
      }
      const selected = plugin.include ?? plugin.components ?? [];
      const unsupported = selected.filter(
        (kind) =>
          CLIENT_ONLY_CONTENT_KINDS.includes(kind) && !supportedKinds.has(kind),
      );
      if (unsupported.length > 0) {
        const implementers = PACKAGE_CLIENT_NAMES.filter((client) =>
          unsupported.some((kind) =>
            PACKAGE_CLIENT_CONTENT_KINDS[client].includes(kind),
          ),
        );
        ctx.addIssue({
          code: "custom",
          path: ["targets", "agent-plugins", "plugins", pluginName],
          message:
            `${unsupported.join(", ")} only exist inside a client extension namespace; the agent-plugins target can't include them` +
            (implementers.length > 0
              ? ` unless targets["agent-plugins"].clients lists a client that loads them (${implementers.join(", ")})`
              : " (pluginpack doesn't place them for any client yet)"),
        });
      }
      for (const client of listedKeys(plugin.clients)) {
        if (!clients.includes(client as PackageClientName)) {
          ctx.addIssue({
            code: "custom",
            path: [
              "targets",
              "agent-plugins",
              "plugins",
              pluginName,
              "clients",
              client,
            ],
            message: `client "${client}" isn't listed in targets["agent-plugins"].clients`,
          });
        }
      }
    }
  });

/** The keys of `record` whose values are set. */
function listedKeys(record: Record<string, unknown> | undefined): string[] {
  return Object.entries(record ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

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

// Authoring types describe schema input, so adding a default does not make
// that field required in existing configs. Parsed project state uses output.
export type Author = z.input<typeof authorSchema>;
export type Metadata = z.input<typeof metadataSchema>;
export type SourceConfig = z.input<typeof sourceSchema>;
export type EmittedPluginConfig = z.input<typeof emittedPluginSchema>;
export type UpdateCheckConfig = z.input<typeof updateCheckSchema>;
export type TargetConfig = z.input<typeof targetSchema>;
export type PluginpackConfig = z.input<typeof configSchema>;
/** The validated config, with schema defaults and transforms applied. */
export type ResolvedPluginpackConfig = z.infer<typeof configSchema>;
export type SourcePluginManifest = z.infer<typeof sourcePluginManifestSchema>;
export type McpManifest = z.infer<typeof mcpManifestSchema>;
