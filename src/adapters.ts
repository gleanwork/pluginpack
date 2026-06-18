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

// The one place a target is wired. `Record<TargetName, …>` is exhaustive at
// compile time — a new TargetName won't build until it has an entry here — so
// emit dispatch, validate dispatch, the CLI `--target` choices, and the set
// build() iterates all derive from this single source instead of parallel maps.
export const adapters: Record<TargetName, TargetAdapter> = {
  cursor: { emit: emitCursor, validate: validateCursor },
  claude: { emit: emitClaude, validate: validateClaude },
  antigravity: { emit: emitAntigravity, validate: validateAntigravity },
  copilot: { emit: emitCopilot, validate: validateCopilot },
  codex: { emit: emitCodex, validate: validateCodex },
};

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
