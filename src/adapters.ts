import path from "node:path";
import {
  emitAntigravity,
  emitClaude,
  emitCodex,
  emitCopilot,
  emitCursor,
  withRootFiles,
} from "./targets.js";
import {
  validateAntigravity,
  validateClaude,
  validateCodex,
  validateCopilot,
  validateCursor,
} from "./validate.js";
import {
  emitFromDefinition,
  validateFromDefinition,
} from "./targets/engine.js";
import { targets as registry } from "./targets/registry.js";
import type {
  Artifact,
  ResolvedProject,
  TargetConfig,
  TargetName,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

type TargetEmitter = (
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
) => Promise<Artifact>;

type TargetValidator = (
  root: string,
  issues: ValidationIssue[],
) => Promise<void>;

export type TargetAdapter = {
  emit: TargetEmitter;
  validate: TargetValidator;
};

// Legacy per-target functions, used only for targets not yet migrated to
// src/targets/registry.ts. Delete this map (and ../targets.ts/../validate.ts's
// per-target functions) once every TargetName has a registry entry.
const legacyAdapters: Record<TargetName, TargetAdapter> = {
  cursor: { emit: emitCursor, validate: validateCursor },
  claude: { emit: emitClaude, validate: validateClaude },
  antigravity: { emit: emitAntigravity, validate: validateAntigravity },
  copilot: { emit: emitCopilot, validate: validateCopilot },
  codex: { emit: emitCodex, validate: validateCodex },
};

// The one place a target is wired. `Record<TargetName, …>` is exhaustive at
// compile time — a new TargetName won't build until it has an entry here — so
// emit dispatch, validate dispatch, the CLI `--target` choices, and the set
// build() iterates all derive from this single source instead of parallel maps.
//
// During migration, a target resolves to the new registry (src/targets/*.ts)
// if it has an entry there, otherwise falls back to the legacy function —
// this map's shape stays the same either way, so callers never notice.
export const adapters: Record<TargetName, TargetAdapter> = Object.fromEntries(
  (Object.keys(legacyAdapters) as TargetName[]).map((target) => {
    const definition = registry[target];
    const adapter: TargetAdapter = definition
      ? {
          emit: (project, targetName, targetConfig, outDir) =>
            emitFromDefinition(
              project,
              targetName,
              targetConfig,
              outDir,
              definition,
            ),
          validate: (root, issues) =>
            validateFromDefinition(root, issues, definition),
        }
      : legacyAdapters[target];
    return [target, adapter];
  }),
) as Record<TargetName, TargetAdapter>;

export const targetNames = Object.keys(adapters) as TargetName[];

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
  const result = await adapters[target].emit(
    project,
    target,
    targetConfig,
    resolvedOutDir,
  );
  return withRootFiles(project, targetConfig, result);
}

export async function validateOutput(
  target: TargetName,
  dir: string,
): Promise<ValidationResult> {
  const root = path.resolve(dir);
  const issues: ValidationIssue[] = [];
  await adapters[target].validate(root, issues);
  return {
    ok: issues.every((issue) => issue.level !== "error"),
    issues,
  };
}
