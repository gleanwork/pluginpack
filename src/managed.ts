import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isInside,
  isInsideFolded,
  isNotFoundError,
  json,
  physicalKey,
  resolveInside,
  toPosix,
  writeArtifact,
} from "./fs.js";
import { listSourcePaths } from "./config.js";
import type {
  Artifact,
  CleanupEntry,
  CleanupResult,
  DeleteGuard,
  FileValue,
  ResolvedProjectConfig,
  TargetName,
} from "./types.js";

/** The newest managed-manifest version this pluginpack reads and the one it writes. */
const MANIFEST_VERSION = 2;

/**
 * A target's managed-file manifest, as read. Version 2 records a sha256 of
 * each file as written, so a later build, prune or clean can tell a file it
 * wrote from one someone edited since. A version 1 manifest (paths only) reads
 * as version 2 with no hashes and is upgraded by the next build.
 */
export type ManagedManifest = {
  version: typeof MANIFEST_VERSION;
  target: TargetName;
  files: string[];
  sha256: Record<string, string>;
};

/** Output-relative path of a target's managed-file manifest. */
export function managedManifestPath(target: TargetName): string {
  return toPosix(path.join(".pluginpack", `${target}.json`));
}

/** The hex sha256 of a file's contents, as recorded in the managed manifest. */
function contentHash(value: FileValue): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Writes the list of files a build produced, with their hashes, for later
 * prune/clean/diff to compare against. Goes through the same containment check
 * as the artifact itself, so a symlinked `.pluginpack/` cannot redirect the
 * write outside the output directory.
 */
export async function writeManagedManifest(artifact: Artifact): Promise<void> {
  const sha256: Record<string, string> = {};
  for (const managedPath of artifact.managedPaths) {
    const value = artifact.files.get(managedPath);
    if (value !== undefined) {
      sha256[managedPath] = contentHash(value);
    }
  }
  const manifest: ManagedManifest = {
    version: MANIFEST_VERSION,
    target: artifact.target,
    files: artifact.managedPaths,
    sha256,
  };
  await writeArtifact(
    artifact.outDir,
    new Map([[managedManifestPath(artifact.target), json(manifest)]]),
  );
}

/**
 * Throws if writing the target's managed manifest would leave the output
 * directory. Build runs this before writing anything, so a planted
 * `.pluginpack` symlink fails the build up front instead of after the
 * artifact is already on disk.
 */
export async function assertManagedManifestContained(
  outDir: string,
  target: TargetName,
): Promise<void> {
  const relative = managedManifestPath(target);
  if (
    (await resolveInside(path.resolve(outDir), path.join(outDir, relative))) ===
    null
  ) {
    throw new Error(
      `Refusing to write through a symlink that leaves the output directory: ${relative} (under ${outDir}). ` +
        `Replace the .pluginpack symlink with a real directory.`,
    );
  }
}

