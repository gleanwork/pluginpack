import type {
  Author,
  Metadata,
  SourceConfig,
  EmittedPluginConfig,
  TargetConfig,
  PluginpackConfig,
  SourcePluginManifest,
} from "./schema.js";

export type {
  Author,
  Metadata,
  SourceConfig,
  EmittedPluginConfig,
  TargetConfig,
  PluginpackConfig,
  SourcePluginManifest,
};

export type TargetName = "claude" | "copilot" | "cursor" | "gemini";

export type SourcePlugin = {
  id: string;
  dir: string;
  manifest: SourcePluginManifest;
  componentRoots?: Partial<Record<string, string>>;
  includeStaticFiles?: boolean;
};

export type ResolvedProject = {
  rootDir: string;
  configPath: string;
  config: PluginpackConfig;
  sourceRoot: string;
  plugins: Map<string, SourcePlugin>;
};

export type ResolvedProjectConfig = {
  rootDir: string;
  configPath: string;
  config: PluginpackConfig;
};

export type FileValue = string | Buffer;

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

export type DeleteGuard = {
  protectedRoots: string[];
  configPath?: string;
  force?: boolean;
};
