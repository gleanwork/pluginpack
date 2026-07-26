import type { TargetName } from "./types.js";

/** Every recognized component directory, across all targets. */
export const componentDirs = [
  "skills",
  "agents",
  "commands",
  "rules",
  "hooks",
  "scripts",
  "assets",
  "policies",
  "themes",
];

/** Files copied verbatim to a target's output root rather than treated as components. */
export const staticFiles = ["README.md", "CHANGELOG.md", "LICENSE"];

/** Component directories emitted for a target when a plugin has no `components` override. */
export const targetDefaultComponents: Record<TargetName, readonly string[]> = {
  claude: ["skills", "agents", "hooks", "scripts", "assets"],
  copilot: ["skills", "agents", "hooks", "scripts", "assets"],
  cursor: ["skills", "agents", "rules", "hooks", "scripts", "assets"],
  antigravity: ["skills", "agents", "rules", "hooks", "scripts", "assets"],
  codex: ["skills", "hooks", "scripts", "assets"],
};

/** Resolves a plugin's component set from its own override, or the target's default. */
export function resolveTargetComponents(
  target: TargetName,
  pluginConfig: { components?: string[] },
): Set<string> {
  return new Set(pluginConfig.components ?? targetDefaultComponents[target]);
}

/** Whether a relative path falls under a recognized component directory. */
export function isComponentPath(relativePath: string): boolean {
  return componentDirs.includes(relativePath.split("/")[0]);
}
