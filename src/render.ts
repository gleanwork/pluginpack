import { isComponentPath } from "./components.js";
import type { FileValue, ResolvedProject, TargetName } from "./types.js";

// Merge the files of one or more source plugins into a single emitted-plugin
// file map. File acquisition is delegated to project.source; the merge +
// duplicate-path guard is pluginpack logic that holds regardless of source.
export async function collectPluginFiles(
  project: ResolvedProject,
  target: TargetName,
  sourceIds: string[],
  components?: Set<string>,
): Promise<Map<string, FileValue>> {
  const files = new Map<string, FileValue>();
  for (const sourceId of sourceIds) {
    if (!project.plugins.has(sourceId)) {
      throw new Error(
        `Target "${target}" references unknown source plugin "${sourceId}".`,
      );
    }
    const pluginFiles = await project.source.readPluginFiles(sourceId, target);
    for (const [relativePath, value] of pluginFiles) {
      if (!shouldEmitFile(relativePath, components)) {
        continue;
      }
      setFile(files, relativePath, value, sourceId);
    }
  }
  return files;
}

// Merge the MCP servers of one or more source plugins; a server name present in
// two merged plugins is an error.
export async function resolveMcpServers(
  project: ResolvedProject,
  sourceIds: string[],
): Promise<Record<string, unknown> | undefined> {
  const merged: Record<string, unknown> = {};
  let found = false;
  for (const sourceId of sourceIds) {
    if (!project.plugins.has(sourceId)) {
      continue;
    }
    const servers = await project.source.readMcpServers(sourceId);
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

function shouldEmitFile(
  relativePath: string,
  components: Set<string> | undefined,
): boolean {
  if (!components || !isComponentPath(relativePath)) {
    return true;
  }
  return components.has(relativePath.split("/")[0]);
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
