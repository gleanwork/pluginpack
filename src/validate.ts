import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { exists, isSafeRelativePath, toPosix, walkFiles } from "./fs.js";
import type { TargetName, ValidationIssue, ValidationResult } from "./types.js";

const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const marketplaceNamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export async function validateOutput(
  target: TargetName,
  dir: string,
): Promise<ValidationResult> {
  const root = path.resolve(dir);
  const issues: ValidationIssue[] = [];
  if (target === "cursor") {
    await validateCursor(root, issues);
  } else if (target === "claude") {
    await validateClaude(root, issues);
  } else if (target === "gemini") {
    await validateGemini(root, issues);
  } else {
    await validateCopilot(root, issues);
  }
  return {
    ok: issues.every((issue) => issue.level !== "error"),
    issues,
  };
}

async function validateGemini(
  root: string,
  issues: ValidationIssue[],
): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const extensionDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name));
  if (extensionDirs.length === 0) {
    error(
      issues,
      "Gemini output must contain at least one extension directory.",
    );
    return;
  }
  for (const extensionDir of extensionDirs) {
    const manifest = await readJson(
      path.join(extensionDir, "gemini-extension.json"),
      "Gemini extension manifest",
      issues,
    );
    if (!manifest) {
      continue;
    }
    const extensionName = path.basename(extensionDir);
    if (
      typeof manifest.name !== "string" ||
      !pluginNamePattern.test(manifest.name)
    ) {
      error(
        issues,
        `${extensionName}: gemini-extension.json must have a lowercase kebab-case "name".`,
      );
    }
    if (manifest.name && manifest.name !== extensionName) {
      error(
        issues,
        `${extensionName}: manifest name must match extension directory name.`,
      );
    }
    for (const field of ["version", "description"]) {
      if (typeof manifest[field] !== "string" || !manifest[field]) {
        error(
          issues,
          `${extensionName}: gemini-extension.json is missing required field "${field}".`,
        );
      }
    }
    await validateFrontmatter(extensionDir, extensionName, "gemini", issues);
    await validateHooks(extensionDir, extensionName, issues);
  }
}

async function validateCopilot(
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

async function validateCursor(
  root: string,
  issues: ValidationIssue[],
): Promise<void> {
  const marketplacePath = path.join(root, ".cursor-plugin", "marketplace.json");
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
      path.join(pluginDir, ".cursor-plugin", "plugin.json"),
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
    await validateReferencedManifestPaths(
      pluginDir,
      pluginName,
      manifest,
      ["logo", "commands", "agents", "skills", "rules", "hooks", "mcpServers"],
      issues,
    );
    await validateFrontmatter(pluginDir, pluginName, "cursor", issues);
  }
}

async function validateClaude(
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
      path.join(pluginDir, ".claude-plugin", "plugin.json"),
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
    if (
      !manifest.author ||
      typeof manifest.author.name !== "string" ||
      !manifest.author.name
    ) {
      error(issues, `${pluginName}: plugin.json is missing "author.name".`);
    }
    await validateFrontmatter(pluginDir, pluginName, "claude", issues);
    await validateHooks(pluginDir, pluginName, issues);
  }
}

function validateMarketplaceBasics(
  marketplace: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  if (
    typeof marketplace.name !== "string" ||
    !marketplaceNamePattern.test(marketplace.name)
  ) {
    error(
      issues,
      'Marketplace "name" must be lowercase kebab-case and start/end with an alphanumeric character.',
    );
  }
  const owner = marketplace.owner as Record<string, unknown> | undefined;
  if (owner && (typeof owner.name !== "string" || !owner.name)) {
    error(
      issues,
      'Marketplace "owner.name" must be a non-empty string when owner is present.',
    );
  }
}

function validatePluginEntry(
  entry: Record<string, string>,
  index: number,
  root: string,
  issues: ValidationIssue[],
): string | null {
  if (!entry || typeof entry !== "object") {
    error(issues, `plugins[${index}] must be an object.`);
    return null;
  }
  if (typeof entry.name !== "string" || !pluginNamePattern.test(entry.name)) {
    error(
      issues,
      `plugins[${index}].name must be lowercase and use only alphanumerics, hyphens, and periods.`,
    );
    return null;
  }
  if (typeof entry.source !== "string" || !isSafeRelativePath(entry.source)) {
    error(issues, `plugins[${index}].source must be a safe relative path.`);
    return null;
  }
  const pluginDir = path.join(root, entry.source);
  if (!entry.source.startsWith("http") && !pathExistsSync(pluginDir)) {
    error(
      issues,
      `plugins[${index}].source directory is missing: ${entry.source}`,
    );
    return null;
  }
  return entry.name;
}

