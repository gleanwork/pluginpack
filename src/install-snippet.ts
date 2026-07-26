import { targets as registry } from "./targets/registry.js";
import type {
  Citation,
  InstallParams,
  InstallSnippet,
} from "./targets/types.js";
import type { TargetName } from "./types.js";

export type {
  Citation,
  InstallParams,
  InstallSnippet,
} from "./targets/types.js";

/**
 * Builds the real, doc-verified command or URL a user needs to add a
 * pluginpack-built marketplace for `target`. See each target's
 * `installSnippet.citation` (and `getInstallSnippetCitation`) for the source
 * this is based on.
 */
export function buildInstallSnippet(
  target: TargetName,
  params: InstallParams,
): InstallSnippet {
  const definition = registry[target].installSnippet;
  if (!definition.userConfigurable || !definition.build) {
    return {
      userConfigurable: false,
      reason:
        definition.unsupportedReason ??
        `${target} has no install command or URL.`,
    };
  }
  return { userConfigurable: true, ...definition.build(params) };
}

/** The citation backing `target`'s install snippet. */
export function getInstallSnippetCitation(target: TargetName): Citation {
  return registry[target].installSnippet.citation;
}

/** Targets with a real, user-configurable install snippet today. */
export function getSupportedInstallTargets(): TargetName[] {
  return (Object.keys(registry) as TargetName[]).filter(
    (target) => registry[target].installSnippet.userConfigurable,
  );
}

/** Targets with no install snippet — empty today, kept for forward-compatibility. */
export function getUnsupportedInstallTargets(): TargetName[] {
  return (Object.keys(registry) as TargetName[]).filter(
    (target) => !registry[target].installSnippet.userConfigurable,
  );
}
