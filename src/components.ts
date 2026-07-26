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

/** Whether a relative path falls under a recognized component directory. */
export function isComponentPath(relativePath: string): boolean {
  return componentDirs.includes(relativePath.split("/")[0]);
}
