import path from "node:path";
import { loadConfig } from "./config.js";
import { writeArtifact } from "./fs.js";
import {
  buildDeleteGuard,
  normalizeManagedPath,
  pruneManagedFiles,
  readManagedManifest,
  writeManagedManifest,
} from "./managed.js";
import { emitTarget, targetNames } from "./adapters.js";
import {
  findUnsubstitutedPartialTags,
  substitutedExtensions,
} from "./partials.js";
import type {
  Artifact,
  BuildOptions,
  ResolvedProject,
  TargetName,
} from "./types.js";

/** Builds every configured (or explicitly selected) target and writes its output, unless `dryRun` is set. */
export async function build(options: BuildOptions = {}): Promise<Artifact[]> {
  const project = await loadConfig(options.cwd, options.configPath);
  const targets = options.target
    ? [options.target]
    : targetNames.filter((target) => project.config.targets[target]);
  const guard = await buildDeleteGuard(project);
  const artifacts: Artifact[] = [];
  for (const target of targets) {
    artifacts.push(await emitTarget(project, target, options.outDir));
  }
  const owner = assertNoCrossTargetCollisions(artifacts);
  await assertNoCollisionsWithBuiltTargets(project, targets, owner);
  assertNoUnsubstitutedPartialTags(artifacts);
  if (!options.dryRun) {
    // Write every target's new files before pruning any target's stale ones.
    // If a later target's write throws, no target has had files pruned yet —
    // the previous build's output is still intact and a re-run starts from
    // the same state, rather than leaving one target with its stale files
    // already gone, its new files only partially written, and a manifest
    // that no longer matches either state.
    for (const artifact of artifacts) {
      await writeArtifact(artifact.outDir, artifact.files);
    }
    for (const artifact of artifacts) {
      await pruneManagedFiles(artifact, { guard });
      await writeManagedManifest(artifact);
    }
  }
  return artifacts;
}

/**
 * A `{{> name}}` tag that reaches output is broken content: whatever reads the
 * file gets a template marker instead of the text it was meant to inline.
 * Substitution resolves (or rejects) every tag in the file types it runs on, so
 * what is left is a tag authored somewhere it never ran — a reference file, a
 * script, a data file. Fail rather than ship it.
 */
function assertNoUnsubstitutedPartialTags(artifacts: Artifact[]): void {
  const found = artifacts.flatMap((artifact) =>
    findUnsubstitutedPartialTags(artifact.files).map(
      (tag) => `  ${artifact.target}: ${tag.path} contains ${tag.tag}`,
    ),
  );
  if (found.length > 0) {
    throw new Error(
      `Unsubstituted partial references in emitted output:\n${found.join("\n")}\n` +
        `Partial substitution only runs on ${substitutedExtensions()} files. ` +
        `Move the shared text into one of those, or inline it here instead.`,
    );
  }
}

/**
 * Two targets pointed at overlapping output paths would silently overwrite each
 * other (and one target's prune could delete the other's files). Catch it.
 * Returns the absolute-path -> owning-target map so
 * `assertNoCollisionsWithBuiltTargets` can reuse it.
 */
function assertNoCrossTargetCollisions(
  artifacts: Artifact[],
): Map<string, TargetName> {
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
  return owner;
}

/**
 * `assertNoCrossTargetCollisions` only sees artifacts built in *this*
 * invocation. Running `pluginpack build --target X` after an earlier
 * `pluginpack build --target Y` wrote overlapping paths would otherwise slip
 * through — X's build would silently overwrite Y's files, and a later
 * `clean --target Y` would then delete what are now X's live files. Guard
 * against that by also checking incoming paths against every other
 * *configured* target's on-disk managed manifest, not just artifacts present
 * in the current invocation.
 */
async function assertNoCollisionsWithBuiltTargets(
  project: ResolvedProject,
  targets: TargetName[],
  incoming: Map<string, TargetName>,
): Promise<void> {
  const building = new Set(targets);
  const collisions: string[] = [];
  for (const other of targetNames) {
    if (building.has(other)) {
      continue;
    }
    const otherConfig = project.config.targets[other];
    if (!otherConfig) {
      continue;
    }
    const otherOutDir = path.resolve(project.rootDir, otherConfig.outDir);
    const manifest = await readManagedManifest(otherOutDir, other);
    if (!manifest) {
      continue;
    }
    for (const file of manifest.files) {
      const absolute = path.resolve(otherOutDir, normalizeManagedPath(file));
      const conflicting = incoming.get(absolute);
      if (conflicting) {
        collisions.push(
          `  ${other} (previously built) and ${conflicting}: ${absolute}`,
        );
      }
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Target output overlaps a previously built target's managed files; give them distinct outDirs:\n${collisions.join("\n")}\n` +
        `Run a full \`build\` (no --target) to see every target's paths at once, or fix the outDir configuration.`,
    );
  }
}
