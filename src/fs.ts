import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileValue } from "./types.js";

/** Converts OS-specific path separators to forward slashes. */
export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Lists every file under `dir`, recursively, as absolute paths, sorted.
 * Dotfiles are included. Symlinks are followed: a link to a file is listed
 * as a file and a link to a directory is walked, except a link back to a
 * directory already being walked, which would loop. Broken links are
 * skipped. A missing `dir` yields no files; a `dir` that is a file is an
 * error, since reading it as an empty directory would silently drop content
 * the author meant to ship.
 */
export async function walkFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string, ancestors: Set<string>) {
    let real: string;
    let entries;
    try {
      real = await fs.realpath(current);
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (await isExistingNonDirectory(err, current)) {
        throw new Error(
          `Expected a directory but found a file: ${current}. Move the file into a directory of that name, or remove it.`,
          { cause: err },
        );
      }
      if (isNotFoundError(err)) {
        return;
      }
      throw err;
    }
    if (ancestors.has(real)) {
      return;
    }
    const below = new Set(ancestors).add(real);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let isFile = entry.isFile();
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        const stats = await fs.stat(full).catch(() => null);
        isFile = stats?.isFile() ?? false;
        isDirectory = stats?.isDirectory() ?? false;
      }
      if (isDirectory) {
        await walk(full, below);
      } else if (isFile) {
        files.push(full);
      }
    }
  }
  await walk(path.resolve(dir), new Set());
  return files.sort();
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
 * The key two paths share when they name the same file on this host: the
 * physical path (symlinks resolved on the deepest existing ancestor), folded
 * for case and Unicode normalization when that ancestor's volume compares
 * names case-insensitively (APFS and NTFS by default).
 *
 * Every check that decides whether a delete or write is safe, or whether two
 * targets claim the same file, compares these keys. Comparing `path.resolve`
 * strings instead lets an alias walk past the check: `out` and `OUT` on APFS,
 * or a symlink into a source tree, are different strings but one file.
 *
 * With `entry` set, only the parent is resolved and the final name is kept,
 * which is the file `fs.rm` removes when the final entry is itself a symlink.
 * Use it for deletions and ownership; leave it off for a root being protected.
 */
export async function physicalKey(
  target: string,
  options: { entry?: boolean } = {},
): Promise<string> {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  const real =
    options.entry && parent !== absolute
      ? path.join(await realpathDeep(parent), path.basename(absolute))
      : await realpathDeep(absolute);
  return (await isCaseInsensitiveAt(real)) ? fold(real) : real;
}

const caseInsensitiveDirs = new Map<string, Promise<boolean>>();

/**
 * Whether names under `real`'s volume compare case-insensitively. Probes the
 * deepest existing component of `real` that has a cased letter: if the
 * case-swapped name is the same inode, the directory holding it folds case.
 * Falls back to the platform default (folding on macOS and Windows) when no
 * component can be probed, since over-matching is the safe direction for a
 * check that decides whether to refuse.
 */
async function isCaseInsensitiveAt(real: string): Promise<boolean> {
  let current = real;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return process.platform === "darwin" || process.platform === "win32";
    }
    const name = path.basename(current);
    const swapped = swapCase(name);
    // Skip names whose case swap does not round-trip ("ß" -> "SS"): the
    // swapped name would be a different name, not a different case.
    if (swapped !== name && swapCase(swapped) === name) {
      const stats = await fs.lstat(current).catch(() => null);
      if (stats) {
        let cached = caseInsensitiveDirs.get(parent);
        if (!cached) {
          cached = fs.lstat(path.join(parent, swapped)).then(
            (other) => other.ino === stats.ino && other.dev === stats.dev,
            () => false,
          );
          caseInsensitiveDirs.set(parent, cached);
        }
        return cached;
      }
    }
    current = parent;
  }
}

function swapCase(value: string): string {
  return [...value]
    .map((char) =>
      char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
    )
    .join("");
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

/**
 * Whether `value` is a URL, or a relative path that can't escape its base
 * directory. For a value that may be either, such as a marketplace entry's
 * `source`. A value that is only ever read from or written to disk must use
 * `isSafeRelativeFilePath` instead.
 */
export function isSafeRelativePath(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return true;
  }
  return isSafeRelativeFilePath(value);
}

/**
 * Whether `value` is a relative filesystem path that can't escape its base
 * directory. Unlike `isSafeRelativePath`, a URL gets no exemption: passed to
 * `path.resolve`, `https://../../outside` is just a path with a `..` in it,
 * and lands outside the base.
 */
export function isSafeRelativeFilePath(value: string): boolean {
  if (!value || path.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  return (
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !path.posix.isAbsolute(normalized) &&
    // A Windows drive-letter path resolves as absolute on Windows.
    !/^[a-zA-Z]:/.test(normalized)
  );
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

/**
 * Whether `error` is an ENOTDIR raised because `dir` itself exists as a file,
 * rather than because some ancestor of it is a file (which means `dir` is
 * simply missing).
 */
async function isExistingNonDirectory(
  error: unknown,
  dir: string,
): Promise<boolean> {
  if (
    !(error instanceof Error) ||
    (error as NodeJS.ErrnoException).code !== "ENOTDIR"
  ) {
    return false;
  }
  const stats = await fs.stat(dir).catch(() => null);
  return stats !== null && !stats.isDirectory();
}
