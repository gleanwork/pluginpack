import { promises as fs } from "node:fs";
import path from "node:path";
import { collectPluginFiles, resolveMcpServers } from "./render.js";
import { isSafeRelativePath, json, toPosix } from "./fs.js";
import { resolveTargetComponents } from "./components.js";
import type {
  Artifact,
  EmittedPluginConfig,
  FileValue,
  Metadata,
  ResolvedProject,
  TargetConfig,
  TargetName,
} from "./types.js";

// Emit per-target repo-root files (e.g. a README authored once in the source
// repo) into the artifact so they are managed, pruned, and synced like every
// other generated file — rather than hand-maintained in each output repo.
export async function withRootFiles(
  project: ResolvedProject,
  targetConfig: TargetConfig,
  result: Artifact,
): Promise<Artifact> {
  const rootFiles = targetConfig.rootFiles;
  if (!rootFiles || Object.keys(rootFiles).length === 0) {
    return result;
  }
  const files = new Map(result.files);
  for (const [dest, source] of Object.entries(rootFiles)) {
    const destPath = toPosix(dest);
    if (!isSafeRelativePath(destPath)) {
      throw new Error(
        `Target "${result.target}" rootFiles destination "${dest}" must be a safe relative path.`,
      );
    }
    if (files.has(destPath)) {
      throw new Error(
        `Target "${result.target}" rootFiles destination "${dest}" collides with a generated file.`,
      );
    }
    let contents: Buffer;
    try {
      contents = await fs.readFile(path.resolve(project.rootDir, source));
    } catch {
      throw new Error(
        `Target "${result.target}" rootFiles source "${source}" could not be read.`,
      );
    }
    files.set(destPath, contents);
  }
  return artifact(result.target, result.outDir, files);
}

type EmitPluginContext = {
  pluginName: string;
  pluginPath: string;
  pluginConfig: EmittedPluginConfig;
  metadata: Metadata | undefined;
  componentDirs: Set<string>;
  mcpServers: Record<string, unknown> | undefined;
  pluginFiles: Map<string, FileValue>;
  manifest: Record<string, unknown> | undefined;
};

type EmitPluginsOptions = {
  resolvePluginPath: (
    pluginName: string,
    pluginConfig: EmittedPluginConfig,
  ) => string;
  // Some targets (Copilot) carry no per-plugin manifest; omit to skip writing one.
  pluginManifest?: {
    path: (pluginPath: string) => string;
    build: (
      metadata: Metadata | undefined,
      pluginName: string,
      pluginConfig: EmittedPluginConfig,
      componentDirs: Set<string>,
      mcpServers: Record<string, unknown> | undefined,
    ) => Record<string, unknown>;
  };
  // Build this plugin's marketplace entry; omit when the target has no marketplace.
  buildEntry?: (ctx: EmitPluginContext) => Record<string, unknown> | undefined;
  mcp?: "file" | "antigravity";
};

async function emitPlugins(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  files: Map<string, string | Buffer>,
  options: EmitPluginsOptions,
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (const [pluginName, pluginConfig] of Object.entries(
    targetConfig.plugins,
  )) {
    const pluginPath = options.resolvePluginPath(pluginName, pluginConfig);
    const pluginFiles = await collectPluginFiles(
      project,
      target,
      pluginConfig.from,
      resolveTargetComponents(target, pluginConfig),
    );
    const componentDirs = new Set(
      [...pluginFiles.keys()].map((file) => file.split("/")[0]),
    );
    for (const [relativePath, value] of pluginFiles) {
      files.set(toPosix(path.join(pluginPath, relativePath)), value);
    }

    const mcpServers = await resolveMcpServers(project, pluginConfig.from);
    if (mcpServers && options.mcp === "file") {
      files.set(
        toPosix(path.join(pluginPath, ".mcp.json")),
        json({ mcpServers }),
      );
    } else if (mcpServers && options.mcp === "antigravity") {
      files.set(
        toPosix(path.join(pluginPath, "mcp_config.json")),
        json({ mcpServers }),
      );
    }

    const metadata = emittedPluginMetadata(project, pluginConfig);
    let manifest: Record<string, unknown> | undefined;
    if (options.pluginManifest) {
      manifest = options.pluginManifest.build(
        metadata,
        pluginName,
        pluginConfig,
        componentDirs,
        mcpServers,
      );
      files.set(
        toPosix(options.pluginManifest.path(pluginPath)),
        json(manifest),
      );
    }

    const entry = options.buildEntry?.({
      pluginName,
      pluginPath,
      pluginConfig,
      metadata,
      componentDirs,
      mcpServers,
      pluginFiles,
      manifest,
    });
    if (entry) {
      // Deep-merge the config's per-plugin entry passthrough so a target can
      // carry author-supplied fields it can't derive (e.g. Codex policy/category).
      entries.push(stripUndefined(deepMerge(entry, pluginConfig.entry ?? {})));
    }
  }
  return entries;
}

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

export async function emitCopilot(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const version = targetConfig.version ?? project.config.version;
  const pluginRoot = targetConfig.pluginRoot ?? "plugins";
  const files = new Map<string, string | Buffer>();

  // Copilot has no per-plugin manifest; each plugin's data lives in its
  // marketplace entry (with a derived skills list), so this omits pluginManifest
  // and builds the entry directly.
  const plugins = await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? toPosix(path.join(pluginRoot, pluginName)),
    buildEntry: ({
      pluginName,
      pluginPath,
      pluginConfig,
      metadata,
      mcpServers,
      pluginFiles,
    }) =>
      stripUndefined({
        name: pluginName,
        source: `./${pluginPath}`,
        description: pluginConfig.description ?? metadata?.description,
        version: pluginConfig.version ?? version,
        skills: [
          ...new Set(
            [...pluginFiles.keys()]
              .filter((file) => file.startsWith("skills/"))
              .map((file) => `./skills/${file.split("/")[1]}`),
          ),
        ].sort(),
        mcpServers: mcpServers ? ".mcp.json" : undefined,
      }),
    mcp: "file",
  });

  const marketplace = stripUndefined(
    deepMerge(
      {
        name: project.config.name,
        metadata: stripUndefined({
          description: project.config.metadata?.description,
          version,
          keywords: project.config.metadata?.keywords,
        }),
        owner:
          project.config.metadata?.owner ?? project.config.metadata?.author,
        plugins,
      },
      targetConfig.manifest ?? {},
    ),
  );
  // Copilot reuses the Claude marketplace schema and reads it from both the
  // repo-root .claude-plugin/ and .github/plugin/ (see github/copilot-plugins).
  const marketplaceJson = json(marketplace);
  files.set(
    toPosix(path.join(".claude-plugin", "marketplace.json")),
    marketplaceJson,
  );
  files.set(
    toPosix(path.join(".github", "plugin", "marketplace.json")),
    marketplaceJson,
  );

  return artifact(target, outDir, files);
}

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Deep-merge an override onto a generated manifest. Nested objects merge so a
// sibling key isn't lost; arrays and scalars from the override replace (not
// concatenate, so keywords/tags don't double up). This is the general escape
// hatch — any field, at any depth, can be overridden via a target/plugin
// `manifest`.
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : value;
  }
  return result;
}

function titleCase(value: string): string {
  return value
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
