import { promises as fs } from "node:fs";
import path from "node:path";
import { json, toPosix } from "./fs.js";
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
  let parsed: Partial<ManagedManifest>;
  try {
    parsed = JSON.parse(raw) as Partial<ManagedManifest>;
  } catch {
    throw new Error(`Invalid managed manifest: ${manifestPath}`);
  }
  if (
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

/** Builds the guard that stops prune/clean from deleting paths inside the config's source tree. */
export function buildDeleteGuard(
  rootDir: string,
  config: PluginpackConfig,
  configPath: string,
  force?: boolean,
): DeleteGuard {
  const protectedRoots: string[] = [];
  if (config.source?.skills) {
    protectedRoots.push(path.resolve(rootDir, config.source.skills));
  }
  // Mirrors loadConfig's default in src/config.ts so the source-plugin
  // discovery root is always protected, whether or not it's written out
  // explicitly in config.
  protectedRoots.push(
    path.resolve(rootDir, config.source?.plugins ?? "plugins"),
  );
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
  const blocked = paths.filter((file) =>
    isProtectedDeletion(outDir, file, guard),
  );
  if (blocked.length === 0) {
    return;
  }
  throw new Error(
    `Refusing to ${command} ${blocked.length} path(s) that resolve inside your source tree or config:\n` +
      `${blocked.map((file) => `  ${file}`).join("\n")}\n` +
      `This usually means a target outDir overlaps source.skills/source.plugins. ` +
      `Fix the config, or re-run with --force to delete anyway.`,
  );
}

function isProtectedDeletion(
  outDir: string,
  relativePath: string,
  guard: DeleteGuard,
): boolean {
  const absolute = path.resolve(outDir, normalizeManagedPath(relativePath));
  if (guard.configPath && absolute === guard.configPath) {
    return true;
  }
  return guard.protectedRoots.some(
    (root) => absolute === root || absolute.startsWith(`${root}${path.sep}`),
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
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Managed path escapes output directory: ${relativePath}`);
  }
  // Defense in depth: fs.rm on a symlink unlinks the symlink itself rather
  // than following it, so this isn't currently exploitable — but refuse
  // outright if the entry is a symlink pointing outside `root`, rather than
  // relying on that fs.rm behavior remaining true forever.
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
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `Refusing to remove a symlink pointing outside the output directory: ${relativePath}`,
      );
    }
  }
  await fs.rm(destination, { force: true });
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
