import { promises as fs } from "node:fs";
import path from "node:path";
import { componentDirs, staticFiles } from "./components.js";
import { exists } from "./config.js";
import { toPosix, walkFiles } from "./fs.js";
import type {
  FileValue,
  ResolvedProject,
  SourcePlugin,
  TargetName,
} from "./types.js";

export async function resolveMcpServers(
  project: ResolvedProject,
  sourceIds: string[],
): Promise<Record<string, unknown> | undefined> {
  const merged: Record<string, unknown> = {};
  let found = false;
  for (const sourceId of sourceIds) {
    const plugin = project.plugins.get(sourceId);
    if (!plugin) {
      continue;
    }
    const servers = await readPluginMcpServers(plugin);
    if (!servers) {
      continue;
    }
    found = true;
    for (const [name, config] of Object.entries(servers)) {
      if (name in merged) {
        throw new Error(
          `Duplicate MCP server "${name}" while merging source plugin "${sourceId}".`,
        );
      }
      merged[name] = config;
    }
  }
  return found ? merged : undefined;
}

// A source plugin declares MCP servers via a .mcp.json file (standard
// { mcpServers: {...} } shape) or an mcpServers key in plugin.pluginpack.json.
// The file takes precedence when both are present.
async function readPluginMcpServers(
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

export async function collectPluginFiles(
  project: ResolvedProject,
  target: TargetName,
  sourceIds: string[],
): Promise<Map<string, FileValue>> {
  const files = new Map<string, FileValue>();
  for (const sourceId of sourceIds) {
    const plugin = project.plugins.get(sourceId);
    if (!plugin) {
      throw new Error(
        `Target "${target}" references unknown source plugin "${sourceId}".`,
      );
    }
    await collectOnePlugin(files, plugin, target);
  }
  return files;
}

async function collectOnePlugin(
  files: Map<string, FileValue>,
  plugin: SourcePlugin,
  target: TargetName,
): Promise<void> {
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
      const value = await fs.readFile(resolved);
      setFile(files, relativeToPlugin, value, plugin.id);
    }
  }

  if (plugin.includeStaticFiles !== false) {
    for (const fileName of staticFiles) {
      const file = path.join(plugin.dir, fileName);
      if (!(await exists(file))) {
        continue;
      }
      const resolved = await resolveTargetOverride(plugin.dir, file, target);
      setFile(files, fileName, await fs.readFile(resolved), plugin.id);
    }
  }
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

function setFile(
  files: Map<string, FileValue>,
  relativePath: string,
  value: FileValue,
  sourceId: string,
): void {
  if (files.has(relativePath)) {
    throw new Error(
      `Duplicate emitted file "${relativePath}" while merging source plugin "${sourceId}". Add a target override or change the target plugin mapping.`,
    );
  }
  files.set(relativePath, value);
}
