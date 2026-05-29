import path from "node:path";
import { collectPluginFiles } from "./render.js";
import { json, toPosix } from "./fs.js";
import type {
  Artifact,
  EmittedPluginConfig,
  Metadata,
  ResolvedProject,
  TargetConfig,
  TargetName,
} from "./types.js";

type TargetEmitter = (
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
) => Promise<Artifact>;

const emitters: Record<TargetName, TargetEmitter> = {
  claude: emitClaude,
  copilot: emitCopilot,
  cursor: emitCursor,
  gemini: emitGemini,
};

export async function emitTarget(
  project: ResolvedProject,
  target: TargetName,
  outDir?: string,
): Promise<Artifact> {
  const targetConfig = project.config.targets[target];
  if (!targetConfig) {
    throw new Error(`Target "${target}" is not configured.`);
  }
  const emitter = emitters[target];
  const resolvedOutDir = path.resolve(
    project.rootDir,
    outDir ?? targetConfig.outDir,
  );
  return emitter(project, target, targetConfig, resolvedOutDir);
}

type MarketplaceEntry = {
  name: string;
  source: string;
  description?: string;
};

type EmitPluginsOptions = {
  resolvePluginPath: (
    pluginName: string,
    pluginConfig: EmittedPluginConfig,
  ) => string;
  pluginManifestPath: (pluginPath: string) => string;
  buildManifest: (
    metadata: Metadata | undefined,
    pluginName: string,
    pluginConfig: EmittedPluginConfig,
    componentDirs: Set<string>,
  ) => Record<string, unknown>;
  entrySource?: (pluginPath: string) => string;
};

async function emitPlugins(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  files: Map<string, string | Buffer>,
  options: EmitPluginsOptions,
): Promise<MarketplaceEntry[]> {
  const entries: MarketplaceEntry[] = [];
  for (const [pluginName, pluginConfig] of Object.entries(
    targetConfig.plugins,
  )) {
    const pluginPath = options.resolvePluginPath(pluginName, pluginConfig);
    const pluginFiles = await collectPluginFiles(
      project,
      target,
      pluginConfig.from,
    );
    const componentDirs = new Set(
      [...pluginFiles.keys()].map((file) => file.split("/")[0]),
    );
    for (const [relativePath, value] of pluginFiles) {
      files.set(toPosix(path.join(pluginPath, relativePath)), value);
    }

    const metadata = emittedPluginMetadata(project, pluginConfig);
    const manifest = options.buildManifest(
      metadata,
      pluginName,
      pluginConfig,
      componentDirs,
    );
    files.set(toPosix(options.pluginManifestPath(pluginPath)), json(manifest));

    if (options.entrySource) {
      entries.push({
        name: pluginName,
        source: options.entrySource(pluginPath),
        description:
          pluginConfig.description ??
          (manifest.description as string | undefined),
      });
    }
  }
  return entries;
}

async function emitCursor(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const marketplaceDir = targetConfig.marketplaceDir ?? ".cursor-plugin";
  const version = project.config.version;
  const files = new Map<string, string | Buffer>();

  const plugins = await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? pluginName,
    pluginManifestPath: (pluginPath) =>
      path.join(pluginPath, marketplaceDir, "plugin.json"),
    buildManifest: (metadata, pluginName, pluginConfig, componentDirs) =>
      cursorPluginManifest(
        metadata,
        version,
        pluginName,
        pluginConfig,
        componentDirs,
      ),
    entrySource: (pluginPath) => pluginPath,
  });

  const marketplace = {
    name: project.config.name,
    owner: project.config.metadata?.owner ?? project.config.metadata?.author,
    metadata: {
      description: project.config.metadata?.description,
      keywords: project.config.metadata?.keywords,
    },
    plugins,
    version,
    ...targetConfig.manifest,
  };
  files.set(
    toPosix(path.join(marketplaceDir, "marketplace.json")),
    json(stripUndefined(marketplace)),
  );

  return artifact(target, outDir, files);
}

