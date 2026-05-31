import { promises as fs } from "node:fs";
import path from "node:path";
import { componentDirs, staticFiles } from "./components.js";
import { exists, toPosix, walkFiles } from "./fs.js";
import type {
  FileValue,
  SourcePlugin,
  SourceProvider,
  TargetName,
} from "./types.js";

// Filesystem-backed source: reads a discovered plugin's component and static
// files (with target overrides) and its MCP servers from disk. The discovered
// plugins map is passed in; an API-backed provider would implement the same
// SourceProvider interface against the Skills API instead.
export function createFilesystemSourceProvider(
  plugins: Map<string, SourcePlugin>,
): SourceProvider {
  return {
    listPlugins: () => Promise.resolve(plugins),
    readPluginFiles: (pluginId, target) =>
      readPluginFiles(pluginOrThrow(plugins, pluginId), target),
    readMcpServers: (pluginId) =>
      readMcpServers(pluginOrThrow(plugins, pluginId)),
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
// The file takes precedence when both are present.
async function readMcpServers(
  plugin: SourcePlugin,
): Promise<Record<string, unknown> | undefined> {
  const filePath = path.join(plugin.dir, ".mcp.json");
  if (await exists(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${filePath}: ${(error as Error).message}`,
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
