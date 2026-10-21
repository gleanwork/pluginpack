import type {
  Author,
  Metadata,
  SourceConfig,
  EmittedPluginConfig,
  TargetConfig,
  PluginpackConfig,
  ResolvedPluginpackConfig,
  SourcePluginManifest,
  McpManifest,
  UpdateCheckConfig,
} from "./schema.js";

export type {
  Author,
  Metadata,
  SourceConfig,
  EmittedPluginConfig,
  TargetConfig,
  PluginpackConfig,
  ResolvedPluginpackConfig,
  SourcePluginManifest,
  McpManifest,
  UpdateCheckConfig,
};

export type TargetName =
  "claude" | "copilot" | "cursor" | "antigravity" | "codex" | "agent-plugins";

/** A discovered source plugin, before it's emitted into any target. */
export type SourcePlugin = {
  id: string;
  dir: string;
  manifest: SourcePluginManifest;
  componentRoots?: Partial<Record<string, string>>;
  includeStaticFiles?: boolean;
};

/**
 * Internal source access used by the build pipeline. Its structural shape
 * is reachable through `ResolvedProject.source`, but the public API does
 * not accept a provider override.
 * @unstable Not a supported extension point; this interface may change.
 */
export interface SourceProvider {
  readPluginFiles(
    pluginId: string,
    target: TargetName,
  ): Promise<Map<string, FileValue>>;
  readMcpServers(
    pluginId: string,
    target: TargetName,
  ): Promise<Record<string, unknown> | undefined>;
}

export type AuthoredPlugin = {
  files: Map<string, FileValue>;
  manifest: SourcePluginManifest;
  mcpServers?: Record<string, unknown>;
};

/** A loaded, fully-resolved pluginpack project, ready to build or validate. */
export type ResolvedProject = {
  rootDir: string;
  configPath: string;
  config: ResolvedPluginpackConfig;
  /** @unstable Internal source-discovery state, not an extension point. */
  sourceRoot: string;
  /** @unstable Internal source-discovery state, not an extension point. */
  plugins: Map<string, SourcePlugin>;
  /** @unstable Internal rendering state, not an extension point. */
  partials: Map<string, string>;
  /** @unstable Internal source access; provider overrides are not supported. */
  source: SourceProvider;
};

/** A loaded pluginpack config, before source plugin discovery. */
export type ResolvedProjectConfig = {
  rootDir: string;
  configPath: string;
  config: ResolvedPluginpackConfig;
};

export type FileValue = string | Uint8Array;

/** One target's build output: its files, and which of them are managed by pluginpack. */
export type Artifact = {
  target: TargetName;
  outDir: string;
  files: Map<string, FileValue>;
  managedPaths: string[];
};

export type BuildOptions = {
  cwd?: string;
  configPath?: string;
  target?: TargetName;
  outDir?: string;
  dryRun?: boolean;
};

export type ValidationIssue = {
  level: "error" | "warning";
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

export type DiffEntry = {
  type: "added" | "changed" | "removed";
  path: string;
};

export type DiffResult = {
  ok: boolean;
  entries: DiffEntry[];
};

export type CleanupEntry = {
  type: "deleted" | "stale";
  target: TargetName;
  path: string;
};

export type CleanupResult = {
  target: TargetName;
  outDir: string;
  entries: CleanupEntry[];
};

/** Paths prune/clean will refuse to delete unless `force` is set. */
export type DeleteGuard = {
  protectedRoots: string[];
  configPath?: string;
  force?: boolean;
};
