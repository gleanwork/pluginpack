import type {
  Author,
  Metadata,
  SourceConfig,
  EmittedPluginConfig,
  TargetConfig,
  PluginpackConfig,
  SourcePluginManifest,
  UpdateCheckConfig,
} from "./schema.js";

export type {
  Author,
  Metadata,
  SourceConfig,
  EmittedPluginConfig,
  TargetConfig,
  PluginpackConfig,
  SourcePluginManifest,
  UpdateCheckConfig,
};

export type TargetName =
  "claude" | "copilot" | "cursor" | "antigravity" | "codex";

/** A discovered source plugin, before it's emitted into any target. */
export type SourcePlugin = {
  id: string;
  dir: string;
  manifest: SourcePluginManifest;
  componentRoots?: Partial<Record<string, string>>;
  includeStaticFiles?: boolean;
};

/**
 * The one surface pluginpack uses to acquire source. A filesystem provider
 * backs it today; an API-backed provider (e.g. a remote skills API) can
 * implement the same two methods without touching the emit/validate/diff
 * pipeline.
 */
export interface SourceProvider {
  readPluginFiles(
    pluginId: string,
    target: TargetName,
  ): Promise<Map<string, FileValue>>;
  readMcpServers(
    pluginId: string,
  ): Promise<Record<string, unknown> | undefined>;
}

/** A loaded, fully-resolved pluginpack project, ready to build or validate. */
export type ResolvedProject = {
  rootDir: string;
  configPath: string;
  config: PluginpackConfig;
  sourceRoot: string;
  plugins: Map<string, SourcePlugin>;
  source: SourceProvider;
};

/** A loaded pluginpack config, before source plugin discovery. */
export type ResolvedProjectConfig = {
  rootDir: string;
  configPath: string;
  config: PluginpackConfig;
};

export type FileValue = string | Buffer;

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
