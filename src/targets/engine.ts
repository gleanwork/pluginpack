import { promises as fs } from "node:fs";
import path from "node:path";
import { collectPluginFiles, resolveMcpServers } from "../render.js";
import { readAuthoredPlugin } from "../source.js";
import { isSafeRelativePath, json, toPosix } from "../fs.js";
import { pluginArgFiles, pluginCommandFiles, renderMcpConfig } from "../mcp.js";
import { resolvePartials } from "../partials.js";
import { validateNoSurvivingPartialTags } from "./validation-shared.js";
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

function resolveContentKinds(
  definition: PluginTargetDefinition,
  pluginConfig: EmittedPluginConfig,
): Set<string> {
  const selected = new Set(
    pluginConfig.include ??
      pluginConfig.components ?? [
        ...definition.defaultComponents,
        "static",
        "mcp",
      ],
  );
  for (const excluded of pluginConfig.exclude ?? []) {
    selected.delete(excluded);
  }
  return selected;
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
  targetDefinition: PluginTargetDefinition,
): Promise<Artifact> {
  const definition =
    targetDefinition.forConfig?.(targetConfig) ?? targetDefinition;
  const version = targetConfig.version ?? project.config.version;
  const files = new Map<string, FileValue>();
  const entries: Record<string, unknown>[] = [];
  const clientMarketplaces =
    definition.clientMarketplaces?.(targetConfig) ?? [];
  const clientEntries = new Map<string, Record<string, unknown>[]>(
    clientMarketplaces.map((marketplace) => [marketplace.client, []]),
  );
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
    let pluginFiles: Map<string, FileValue>;
    let mcpServers: Record<string, unknown> | undefined;
    let sourceMetadata: Record<string, unknown> | undefined;
    if (pluginConfig.source) {
      const authored = await readAuthoredPlugin(
        project.rootDir,
        pluginConfig.source,
        pluginConfig.overrides,
        resolveContentKinds(definition, pluginConfig),
      );
      pluginFiles = new Map(
        [...authored.files].map(([relativePath, value]) => [
          relativePath,
          resolvePartials(relativePath, value, project.partials),
        ]),
      );
      mcpServers = authored.mcpServers;
      sourceMetadata = authored.manifest;
    } else {
      const sourceIds = pluginConfig.from ?? [];
      pluginFiles = await collectPluginFiles(
        project,
        target,
        sourceIds,
        resolveComponents(definition, pluginConfig),
      );
      mcpServers = await resolveMcpServers(project, sourceIds, target);
      sourceMetadata =
        sourceIds.length === 1
          ? project.plugins.get(sourceIds[0])?.manifest
          : undefined;
    }
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
    // same-path no-op. A target that places files itself places hooks too,
    // so it can move them into a client's directory or reject them.
    const sourceHooksFile = definition.placeFile
      ? undefined
      : pluginFiles.get("hooks/hooks.json");
    if (sourceHooksFile !== undefined) {
      pluginFiles.delete("hooks/hooks.json");
    }
    // Placement can map two source files to one path (e.g. agents/x.md and
    // agents/x.agent.md for Copilot); fail instead of keeping either.
    const placedFrom = new Map<string, string>();
    for (const [relativePath, value] of pluginFiles) {
      for (const placed of definition.placeFile?.(relativePath, pluginName) ?? [
        relativePath,
      ]) {
        // Key on the joined output path, so "./a" and "a" collide.
        const outputPath = toPosix(path.join(pluginPath, placed));
        const earlier = placedFrom.get(outputPath);
        if (earlier !== undefined && earlier !== relativePath) {
          throw new Error(
            `Target "${target}" plugin "${pluginName}": "${earlier}" and "${relativePath}" both write "${placed}". Rename or remove one of them.`,
          );
        }
        placedFrom.set(outputPath, relativePath);
        files.set(outputPath, value);
      }
    }
    if (sourceHooksFile !== undefined) {
      files.set(toPosix(definition.hooksPath(pluginPath)), sourceHooksFile);
    }

    const mcpConfigPath = definition.mcpConfigPath(pluginPath);
    if (mcpServers && mcpConfigPath) {
      files.set(
        toPosix(mcpConfigPath),
        json(
          renderMcpConfig(
            mcpServers,
            definition.mcpDialect,
            `Target "${target}" plugin "${pluginName}"`,
          ),
        ),
      );
      // A warning, not an error: the file may be added to the output after
      // the build (e.g. a compiled binary). `validate` checks the result.
      for (const { server, command, file } of pluginCommandFiles(mcpServers)) {
        if (!files.has(toPosix(path.join(pluginPath, file)))) {
          console.warn(
            `Target "${target}" plugin "${pluginName}": MCP server "${server}" "command" is ${JSON.stringify(command)}, but the plugin does not ship "${file}". Add the file to the plugin source (an MCP server file goes in mcp/pluginpack.json "files"), or fix the command.`,
          );
        }
      }
      // An argument may name a directory the plugin ships, too.
      for (const { server, field, value, file } of pluginArgFiles(mcpServers)) {
        const shipped = toPosix(path.join(pluginPath, file));
        if (
          !files.has(shipped) &&
          ![...files.keys()].some((key) => key.startsWith(`${shipped}/`))
        ) {
          console.warn(
            `Target "${target}" plugin "${pluginName}": MCP server "${server}" "${field}" is ${JSON.stringify(value)}, but the plugin does not ship "${file}". Add the file to the plugin source (an MCP server file goes in mcp/pluginpack.json "files"), or fix the argument.`,
          );
        }
      }
    }

    const metadata = emittedPluginMetadata(
      project,
      pluginConfig,
      sourceMetadata,
    );
    const manifest = definition.buildPluginManifest({
      metadata,
      version,
      pluginName,
      pluginConfig,
      componentDirs,
      mcpServers,
    });
    const merged = stripUndefined(
      deepMerge(manifest, pluginConfig.manifest ?? {}),
    );
    const manifestContent = json(
      definition.finalizeManifest?.(merged, pluginName) ?? merged,
    );
    for (const manifestPath of definition.manifestPaths(
      pluginPath,
      targetConfig,
    )) {
      files.set(toPosix(manifestPath), manifestContent);
    }

    const entryContext = {
      pluginName,
      pluginPath,
      pluginConfig,
      metadata,
      componentDirs,
      mcpServers,
      pluginFiles,
      manifest,
    };
    const entry = definition.buildMarketplaceEntry(entryContext);
    if (entry) {
      // Deep-merge the config's per-plugin entry passthrough, so a target
      // can carry author-supplied fields it can't derive on its own.
      entries.push(stripUndefined(deepMerge(entry, pluginConfig.entry ?? {})));
    }
    for (const marketplace of clientMarketplaces) {
      const clientEntry = (
        pluginConfig.clients as
          Record<string, { entry?: Record<string, unknown> }> | undefined
      )?.[marketplace.client]?.entry;
      clientEntries
        .get(marketplace.client)
        ?.push(
          stripUndefined(
            deepMerge(marketplace.buildEntry(entryContext), clientEntry ?? {}),
          ),
        );
    }
  }

  for (const marketplace of clientMarketplaces) {
    const clientManifest = (
      targetConfig.clients as
        Record<string, { manifest?: Record<string, unknown> }> | undefined
    )?.[marketplace.client]?.manifest;
    files.set(
      toPosix(marketplace.path),
      json(
        stripUndefined(
          deepMerge(
            marketplace.buildManifest({
              project,
              targetConfig,
              version,
              plugins: clientEntries.get(marketplace.client) ?? [],
            }),
            clientManifest ?? {},
          ),
        ),
      ),
    );
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

/**
 * Validates one target's output using its `PluginTargetDefinition`, plus the
 * checks that hold for every target regardless of its layout.
 * `managedPaths` is the managed manifest's file list, or `undefined` when
 * the output has no managed manifest for this target.
 */
export async function validateFromDefinition(
  root: string,
  issues: ValidationIssue[],
  definition: PluginTargetDefinition,
  managedPaths?: string[],
): Promise<void> {
  const ownedPaths = await definition.validateOutput(root, issues, {
    hasManagedState: managedPaths !== undefined,
  });
  await validateNoSurvivingPartialTags(
    root,
    [...ownedPaths, ...(managedPaths ?? [])],
    issues,
  );
}

function emittedPluginMetadata(
  project: ResolvedProject,
  pluginConfig: EmittedPluginConfig,
  sourceMetadata?: Record<string, unknown>,
) {
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
  const repositoryFiles = targetConfig.repositoryFiles;
  if ((!rootFiles || Object.keys(rootFiles).length === 0) && !repositoryFiles) {
    return result;
  }
  const files = new Map(result.files);
  for (const [dest, source] of Object.entries(rootFiles ?? {})) {
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
    files.set(destPath, resolvePartials(destPath, contents, project.partials));
  }
  if (repositoryFiles) {
    const repositoryDir = path.resolve(project.rootDir, repositoryFiles);
    let repositoryEntries: string[];
    try {
      repositoryEntries = await walkRepositoryFiles(repositoryDir);
    } catch {
      throw new Error(
        `Target "${result.target}" repositoryFiles directory "${repositoryFiles}" could not be read.`,
      );
    }
    for (const source of repositoryEntries) {
      const destPath = toPosix(path.relative(repositoryDir, source));
      if (files.has(destPath)) {
        throw new Error(
          `Target "${result.target}" repositoryFiles path "${destPath}" collides with a generated file.`,
        );
      }
      const contents = await fs.readFile(source);
      files.set(
        destPath,
        resolvePartials(destPath, contents, project.partials),
      );
    }
  }
  return artifact(result.target, result.outDir, files);
}

async function walkRepositoryFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRepositoryFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files.sort();
}
