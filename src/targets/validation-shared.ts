import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  exists,
  isNotFoundError,
  isSafeRelativePath,
  toPosix,
  walkFiles,
} from "../fs.js";
import type { TargetName, ValidationIssue } from "../types.js";

export const marketplaceNamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Validates a marketplace entry whose `source` is a bare string — the shape
 * most targets share. A target whose entry shape differs (e.g. a structured
 * `source` object) implements its own `validateMarketplaceEntry` instead of
 * calling this.
 */
export function validateBareStringSourceEntry(
  entry: Record<string, unknown>,
  index: number,
  root: string,
  issues: ValidationIssue[],
  namePattern: RegExp,
): string | null {
  if (!entry || typeof entry !== "object") {
    error(issues, `plugins[${index}] must be an object.`);
    return null;
  }
  if (typeof entry.name !== "string" || !namePattern.test(entry.name)) {
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

export const pluginNamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Pushes an error-level issue onto `issues`. */
export function error(issues: ValidationIssue[], message: string): void {
  issues.push({ level: "error", message });
}

/** Reads and parses a JSON file, pushing an issue and returning `null` on failure. */
export async function readJson(
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

export function pathExistsSync(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) {
      return false;
    }
    throw err;
  }
}

/** Validates the fields common to every target's marketplace manifest. */
export function validateMarketplaceBasics(
  marketplace: Record<string, unknown>,
  issues: ValidationIssue[],
  options: { requireOwner: boolean } = { requireOwner: false },
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
  if (options.requireOwner && !owner) {
    error(issues, 'Marketplace is missing required field "owner".');
  }
  if (owner && (typeof owner.name !== "string" || !owner.name)) {
    error(
      issues,
      'Marketplace "owner.name" must be a non-empty string when owner is present.',
    );
  }
}

/**
 * Validates a hooks file's shape at `hooksRelativePath` — parameterized by
 * path rather than a hardcoded location, since a target may relocate hooks
 * to somewhere other than `hooks/hooks.json` (e.g. a root-level file).
 */
export async function validateHooksShape(
  pluginDir: string,
  pluginName: string,
  hooksRelativePath: string,
  issues: ValidationIssue[],
): Promise<void> {
  const hooksFile = path.join(pluginDir, hooksRelativePath);
  if (!(await exists(hooksFile))) {
    return;
  }
  const hooks = await readJson(hooksFile, `${pluginName} hooks`, issues);
  if (hooks && (!hooks.hooks || typeof hooks.hooks !== "object")) {
    error(
      issues,
      `${pluginName}: ${hooksRelativePath} must have a "hooks" object.`,
    );
  }
}

/** Validates that manifest fields referencing paths point at files that exist. */
export function validateReferencedManifestPaths(
  pluginDir: string,
  pluginName: string,
  manifest: Record<string, unknown>,
  fields: string[],
  issues: ValidationIssue[],
): Promise<void> {
  return (async () => {
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
  })();
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

/** Validates skill/agent/command/rule frontmatter conventions for a plugin's files. */
export async function validateFrontmatter(
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
      if (
        target === "cursor" ||
        target === "antigravity" ||
        target === "copilot"
      ) {
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
