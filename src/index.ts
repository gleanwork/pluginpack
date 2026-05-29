export { defineConfig, loadConfig } from "./config.js";
export { build } from "./build.js";
export { diffTarget } from "./diff.js";
export { validateOutput } from "./validate.js";
export type {
  Artifact,
  Author,
  BuildOptions,
  DiffResult,
  EmittedPluginConfig,
  Metadata,
  PluginpackConfig,
  TargetConfig,
  TargetName,
  ValidationResult,
} from "./types.js";
