import type { TargetName } from "./types.js";

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

export const staticFiles = ["README.md", "CHANGELOG.md", "LICENSE"];

export const targetDefaultComponents: Record<TargetName, readonly string[]> = {
  claude: ["skills", "agents", "hooks", "scripts", "assets"],
  copilot: ["skills", "agents", "hooks", "scripts", "assets"],
  cursor: ["skills", "agents", "rules", "hooks", "scripts", "assets"],
  antigravity: ["skills", "agents", "rules", "hooks", "scripts", "assets"],
  codex: ["skills", "agents", "hooks", "scripts", "assets"],
};

export function resolveTargetComponents(
  target: TargetName,
  pluginConfig: { components?: string[] },
): Set<string> {
  return new Set(pluginConfig.components ?? targetDefaultComponents[target]);
}

export function isComponentPath(relativePath: string): boolean {
  return componentDirs.includes(relativePath.split("/")[0]);
}