async function emitClaude(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const marketplaceDir = targetConfig.marketplaceDir ?? ".claude-plugin";
  const pluginRoot = targetConfig.pluginRoot ?? "plugins";
  const version = project.config.version;
  const files = new Map<string, string | Buffer>();

  const plugins = await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? toPosix(path.join(pluginRoot, pluginName)),
    pluginManifestPath: (pluginPath) =>
      path.join(pluginPath, marketplaceDir, "plugin.json"),
    buildManifest: (metadata, pluginName, pluginConfig) =>
      claudePluginManifest(metadata, version, pluginName, pluginConfig),
    entrySource: (pluginPath) => `./${pluginPath}`,
  });

  const marketplace = {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: project.config.name,
    version,
    description: project.config.metadata?.description,
    owner: project.config.metadata?.owner ?? project.config.metadata?.author,
    plugins,
    ...targetConfig.manifest,
  };
  files.set(
    toPosix(path.join(marketplaceDir, "marketplace.json")),
    json(stripUndefined(marketplace)),
  );

  return artifact(target, outDir, files);
}

async function emitGemini(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const version = project.config.version;
  const files = new Map<string, string | Buffer>();

  await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? pluginName,
    pluginManifestPath: (pluginPath) =>
      path.join(pluginPath, "gemini-extension.json"),
    buildManifest: (metadata, pluginName, pluginConfig) =>
      geminiExtensionManifest(metadata, version, pluginName, pluginConfig),
  });

  return artifact(target, outDir, files);
}

async function emitCopilot(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const files = new Map<string, string | Buffer>();

  for (const pluginConfig of Object.values(targetConfig.plugins)) {
    const pluginFiles = await collectPluginFiles(
      project,
      target,
      pluginConfig.from,
    );
    for (const [relativePath, value] of pluginFiles) {
      if (!relativePath.startsWith("skills/")) {
        continue;
      }
      const destination = toPosix(path.join(".github", relativePath));
      if (files.has(destination)) {
        throw new Error(`Duplicate Copilot skill output "${destination}".`);
      }
      files.set(destination, value);
    }
  }

  return artifact(target, outDir, files);
}

function emittedPluginMetadata(
  project: ResolvedProject,
  pluginConfig: EmittedPluginConfig,
): Metadata | undefined {
  const sourceMetadata =
    pluginConfig.from.length === 1
      ? project.plugins.get(pluginConfig.from[0])?.manifest
      : undefined;
  return stripUndefined({
    ...project.config.metadata,
    ...sourceMetadata,
  });
}

function cursorPluginManifest(
  metadata: Metadata | undefined,
  version: string,
  pluginName: string,
  pluginConfig: EmittedPluginConfig,
  componentDirs: Set<string>,
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
    "mcpServers",
  ];
  for (const component of components) {
    if (componentDirs.has(component)) {
      manifest[component] = `./${component}/`;
    }
  }
  return stripUndefined({ ...manifest, ...pluginConfig.manifest });
}

function claudePluginManifest(
  metadata: Metadata | undefined,
  version: string,
  pluginName: string,
  pluginConfig: EmittedPluginConfig,
): Record<string, unknown> {
  return stripUndefined({
    name: pluginName,
    version,
    description: pluginConfig.description ?? metadata?.description,
    author: metadata?.author,
    homepage: metadata?.homepage,
    repository: metadata?.repository,
    license: metadata?.license,
    keywords: metadata?.keywords,
    ...pluginConfig.manifest,
  });
}

function geminiExtensionManifest(
  metadata: Metadata | undefined,
  version: string,
  pluginName: string,
  pluginConfig: EmittedPluginConfig,
): Record<string, unknown> {
  return stripUndefined({
    name: pluginName,
    version,
    description: pluginConfig.description ?? metadata?.description,
    ...pluginConfig.manifest,
  });
}

function artifact(
  target: TargetName,
  outDir: string,
  files: Map<string, string | Buffer>,
): Artifact {
  const managedPaths = [...files.keys()].sort();
  return {
    target,
    outDir,
    files: new Map([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
    managedPaths,
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function titleCase(value: string): string {
  return value
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
