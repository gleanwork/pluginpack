import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "./build.js";
import { exists, loadConfig } from "./config.js";
import type { DiffEntry, DiffResult, TargetName } from "./types.js";

export async function diffTarget(options: {
  cwd?: string;
  configPath?: string;
  target: TargetName;
  against: string;
}): Promise<DiffResult> {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "pluginpack-diff-"));
  try {
    const project = await loadConfig(options.cwd, options.configPath);
    const ignoredDiffPaths =
      project.config.targets[options.target]?.ignoredDiffPaths ?? [];
    const [artifact] = await build({
      cwd: options.cwd,
      configPath: options.configPath,
      target: options.target,
      outDir: tempDir,
    });
    const againstRoot = path.resolve(
      options.cwd ?? process.cwd(),
      options.against,
    );
    const entries: DiffEntry[] = [];
    for (const relativePath of artifact.managedPaths) {
      if (isIgnoredDiffPath(relativePath, ignoredDiffPaths)) {
        continue;
      }
      const generatedPath = path.join(tempDir, relativePath);
      const againstPath = path.join(againstRoot, relativePath);
      if (!(await exists(againstPath))) {
        entries.push({ type: "added", path: relativePath });
        continue;
      }
      const [generated, existing] = await Promise.all([
        fs.readFile(generatedPath),
        fs.readFile(againstPath),
      ]);
      if (!generated.equals(existing)) {
        entries.push({ type: "changed", path: relativePath });
      }
    }
    return {
      ok: entries.length === 0,
      entries,
    };
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

function isIgnoredDiffPath(
  relativePath: string,
  ignoredPaths: string[],
): boolean {
  const normalized = normalizeDiffPath(relativePath);
  return ignoredPaths.some((ignoredPath) => {
    const ignored = normalizeDiffPath(ignoredPath);
    return normalized === ignored || normalized.startsWith(`${ignored}/`);
  });
}

function normalizeDiffPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}
