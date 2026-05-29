import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { z } from "zod";
import { configSchema, sourcePluginManifestSchema } from "./schema.js";
import type {
  ResolvedProject,
  PluginpackConfig,
  ResolvedProjectConfig,
  SourcePlugin,
  SourcePluginManifest,
} from "./types.js";

export function defineConfig(config: PluginpackConfig): PluginpackConfig {
  return config;
}

export async function loadConfig(
  cwd = process.cwd(),
  configPath?: string,
): Promise<ResolvedProject> {
  const projectConfig = await loadProjectConfig(cwd, configPath);
  const { config, rootDir } = projectConfig;
  const sourceRoot = path.resolve(rootDir, config.source?.plugins ?? "plugins");
  const plugins = await discoverSourcePlugins(sourceRoot);
  await addRootSkillsPlugin(rootDir, config, plugins);
  return {
    ...projectConfig,
    sourceRoot,
    plugins,
  };
}

export async function loadProjectConfig(
  cwd = process.cwd(),
  configPath?: string,
): Promise<ResolvedProjectConfig> {
  const resolvedConfigPath = configPath
    ? path.resolve(cwd, configPath)
    : await findConfig(cwd);
  const jiti = createJiti(pathToFileURL(resolvedConfigPath).href, {
    interopDefault: true,
  });
  const loaded = await jiti.import(resolvedConfigPath, { default: true });
  const config = parseWithContext(
    configSchema,
    loaded,
    resolvedConfigPath,
  ) as PluginpackConfig;
  const rootDir = path.dirname(resolvedConfigPath);
  return {
    rootDir,
    configPath: resolvedConfigPath,
    config,
  };
}

async function addRootSkillsPlugin(
  rootDir: string,
  config: PluginpackConfig,
  plugins: Map<string, SourcePlugin>,
): Promise<void> {
  if (!config.source?.skills) {
    return;
  }
  const id = config.source.rootPlugin?.id ?? "core";
  if (plugins.has(id)) {
    throw new Error(
      `Root skills source plugin "${id}" conflicts with an existing source plugin.`,
    );
  }
  const skillsDir = path.resolve(rootDir, config.source.skills);
  if (!(await exists(skillsDir))) {
    throw new Error(`Root skills source directory is missing: ${skillsDir}`);
  }
  const manifest = { ...(config.source.rootPlugin ?? {}) };
  delete manifest.id;
  plugins.set(id, {
    id,
    dir: rootDir,
    manifest,
    componentRoots: {
      skills: skillsDir,
    },
    includeStaticFiles: false,
  });
}

async function findConfig(cwd: string): Promise<string> {
  const names = [
    "pluginpack.config.ts",
    "pluginpack.config.mts",
    "pluginpack.config.mjs",
    "pluginpack.config.js",
  ];
  for (const name of names) {
    const candidate = path.resolve(cwd, name);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `No pluginpack config found in ${cwd}. Expected ${names.join(", ")}.`,
  );
}

async function discoverSourcePlugins(
  sourceRoot: string,
): Promise<Map<string, SourcePlugin>> {
  const plugins = new Map<string, SourcePlugin>();
  if (!(await exists(sourceRoot))) {
    return plugins;
  }
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const dir = path.join(sourceRoot, entry.name);
    const manifestPath = path.join(dir, "plugin.pluginpack.json");
    const manifest = await readSourceManifest(manifestPath);
    plugins.set(entry.name, {
      id: entry.name,
      dir,
      manifest,
    });
  }
  return plugins;
}

async function readSourceManifest(
  filePath: string,
): Promise<SourcePluginManifest> {
  if (!(await exists(filePath))) {
    return {};
  }
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return parseWithContext(
      sourcePluginManifestSchema,
      JSON.parse(raw),
      filePath,
    ) as SourcePluginManifest;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function parseWithContext(
  schema: z.ZodType,
  value: unknown,
  context: string,
): unknown {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid pluginpack config in ${context}: ${details}`);
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
