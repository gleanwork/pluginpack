import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { z } from "zod";
import { componentDirs } from "./components.js";
import { warnOnStrippedKeys } from "./config-diagnostics.js";
import { exists, isInside, physicalKey } from "./fs.js";
import { loadPartials } from "./partials.js";
import { configSchema, sourcePluginManifestSchema } from "./schema.js";
import { createFilesystemSourceProvider } from "./source.js";
import type {
  ResolvedProject,
  PluginpackConfig,
  ResolvedPluginpackConfig,
  ResolvedProjectConfig,
  SourcePlugin,
  SourcePluginManifest,
} from "./types.js";

/** Identity helper giving config authors type-checking and editor completion. */
export function defineConfig(config: PluginpackConfig): PluginpackConfig {
  return config;
}

/** Loads the project config and discovers its source plugins, ready for `build()`. */
export async function loadConfig(
  cwd = process.cwd(),
  configPath?: string,
): Promise<ResolvedProject> {
  const projectConfig = await loadProjectConfig(cwd, configPath);
  await assertOutDirsOutsideSource(projectConfig);
  const { config, rootDir } = projectConfig;
  const sourceRoot = path.resolve(rootDir, config.source?.plugins ?? "plugins");
  const plugins = await discoverSourcePlugins(sourceRoot);
  await addRootSkillsPlugin(rootDir, config, plugins);
  const partials = await loadPartialsIfConfigured(rootDir, config);
  return {
    ...projectConfig,
    sourceRoot,
    plugins,
    partials,
    source: createFilesystemSourceProvider(plugins),
  };
}

/**
 * Loads the project-level `partials/` map if `source.partials` is
 * configured, shared across every source plugin (unlike components, which
 * are scoped to one plugin's own directory) — see `src/partials.ts`.
 */
async function loadPartialsIfConfigured(
  rootDir: string,
  config: ResolvedPluginpackConfig,
): Promise<Map<string, string>> {
  if (!config.source?.partials) {
    return new Map();
  }
  const partialsDir = path.resolve(rootDir, config.source.partials);
  if (!(await exists(partialsDir))) {
    throw new Error(`Source partials directory is missing: ${partialsDir}`);
  }
  return loadPartials(partialsDir);
}

/** Loads and validates the config file itself, without discovering source plugins. */
export async function loadProjectConfig(
  cwd = process.cwd(),
  configPath?: string,
): Promise<ResolvedProjectConfig> {
  const resolvedConfigPath = configPath
    ? path.resolve(cwd, configPath)
    : await findConfig(cwd);
  // No module cache: a long-lived process (a watcher, a test harness) that
  // calls build() again after the config file changed must get the new
  // config, not the module jiti evaluated the first time.
  const jiti = createJiti(pathToFileURL(resolvedConfigPath).href, {
    interopDefault: true,
    moduleCache: false,
  });
  const loaded = await jiti.import(resolvedConfigPath, { default: true });
  const config = parseWithContext(configSchema, loaded, resolvedConfigPath);
  const rootDir = path.dirname(resolvedConfigPath);
  return {
    rootDir,
    configPath: resolvedConfigPath,
    config,
  };
}

async function addRootSkillsPlugin(
  rootDir: string,
  config: ResolvedPluginpackConfig,
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
  for (const dir of await listSourcePluginDirs(sourceRoot)) {
    const id = path.basename(dir);
    const manifest = await readSourceManifest(
      path.join(dir, "plugin.pluginpack.json"),
    );
    plugins.set(id, { id, dir, manifest });
  }
  return plugins;
}

/** An authored path the delete guard protects, with the config field that names it. */
export type SourcePath = {
  path: string;
  field: string;
};

/**
 * Every authored path the config reads from: the paths prune and clean must
 * never delete and a target's outDir must never sit inside.
 *
 * Derived from the config, not from what is on disk, so `clean` keeps working
 * when the source tree no longer loads. `source.plugins` is protected whole
 * only when the config sets it. Under the default `plugins/` root — where the
 * README's layouts also write generated output — only the legacy source
 * plugins a target actually reads through `from`, and directories carrying a
 * `plugin.pluginpack.json` (which generated output never contains), count as
 * source here. Other directories legacy discovery would read as source plugins
 * are listed by `listUnreferencedSourcePluginDirs`; the delete guard protects
 * them unless pluginpack recorded writing every file in them, since guessing
 * from component directories alone misreads a generated package
 * (`plugins/acme/skills/`) as source and blocks its own prune.
 */
export async function listSourcePaths(
  project: ResolvedProjectConfig,
): Promise<SourcePath[]> {
  const { rootDir, config } = project;
  const paths: SourcePath[] = [];
  const add = (value: string, field: string) =>
    paths.push({ path: path.resolve(rootDir, value), field });
  if (config.source?.skills) {
    add(config.source.skills, "source.skills");
  }
  if (config.source?.partials) {
    add(config.source.partials, "source.partials");
  }
  if (config.source?.plugins) {
    add(config.source.plugins, "source.plugins");
  } else {
    const defaultRoot = path.resolve(rootDir, "plugins");
    const legacyIds = referencedLegacyIds(project);
    for (const id of legacyIds) {
      paths.push({
        path: path.join(defaultRoot, id),
        field: `legacy source plugin "${id}" (from)`,
      });
    }
    for (const dir of await listManifestPluginDirs(defaultRoot)) {
      if (!legacyIds.has(path.basename(dir))) {
        paths.push({ path: dir, field: "plugin.pluginpack.json" });
      }
    }
  }
  for (const [name, target] of Object.entries(config.targets)) {
    if (!target) {
      continue;
    }
    if (target.repositoryFiles) {
      add(target.repositoryFiles, `targets.${name}.repositoryFiles`);
    }
    for (const [dest, source] of Object.entries(target.rootFiles ?? {})) {
      add(source, `targets.${name}.rootFiles["${dest}"]`);
    }
    for (const [pluginName, plugin] of Object.entries(target.plugins)) {
      if (plugin.source) {
        add(plugin.source, `targets.${name}.plugins.${pluginName}.source`);
      }
      if (plugin.overrides) {
        add(
          plugin.overrides,
          `targets.${name}.plugins.${pluginName}.overrides`,
        );
      }
    }
  }
  return paths;
}

