/** Public API — everything the CLI itself uses is exported here for programmatic use. */
export { defineConfig, loadConfig } from "./config.js";
export { build } from "./build.js";
export { clean, prune } from "./cleanup.js";
export { diffTarget } from "./diff.js";
export { validateOutput } from "./adapters.js";
export {
  buildInstallSnippet,
  getInstallSnippetCitation,
  getSupportedInstallTargets,
  getUnsupportedInstallTargets,
} from "./install-snippet.js";
export type {
  Citation,
  InstallParams,
  InstallSnippet,
} from "./install-snippet.js";
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
  TargetConfig,
  TargetName,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