/** Reads a target's managed-file manifest, or `null` if none exists yet. */
export async function readManagedManifest(
  outDir: string,
  target: TargetName,
): Promise<ManagedManifest | null> {
  const manifestPath = path.join(outDir, managedManifestPath(target));
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  const invalid = (reason: string) =>
    new Error(
      `Invalid managed manifest: ${manifestPath} (${reason}). ` +
        `It records which files pluginpack may delete. Restore it from version control, ` +
        `or delete it and rebuild; pluginpack then leaves any files it listed in place.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("not valid JSON");
  }
  // `JSON.parse` happily returns null, a number, or a string for a truncated
  // or hand-edited manifest; those must land on the same clear error as
  // malformed JSON, not a TypeError from the field checks below.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid("not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const version = record.version;
  if (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version > MANIFEST_VERSION
  ) {
    throw new Error(
      `Managed manifest ${manifestPath} has version ${version}, so a newer pluginpack wrote it. ` +
        `This pluginpack reads versions 1 to ${MANIFEST_VERSION}. Upgrade pluginpack to build, prune or clean this output.`,
    );
  }
  if (version !== 1 && version !== 2) {
    throw invalid(`unsupported version ${JSON.stringify(version)}`);
  }
  if (record.target !== target) {
    throw invalid(
      `target is ${JSON.stringify(record.target)}, expected "${target}"`,
    );
  }
  const files = record.files;
  if (
    !Array.isArray(files) ||
    !files.every((file): file is string => typeof file === "string")
  ) {
    throw invalid('"files" must be an array of paths');
  }
  let sha256: Record<string, string> = {};
  if (version === 2) {
    const hashes = record.sha256;
    if (
      !hashes ||
      typeof hashes !== "object" ||
      Array.isArray(hashes) ||
      !Object.values(hashes).every((hash) => typeof hash === "string")
    ) {
      throw invalid('"sha256" must map each path to a hash');
    }
    sha256 = hashes as Record<string, string>;
  }
  return { version: MANIFEST_VERSION, target, files, sha256 };
}

/** What a prune will delete, decided before anything is written or removed. */
export type PrunePlan = {
  artifact: Artifact;
  previous: ManagedManifest | null;
  stale: string[];
};

/**
 * Decides which previously managed files are stale and checks it is safe to
 * delete them, without touching disk. Runs on dry runs too, so `--dry-run`
 * fails exactly where the real command would.
 *
 * `owners` maps the physical key of every path another target produces in
 * this build, or claims in its own manifest, to that target. A stale path
 * another target owns has changed hands (for example a marketplace file moved
 * from one target to another sharing the outDir) and is left in place rather
 * than deleted from under its new owner. This target's next manifest no
 * longer lists it, so the ownership transfer completes on the next build.
 */
export async function planPrune(
  artifact: Artifact,
  options: {
    dryRun?: boolean;
    guard?: DeleteGuard;
    owners?: Map<string, TargetName>;
  } = {},
): Promise<PrunePlan> {
  const previous = await readManagedManifest(artifact.outDir, artifact.target);
  const current = new Set(artifact.managedPaths.map(normalizeManagedPath));
  const stale: string[] = [];
  for (const file of (previous?.files ?? []).map(normalizeManagedPath)) {
    if (current.has(file)) {
      continue;
    }
    if (options.owners) {
      const key = await managedPathKey(artifact.outDir, artifact.target, file, {
        entry: true,
      });
      const owner = options.owners.get(key);
      if (owner && owner !== artifact.target) {
        continue;
      }
    }
    stale.push(file);
  }
  await assertNoProtectedDeletions(
    artifact.outDir,
    artifact.target,
    stale,
    options.guard,
    "prune",
  );
  await assertRemovalsContained(artifact.outDir, artifact.target, stale);
  await warnOnEditedFiles(
    artifact.outDir,
    artifact.target,
    stale,
    previous,
    options.dryRun ? "a real run would delete it" : "deleting it",
  );
  return { artifact, previous, stale };
}

/** Deletes the stale files a `planPrune` decided on. */
export async function executePrune(plan: PrunePlan): Promise<void> {
  for (const file of plan.stale) {
    await removeManagedPath(plan.artifact.outDir, file, plan.artifact.target);
  }
}

/** The cleanup report for a prune plan. */
export function pruneResult(plan: PrunePlan): CleanupResult {
  return {
    target: plan.artifact.target,
    outDir: plan.artifact.outDir,
    entries: plan.stale.map((file): CleanupEntry => ({
      type: "stale",
      target: plan.artifact.target,
      path: file,
    })),
  };
}

/**
 * Warns before a build overwrites a managed file someone edited since the
 * last build. The build still overwrites it: pluginpack owns its output, but
 * the edit should not vanish without a word.
 */
export async function warnOnEditedOverwrites(
  plan: PrunePlan,
  dryRun?: boolean,
): Promise<void> {
  const { artifact, previous } = plan;
  const incoming = new Map<string, string>();
  for (const [file, value] of artifact.files) {
    incoming.set(file, contentHash(value));
  }
  await warnOnEditedFiles(
    artifact.outDir,
    artifact.target,
    artifact.managedPaths,
    previous,
    dryRun ? "a real build would overwrite it" : "overwriting it",
    incoming,
  );
}

/** What a clean will delete for one target, decided before anything is removed. */
export type CleanPlan = {
  target: TargetName;
  outDir: string;
  /** Every managed path, then the manifest itself; empty when no manifest exists. */
  paths: string[];
};

/**
 * Checks it is safe to delete every file the previous build managed for a
 * target, without touching disk: the delete guard, containment of every path,
 * and a warning for each edited file. Runs on dry runs too.
 */
export async function planClean(
  outDir: string,
  target: TargetName,
  options: { dryRun?: boolean; guard?: DeleteGuard } = {},
): Promise<CleanPlan> {
  const previous = await readManagedManifest(outDir, target);
  if (!previous) {
    return { target, outDir, paths: [] };
  }
  const files = previous.files.map(normalizeManagedPath);
  await assertNoProtectedDeletions(
    outDir,
    target,
    files,
    options.guard,
    "clean",
  );
  await assertRemovalsContained(outDir, target, files);
  await warnOnEditedFiles(
    outDir,
    target,
    files,
    previous,
    options.dryRun ? "a real run would delete it" : "deleting it",
  );
  return { target, outDir, paths: [...files, managedManifestPath(target)] };
}

/** Deletes what a `planClean` decided on, the manifest last. */
export async function executeClean(plan: CleanPlan): Promise<void> {
  for (const file of plan.paths) {
    await removeManagedPath(plan.outDir, file, plan.target);
  }
}

/** The cleanup report for a clean plan. */
export function cleanResult(plan: CleanPlan): CleanupResult {
  return {
    target: plan.target,
    outDir: plan.outDir,
    entries: plan.paths.map((file): CleanupEntry => ({
      type: "deleted",
      target: plan.target,
      path: file,
    })),
  };
}

/**
 * Prints a warning for each of `files` whose on-disk content no longer
 * matches the hash the manifest recorded when pluginpack wrote it. Files with
 * no recorded hash (a version 1 manifest) and files already gone are skipped,
 * as are files whose edit already matches what `replacements` will write.
 */
async function warnOnEditedFiles(
  outDir: string,
  target: TargetName,
  files: string[],
  previous: ManagedManifest | null,
  action: string,
  replacements?: Map<string, string>,
): Promise<void> {
  if (!previous) {
    return;
  }
  for (const file of files) {
    const recorded = previous.sha256[file];
    if (recorded === undefined) {
      continue;
    }
    let contents: Buffer;
    try {
      contents = await fs.readFile(path.resolve(outDir, file));
    } catch {
      continue;
    }
    const actual = contentHash(contents);
    if (actual !== recorded && actual !== replacements?.get(file)) {
      console.warn(
        `warning: ${target} managed file ${path.join(outDir, file)} was edited after pluginpack wrote it; ${action}. ` +
          `Keep the edit by moving it into the source, or recover it from version control.`,
      );
    }
  }
}

/**
 * Builds the guard that stops prune/clean from deleting the config, a source
 * tree, or an output repository's `.git` directory.
 *
 * Takes the loaded config rather than plugin discovery results, so `clean`
 * keeps working when the source tree no longer loads. See `listSourcePaths`
 * for which authored paths count as source.
 */
export async function buildDeleteGuard(
  project: ResolvedProjectConfig,
  force?: boolean,
): Promise<DeleteGuard> {
  const protectedRoots = (await listSourcePaths(project)).map(
    (source) => source.path,
  );
  // An outDir can sit outside the source repo (a sibling output repo), where
  // none of the source paths above apply. Its version-control data is the one
  // thing there no manifest should ever name.
  for (const target of Object.values(project.config.targets)) {
    if (target) {
      protectedRoots.push(path.resolve(project.rootDir, target.outDir, ".git"));
    }
  }
  return {
    protectedRoots,
    configPath: path.resolve(project.configPath),
    force,
  };
}

async function assertNoProtectedDeletions(
  outDir: string,
  target: TargetName,
  paths: string[],
  guard: DeleteGuard | undefined,
  command: string,
): Promise<void> {
  if (!guard || guard.force || paths.length === 0) {
    return;
  }
  const roots = [
    ...(guard.configPath ? [guard.configPath] : []),
    ...guard.protectedRoots,
  ];
  const rootKeys = await Promise.all(
    roots.map(async (root) => ({ root, key: await physicalKey(root) })),
  );
  const blocked: Array<{ file: string; root: string }> = [];
  for (const file of paths) {
    const root = await protectingRoot(outDir, target, file, rootKeys);
    if (root !== null) {
      blocked.push({ file, root });
    }
  }
  if (blocked.length === 0) {
    return;
  }
  throw new Error(
    `Refusing to ${command} ${blocked.length} path(s) that resolve inside your source tree or config:\n` +
      `${blocked.map(({ file, root }) => `  ${file} -> resolves inside ${root}`).join("\n")}\n` +
      `This usually means a target outDir overlaps source, overrides, repositoryFiles, or legacy source config. ` +
      `Fix the config, or re-run with --force to delete anyway.`,
  );
}

/**
 * The protected root `relativePath` resolves inside, or `null` if it is safe to
 * delete. Returns the matching root rather than a boolean so the refusal can
 * name what it collided with — "resolves inside <path>" is actionable in a way
 * that a bare list of refused paths is not.
 *
 * Two comparisons, either of which refuses. The lexical one folds case and
 * Unicode normalization on every host, so a manifest entry differing from a
 * root only by case is refused even where the filesystem would not alias them.
 * The physical one compares the entry `fs.rm` would remove against each root
 * with symlinks resolved, so an outDir that reaches source through a symlink
 * or a case variant is refused too.
 */
async function protectingRoot(
  outDir: string,
  target: TargetName,
  relativePath: string,
  roots: Array<{ root: string; key: string }>,
): Promise<string | null> {
  const absolute = path.resolve(outDir, normalizeManagedPath(relativePath));
  const lexical = roots.find(({ root }) => isInsideFolded(root, absolute));
  if (lexical) {
    return lexical.root;
  }
  const key = await managedPathKey(outDir, target, relativePath, {
    entry: true,
  });
  return roots.find((root) => isInside(root.key, key))?.root ?? null;
}

/**
 * `physicalKey` for a path a target's managed manifest lists. A failure to
 * resolve it (EACCES on a locked directory, say) names the manifest and the
 * way out, since every caller runs before anything is deleted.
 */
export async function managedPathKey(
  outDir: string,
  target: TargetName,
  relativePath: string,
  options: { entry?: boolean } = {},
): Promise<string> {
  try {
    return await physicalKey(
      path.resolve(outDir, normalizeManagedPath(relativePath)),
      options,
    );
  } catch (error) {
    throw uncheckedPathError(outDir, target, relativePath, error);
  }
}

function uncheckedPathError(
  outDir: string,
  target: TargetName,
  relativePath: string,
  error: unknown,
): Error {
  return new Error(
    `Cannot check managed path "${relativePath}" under ${outDir}: ${(error as Error).message}. ` +
      nothingDeleted(outDir, target),
    { cause: error },
  );
}

function nothingDeleted(outDir: string, target: TargetName): string {
  const manifest = path.join(path.resolve(outDir), managedManifestPath(target));
  return (
    `Nothing was deleted. The managed manifest ${manifest} lists this path. ` +
    `Fix the cause and re-run the same command, or remove the entry from that manifest to leave the path alone.`
  );
}

/** Normalizes a managed path to a safe, relative, forward-slash form, throwing if it escapes the output dir. */
export function normalizeManagedPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (
    !value ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    // A Windows drive-letter path (e.g. "C:/Users/x") isn't caught by
    // path.posix.isAbsolute, but path.resolve on an actual Windows host
    // would treat it as absolute and escape `root` entirely. Reject it on
    // every platform so a manifest built on one OS can't misbehave on
    // another.
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new Error(`Unsafe managed path: ${value}`);
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

/** A managed path that cannot be removed safely. The message says why. */
class UnsafeRemovalError extends Error {}

/**
 * The absolute path `relativePath` names under `root`, or `null` when there is
 * nothing to remove: the entry is missing, or an ancestor is now a file, so
 * the managed file cannot exist. Throws `UnsafeRemovalError` when removing the
 * entry would reach outside `root`.
 */
async function inspectRemoval(
  root: string,
  relativePath: string,
): Promise<string | null> {
  const normalized = normalizeManagedPath(relativePath);
  const destination = path.resolve(root, normalized);
  if (!isInside(root, destination)) {
    throw new UnsafeRemovalError(
      `Managed path escapes output directory: ${relativePath}`,
    );
  }
  let stats;
  try {
    stats = await fs.lstat(destination);
  } catch (error) {
    // ENOTDIR: an ancestor was replaced by a file, so the managed file is
    // gone and the file in its way is not pluginpack's to delete.
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const linkTarget = path.resolve(
      path.dirname(destination),
      await fs.readlink(destination),
    );
    if (!isInside(root, linkTarget)) {
      throw new UnsafeRemovalError(
        `Refusing to remove a symlink pointing outside the output directory: ${relativePath}`,
      );
    }
  }
  // The checks above are lexical, or inspect only the final entry. Neither sees
  // a path whose *intermediate* directory is a symlink pointing elsewhere: the
  // string test passes and the final entry is an ordinary file. Resolve the
  // real destination as the catch-all before deleting.
  if ((await resolveInside(root, destination)) === null) {
    throw new UnsafeRemovalError(
      `Refusing to remove a path that resolves outside the output directory: ${relativePath}`,
    );
  }
  return destination;
}

/**
 * Runs the containment checks `removeManagedPath` runs, for every path, before
 * anything is written or deleted. Dry runs run it too, so `--dry-run` refuses
 * a path that escapes the output directory exactly where the real command
 * would, and a build refuses before writing new output.
 */
async function assertRemovalsContained(
  outDir: string,
  target: TargetName,
  paths: string[],
): Promise<void> {
  const root = path.resolve(outDir);
  for (const file of paths) {
    try {
      await inspectRemoval(root, file);
    } catch (error) {
      if (error instanceof UnsafeRemovalError) {
        throw new Error(
          `${error.message} (under ${outDir}). ${nothingDeleted(outDir, target)}`,
          { cause: error },
        );
      }
      throw uncheckedPathError(outDir, target, file, error);
    }
  }
}

async function removeManagedPath(
  outDir: string,
  relativePath: string,
  target: TargetName,
): Promise<void> {
  const root = path.resolve(outDir);
  const manifest = path.join(root, managedManifestPath(target));
  const recovery =
    `The managed manifest ${manifest} still lists every remaining path, so fix the cause and re-run the same command. ` +
    `To stop pluginpack managing these files instead, delete that manifest.`;
  let destination: string | null;
  try {
    destination = await inspectRemoval(root, relativePath);
  } catch (error) {
    if (error instanceof UnsafeRemovalError) {
      throw new Error(`${error.message}. ${recovery}`, { cause: error });
    }
    throw new Error(
      `Failed to check managed path "${relativePath}" under ${outDir}: ${(error as Error).message}. ${recovery}`,
      { cause: error },
    );
  }
  if (destination === null) {
    return;
  }
  try {
    await fs.rm(destination, { force: true });
  } catch (error) {
    throw new Error(
      `Failed to remove managed path "${relativePath}" under ${outDir}: ${(error as Error).message}. ${recovery}`,
      { cause: error },
    );
  }
  await removeEmptyParents(path.dirname(destination), root);
}

async function removeEmptyParents(dir: string, root: string): Promise<void> {
  let current = dir;
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (isNotFound(error) || isDirectoryNotEmpty(error)) {
        return;
      }
      throw error;
    }
    current = path.dirname(current);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
      (error as NodeJS.ErrnoException).code === "EEXIST")
  );
}
