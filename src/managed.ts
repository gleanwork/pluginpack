import { promises as fs } from "node:fs";
import path from "node:path";
import { isInside, json, resolveInside, toPosix } from "./fs.js";
import { listSourcePluginDirs } from "./config.js";
import type {
  Artifact,
  CleanupEntry,
  CleanupResult,
  DeleteGuard,
  PluginpackConfig,
  TargetName,
} from "./types.js";

type ManagedManifest = {
  version: 1;
  target: TargetName;
  files: string[];
};

/** Output-relative path of a target's managed-file manifest. */
export function managedManifestPath(target: TargetName): string {
  return toPosix(path.join(".pluginpack", `${target}.json`));
}

/** Writes the list of files a build produced, for later prune/clean/diff to compare against. */
export async function writeManagedManifest(artifact: Artifact): Promise<void> {
  const manifest: ManagedManifest = {
    version: 1,
    target: artifact.target,
    files: artifact.managedPaths,
  };
  const destination = path.join(
    artifact.outDir,
    managedManifestPath(artifact.target),
  );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, json(manifest));
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
  let parsed: Partial<ManagedManifest> | null;
  try {
    parsed = JSON.parse(raw) as Partial<ManagedManifest> | null;
  } catch {
    throw new Error(`Invalid managed manifest: ${manifestPath}`);
  }
  if (
    // `JSON.parse` happily returns null, a number, or a string for a
    // truncated or hand-edited manifest; those must land on the same clear
    // error as malformed JSON, not a TypeError from the field checks below.
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    parsed.target !== target ||
    !Array.isArray(parsed.files) ||
    !parsed.files.every((file) => typeof file === "string")
  ) {
    throw new Error(`Invalid managed manifest: ${manifestPath}`);
  }
  return parsed as ManagedManifest;
}

/** Deletes files the previous build managed but the current one no longer produces. */
export async function pruneManagedFiles(
  artifact: Artifact,
  options: { dryRun?: boolean; guard?: DeleteGuard } = {},
): Promise<CleanupResult> {
  const previous = await readManagedManifest(artifact.outDir, artifact.target);
  const current = new Set(artifact.managedPaths.map(normalizeManagedPath));
  const stale = (previous?.files ?? [])
    .map(normalizeManagedPath)
    .filter((file) => !current.has(file));
  if (!options.dryRun) {
    assertNoProtectedDeletions(artifact.outDir, stale, options.guard, "prune");
  }
  const entries: CleanupEntry[] = [];
  for (const normalized of stale) {
    entries.push({
      type: "stale",
      target: artifact.target,
      path: normalized,
    });
    if (!options.dryRun) {
      await removeManagedPath(artifact.outDir, normalized);
    }
  }
  return {
    target: artifact.target,
    outDir: artifact.outDir,
    entries,
  };
}

/** Deletes every file the previous build managed for a target, including its manifest. */
export async function cleanManagedFiles(
  outDir: string,
  target: TargetName,
  options: { dryRun?: boolean; guard?: DeleteGuard } = {},
): Promise<CleanupResult> {
  const previous = await readManagedManifest(outDir, target);
  const entries: CleanupEntry[] = [];
  if (!previous) {
    return { target, outDir, entries };
  }
  const files = (previous.files ?? []).map(normalizeManagedPath);
  if (!options.dryRun) {
    assertNoProtectedDeletions(outDir, files, options.guard, "clean");
  }
  for (const normalized of files) {
    entries.push({ type: "deleted", target, path: normalized });
    if (!options.dryRun) {
      await removeManagedPath(outDir, normalized);
    }
  }
  const manifestPath = managedManifestPath(target);
  entries.push({ type: "deleted", target, path: manifestPath });
  if (!options.dryRun) {
    await removeManagedPath(outDir, manifestPath);
  }
  return { target, outDir, entries };
}

/**
 * Builds the guard that stops prune/clean from deleting the config or a source tree.
 *
 * `source.plugins` gets different treatment depending on whether it was set:
 * when the user names a directory as their source-plugin root, that whole
 * directory is protected. When they don't, the default root is `plugins/` —
 * which is also where the recommended layout writes every target's *output*, so
 * protecting it wholesale made the documented layout refuse to prune its own
 * generated files after any source file was removed. Under the default, protect
 * only the directories that really are source plugins.
 */
