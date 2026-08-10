import { promises as fs } from "node:fs";
import path from "node:path";
import { componentDirs, staticFiles } from "./components.js";
import { exists, isSafeRelativePath, toPosix, walkFiles } from "./fs.js";
import { mcpManifestSchema, sourcePluginManifestSchema } from "./schema.js";
import type {
  AuthoredPlugin,
  FileValue,
  McpManifest,
  SourcePlugin,
  SourceProvider,
  TargetName,
} from "./types.js";

/**
 * Filesystem-backed `SourceProvider`: reads a discovered plugin's component
 * and static files (with target overrides) and its MCP servers from disk.
 * An API-backed provider would implement the same interface against a
 * remote source instead.
 */
export function createFilesystemSourceProvider(
  plugins: Map<string, SourcePlugin>,
): SourceProvider {
  return {
    readPluginFiles: (pluginId, target) =>
      readPluginFiles(pluginOrThrow(plugins, pluginId), target),
    readMcpServers: (pluginId, target) =>
      readMcpServers(pluginOrThrow(plugins, pluginId), target),
  };
}

/**
 * Reads the 0.11 authored-plugin shape: one direct shared source, followed by
 * one target overlay that may add or replace selected content.
 */
export async function readAuthoredPlugin(
  rootDir: string,
  sourcePath: string,
  overlayPath: string | undefined,
  selected: Set<string>,
): Promise<AuthoredPlugin> {
  const sourceDir = path.resolve(rootDir, sourcePath);
  if (!(await exists(sourceDir))) {
    throw new Error(`Authored plugin source is missing: ${sourcePath}`);
  }
  const overlayDir = overlayPath
    ? path.resolve(rootDir, overlayPath)
    : undefined;
  if (overlayDir && !(await exists(overlayDir))) {
    throw new Error(`Authored plugin overlay is missing: ${overlayPath}`);
  }

  const manifest = await readOptionalJson(
    path.join(sourceDir, "plugin.pluginpack.json"),
    sourcePluginManifestSchema,
    {},
  );
  const files = new Map<string, FileValue>();

  for (const dirName of componentDirs) {
    if (!selected.has(dirName)) {
      continue;
    }
    await addTree(files, path.join(sourceDir, dirName), dirName, false);
    if (overlayDir) {
      await addTree(files, path.join(overlayDir, dirName), dirName, true);
    }
  }

  if (selected.has("static")) {
    for (const fileName of staticFiles) {
      const base = path.join(sourceDir, fileName);
      if (await exists(base)) {
        files.set(fileName, await fs.readFile(base));
      }
      if (overlayDir) {
        const overlay = path.join(overlayDir, fileName);
        if (await exists(overlay)) {
          files.set(fileName, await fs.readFile(overlay));
        }
      }
    }
  }

  await addDeclaredFiles(files, sourceDir, manifest.additionalFiles);

  let mcpServers: Record<string, unknown> | undefined;
  if (selected.has("mcp")) {
    const mcpDir = path.join(sourceDir, "mcp");
    const overlayMcpDir = overlayDir ? path.join(overlayDir, "mcp") : undefined;
    const configPath = await lastExisting([
      path.join(mcpDir, "config.json"),
      ...(overlayMcpDir ? [path.join(overlayMcpDir, "config.json")] : []),
    ]);
    if (configPath) {
      const config = await readJsonObject(configPath);
      if (isObject(config.mcpServers)) {
        mcpServers = config.mcpServers;
      }
    }

    const mcpManifestPath = await lastExisting([
      path.join(mcpDir, "pluginpack.json"),
      ...(overlayMcpDir ? [path.join(overlayMcpDir, "pluginpack.json")] : []),
    ]);
    if (mcpManifestPath) {
      const mcpManifest = await readRequiredJson(
        mcpManifestPath,
        mcpManifestSchema,
      );
      await addMcpFiles(files, mcpDir, overlayMcpDir, mcpManifest.files);
    }
  }

  return { files, manifest, mcpServers };
}

async function addTree(
  files: Map<string, FileValue>,
  dir: string,
  prefix: string,
  replace: boolean,
): Promise<void> {
  if (!(await exists(dir))) {
    return;
  }
  for (const file of await walkFiles(dir)) {
    const relative = toPosix(path.join(prefix, path.relative(dir, file)));
    if (!replace && files.has(relative)) {
      throw new Error(`Duplicate authored plugin file "${relative}".`);
    }
    files.set(relative, await fs.readFile(file));
  }
}

async function addDeclaredFiles(
  files: Map<string, FileValue>,
  sourceDir: string,
  declared: Record<string, string> | undefined,
): Promise<void> {
  for (const [dest, source] of Object.entries(declared ?? {})) {
    if (files.has(dest)) {
      throw new Error(
        `Authored plugin additionalFiles destination "${dest}" collides with another emitted file.`,
      );
    }
    const sourceFile = path.resolve(sourceDir, source);
    if (!(await exists(sourceFile))) {
      throw new Error(
        `Authored plugin additionalFiles source "${source}" could not be read.`,
      );
    }
    files.set(toPosix(dest), await fs.readFile(sourceFile));
  }
}

