import { promises as fs } from "node:fs";
import path from "node:path";
import fastGlob from "fast-glob";
import type { FileValue } from "./types.js";

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fastGlob("**/*", {
    cwd: dir,
    absolute: true,
    onlyFiles: true,
    dot: true,
  });
  return entries.sort();
}

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

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

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

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
