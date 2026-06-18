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

export async function emitCodex(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const pluginRoot = targetConfig.pluginRoot ?? "plugins";
  const version = targetConfig.version ?? project.config.version;
  const files = new Map<string, string | Buffer>();

  const plugins = await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? toPosix(path.join(pluginRoot, pluginName)),
    pluginManifest: {
      path: (pluginPath) =>
        path.join(pluginPath, ".codex-plugin", "plugin.json"),
      build: (metadata, pluginName, pluginConfig, componentDirs, mcpServers) =>
        codexPluginManifest(
          metadata,
          pluginConfig.version ?? version,
          pluginName,
          pluginConfig,
          componentDirs,
          mcpServers,
        ),
    },
    // Base entry stays guess-free; authors supply policy/category via `entry`.
    buildEntry: ({ pluginName, pluginPath, pluginConfig, manifest }) => ({
      name: pluginName,
      source: `./${pluginPath}`,
      description:
        pluginConfig.description ??
        (manifest?.description as string | undefined),
      version: pluginConfig.version ?? version,
    }),
    mcp: "file",
  });

  const marketplace = stripUndefined(
    deepMerge(
      {
        name: project.config.name,
        interface: {
          displayName:
            project.config.metadata?.displayName ?? project.config.name,
        },
        plugins,
      },
      targetConfig.manifest ?? {},
    ),
  );
  files.set(
    toPosix(path.join(".agents", "plugins", "marketplace.json")),
    json(marketplace),
  );

  return artifact(target, outDir, files);
}

function codexPluginManifest(
  metadata: Metadata | undefined,
  version: string,
  pluginName: string,
  pluginConfig: EmittedPluginConfig,
  componentDirs: Set<string>,
  mcpServers: Record<string, unknown> | undefined,
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
  // Codex manifests point `skills` at the bundled folder (not a per-skill list).
  if (componentDirs.has("skills")) {
    manifest.skills = "./skills/";
  }
  if (mcpServers) {
    manifest.mcpServers = "./.mcp.json";
  }
  return stripUndefined(deepMerge(manifest, pluginConfig.manifest ?? {}));
}
