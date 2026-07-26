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

/** Writes every file in `files` under `outDir`, refusing to write outside it. */
export async function writeArtifact(
  outDir: string,
  files: Map<string, FileValue>,
): Promise<void> {
  const resolvedOut = path.resolve(outDir);
  for (const [relativePath, value] of files) {
    const destination = path.resolve(outDir, relativePath);
    if (
      destination !== resolvedOut &&
      !destination.startsWith(resolvedOut + path.sep)
    ) {
      throw new Error(
        `Refusing to write outside the output directory: ${relativePath}`,
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
