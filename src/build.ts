import { promises as fs } from "node:fs";
import path from "node:path";
import { assertOutDirsOutsideSource, loadConfig } from "./config.js";
import { physicalKey, withPathCache, writeArtifact } from "./fs.js";
import {
  assertManagedManifestContained,
  buildDeleteGuard,
  executePrune,
  managedManifestPath,
  managedPathKey,
  normalizeManagedPath,
  planPrune,
  readManagedManifest,
  recordHandedOverHashes,
  warnOnEditedOverwrites,
  writeManagedManifest,
  type PrunePlan,
} from "./managed.js";
import { emitTarget, targetNames } from "./adapters.js";
import {
  findUnsubstitutedPartialTags,
  substitutedExtensions,
} from "./partials.js";
import type {
  Artifact,
  BuildOptions,
  ResolvedProject,
  ResolvedProjectConfig,
  TargetName,
} from "./types.js";

/** Builds every configured (or explicitly selected) target and writes its output, unless `dryRun` is set. */
export async function build(options: BuildOptions = {}): Promise<Artifact[]> {
  const { artifacts, prunes } = await planBuild(options);
  for (const plan of prunes) {
    await warnOnEditedOverwrites(plan, options.dryRun);
  }
  if (!options.dryRun) {
    // Write every target's new files before pruning any target's stale ones.
    // If a later target's write throws, no target has had files pruned yet —
    // the previous build's output is still intact and a re-run starts from
    // the same state, rather than leaving one target with its stale files
    // already gone, its new files only partially written, and a manifest
    // that no longer matches either state.
    for (const artifact of artifacts) {
      await writeArtifact(artifact.outDir, artifact.files);
    }
    // Before any target prunes or gives up a path, every target's manifest
    // claims its new paths and still lists its old ones. A path handed from
    // one target to another is then always listed by at least one manifest:
    // if the recipient's prune fails after the donor's final manifest is
    // written, the recipient's interim manifest still owns the path, and a
    // later clean can remove it.
    for (const plan of prunes) {
      await writeManagedManifest(plan.artifact, plan.previous);
    }
    for (const plan of prunes) {
      await executePrune(plan);
      await writeManagedManifest(plan.artifact);
    }
  }
  return artifacts;
}

/**
 * Emits every selected target and runs every check that could refuse the
 * build, without touching disk: cross-target collisions, collisions with other
 * targets' manifests, unsubstituted partials, self-referential rootFiles,
 * manifest containment, and the delete guard over each target's stale files.
 *
 * `build` and `prune` both start here, and a dry run stops here, so a dry run
 * fails exactly where the real command would, and a refused prune never
 * leaves a half-written build behind. `force` relaxes only the delete guard.
 */
export function planBuild(
  options: BuildOptions,
  force?: boolean,
): Promise<{ artifacts: Artifact[]; prunes: PrunePlan[] }> {
  // Nothing in the plan writes, so it can resolve each directory once.
  return withPathCache(() => planBuildChecked(options, force));
}

async function planBuildChecked(
  options: BuildOptions,
  force?: boolean,
): Promise<{ artifacts: Artifact[]; prunes: PrunePlan[] }> {
  const project = await loadConfig(options.cwd, options.configPath);
  const targets = options.target
    ? [options.target]
    : targetNames.filter((target) => project.config.targets[target]);
  const guard = await buildDeleteGuard(project, force);
  const artifacts: Artifact[] = [];
  for (const target of targets) {
    artifacts.push(await emitTarget(project, target, options.outDir));
  }
  if (options.outDir) {
    await assertOutDirsOutsideSource(
      project,
      artifacts.map((artifact) => ({
        target: artifact.target,
        outDir: artifact.outDir,
      })),
    );
  }
  await assertNoOrphanManifests(
    project,
    artifacts.map(({ target, outDir }) => ({ target, outDir })),
  );
  const incoming = await assertNoCrossTargetCollisions(artifacts);
  const claimedElsewhere = await assertNoCollisionsWithBuiltTargets(
    project,
    targets,
    incoming,
  );
  assertNoUnsubstitutedPartialTags(artifacts);
  await assertNoSelfReferentialRootFiles(project, artifacts);
  for (const artifact of artifacts) {
    await assertManagedManifestContained(artifact.outDir, artifact.target);
  }
  const owners = new Map<string, TargetName>(claimedElsewhere);
  for (const [key, claim] of incoming.byEntry) {
    owners.set(key, claim.target);
  }
  const prunes: PrunePlan[] = [];
  for (const artifact of artifacts) {
    prunes.push(
      await planPrune(artifact, { dryRun: options.dryRun, guard, owners }),
    );
  }
  await recordHandedOverHashes(prunes);
  return { artifacts, prunes };
}

/**
 * A `{{> name}}` tag that reaches output is broken content: whatever reads the
 * file gets a template marker instead of the text it was meant to inline.
 * Substitution resolves (or rejects) every tag in the file types it runs on, so
 * what is left is a tag authored somewhere it never ran — a reference file, a
 * script, a data file. Fail rather than ship it.
 */
