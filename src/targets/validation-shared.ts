import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { componentDirs, staticFiles } from "../components.js";
import {
  exists,
  isNotFoundError,
  isSafeRelativePath,
  toPosix,
  walkFiles,
} from "../fs.js";
import { UPDATE_CHECK_SCRIPT_PATH } from "../update-check.js";
import {
  findPartialTag,
  substitutedExtensions,
  substitutionRunsOn,
} from "../partials.js";
import type { TargetName, ValidationIssue } from "../types.js";
import type { OutputValidationContext } from "./types.js";

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

/** Pushes a warning-level issue onto `issues` (does not fail validation). */
export function warning(issues: ValidationIssue[], message: string): void {
  issues.push({ level: "warning", message });
}

/**
 * Flags `{{> name}}` partial references left in generated output in a file
 * type substitution never runs on (a `.yaml` reference file, a `.py`
 * script). Whatever reads such a file gets a template marker instead of the
 * text meant to be inlined, so it's an error.
 *
 * Files substitution does run on are not scanned. At build time
 * `resolvePartials` resolves every tag in them, or fails the build on an
 * unknown, malformed, or assembled one, so the only tag a current build
 * leaves there is the documented `\{{>` escape, which is meant to reach
 * output. Validate cannot tell an escape from a stale or hand-edited tag
 * after the fact, and flagging every escape would make the documented
 * syntax permanent noise.
 */
export async function validateNoSurvivingPartialTags(
  root: string,
  ownedPaths: string[],
  issues: ValidationIssue[],
): Promise<void> {
  const files = (
    await Promise.all(
      ownedPaths.map(async (ownedPath) => {
        try {
          return (await fs.stat(ownedPath)).isDirectory()
            ? await walkFiles(ownedPath)
            : [ownedPath];
        } catch (error) {
          if (isNotFoundError(error)) {
            return [];
          }
          throw error;
        }
      }),
    )
  ).flat();
  for (const file of [...new Set(files)]) {
    const relative = toPosix(path.relative(root, file));
    if (substitutionRunsOn(relative)) {
      continue;
    }
    const tag = findPartialTag(await fs.readFile(file));
    if (tag) {
      error(
        issues,
        `${relative} contains an unsubstituted partial reference ${tag}. Partial substitution does not run on this file type (${substitutedExtensions()}).`,
      );
    }
  }
}

/**
 * The paths `validateNoSurvivingPartialTags` should scan for one plugin
 * directory a target's validator found. A plugin in its own directory is
 * scanned whole.
 *
 * A plugin emitted at the output root (`path: "."`) shares that root with
 * authored sources, dependencies, and other files pluginpack does not own,
 * so the root is never walked. Instead:
 *
 * - `nativeFiles` (plugin-relative manifest, MCP, hooks, and extension
 *   paths) are always scanned, because the host reads them from a root
 *   plugin whoever wrote them.
 * - With managed state, the managed manifest's file list covers the rest of
 *   the output (the engine adds it), so nothing else is scanned.
 * - Without managed state, the recognized component directories and static
 *   files are scanned as the best available guess at the plugin's output.
 */
export function pluginScanPaths(
  root: string,
  pluginDir: string,
  nativeFiles: readonly string[],
  context: OutputValidationContext,
): string[] {
  if (path.resolve(pluginDir) !== path.resolve(root)) {
    return [pluginDir];
  }
  const fallback = context.hasManagedState
    ? []
    : [...componentDirs, ...staticFiles];
  return [...nativeFiles, ...fallback].map((entry) =>
    path.join(pluginDir, entry),
  );
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
 * to somewhere other than `hooks/hooks.json` (e.g. a root-level file). Also
 * checks that any command referencing the generated update-check script
 * (`UPDATE_CHECK_SCRIPT_PATH`) actually ships it, since that hook is
 * injected separately from the plugin's own authored hooks.
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
  if (!hooks) {
    return;
  }
  if (
    !hooks.hooks ||
    typeof hooks.hooks !== "object" ||
    Array.isArray(hooks.hooks)
  ) {
    error(
      issues,
      `${pluginName}: ${hooksRelativePath} must have a "hooks" object.`,
    );
    return;
  }
  for (const [event, entries] of Object.entries(
    hooks.hooks as Record<string, unknown>,
  )) {
    if (!Array.isArray(entries)) {
      error(
        issues,
        `${pluginName}: ${hooksRelativePath} "hooks.${event}" must be an array.`,
      );
    }
  }
  for (const command of extractCommandStrings(hooks.hooks)) {
    if (!command) {
      error(
        issues,
        `${pluginName}: ${hooksRelativePath} has an empty "command" string.`,
      );
      continue;
    }
    if (
      command.includes(UPDATE_CHECK_SCRIPT_PATH) &&
      !(await exists(path.join(pluginDir, UPDATE_CHECK_SCRIPT_PATH)))
    ) {
      error(
        issues,
        `${pluginName}: ${hooksRelativePath} references ${UPDATE_CHECK_SCRIPT_PATH} but the script is missing.`,
      );
    }
  }
}

/**
 * All string values under a "command" key, at any depth (Claude nests
 * command entries under matcher groups; Cursor keeps them at the event
 * level).
 */
function extractCommandStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(extractCommandStrings);
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const own = typeof object.command === "string" ? [object.command] : [];
    return [...own, ...Object.values(object).flatMap(extractCommandStrings)];
  }
  return [];
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

/**
 * Parses YAML frontmatter from a file pluginpack is validating: a `---` line
 * at the top, YAML, and a closing `---` line (to end of file when it's
 * missing). The delimiter rules match gray-matter, which pluginpack used
 * before. Only YAML is accepted, and js-yaml 4's `load` is safe by default,
 * so validating a package never runs code from it. Throws when the block
 * isn't a YAML mapping.
 */
export function parseMatter(content: string): {
  data: Record<string, unknown>;
  content: string;
} {
  let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!text.startsWith("---") || text.charAt(3) === "-") {
    return { data: {}, content: text };
  }
  text = text.slice(3);
  const lineEnd = text.search(/\r?\n/);
  const language = (lineEnd === -1 ? text : text.slice(0, lineEnd))
    .trim()
    .toLowerCase();
  if (language) {
    if (language !== "yaml" && language !== "yml") {
      throw new Error(
        language === "js" || language === "javascript"
          ? "JavaScript frontmatter is not supported; use YAML frontmatter."
          : `Frontmatter language "${language}" is not supported; use YAML frontmatter.`,
      );
    }
    text = lineEnd === -1 ? "" : text.slice(lineEnd);
  }
  const closeIndex = text.indexOf("\n---");
  const block = closeIndex === -1 ? text : text.slice(0, closeIndex);
  const body =
    closeIndex === -1 ? "" : text.slice(closeIndex + 4).replace(/^\r?\n/, "");
  if (block.replace(/^\s*#[^\n]+/gm, "").trim() === "") {
    return { data: {}, content: body };
  }
  const data: unknown = yaml.load(block);
  if (data === null || data === undefined) {
    return { data: {}, content: body };
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Frontmatter must be a YAML mapping of fields.");
  }
  return { data: data as Record<string, unknown>, content: body };
}

function parseFrontmatter(
  content: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = parseMatter(content);
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
