import path from "node:path";
import { json, toPosix } from "../fs.js";
import { artifact, deepMerge, emitPlugins, stripUndefined } from "./engine.js";
import type {
  Artifact,
  EmittedPluginConfig,
  Metadata,
  ResolvedProject,
  TargetConfig,
  TargetName,
} from "../types.js";

export async function emitClaude(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const marketplaceDir = targetConfig.marketplaceDir ?? ".claude-plugin";
  const pluginRoot = targetConfig.pluginRoot ?? "plugins";
  const version = targetConfig.version ?? project.config.version;
  const files = new Map<string, string | Buffer>();

  const plugins = await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? toPosix(path.join(pluginRoot, pluginName)),
    pluginManifest: {
      path: (pluginPath) =>
        path.join(pluginPath, marketplaceDir, "plugin.json"),
      build: (metadata, pluginName, pluginConfig) =>
        claudePluginManifest(
          metadata,
          pluginConfig.version ?? version,
          pluginName,
          pluginConfig,
        ),
    },
    buildEntry: ({ pluginName, pluginPath, pluginConfig, manifest }) => ({
      name: pluginName,
      source: `./${pluginPath}`,
      description:
        pluginConfig.description ??
        (manifest?.description as string | undefined),
    }),
    mcp: "file",
  });

  const marketplace = stripUndefined(
    deepMerge(
      {
        $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
        name: project.config.name,
        version,
        description: project.config.metadata?.description,
        owner:
          project.config.metadata?.owner ?? project.config.metadata?.author,
        plugins,
      },
      targetConfig.manifest ?? {},
    ),
  );
  files.set(
    toPosix(path.join(marketplaceDir, "marketplace.json")),
    json(marketplace),
  );

  return artifact(target, outDir, files);
}

function claudePluginManifest(
  metadata: Metadata | undefined,
  version: string,
  pluginName: string,
  pluginConfig: EmittedPluginConfig,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: pluginName,
    version,
    description: pluginConfig.description ?? metadata?.description,
    author: metadata?.author,
    homepage: metadata?.homepage,
    repository: metadata?.repository,
    license: metadata?.license,
    keywords: metadata?.keywords,
  };
  return stripUndefined(deepMerge(manifest, pluginConfig.manifest ?? {}));
}
