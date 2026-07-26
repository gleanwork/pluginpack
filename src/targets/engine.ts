import { promises as fs } from "node:fs";
import path from "node:path";
import { collectPluginFiles, resolveMcpServers } from "../render.js";
import { isSafeRelativePath, json, toPosix } from "../fs.js";
import { deepMerge, stripUndefined } from "./shared.js";
import { applyUpdateCheck, pluginAllowsUpdateCheck } from "../update-check.js";
import type { UpdateCheckFormat } from "../update-check.js";
import type {
  Artifact,
  EmittedPluginConfig,
  FileValue,
  ResolvedProject,
  TargetConfig,
  TargetName,
  ValidationIssue,
} from "../types.js";
import type { PluginTargetDefinition } from "./types.js";

/**
 * Resolves a plugin's component set from its own `components` override, or
 * the target definition's default — each target owns its own defaults via
 * `PluginTargetDefinition.defaultComponents` rather than a shared table.
 */
function resolveComponents(
  definition: PluginTargetDefinition,
  pluginConfig: { components?: string[] },
): Set<string> {
  return new Set(pluginConfig.components ?? definition.defaultComponents);
}

/**
 * Resolves a target's `updateCheck` config into the options `applyUpdateCheck`
 * needs, failing fast when no repository URL can be determined. Only
 * claude/cursor ever have `updateCheck` set (enforced at config-schema
 * validation), so `target` narrows safely once this returns non-undefined.
 */
function resolveUpdateCheck(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  version: string,
):
  | {
      format: UpdateCheckFormat;
      repository: string;
      version: (pluginConfig: EmittedPluginConfig) => string;
    }
  | undefined {
  if (!targetConfig.updateCheck) {
    return undefined;
  }
  const repository =
    targetConfig.updateCheck.repository ?? project.config.metadata?.repository;
  if (!repository) {
    throw new Error(
      `Target "${target}" updateCheck requires a repository ` +
        `(set targets.${target}.updateCheck.repository or metadata.repository).`,
    );
  }
  return {
    format: target as UpdateCheckFormat,
    repository,
    version: (pluginConfig) => pluginConfig.version ?? version,
  };
}

/**
 * Emits one target's output using its `PluginTargetDefinition` — the shared
 * engine every migrated target runs through, in place of a bespoke
 * `emitXxx` function per target.
 */
export async function emitFromDefinition(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
  definition: PluginTargetDefinition,
): Promise<Artifact> {
  const version = targetConfig.version ?? project.config.version;
  const files = new Map<string, FileValue>();
  const entries: Record<string, unknown>[] = [];
  const updateCheck = resolveUpdateCheck(
    project,
    target,
    targetConfig,
    version,
  );

  for (const [pluginName, pluginConfig] of Object.entries(
    targetConfig.plugins,
  )) {
    const pluginPath = definition.resolvePluginPath(
      pluginName,
      pluginConfig,
      targetConfig,
    );
    const pluginFiles = await collectPluginFiles(
      project,
      target,
      pluginConfig.from,
      resolveComponents(definition, pluginConfig),
    );
    // Applied before componentDirs is derived, so an injected hooks/ dir
    // registers as a present component (e.g. for a manifest pointer) even if
    // this plugin's own `components` override excludes hooks.
    if (updateCheck && pluginAllowsUpdateCheck(pluginConfig)) {
      applyUpdateCheck(pluginFiles, target, {
        format: updateCheck.format,
        pluginName,
        version: updateCheck.version(pluginConfig),
        repository: updateCheck.repository,
      });
    }
    const componentDirs = new Set(
      [...pluginFiles.keys()].map((file) => file.split("/")[0]),
    );

    // Hooks are relocated to definition.hooksPath() rather than copied
    // verbatim from the source's conventional hooks/hooks.json, so a target
    // whose real hooks convention differs (e.g. a root-level file, not a
    // directory) gets it right by construction. A same-path target is a
    // same-path no-op.
    const sourceHooksFile = pluginFiles.get("hooks/hooks.json");
    if (sourceHooksFile !== undefined) {
      pluginFiles.delete("hooks/hooks.json");
    }
    for (const [relativePath, value] of pluginFiles) {
      files.set(toPosix(path.join(pluginPath, relativePath)), value);
    }
    if (sourceHooksFile !== undefined) {
      files.set(toPosix(definition.hooksPath(pluginPath)), sourceHooksFile);
    }

    const mcpServers = await resolveMcpServers(project, pluginConfig.from);
    const mcpConfigPath = definition.mcpConfigPath(pluginPath);
    if (mcpServers && mcpConfigPath) {
      files.set(toPosix(mcpConfigPath), json({ mcpServers }));
    }

    const metadata = emittedPluginMetadata(project, pluginConfig);
    const manifest = definition.buildPluginManifest({
      metadata,
      version,
      pluginName,
      pluginConfig,
      componentDirs,
      mcpServers,
    });
    const manifestContent = json(
      stripUndefined(deepMerge(manifest, pluginConfig.manifest ?? {})),
    );
    for (const manifestPath of definition.manifestPaths(
      pluginPath,
      targetConfig,
    )) {
      files.set(toPosix(manifestPath), manifestContent);
    }

    const entry = definition.buildMarketplaceEntry({
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
      // Deep-merge the config's per-plugin entry passthrough, so a target
      // can carry author-supplied fields it can't derive on its own.
      entries.push(stripUndefined(deepMerge(entry, pluginConfig.entry ?? {})));
    }
  }

  const marketplace = stripUndefined(
    deepMerge(
      definition.buildMarketplaceManifest({
        project,
        targetConfig,
        version,
        plugins: entries,
      }),
      targetConfig.manifest ?? {},
    ),
  );
  const marketplaceContent = json(marketplace);
  for (const marketplacePath of definition.marketplacePaths(targetConfig)) {
    files.set(toPosix(marketplacePath), marketplaceContent);
  }

  return artifact(target, outDir, files);
}

/** Validates one target's output using its `PluginTargetDefinition`. */
export async function validateFromDefinition(
  root: string,
  issues: ValidationIssue[],
  definition: PluginTargetDefinition,
): Promise<void> {
  await definition.validateOutput(root, issues);
}

function emittedPluginMetadata(
  project: ResolvedProject,
  pluginConfig: EmittedPluginConfig,
) {
  const sourceMetadata =
    pluginConfig.from.length === 1
      ? project.plugins.get(pluginConfig.from[0])?.manifest
      : undefined;
  return stripUndefined({
    ...project.config.metadata,
    ...sourceMetadata,
  });
}

function artifact(
  target: TargetName,
  outDir: string,
  files: Map<string, FileValue>,
): Artifact {
  const managedPaths = [...files.keys()].sort();
  return {
    target,
    outDir,
    files: new Map([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
    managedPaths,
  };
}

/**
 * Emits per-target repo-root files (e.g. a README authored once in the
 * source repo) into the artifact so they are managed, pruned, and synced
 * like every other generated file — rather than hand-maintained in each
 * output repo.
 */
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
