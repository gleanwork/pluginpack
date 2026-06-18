import path from "node:path";
import { artifact, deepMerge, emitPlugins, stripUndefined } from "./engine.js";
import type {
  Artifact,
  EmittedPluginConfig,
  Metadata,
  ResolvedProject,
  TargetConfig,
  TargetName,
} from "../types.js";

export async function emitAntigravity(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const version = targetConfig.version ?? project.config.version;
  const files = new Map<string, string | Buffer>();

  await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? pluginName,
    pluginManifest: {
      path: (pluginPath) => path.join(pluginPath, "plugin.json"),
      build: (metadata, pluginName, pluginConfig) =>
        antigravityPluginManifest(
          metadata,
          pluginConfig.version ?? version,
          pluginName,
          pluginConfig,
        ),
    },
    mcp: "antigravity",
  });

  return artifact(target, outDir, files);
}

function antigravityPluginManifest(
  metadata: Metadata | undefined,
  version: string,
  pluginName: string,
  pluginConfig: EmittedPluginConfig,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: pluginName,
    version,
    description: pluginConfig.description ?? metadata?.description,
  };
  return stripUndefined(deepMerge(manifest, pluginConfig.manifest ?? {}));
}
