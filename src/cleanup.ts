import path from "node:path";
import { describeAlias, planBuild } from "./build.js";
import { targetNames } from "./adapters.js";
import { loadProjectConfig } from "./config.js";
import { withPathCache } from "./fs.js";
import {
  buildDeleteGuard,
  cleanResult,
  executeClean,
  executePrune,
  managedPathKey,
  planClean,
  normalizeManagedPath,
  pruneResult,
  readManagedManifest,
  type CleanPlan,
} from "./managed.js";
import type {
  CleanupResult,
  ResolvedProjectConfig,
  TargetName,
} from "./types.js";

/**
 * Deletes managed files no longer produced by the current build, without
 * rewriting current output. Runs the same plan, and so the same checks, as
 * `build`: the delete guard, cross-target ownership of stale paths, and every
 * collision check. `--dry-run` runs them too and only skips the deletes.
 */
export async function prune(
  options: {
    cwd?: string;
    configPath?: string;
    target?: TargetName;
    dryRun?: boolean;
    force?: boolean;
  } = {},
): Promise<CleanupResult[]> {
  const { prunes } = await planBuild(
    {
      cwd: options.cwd,
      configPath: options.configPath,
      target: options.target,
      dryRun: options.dryRun,
    },
    options.force,
  );
  if (!options.dryRun) {
    for (const plan of prunes) {
      await executePrune(plan);
    }
  }
  return prunes.map(pruneResult);
}

/** Deletes every managed file for the given target(s), tearing the generated output down entirely. */
export async function clean(
  options: {
    cwd?: string;
    configPath?: string;
    target?: TargetName;
    dryRun?: boolean;
    force?: boolean;
  } = {},
): Promise<CleanupResult[]> {
  // Check every target before deleting anything, so a refusal for one target
  // does not leave another already torn down.
  const plans = await withPathCache(async () => {
    const project = await loadProjectConfig(options.cwd, options.configPath);
    const guard = await buildDeleteGuard(project, options.force);
    const targets = options.target
      ? [options.target]
      : (Object.keys(project.config.targets) as TargetName[]);
    await assertNoManifestCollisions(project, targets, options.force);
    const planned: CleanPlan[] = [];
    for (const target of targets) {
      const targetConfig = project.config.targets[target];
      if (!targetConfig) {
        throw new Error(`Target "${target}" is not configured.`);
      }
      const outDir = path.resolve(project.rootDir, targetConfig.outDir);
      planned.push(
        await planClean(outDir, target, { dryRun: options.dryRun, guard }),
      );
    }
    return planned;
  });
  if (!options.dryRun) {
    for (const plan of plans) {
      await executeClean(plan);
    }
  }
  return plans.map(cleanResult);
}

/**
 * Refuses to clean a path another configured target's manifest also claims.
 *
 * `build()` and `prune()` share one plan that rejects overlapping output and
 * leaves a stale path alone when another target owns it. `clean()`
 * deliberately never builds — teardown has to keep working when the source
 * tree or config no longer does, which is often exactly why someone is
 * cleaning — so it cannot share that plan. This is the standalone check,
 * working purely from the manifests on disk.
 *
 * Paths are compared physically, so two outDirs that differ only in case on a
 * case-insensitive filesystem, or that alias one directory through a symlink,
 * collide here just as they do on disk. Overlapping manifests otherwise come
 * from a pluginpack older than the build check, or from a manifest edited out
 * of band; either way the file being deleted is another target's live output,
 * so refuse rather than delete it. `--force` still wins, so nobody ends up
 * unable to tear down their own repo.
 */
async function assertNoManifestCollisions(
  project: ResolvedProjectConfig,
  cleaning: TargetName[],
  force?: boolean,
): Promise<void> {
  if (force) {
    return;
  }
  const owners = new Map<string, { target: TargetName; absolute: string }>();
  const collisions: string[] = [];
  for (const target of targetNames) {
    const targetConfig = project.config.targets[target];
    if (!targetConfig) {
      continue;
    }
    const outDir = path.resolve(project.rootDir, targetConfig.outDir);
    const manifest = await readManagedManifest(outDir, target);
    if (!manifest) {
      continue;
    }
    for (const file of manifest.files) {
      const absolute = path.resolve(outDir, normalizeManagedPath(file));
      const key = await managedPathKey(outDir, target, file, { entry: true });
      const owner = owners.get(key);
      if (owner && owner.target !== target) {
        if (cleaning.includes(owner.target) || cleaning.includes(target)) {
          collisions.push(
            `  ${owner.target} and ${target}: ${describeAlias(owner.absolute, absolute)}`,
          );
        }
        continue;
      }
      owners.set(key, { target, absolute });
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Refusing to clean paths claimed by more than one target's managed manifest:\n${collisions.join("\n")}\n` +
        `Deleting them would remove another target's live output. Give the targets distinct outDirs and rebuild, or re-run with --force to delete anyway.`,
    );
  }
}
