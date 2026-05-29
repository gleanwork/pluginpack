export type TargetName = "claude" | "copilot" | "cursor" | "gemini";

export type Author = {
  name: string;
  email?: string;
  url?: string;
};

export type Metadata = {
  displayName?: string;
  description?: string;
  author?: Author;
  owner?: Author;
  homepage?: string;
  repository?: string;
  license?: string;
  logo?: string;
  keywords?: string[];
  category?: string;
  tags?: string[];
};

export type SourceConfig = {
  plugins?: string;
  skills?: string;
  rootPlugin?: Metadata & {
    id?: string;
    name?: string;
    description?: string;
  };
};

export type EmittedPluginConfig = {
  from: string[];
  path?: string;
  description?: string;
  displayName?: string;
  manifest?: Record<string, unknown>;
  components?: string[];
};

export type TargetConfig = {
  outDir: string;
  marketplaceDir?: string;
  pluginRoot?: string;
  plugins: Record<string, EmittedPluginConfig>;
  manifest?: Record<string, unknown>;
  ignoredDiffPaths?: string[];
};

export type PluginpackConfig = {
  name: string;
  version: string;
  source?: SourceConfig;
  metadata?: Metadata;
  targets: Partial<Record<TargetName, TargetConfig>>;
};

export type SourcePluginManifest = Metadata & {
  name?: string;
  description?: string;
};

export type SourcePlugin = {
  id: string;
  dir: string;
  manifest: SourcePluginManifest;
  componentRoots?: Partial<Record<string, string>>;
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