async function validateReferencedManifestPaths(
  pluginDir: string,
  pluginName: string,
  manifest: Record<string, unknown>,
  fields: string[],
  issues: ValidationIssue[],
): Promise<void> {
  for (const field of fields) {
    for (const value of extractPathValues(manifest[field])) {
      if (value.startsWith("http://") || value.startsWith("https://")) {
        continue;
      }
      if (!isSafeRelativePath(value)) {
        error(
          issues,
          `${pluginName}: field "${field}" has unsafe path "${value}".`,
        );
        continue;
      }
      if (!(await exists(path.join(pluginDir, value)))) {
        error(
          issues,
          `${pluginName}: field "${field}" references missing path "${value}".`,
        );
      }
    }
  }
}

function extractPathValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractPathValues);
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return [object.path, object.file].filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return [];
}

async function validateFrontmatter(
  pluginDir: string,
  pluginName: string,
  target: TargetName,
  issues: ValidationIssue[],
): Promise<void> {
  const files = await walkFiles(pluginDir);
  for (const file of files) {
    const kind = detectFrontmatterKind(file);
    if (!kind) {
      continue;
    }
    const relative = toPosix(path.relative(pluginDir, file));
    const parsed = parseFrontmatter(await fs.readFile(file, "utf8"));
    if (!parsed.ok) {
      error(
        issues,
        `${pluginName}: ${kind} frontmatter error in ${relative}: ${parsed.error}`,
      );
      continue;
    }
    if (kind === "agent") {
      requireFrontmatter(
        pluginName,
        kind,
        relative,
        parsed.value,
        ["name", "description"],
        issues,
      );
    } else if (kind === "command") {
      requireFrontmatter(
        pluginName,
        kind,
        relative,
        parsed.value,
        ["description"],
        issues,
      );
      if (target === "cursor" || target === "gemini" || target === "copilot") {
        requireFrontmatter(
          pluginName,
          kind,
          relative,
          parsed.value,
          ["name"],
          issues,
        );
      }
    } else if (kind === "skill") {
      if (target === "cursor") {
        requireFrontmatter(
          pluginName,
          kind,
          relative,
          parsed.value,
          ["name", "description"],
          issues,
        );
      } else if (!parsed.value.description && !parsed.value.when_to_use) {
        error(
          issues,
          `${pluginName}: ${kind} frontmatter error in ${relative}: Missing required "description" field.`,
        );
      }
    } else if (kind === "rule") {
      requireFrontmatter(
        pluginName,
        kind,
        relative,
        parsed.value,
        ["description"],
        issues,
      );
    }
  }
}

function detectFrontmatterKind(
  filePath: string,
): "agent" | "skill" | "command" | "rule" | null {
  const normalized = toPosix(filePath);
  const inSkillContent =
    /\/skills\/[^/]+\//.test(normalized) && !normalized.endsWith("/SKILL.md");
  if (
    normalized.includes("/agents/") &&
    /\.(md|mdc|markdown)$/.test(normalized) &&
    !inSkillContent
  ) {
    return "agent";
  }
  if (normalized.includes("/skills/") && normalized.endsWith("/SKILL.md")) {
    return "skill";
  }
  if (
    normalized.includes("/commands/") &&
    /\.(md|mdc|markdown|txt)$/.test(normalized) &&
    !inSkillContent
  ) {
    return "command";
  }
  if (
    normalized.includes("/rules/") &&
    /\.(md|mdc|markdown)$/.test(normalized) &&
    !inSkillContent
  ) {
    return "rule";
  }
  return null;
}

function parseFrontmatter(
  content: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = matter(content);
    if (Object.keys(parsed.data).length === 0) {
      return { ok: false, error: "No frontmatter found" };
    }
    return { ok: true, value: parsed.data };
  } catch (err) {
    return { ok: false, error: `YAML parse failed: ${(err as Error).message}` };
  }
}

function requireFrontmatter(
  pluginName: string,
  kind: string,
  relative: string,
  frontmatter: Record<string, unknown>,
  fields: string[],
  issues: ValidationIssue[],
): void {
  for (const field of fields) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field]) {
      error(
        issues,
        `${pluginName}: ${kind} frontmatter error in ${relative}: Missing required "${field}" field.`,
      );
    }
  }
}

async function validateHooks(
  pluginDir: string,
  pluginName: string,
  issues: ValidationIssue[],
): Promise<void> {
  const hooksPath = path.join(pluginDir, "hooks", "hooks.json");
  if (!(await exists(hooksPath))) {
    return;
  }
  const hooks = await readJson(
    hooksPath,
    `${pluginName} hooks/hooks.json`,
    issues,
  );
  if (hooks && (!hooks.hooks || typeof hooks.hooks !== "object")) {
    error(
      issues,
      `${pluginName}: hooks/hooks.json must have a "hooks" object.`,
    );
  }
}

async function readJson(
  filePath: string,
  context: string,
  issues: ValidationIssue[],
): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
      string,
      any
    >;
  } catch (err) {
    error(
      issues,
      `${context} is missing or invalid (${filePath}): ${(err as Error).message}`,
    );
    return null;
  }
}

function pathExistsSync(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function error(issues: ValidationIssue[], message: string): void {
  issues.push({ level: "error", message });
}
