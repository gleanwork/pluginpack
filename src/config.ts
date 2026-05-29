import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { z } from "zod";
import type {
  ResolvedProject,
  PluginpackConfig,
  SourcePlugin,
  SourcePluginManifest,
} from "./types.js";

const authorSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});

const metadataSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  owner: authorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  logo: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const emittedPluginSchema = z.object({
  from: z.array(z.string().min(1)).min(1),
  path: z.string().optional(),
  description: z.string().optional(),
  displayName: z.string().optional(),
  manifest: z.record(z.string(), z.unknown()).optional(),
  components: z.array(z.string()).optional(),
});

const targetSchema = z.object({
  outDir: z.string().min(1),
  marketplaceDir: z.string().optional(),
  pluginRoot: z.string().optional(),
  plugins: z.record(z.string(), emittedPluginSchema),
  manifest: z.record(z.string(), z.unknown()).optional(),
  ignoredDiffPaths: z.array(z.string()).optional(),
});

const configSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.object({ plugins: z.string().optional() }).optional(),
  metadata: metadataSchema.optional(),
  targets: z.object({
    claude: targetSchema.optional(),
    copilot: targetSchema.optional(),
    cursor: targetSchema.optional(),
    gemini: targetSchema.optional(),
  }),
});

const sourcePluginManifestSchema = metadataSchema.extend({
  name: z.string().optional(),
  description: z.string().optional(),
});

export function defineConfig(config: PluginpackConfig): PluginpackConfig {
  return config;
}

export async function loadConfig(
  cwd = process.cwd(),
  configPath?: string,
): Promise<ResolvedProject> {
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
  const sourceRoot = path.resolve(rootDir, config.source?.plugins ?? "plugins");
  const plugins = await discoverSourcePlugins(sourceRoot);
  return {
    rootDir,
    configPath: resolvedConfigPath,
    config,
    sourceRoot,
    plugins,
  };
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
