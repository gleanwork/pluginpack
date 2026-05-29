import path from "node:path";
import { build } from "./build.js";
import { loadProjectConfig } from "./config.js";
import {
  buildDeleteGuard,
  cleanManagedFiles,
  pruneManagedFiles,
} from "./managed.js";
import type { CleanupResult, TargetName } from "./types.js";

export async function prune(
  options: {
    cwd?: string;
    configPath?: string;
    target?: TargetName;
    dryRun?: boolean;
    force?: boolean;
  } = {},
): Promise<CleanupResult[]> {
  const project = await loadProjectConfig(options.cwd, options.configPath);
  const guard = buildDeleteGuard(
    project.rootDir,
    project.config,
    project.configPath,
    options.force,
  );
  const artifacts = await build({
    cwd: options.cwd,
    configPath: options.configPath,
    target: options.target,
    dryRun: true,
  });
  const results: CleanupResult[] = [];
  for (const artifact of artifacts) {
    results.push(
      await pruneManagedFiles(artifact, { dryRun: options.dryRun, guard }),
    );
  }
  return results;
}

export async function clean(
  options: {
    cwd?: string;
    configPath?: string;
    target?: TargetName;
    dryRun?: boolean;
    force?: boolean;
  } = {},
): Promise<CleanupResult[]> {
  const project = await loadProjectConfig(options.cwd, options.configPath);
  const guard = buildDeleteGuard(
    project.rootDir,
    project.config,
    project.configPath,
    options.force,
  );
  const targets = options.target
    ? [options.target]
    : (Object.keys(project.config.targets) as TargetName[]);
  const results: CleanupResult[] = [];
  for (const target of targets) {
    const targetConfig = project.config.targets[target];
    if (!targetConfig) {
      throw new Error(`Target "${target}" is not configured.`);
    }
    const outDir = path.resolve(project.rootDir, targetConfig.outDir);
    results.push(
      await cleanManagedFiles(outDir, target, {
        dryRun: options.dryRun,
        guard,
      }),
    );
  }
  return results;
}
