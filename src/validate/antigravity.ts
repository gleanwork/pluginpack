import { promises as fs } from "node:fs";
import path from "node:path";
import { exists } from "../fs.js";
import {
  error,
  pluginNamePattern,
  readJson,
  validateFrontmatter,
  validateHooks,
} from "./shared.js";
import type { ValidationIssue } from "../types.js";

export async function validateAntigravity(
  root: string,
  issues: ValidationIssue[],
): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const pluginDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name));
  if (pluginDirs.length === 0) {
    error(
      issues,
      "Antigravity output must contain at least one plugin directory.",
    );
    return;
  }
  for (const pluginDir of pluginDirs) {
    const manifest = await readJson(
      path.join(pluginDir, "plugin.json"),
      "Antigravity plugin manifest",
      issues,
    );
    if (!manifest) {
      continue;
    }
    const pluginName = path.basename(pluginDir);
    if (
      typeof manifest.name !== "string" ||
      !pluginNamePattern.test(manifest.name)
    ) {
      error(
        issues,
        `${pluginName}: plugin.json must have a lowercase kebab-case "name".`,
      );
    }
    if (manifest.name && manifest.name !== pluginName) {
      error(
        issues,
        `${pluginName}: manifest name must match plugin directory name.`,
      );
    }
    for (const field of ["version", "description"]) {
      if (typeof manifest[field] !== "string" || !manifest[field]) {
        error(
          issues,
          `${pluginName}: plugin.json is missing required field "${field}".`,
        );
      }
    }
    const mcpConfigPath = path.join(pluginDir, "mcp_config.json");
    if (await exists(mcpConfigPath)) {
      await readJson(mcpConfigPath, `${pluginName} MCP config`, issues);
    }
    await validateFrontmatter(pluginDir, pluginName, "antigravity", issues);
    await validateHooks(pluginDir, pluginName, issues);
  }
}
