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

async function emitCursor(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const marketplaceDir = targetConfig.marketplaceDir ?? ".cursor-plugin";
  const files = new Map<string, string | Buffer>();
  const plugins = [];

  for (const [pluginName, pluginConfig] of Object.entries(
    targetConfig.plugins,
  )) {
    const pluginPath = pluginConfig.path ?? pluginName;
    const pluginFiles = await collectPluginFiles(
      project,
      target,
      pluginConfig.from,
    );
    const componentDirs = new Set(
      [...pluginFiles.keys()].map((file) => file.split("/")[0]),
    );
    const metadata = emittedPluginMetadata(project, pluginConfig);
    for (const [relativePath, value] of pluginFiles) {
      files.set(toPosix(path.join(pluginPath, relativePath)), value);
    }

    const manifest = cursorPluginManifest(
      metadata,
      project.config.version,
      pluginName,
      pluginConfig,
      componentDirs,
    );
    files.set(
      toPosix(path.join(pluginPath, marketplaceDir, "plugin.json")),
      json(manifest),
    );

    plugins.push({
      name: pluginName,
      source: pluginPath,
      description: pluginConfig.description ?? manifest.description,
    });
  }

  const marketplace = {
    name: project.config.name,
    owner: project.config.metadata?.owner ?? project.config.metadata?.author,
    metadata: {
      description: project.config.metadata?.description,
      keywords: project.config.metadata?.keywords,
    },
    plugins,
    version: project.config.version,
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
  const files = new Map<string, string | Buffer>();
  const plugins = [];

  for (const [pluginName, pluginConfig] of Object.entries(
    targetConfig.plugins,
  )) {
    const pluginPath =
      pluginConfig.path ?? toPosix(path.join(pluginRoot, pluginName));
    const metadata = emittedPluginMetadata(project, pluginConfig);
    const pluginFiles = await collectPluginFiles(
      project,
      target,
      pluginConfig.from,
    );
    for (const [relativePath, value] of pluginFiles) {
      files.set(toPosix(path.join(pluginPath, relativePath)), value);
    }

    const manifest = claudePluginManifest(
      metadata,
      project.config.version,
      pluginName,
      pluginConfig,
    );
    files.set(
      toPosix(path.join(pluginPath, marketplaceDir, "plugin.json")),
      json(manifest),
    );

    plugins.push({
      name: pluginName,
      source: `./${pluginPath}`,
      description: pluginConfig.description ?? manifest.description,
    });
  }

  const marketplace = {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: project.config.name,
    version: project.config.version,
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
  const files = new Map<string, string | Buffer>();

  for (const [pluginName, pluginConfig] of Object.entries(
    targetConfig.plugins,
  )) {
    const pluginPath = pluginConfig.path ?? pluginName;
    const metadata = emittedPluginMetadata(project, pluginConfig);
    const pluginFiles = await collectPluginFiles(
      project,
      target,
      pluginConfig.from,
    );
    for (const [relativePath, value] of pluginFiles) {
      files.set(toPosix(path.join(pluginPath, relativePath)), value);
    }

    const manifest = geminiExtensionManifest(
      metadata,
      project.config.version,
      pluginName,
      pluginConfig,
    );
    files.set(
      toPosix(path.join(pluginPath, "gemini-extension.json")),
      json(manifest),
    );
  }

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
