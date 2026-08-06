import { promises as fs } from "node:fs";
import path from "node:path";
import fastGlob from "fast-glob";
import type { FileValue } from "./types.js";

/** Converts OS-specific path separators to forward slashes. */
export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** Lists every file under `dir`, recursively, as absolute paths, sorted. */
export async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fastGlob("**/*", {
    cwd: dir,
    absolute: true,
    onlyFiles: true,
    dot: true,
  });
  return entries.sort();
}

/** Whether `candidate` is `root` itself or sits beneath it, comparing already-resolved paths. */
export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * `isInside`, comparing the way a case-insensitive filesystem does.
 *
 * On APFS and NTFS `fs.rm` resolves `Skills/x` and `skills/x` to the same file,
 * so an exact-match containment test can be walked past by one letter of case.
 * Folding case and Unicode normalization over-matches on a case-sensitive host,
 * which is the right direction for a check that decides whether to refuse.
 */
export function isInsideFolded(root: string, candidate: string): boolean {
  return isInside(root, candidate) || isInside(fold(root), fold(candidate));
}

function fold(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * Resolves `target` with symlinks followed, or returns `null` if the result
 * escapes `root`.
 *
 * `path.resolve` is purely lexical, so a prefix test against it is satisfied by
 * a path whose *intermediate* directory is a symlink pointing elsewhere —
 * `<outDir>/link/file` passes the string check while landing wherever `link`
 * points. Checking the final entry with `lstat` does not help either, since the
 * final entry is an ordinary file.
 *
 * Both sides go through the same resolution, which matters more than it looks:
 * resolving only the target and comparing against a lexical root rejects every
 * ordinary write whenever any ancestor of the output directory is itself a
 * symlink — `/tmp` is one on macOS — and does so precisely when the output
 * directory does not exist yet, i.e. on a first build.
 */
export async function resolveInside(
  root: string,
  target: string,
): Promise<string | null> {
  const realRoot = await realpathDeep(root);
  const realTarget = await realpathDeep(target);
  return isInside(realRoot, realTarget) ? realTarget : null;
}

/**
 * `fs.realpath` for a path that may not exist yet: resolves symlinks on the
 * deepest ancestor that does exist, then re-attaches the missing tail.
 */
async function realpathDeep(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...[...missing].reverse());
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(target);
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Writes every file in `files` under `outDir`, refusing to write outside it. */
export async function writeArtifact(
  outDir: string,
  files: Map<string, FileValue>,
): Promise<void> {
  const resolvedOut = path.resolve(outDir);
  for (const [relativePath, value] of files) {
    const destination = path.resolve(outDir, relativePath);
    if (!isInside(resolvedOut, destination)) {
      throw new Error(
        `Refusing to write outside the output directory: ${relativePath}`,
      );
    }
    // The lexical check above cannot see through a symlinked intermediate
    // directory, so confirm the real destination too, before creating anything.
    if ((await resolveInside(resolvedOut, destination)) === null) {
      throw new Error(
        `Refusing to write through a symlink that leaves the output directory: ${relativePath}`,
      );
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, value);
  }
}

/** Serializes `value` as pretty-printed JSON with a trailing newline. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Whether `value` is a URL, or a relative path that can't escape its base directory. */
export function isSafeRelativePath(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return true;
  }
  if (path.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  return normalized !== ".." && !normalized.startsWith("../");
}

/** Whether the file at `filePath` exists. */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether `error` is an ENOENT/ENOTDIR ("path doesn't exist") rather than a
 * real IO/permission failure (EACCES, ELOOP, …) that should surface instead
 * of being read as "does not exist".
 */
export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