function assertNoUnsubstitutedPartialTags(artifacts: Artifact[]): void {
  const found = artifacts.flatMap((artifact) =>
    findUnsubstitutedPartialTags(artifact.files).map(
      (tag) => `  ${artifact.target}: ${tag.path} contains ${tag.tag}`,
    ),
  );
  if (found.length > 0) {
    throw new Error(
      `Unsubstituted partial references in emitted output:\n${found.join("\n")}\n` +
        `Partial substitution only runs on ${substitutedExtensions()} files. ` +
        `Move the shared text into one of those, or inline it here instead.`,
    );
  }
}

/**
 * A `rootFiles` entry whose destination is its own source makes the authored
 * file a managed output: the build copies it onto itself, and the next `clean`
 * (or a prune after the entry is removed) deletes the only copy. Refuse it
 * before writing anything. (A `repositoryFiles` directory that is the outDir
 * is caught earlier, at config load, as an outDir inside a source path.)
 */
async function assertNoSelfReferentialRootFiles(
  project: ResolvedProject,
  artifacts: Artifact[],
): Promise<void> {
  const problems: string[] = [];
  for (const artifact of artifacts) {
    const targetConfig = project.config.targets[artifact.target];
    for (const [dest, source] of Object.entries(
      targetConfig?.rootFiles ?? {},
    )) {
      const [destKey, sourceKey] = await Promise.all([
        physicalKey(path.resolve(artifact.outDir, dest)),
        physicalKey(path.resolve(project.rootDir, source)),
      ]);
      if (destKey === sourceKey) {
        problems.push(
          `  targets.${artifact.target}.rootFiles["${dest}"] copies ${path.resolve(project.rootDir, source)} onto itself`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid pluginpack config: a generated file would replace its own source:\n${problems.join("\n")}\n` +
        `pluginpack would then manage, and later delete, the authored file. ` +
        `Map each entry to a different destination, or remove it if the file already lives in the output repository.`,
    );
  }
}

/** Which target claims a path, and the path as that target names it. */
type Claim = { target: TargetName; absolute: string };

/**
 * Every path this build writes, keyed two ways. `byWrite` keys the file a
 * write lands on, with every symlink resolved, the final entry included:
 * writing through a symlinked `SKILL.md` changes the file it points at. Write
 * collisions compare these. `byEntry` keys the entry itself (parent resolved,
 * final name kept), which is what a prune unlinks; ownership compares these.
 */
type IncomingPaths = {
  byWrite: Map<string, Claim>;
  byEntry: Map<string, Claim>;
};

/**
 * Two targets pointed at overlapping output paths would silently overwrite each
 * other (and one target's prune could delete the other's files). Catch it.
 * Keys on physical paths, so `out` and `OUT` on a case-insensitive filesystem,
 * an outDir reached through a symlink, or a generated file that is itself a
 * symlink to another target's file, are one path, as they are on disk.
 * Returns the keyed claims so later checks can reuse them.
 */
async function assertNoCrossTargetCollisions(
  artifacts: Artifact[],
): Promise<IncomingPaths> {
  const byWrite = new Map<string, Claim>();
  const byEntry = new Map<string, Claim>();
  const collisions: string[] = [];
  for (const artifact of artifacts) {
    for (const managedPath of artifact.managedPaths) {
      const absolute = path.resolve(artifact.outDir, managedPath);
      const claim = { target: artifact.target, absolute };
      const writeKey = await physicalKey(absolute);
      const previous = byWrite.get(writeKey);
      if (previous && previous.target !== artifact.target) {
        collisions.push(
          `  ${previous.target} and ${artifact.target}: ${describeAlias(previous.absolute, absolute)}`,
        );
        continue;
      }
      byWrite.set(writeKey, claim);
      const entryKey = await physicalKey(absolute, { entry: true });
      if (!byEntry.has(entryKey)) {
        byEntry.set(entryKey, claim);
      }
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Targets write overlapping output paths; give them distinct outDirs:\n${collisions.join("\n")}\n` +
        `If an output path is a symlink to another target's file, replace it with a regular file or remove it.`,
    );
  }
  return { byWrite, byEntry };
}

/**
 * `assertNoCrossTargetCollisions` only sees artifacts built in *this*
 * invocation. Running `pluginpack build --target X` after an earlier
 * `pluginpack build --target Y` wrote overlapping paths would otherwise slip
 * through — X's build would silently overwrite Y's files, and a later
 * `clean --target Y` would then delete what are now X's live files. Guard
 * against that by also checking incoming paths against every other
 * *configured* target's on-disk managed manifest, not just artifacts present
 * in the current invocation.
 *
 * Returns the physical key of every path those other manifests claim, so
 * prune can leave a stale path alone when another target owns it now.
 */
async function assertNoCollisionsWithBuiltTargets(
  project: ResolvedProject,
  targets: TargetName[],
  incoming: IncomingPaths,
): Promise<Map<string, TargetName>> {
  const building = new Set(targets);
  const claimed = new Map<string, TargetName>();
  const collisions: string[] = [];
  for (const other of targetNames) {
    if (building.has(other)) {
      continue;
    }
    const otherConfig = project.config.targets[other];
    if (!otherConfig) {
      continue;
    }
    const otherOutDir = path.resolve(project.rootDir, otherConfig.outDir);
    const manifest = await readManagedManifest(otherOutDir, other);
    if (!manifest) {
      continue;
    }
    for (const file of manifest.files) {
      const absolute = path.resolve(otherOutDir, normalizeManagedPath(file));
      const key = await managedPathKey(otherOutDir, other, file, {
        entry: true,
      });
      claimed.set(key, other);
      const conflicting =
        incoming.byEntry.get(key) ??
        incoming.byWrite.get(await managedPathKey(otherOutDir, other, file));
      if (conflicting) {
        collisions.push(
          `  ${other} (previously built) and ${conflicting.target}: ${describeAlias(absolute, conflicting.absolute)}`,
        );
      }
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Target output overlaps a previously built target's managed files; give them distinct outDirs:\n${collisions.join("\n")}\n` +
        `Run a full \`build\` (no --target) to see every target's paths at once, or fix the outDir configuration.`,
    );
  }
  return claimed;
}

/** Where a target's managed manifest lives: `<outDir>/.pluginpack/<target>.json`. */
export type ManifestLocation = { target: TargetName; outDir: string };

/**
 * Managed manifests in the outDirs this config uses that no target builds
 * into: a target the config dropped, or one whose outDir moved. Switching an
 * outDir from codex to agent-plugins, say, leaves `.pluginpack/codex.json`
 * behind. No configured target prunes the files it lists, so they would stay
 * forever, and some (a codex hooks file inside an agent-plugins package)
 * make the new output invalid.
 *
 * Scans the outDir of every configured target, plus `building` (the outDirs
 * of this invocation, which a `--out-dir` override moves). A manifest is
 * expected where its target is configured to write or is writing now.
 */
export async function findOrphanManifests(
  project: ResolvedProjectConfig,
  building: ManifestLocation[] = [],
): Promise<ManifestLocation[]> {
  const expected = new Map<TargetName, Set<string>>();
  const scanned = new Map<string, string>();
  const add = async ({ target, outDir }: ManifestLocation) => {
    const key = await physicalKey(outDir);
    expected.set(target, (expected.get(target) ?? new Set()).add(key));
    if (!scanned.has(key)) {
      scanned.set(key, outDir);
    }
  };
  for (const [target, config] of Object.entries(project.config.targets)) {
    if (config) {
      await add({
        target: target as TargetName,
        outDir: path.resolve(project.rootDir, config.outDir),
      });
    }
  }
  for (const location of building) {
    await add(location);
  }
  const known = new Set<string>(targetNames);
  const orphans: ManifestLocation[] = [];
  for (const [key, outDir] of scanned) {
    const names = await fs
      .readdir(path.join(outDir, ".pluginpack"))
      .catch(() => [] as string[]);
    for (const name of names.sort()) {
      const target = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!known.has(target)) {
        continue;
      }
      if (!expected.get(target as TargetName)?.has(key)) {
        orphans.push({ target: target as TargetName, outDir });
      }
    }
  }
  return orphans;
}

/**
 * Refuses to build or prune while an outDir holds a manifest no target builds
 * there (see `findOrphanManifests`).
 *
 * Pruning those files instead would delete on the authority of a manifest
 * alone, with no config left describing that output: a target dropped from
 * the config by mistake, or a second project that shares the output
 * repository, would lose its files without a word. Refusing costs one
 * command, and `clean --target <old>` (which finds these manifests) deletes
 * the files through the same guard and checks as any clean.
 */
async function assertNoOrphanManifests(
  project: ResolvedProjectConfig,
  building: ManifestLocation[],
): Promise<void> {
  const orphans = await findOrphanManifests(project, building);
  if (orphans.length === 0) {
    return;
  }
  const lines = orphans.map(
    ({ target, outDir }) =>
      `  ${path.join(outDir, managedManifestPath(target))} (${target})`,
  );
  const commands = [...new Set(orphans.map(({ target }) => target))]
    .map((target) => `\`pluginpack clean --target ${target}\``)
    .join(", then ");
  throw new Error(
    `Found managed output from a target this config does not build there:\n${lines.join("\n")}\n` +
      `No configured target prunes the files these manifests list, so they would stay in the output. ` +
      `Run ${commands} to delete them first. To keep the files unmanaged instead, delete the manifest.`,
  );
}

/** One path, or both spellings when two different strings name the same file. */
export function describeAlias(first: string, second: string): string {
  return first === second ? first : `${first} (same file as ${second})`;
}