export async function buildDeleteGuard(
  rootDir: string,
  config: PluginpackConfig,
  configPath: string,
  force?: boolean,
): Promise<DeleteGuard> {
  const protectedRoots: string[] = [];
  if (config.source?.skills) {
    protectedRoots.push(path.resolve(rootDir, config.source.skills));
  }
  if (config.source?.partials) {
    protectedRoots.push(path.resolve(rootDir, config.source.partials));
  }
  if (config.source?.plugins) {
    protectedRoots.push(path.resolve(rootDir, config.source.plugins));
  } else {
    protectedRoots.push(
      ...(await listSourcePluginDirs(path.resolve(rootDir, "plugins"))),
    );
  }
  return { protectedRoots, configPath: path.resolve(configPath), force };
}

function assertNoProtectedDeletions(
  outDir: string,
  paths: string[],
  guard: DeleteGuard | undefined,
  command: string,
): void {
  if (!guard || guard.force) {
    return;
  }
  const blocked = paths
    .map((file) => ({ file, root: protectingRoot(outDir, file, guard) }))
    .filter(
      (entry): entry is { file: string; root: string } => entry.root !== null,
    );
  if (blocked.length === 0) {
    return;
  }
  throw new Error(
    `Refusing to ${command} ${blocked.length} path(s) that resolve inside your source tree or config:\n` +
      `${blocked.map(({ file, root }) => `  ${file} -> resolves inside ${root}`).join("\n")}\n` +
      `This usually means a target outDir overlaps source.skills/source.plugins. ` +
      `Fix the config, or re-run with --force to delete anyway.`,
  );
}

/**
 * The protected root `relativePath` resolves inside, or `null` if it is safe to
 * delete. Returns the matching root rather than a boolean so the refusal can
 * name what it collided with — "resolves inside <path>" is actionable in a way
 * that a bare list of refused paths is not.
 *
 * Comparison is case- and normalization-folded, not exact. On a case-insensitive
 * filesystem (APFS, NTFS) `fs.rm` resolves `Skills/x` and `skills/x` to the same
 * file, so an exact-match guard can be walked straight past by one letter of
 * case — reachable from a single typo in `source.skills` that the OS forgives,
 * or a case-only rename in git history. Folding over-protects on a
 * case-sensitive host, which is the correct direction for a guard whose job is
 * refusing to delete.
 */
function protectingRoot(
  outDir: string,
  relativePath: string,
  guard: DeleteGuard,
): string | null {
  const absolute = path.resolve(outDir, normalizeManagedPath(relativePath));
  if (guard.configPath && pathsEqual(absolute, guard.configPath)) {
    return guard.configPath;
  }
  return (
    guard.protectedRoots.find(
      (root) => pathsEqual(absolute, root) || isUnder(absolute, root),
    ) ?? null
  );
}

/** Case- and normalization-folded form, for comparing paths the filesystem treats as equal. */
function fold(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function pathsEqual(a: string, b: string): boolean {
  return a === b || fold(a) === fold(b);
}

function isUnder(candidate: string, root: string): boolean {
  return (
    candidate.startsWith(`${root}${path.sep}`) ||
    fold(candidate).startsWith(`${fold(root)}${path.sep}`)
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

async function removeManagedPath(
  outDir: string,
  relativePath: string,
): Promise<void> {
  const root = path.resolve(outDir);
  const normalized = normalizeManagedPath(relativePath);
  const destination = path.resolve(root, normalized);
  if (!isInside(root, destination)) {
    throw new Error(`Managed path escapes output directory: ${relativePath}`);
  }
  let stats;
  try {
    stats = await fs.lstat(destination);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const target = path.resolve(
      path.dirname(destination),
      await fs.readlink(destination),
    );
    if (!isInside(root, target)) {
      throw new Error(
        `Refusing to remove a symlink pointing outside the output directory: ${relativePath}`,
      );
    }
  }
  // The checks above are lexical, or inspect only the final entry. Neither sees
  // a path whose *intermediate* directory is a symlink pointing elsewhere: the
  // string test passes and the final entry is an ordinary file. Resolve the
  // real destination as the catch-all before deleting.
  if ((await resolveInside(root, destination)) === null) {
    throw new Error(
      `Refusing to remove a path that resolves outside the output directory: ${relativePath}`,
    );
  }
  try {
    await fs.rm(destination, { force: true });
  } catch (error) {
    throw new Error(
      `Failed to remove managed path "${relativePath}" under ${outDir}: ${(error as Error).message}. ` +
        `The managed manifest still lists every path, so re-running is safe once the cause is fixed.`,
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
