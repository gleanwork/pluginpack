import path from "node:path";
import { exists } from "../fs.js";
import {
  error,
  readJson,
  validateFrontmatter,
  validateMarketplaceBasics,
  validatePluginEntry,
} from "./shared.js";
import type { ValidationIssue } from "../types.js";

export async function validateCopilot(
  root: string,
  issues: ValidationIssue[],
): Promise<void> {
  const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
  const marketplace = await readJson(
    marketplacePath,
    "Marketplace manifest",
    issues,
  );
  if (!marketplace) {
    return;
  }
  validateMarketplaceBasics(marketplace, issues);
  if (
    !(await exists(path.join(root, ".github", "plugin", "marketplace.json")))
  ) {
    error(
      issues,
      "Copilot output must mirror the marketplace at .github/plugin/marketplace.json.",
    );
  }
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
    await validateFrontmatter(
      path.join(root, entry.source),
      pluginName,
      "copilot",
      issues,
    );
  }
}
