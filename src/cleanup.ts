import path from "node:path";
import { build } from "./build.js";
import { targetNames } from "./adapters.js";
import { loadProjectConfig } from "./config.js";
import {
  buildDeleteGuard,
  cleanManagedFiles,
  normalizeManagedPath,
  pruneManagedFiles,
  readManagedManifest,
} from "./managed.js";
import type {
  CleanupResult,
  ResolvedProjectConfig,
  TargetName,
} from "./types.js";

/** Deletes managed files no longer produced by the current build, without rewriting current output. */
export async function prune(
  options: {
    cwd?: string;
    configPath?: string;
    target?: TargetName;
    dryRun?: boolean;
    force?: boolean;
  } = {},
): Promise<CleanupResult[]> {
  const project = await loadProjectConfig(options.cwd, options.configPath);
  const guard = buildDeleteGuard(
    project.rootDir,
    project.config,
    project.configPath,
    options.force,
  );
  const artifacts = await build({
    cwd: options.cwd,
    configPath: options.configPath,
    target: options.target,
    dryRun: true,
  });
  const results: CleanupResult[] = [];
  for (const artifact of artifacts) {
    results.push(
      await pruneManagedFiles(artifact, { dryRun: options.dryRun, guard }),
    );
  }
  return results;
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
  const project = await loadProjectConfig(options.cwd, options.configPath);
  const guard = buildDeleteGuard(
    project.rootDir,
    project.config,
    project.configPath,
    options.force,
  );
  const targets = options.target
    ? [options.target]
    : (Object.keys(project.config.targets) as TargetName[]);
  await assertNoManifestCollisions(project, targets, options.force);
  const results: CleanupResult[] = [];
  for (const target of targets) {
    const targetConfig = project.config.targets[target];
    if (!targetConfig) {
      throw new Error(`Target "${target}" is not configured.`);
    }
    const outDir = path.resolve(project.rootDir, targetConfig.outDir);
    results.push(
      await cleanManagedFiles(outDir, target, {
        dryRun: options.dryRun,
        guard,
      }),
    );
  }
  return results;
}

/**
 * Refuses to clean a path another configured target's manifest also claims.
 *
 * `build()` rejects two targets writing overlapping output paths, and `prune()`
 * inherits that check for free by running `build({ dryRun: true })` first.
 * `clean()` deliberately never builds — teardown has to keep working when the
 * source tree or config no longer does, which is often exactly why someone is
 * cleaning — so it cannot inherit the check the same way. This is the
 * standalone equivalent, working purely from the manifests on disk.
 *
 * Overlapping manifests can only come from a pluginpack older than that build
 * check, or from a manifest edited out of band; either way the file being
 * deleted is another target's live output, so refuse rather than delete it.
 * `--force` still wins, so nobody ends up unable to tear down their own repo.
 */
async function assertNoManifestCollisions(
  project: ResolvedProjectConfig,
  cleaning: TargetName[],
  force?: boolean,
): Promise<void> {
  if (force) {
    return;
  }
  const owners = new Map<string, TargetName>();
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
      const owner = owners.get(absolute);
      if (owner && owner !== target) {
        if (cleaning.includes(owner) || cleaning.includes(target)) {
          collisions.push(`  ${owner} and ${target}: ${absolute}`);
        }
        continue;
      }
      owners.set(absolute, target);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Refusing to clean paths claimed by more than one target's managed manifest:\n${collisions.join("\n")}\n` +
        `Deleting them would remove another target's live output. Give the targets distinct outDirs and rebuild, or re-run with --force to delete anyway.`,
    );
  }
}
