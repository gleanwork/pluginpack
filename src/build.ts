import path from "node:path";
import { loadConfig } from "./config.js";
import { writeArtifact } from "./fs.js";
import {
  buildDeleteGuard,
  pruneManagedFiles,
  writeManagedManifest,
} from "./managed.js";
import { emitTarget } from "./targets.js";
import type { Artifact, BuildOptions, TargetName } from "./types.js";

const allTargets: TargetName[] = ["cursor", "claude", "antigravity", "copilot"];

export async function build(options: BuildOptions = {}): Promise<Artifact[]> {
  const project = await loadConfig(options.cwd, options.configPath);
  const targets = options.target
    ? [options.target]
    : allTargets.filter((target) => project.config.targets[target]);
  const guard = buildDeleteGuard(
    project.rootDir,
    project.config,
    project.configPath,
  );
  const artifacts: Artifact[] = [];
  for (const target of targets) {
    artifacts.push(await emitTarget(project, target, options.outDir));
  }
  assertNoCrossTargetCollisions(artifacts);
  if (!options.dryRun) {
    for (const artifact of artifacts) {
      await pruneManagedFiles(artifact, { guard });
      await writeArtifact(artifact.outDir, artifact.files);
      await writeManagedManifest(artifact);
    }
  }
  return artifacts;
}

// Two targets pointed at overlapping output paths would silently overwrite each
// other (and one target's prune could delete the other's files). Catch it.
function assertNoCrossTargetCollisions(artifacts: Artifact[]): void {
  const owner = new Map<string, TargetName>();
  const collisions: string[] = [];
  for (const artifact of artifacts) {
    for (const managedPath of artifact.managedPaths) {
      const absolute = path.resolve(artifact.outDir, managedPath);
      const previous = owner.get(absolute);
      if (previous && previous !== artifact.target) {
        collisions.push(`  ${previous} and ${artifact.target}: ${absolute}`);
      } else {
        owner.set(absolute, artifact.target);
      }
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Targets write overlapping output paths; give them distinct outDirs:\n${collisions.join("\n")}`,
    );
  }
}
