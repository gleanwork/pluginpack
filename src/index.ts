export { defineConfig, loadConfig } from "./config.js";
export { build } from "./build.js";
export { clean, prune } from "./cleanup.js";
export { diffTarget } from "./diff.js";
export { validateOutput } from "./validate.js";
export type {
  Artifact,
  Author,
  BuildOptions,
  CleanupEntry,
  CleanupResult,
  DiffEntry,
  DiffResult,
  EmittedPluginConfig,
  FileValue,
  Metadata,
  PluginpackConfig,
  ResolvedProject,
  SourcePlugin,
  SourceProvider,
  TargetConfig,
  TargetName,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
