import { loadConfig } from "./config.js";
import { writeArtifact } from "./fs.js";
import { emitTarget } from "./targets.js";
import type { Artifact, BuildOptions, TargetName } from "./types.js";

const allTargets: TargetName[] = ["cursor", "claude", "gemini", "copilot"];

export async function build(options: BuildOptions = {}): Promise<Artifact[]> {
  const project = await loadConfig(options.cwd, options.configPath);
  const targets = options.target
    ? [options.target]
    : allTargets.filter((target) => project.config.targets[target]);
  const artifacts: Artifact[] = [];
  for (const target of targets) {
    const artifact = await emitTarget(project, target, options.outDir);
    artifacts.push(artifact);
    if (!options.dryRun) {
      await writeArtifact(artifact.outDir, artifact.files);
    }
  }
  return artifacts;
}
