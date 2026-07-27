import { promises as fs } from "node:fs";
import path from "node:path";
import { componentDirs, staticFiles } from "./components.js";
import { exists, isSafeRelativePath, toPosix, walkFiles } from "./fs.js";
import type {
  FileValue,
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
  const declaredFiles = plugin.manifest.files;
  if (declaredFiles) {
    for (const [dest, source] of Object.entries(declaredFiles)) {
      const destPath = toPosix(dest);
      if (!isSafeRelativePath(destPath)) {
        throw new Error(
          `Source plugin "${plugin.id}" files destination "${dest}" must be a safe relative path.`,
        );
      }
      if (files.has(destPath)) {
        throw new Error(
          `Source plugin "${plugin.id}" files destination "${dest}" collides with another emitted file.`,
        );
      }
      const resolved = await resolveTargetOverride(
        plugin.dir,
        path.resolve(plugin.dir, source),
        target,
      );
      if (!(await exists(resolved))) {
        throw new Error(
          `Source plugin "${plugin.id}" files source "${source}" could not be read.`,
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

// A source plugin declares MCP servers via a .mcp.json file (standard
// { mcpServers: {...} } shape) or an mcpServers key in plugin.pluginpack.json.
// The file takes precedence when both are present. The file form supports
// per-target overrides: targets/<host>/.mcp.json wins for that host. The
// manifest form has no per-file override; authors who need per-target MCP
// config should use the .mcp.json file form.
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
