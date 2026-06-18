import path from "node:path";
import { json, toPosix } from "../fs.js";
import {
  artifact,
  deepMerge,
  emitPlugins,
  stripUndefined,
  titleCase,
} from "./engine.js";
import type {
  Artifact,
  EmittedPluginConfig,
  Metadata,
  ResolvedProject,
  TargetConfig,
  TargetName,
} from "../types.js";

export async function emitCursor(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const marketplaceDir = targetConfig.marketplaceDir ?? ".cursor-plugin";
  const version = targetConfig.version ?? project.config.version;
  const files = new Map<string, string | Buffer>();

  const plugins = await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? pluginName,
    pluginManifest: {
      path: (pluginPath) =>
        path.join(pluginPath, marketplaceDir, "plugin.json"),
      build: (metadata, pluginName, pluginConfig, componentDirs, mcpServers) =>
        cursorPluginManifest(
          metadata,
          pluginConfig.version ?? version,
          pluginName,
          pluginConfig,
          componentDirs,
          mcpServers,
        ),
    },
    buildEntry: ({ pluginName, pluginPath, pluginConfig, manifest }) => ({
      name: pluginName,
      source: pluginPath,
      description:
        pluginConfig.description ??
        (manifest?.description as string | undefined),
    }),
    mcp: "file",
  });

  const marketplace = stripUndefined(
    deepMerge(
      {
        name: project.config.name,
        owner:
          project.config.metadata?.owner ?? project.config.metadata?.author,
        metadata: {
          description: project.config.metadata?.description,
          keywords: project.config.metadata?.keywords,
        },
        plugins,
        version,
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

function cursorPluginManifest(
  metadata: Metadata | undefined,
  version: string,
  pluginName: string,
  pluginConfig: EmittedPluginConfig,
  componentDirs: Set<string>,
  mcpServers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: pluginName,
    displayName:
      pluginConfig.displayName ??
      metadata?.displayName ??
      titleCase(pluginName),
    version,
    description: pluginConfig.description ?? metadata?.description,
    author: metadata?.author,
    homepage: metadata?.homepage,
    repository: metadata?.repository,
    license: metadata?.license,
    logo: metadata?.logo,
    keywords: metadata?.keywords,
    category: metadata?.category,
    tags: metadata?.tags,
  };
  const components = pluginConfig.components ?? [
    "skills",
    "agents",
    "commands",
    "rules",
    "hooks",
  ];
  for (const component of components) {
    if (componentDirs.has(component)) {
      manifest[component] = `./${component}/`;
    }
  }
  if (mcpServers) {
    manifest.mcpServers = "./.mcp.json";
  }
  return stripUndefined(deepMerge(manifest, pluginConfig.manifest ?? {}));
}