async function addMcpFiles(
  files: Map<string, FileValue>,
  mcpDir: string,
  overlayMcpDir: string | undefined,
  declared: McpManifest["files"],
): Promise<void> {
  for (const [dest, source] of Object.entries(declared ?? {})) {
    const sourceFile = await lastExisting([
      path.resolve(mcpDir, source),
      ...(overlayMcpDir ? [path.resolve(overlayMcpDir, source)] : []),
    ]);
    if (!sourceFile) {
      throw new Error(`MCP shipping file "${source}" could not be read.`);
    }
    files.set(toPosix(dest), await fs.readFile(sourceFile));
  }
}

async function lastExisting(candidates: string[]): Promise<string | undefined> {
  let result: string | undefined;
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      result = candidate;
    }
  }
  return result;
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!isObject(parsed)) {
    throw new Error(`Invalid JSON object in ${file}.`);
  }
  return parsed;
}

async function readRequiredJson<T>(
  file: string,
  schema: {
    safeParse(value: unknown): {
      success: boolean;
      data?: T;
      error?: { issues: { path: PropertyKey[]; message: string }[] };
    };
  },
): Promise<T> {
  const parsed = await readJsonObject(file);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error?.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid pluginpack JSON in ${file}: ${details}`);
  }
  return result.data as T;
}

async function readOptionalJson<T>(
  file: string,
  schema: Parameters<typeof readRequiredJson<T>>[1],
  fallback: T,
): Promise<T> {
  return (await exists(file)) ? readRequiredJson(file, schema) : fallback;
}

function pluginOrThrow(
  plugins: Map<string, SourcePlugin>,
  pluginId: string,
): SourcePlugin {
  const plugin = plugins.get(pluginId);
  if (!plugin) {
    throw new Error(`Unknown source plugin "${pluginId}".`);
  }
  return plugin;
}

async function readPluginFiles(
  plugin: SourcePlugin,
  target: TargetName,
): Promise<Map<string, FileValue>> {
  const files = new Map<string, FileValue>();
  for (const dirName of componentDirs) {
    const dir =
      plugin.componentRoots?.[dirName] ?? path.join(plugin.dir, dirName);
    if (!(await exists(dir))) {
      continue;
    }
    for (const file of await walkFiles(dir)) {
      if (isTargetOverrideFile(file)) {
        continue;
      }
      const relativeToPlugin = toPosix(
        plugin.componentRoots?.[dirName]
          ? path.join(dirName, path.relative(dir, file))
          : path.relative(plugin.dir, file),
      );
      const resolved = await resolveTargetOverride(plugin.dir, file, target);
      files.set(relativeToPlugin, await fs.readFile(resolved));
    }
  }

  if (plugin.includeStaticFiles !== false) {
    for (const fileName of staticFiles) {
      const file = path.join(plugin.dir, fileName);
      if (!(await exists(file))) {
        continue;
      }
      const resolved = await resolveTargetOverride(plugin.dir, file, target);
      files.set(fileName, await fs.readFile(resolved));
    }
  }

  // Arbitrary files the source plugin declares in plugin.pluginpack.json
  // (e.g. a bundled server, launcher, or a package.json). Emitted verbatim at
  // the plugin root, with target overrides on the source path.
  const additionalFiles = plugin.manifest.additionalFiles;
  if (additionalFiles) {
    for (const [dest, source] of Object.entries(additionalFiles)) {
      const destPath = toPosix(dest);
      if (!isSafeRelativePath(destPath)) {
        throw new Error(
          `Source plugin "${plugin.id}" additionalFiles destination "${dest}" must be a safe relative path.`,
        );
      }
      if (files.has(destPath)) {
        throw new Error(
          `Source plugin "${plugin.id}" additionalFiles destination "${dest}" collides with another emitted file.`,
        );
      }
      const resolved = await resolveTargetOverride(
        plugin.dir,
        path.resolve(plugin.dir, source),
        target,
      );
      if (!(await exists(resolved))) {
        throw new Error(
          `Source plugin "${plugin.id}" additionalFiles source "${source}" could not be read.`,
        );
      }
      files.set(destPath, await fs.readFile(resolved));
    }
  }
  return files;
}

function isTargetOverrideFile(filePath: string): boolean {
  return filePath.split(path.sep).includes("targets");
}

async function resolveTargetOverride(
  pluginDir: string,
  file: string,
  target: TargetName,
): Promise<string> {
  const basenameOverride = path.join(
    path.dirname(file),
    "targets",
    target,
    path.basename(file),
  );
  if (await exists(basenameOverride)) {
    return basenameOverride;
  }
  const relative = path.relative(pluginDir, file);
  const rootOverride = path.join(pluginDir, "targets", target, relative);
  if (await exists(rootOverride)) {
    return rootOverride;
  }
  return file;
}

/**
 * A source plugin declares MCP servers via a .mcp.json file (standard
 * { mcpServers: {...} } shape) or an mcpServers key in plugin.pluginpack.json.
 * The file takes precedence when both are present. The file form supports
 * per-target overrides: targets/<host>/.mcp.json wins for that host. The
 * manifest form has no per-file override; authors who need per-target MCP
 * config should use the .mcp.json file form.
 */
async function readMcpServers(
  plugin: SourcePlugin,
  target: TargetName,
): Promise<Record<string, unknown> | undefined> {
  const resolved = await resolveTargetOverride(
    plugin.dir,
    path.join(plugin.dir, ".mcp.json"),
    target,
  );
  if (await exists(resolved)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(resolved, "utf8"));
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${resolved}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    return isObject(servers) ? servers : undefined;
  }
  return isObject(plugin.manifest.mcpServers)
    ? plugin.manifest.mcpServers
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
