import path from "node:path";
import {
  describeAlias,
  findOrphanManifests,
  planBuild,
  type ManifestLocation,
} from "./build.js";
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
    const configured = configuredLocations(project);
    const orphans = await findOrphanManifests(project);
    const selected = (location: ManifestLocation) =>
      !options.target || location.target === options.target;
    // A target the config dropped, or one whose outDir moved, left its
    // manifest in an outDir this config uses; cleaning it is how a user
    // removes that output, so it counts as that target's to clean.
    const cleaning = [...configured, ...orphans].filter(selected);
    if (options.target && cleaning.length === 0) {
      throw new Error(
        `Target "${options.target}" is not configured, and no outDir this config uses holds a .pluginpack/${options.target}.json manifest.`,
      );
    }
    await assertNoManifestCollisions(
      [...configured, ...orphans],
      cleaning,
      options.force,
    );
    const planned: CleanPlan[] = [];
    for (const { target, outDir } of cleaning) {
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

/** Where each configured target's managed manifest lives, in registry order. */
function configuredLocations(
  project: ResolvedProjectConfig,
): ManifestLocation[] {
  return targetNames.flatMap((target) => {
    const config = project.config.targets[target];
    return config
      ? [{ target, outDir: path.resolve(project.rootDir, config.outDir) }]
      : [];
  });
}

/**
 * Refuses to clean a path another target's manifest also claims.
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
  manifests: ManifestLocation[],
  cleaning: ManifestLocation[],
  force?: boolean,
): Promise<void> {
  if (force) {
    return;
  }
  const isCleaning = (location: ManifestLocation) =>
    cleaning.includes(location);
  const owners = new Map<
    string,
    { location: ManifestLocation; absolute: string }
  >();
  const collisions: string[] = [];
  for (const location of manifests) {
    const { target, outDir } = location;
    const manifest = await readManagedManifest(outDir, target);
    if (!manifest) {
      continue;
    }
    for (const file of manifest.files) {
      const absolute = path.resolve(outDir, normalizeManagedPath(file));
      const key = await managedPathKey(outDir, target, file, { entry: true });
      const owner = owners.get(key);
      if (owner && owner.location !== location) {
        if (isCleaning(owner.location) || isCleaning(location)) {
          collisions.push(
            `  ${owner.location.target} and ${target}: ${describeAlias(owner.absolute, absolute)}`,
          );
        }
        continue;
      }
      owners.set(key, { location, absolute });
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Refusing to clean paths claimed by more than one target's managed manifest:\n${collisions.join("\n")}\n` +
        `Deleting them would remove another target's live output. Give the targets distinct outDirs and rebuild, or re-run with --force to delete anyway.`,
    );
  }
}
