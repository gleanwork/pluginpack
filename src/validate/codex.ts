import path from "node:path";
import {
  error,
  readJson,
  validateFrontmatter,
  validateHooks,
  validateMarketplaceBasics,
  validatePluginEntry,
} from "./shared.js";
import type { ValidationIssue } from "../types.js";

export async function validateCodex(
  root: string,
  issues: ValidationIssue[],
): Promise<void> {
  const marketplacePath = path.join(
    root,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  const marketplace = await readJson(
    marketplacePath,
    "Marketplace manifest",
    issues,
  );
  if (!marketplace) {
    return;
  }
  validateMarketplaceBasics(marketplace, issues);
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (plugins.length === 0) {
    error(issues, 'Marketplace "plugins" must be a non-empty array.');
    return;
  }
  for (const [index, entry] of plugins.entries()) {
    const pluginName = validatePluginEntry(entry, index, root, issues);
    if (!pluginName) {
      continue;
    }
    const pluginDir = path.join(root, entry.source);
    const manifest = await readJson(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      `${pluginName} plugin manifest`,
      issues,
    );
    if (!manifest) {
      continue;
    }
    if (manifest.name !== pluginName) {
      error(
        issues,
        `${pluginName}: marketplace entry name does not match plugin.json name ("${manifest.name}").`,
      );
    }
    for (const field of ["name", "version", "description"]) {
      if (typeof manifest[field] !== "string" || !manifest[field]) {
        error(
          issues,
          `${pluginName}: plugin.json is missing required field "${field}".`,
        );
      }
    }
    await validateFrontmatter(pluginDir, pluginName, "codex", issues);
    await validateHooks(pluginDir, pluginName, issues);
  }
}