/**
 * Legacy source plugin ids a target reads through `from`, except the root
 * skills plugin, which reads only `source.skills`.
 */
function referencedLegacyIds(project: ResolvedProjectConfig): Set<string> {
  const { config } = project;
  const rootPluginId = config.source?.skills
    ? (config.source.rootPlugin?.id ?? "core")
    : undefined;
  const ids = new Set<string>();
  for (const target of Object.values(config.targets)) {
    for (const plugin of Object.values(target?.plugins ?? {})) {
      for (const id of plugin.from ?? []) {
        if (id !== rootPluginId) {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}

/**
 * Directories under the default `plugins/` root that legacy discovery reads
 * as source plugins (a component directory, no `plugin.pluginpack.json`) but
 * that `listSourcePaths` does not already protect, because no target reads
 * them through `from`. Such a directory is either authored source nobody
 * references yet or a generated package (`plugins/acme/skills/` under
 * `outDir: "."`); the delete guard tells them apart by provenance. Empty when
 * the config sets `source.plugins`, which is then protected whole.
 */
export async function listUnreferencedSourcePluginDirs(
  project: ResolvedProjectConfig,
): Promise<string[]> {
  if (project.config.source?.plugins) {
    return [];
  }
  const defaultRoot = path.resolve(project.rootDir, "plugins");
  const legacyIds = referencedLegacyIds(project);
  const dirs: string[] = [];
  for (const dir of await listSourcePluginDirs(defaultRoot)) {
    if (
      !legacyIds.has(path.basename(dir)) &&
      !(await exists(path.join(dir, "plugin.pluginpack.json")))
    ) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Rejects a config whose target outDir physically resolves inside an authored
 * path: building there overwrites source, and prune/clean would then have to
 * delete it. Compares physical paths, so an outDir that only reaches source
 * through a symlink, or through a case variant the filesystem forgives, is
 * caught too. An outDir that is merely a symlink to somewhere safe still works.
 *
 * Checks every configured outDir, or only `outDirs` when given (the absolute
 * outDirs a `--out-dir` override produced).
 */
export async function assertOutDirsOutsideSource(
  project: ResolvedProjectConfig,
  outDirs?: Array<{ target: string; outDir: string }>,
): Promise<void> {
  const sources = await listSourcePaths(project);
  const sourceKeys = await Promise.all(
    sources.map(async (source) => ({
      ...source,
      key: await physicalKey(source.path),
    })),
  );
  const checked =
    outDirs ??
    Object.entries(project.config.targets).flatMap(([target, config]) =>
      config
        ? [{ target, outDir: path.resolve(project.rootDir, config.outDir) }]
        : [],
    );
  const problems: string[] = [];
  for (const { target: name, outDir } of checked) {
    const outKey = await physicalKey(outDir);
    for (const source of sourceKeys) {
      if (isInside(source.key, outKey)) {
        problems.push(
          `  targets.${name}.outDir (${outDir}) resolves inside ${source.path} (${source.field})`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid pluginpack config in ${project.configPath}: a target writes its output inside an authored source path:\n${problems.join("\n")}\n` +
        `A build there overwrites source files, and prune or clean would delete them. ` +
        `Point each outDir at a directory outside every source, overrides, partials, repositoryFiles and rootFiles path.`,
    );
  }
}

/**
 * Directories directly under `sourceRoot` that carry a
 * `plugin.pluginpack.json`. Generated output never contains that file, so
 * these are authored source whether or not a target reads them.
 */
async function listManifestPluginDirs(sourceRoot: string): Promise<string[]> {
  if (!(await exists(sourceRoot))) {
    return [];
  }
  const dirs: string[] = [];
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const dir = path.join(sourceRoot, entry.name);
    if (
      entry.isDirectory() &&
      (await exists(path.join(dir, "plugin.pluginpack.json")))
    ) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/** Directories under `sourceRoot` that legacy discovery reads as source plugins. */
async function listSourcePluginDirs(sourceRoot: string): Promise<string[]> {
  if (!(await exists(sourceRoot))) {
    return [];
  }
  const dirs: string[] = [];
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const dir = path.join(sourceRoot, entry.name);
    if (await isSourcePluginDir(dir)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * A source plugin dir declares a manifest or has at least one component dir.
 * This keeps generated target output (e.g. plugins/cursor/ in a single-repo
 * layout) from being misread as source on rebuild.
 */
async function isSourcePluginDir(dir: string): Promise<boolean> {
  if (await exists(path.join(dir, "plugin.pluginpack.json"))) {
    return true;
  }
  for (const component of componentDirs) {
    if (await exists(path.join(dir, component))) {
      return true;
    }
  }
  return false;
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
      "manifest",
    ) as SourcePluginManifest;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function parseWithContext<S extends z.ZodType>(
  schema: S,
  value: unknown,
  context: string,
  kind: "config" | "manifest" = "config",
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    warnOnStrippedKeys(value, parsed.data, context, kind);
    return parsed.data;
  }
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid pluginpack ${kind} in ${context}: ${details}`);
}
