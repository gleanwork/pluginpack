import path from "node:path";
import {
  emitFromDefinition,
  validateFromDefinition,
  withRootFiles,
} from "./targets/engine.js";
import { targets as registry } from "./targets/registry.js";
import type {
  Artifact,
  ResolvedProject,
  TargetName,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

/** Every target name with a registry entry — the exhaustive list `build()` and the CLI derive from. */
export const targetNames = Object.keys(registry) as TargetName[];

/** Emits one target's output and applies its `rootFiles`, resolving `outDir` from config if omitted. */
export async function emitTarget(
  project: ResolvedProject,
  target: TargetName,
  outDir?: string,
): Promise<Artifact> {
  const targetConfig = project.config.targets[target];
  if (!targetConfig) {
    throw new Error(`Target "${target}" is not configured.`);
  }
  const resolvedOutDir = path.resolve(
    project.rootDir,
    outDir ?? targetConfig.outDir,
  );
  const result = await emitFromDefinition(
    project,
    target,
    targetConfig,
    resolvedOutDir,
    registry[target],
  );
  return withRootFiles(project, targetConfig, result);
}

/** Validates an already-built target's output directory. */
export async function validateOutput(
  target: TargetName,
  dir: string,
): Promise<ValidationResult> {
  const root = path.resolve(dir);
  const issues: ValidationIssue[] = [];
  await validateFromDefinition(root, issues, registry[target]);
  return {
    ok: issues.every((issue) => issue.level !== "error"),
    issues,
  };
}
