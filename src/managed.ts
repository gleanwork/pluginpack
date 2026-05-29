import { promises as fs } from "node:fs";
import path from "node:path";
import { json, toPosix } from "./fs.js";
import type {
  Artifact,
  CleanupEntry,
  CleanupResult,
  TargetName,
} from "./types.js";

type ManagedManifest = {
  version: 1;
  target: TargetName;
  files: string[];
};

export function managedManifestPath(target: TargetName): string {
  return toPosix(path.join(".pluginpack", `${target}.json`));
}

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
  const parsed = JSON.parse(raw) as Partial<ManagedManifest>;
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

export async function pruneManagedFiles(
  artifact: Artifact,
  options: { dryRun?: boolean } = {},
): Promise<CleanupResult> {
  const previous = await readManagedManifest(artifact.outDir, artifact.target);
  const current = new Set(artifact.managedPaths.map(normalizeManagedPath));
  const entries: CleanupEntry[] = [];
  for (const file of previous?.files ?? []) {
    const normalized = normalizeManagedPath(file);
    if (current.has(normalized)) {
      continue;
    }
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

export async function cleanManagedFiles(
  outDir: string,
  target: TargetName,
  options: { dryRun?: boolean } = {},
): Promise<CleanupResult> {
  const previous = await readManagedManifest(outDir, target);
  const entries: CleanupEntry[] = [];
  if (!previous) {
    return { target, outDir, entries };
  }
  for (const file of previous?.files ?? []) {
    const normalized = normalizeManagedPath(file);
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

export function normalizeManagedPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (
    !value ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
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
