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
