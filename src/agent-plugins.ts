import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { exists } from "./fs.js";
import { AGENT_PLUGINS_MCP_SCHEMA, renderMcpConfig } from "./mcp.js";
import { deepMerge, stripUndefined } from "./targets/shared.js";
import { error, readJson } from "./targets/validation-shared.js";
import type { ManifestBuildContext } from "./targets/types.js";
import type { ValidationIssue } from "./types.js";

/**
 * The Agent Plugins package module: everything about laying one plugin out
 * as an Agent Plugins 1.0 package — `plugin.json`, `skills/`, `mcp.json` —
 * plus the client profile a target adds on top. Targets that emit packages
 * (`codex`, `agent-plugins`) compose this module instead of building and
 * validating the layout themselves. Marketplaces are deliberately not here:
 * the specification leaves them to each client.
 *
 * Spec: https://agent-plugins.org/specification (1.0.0).
 */

export const AGENT_PLUGINS_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** A client's additions to a package. */
export type ClientProfile = {
  /**
   * The client's reverse-domain extension namespace, e.g. `com.openai`.
   * Authored manifest fields outside the portable manifest move under
   * `extensions[namespace]`; with no namespace they are a build error.
   */
  namespace?: string;
};

/** The only top-level fields the closed Agent Plugins manifest allows (spec §5.2). */
const MANIFEST_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
];
const STRING_FIELDS = [
  "version",
  "description",
  "homepage",
  "repository",
  "license",
];
const AUTHOR_FIELDS = ["name", "email", "url"];

/** The package file layout, relative to the plugin directory. */
export const packageLayout = {
  manifest: "plugin.json",
  mcp: "mcp.json",
  skills: "skills",
};

/**
 * Builds the portable manifest — identity and metadata only. Components are
 * discovered from fixed locations, so the manifest never points at them.
 */
export function buildPackageManifest({
  metadata,
  version,
  pluginName,
  pluginConfig,
}: ManifestBuildContext): Record<string, unknown> {
  const problem = packageNameProblem(pluginName);
  if (problem) {
    throw new Error(
      `Plugin "${pluginName}" can't be an Agent Plugins package: ${problem}`,
    );
  }
  return stripUndefined({
    $schema: AGENT_PLUGINS_SCHEMA,
    name: pluginName,
    version: pluginConfig.version ?? version,
    description: pluginConfig.description ?? metadata?.description,
    author: metadata?.author,
    homepage: metadata?.homepage,
    repository: metadata?.repository,
    license: metadata?.license,
    keywords: metadata?.keywords,
  });
}

/**
 * Applied after a config's `manifest` override is merged: portable fields
 * stay at the top level, and every other authored field moves under the
 * profile's extension namespace (merged with any `extensions[namespace]`
 * the author wrote directly). The result always conforms to the closed
 * manifest schema.
 */
export function placeClientFields(
  manifest: Record<string, unknown>,
  profile: ClientProfile,
  pluginName: string,
): Record<string, unknown> {
  const portable: Record<string, unknown> = {};
  const client: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "extensions") {
      continue;
    }
    (MANIFEST_FIELDS.includes(key) ? portable : client)[key] = value;
  }
  const extensions: Record<string, unknown> = {};
  if (manifest.extensions !== undefined) {
    if (!isObject(manifest.extensions)) {
      throw new Error(
        `Plugin "${pluginName}": manifest "extensions" must be an object keyed by extension namespace.`,
      );
    }
    Object.assign(extensions, manifest.extensions);
  }
  const clientKeys = Object.keys(client);
  if (clientKeys.length > 0) {
    if (!profile.namespace) {
      throw new Error(
        `Plugin "${pluginName}": manifest field(s) ${clientKeys.map((key) => `"${key}"`).join(", ")} aren't part of the Agent Plugins manifest. ` +
          `Put client-specific data under manifest.extensions["<namespace>"].`,
      );
    }
    const existing = extensions[profile.namespace];
    extensions[profile.namespace] = deepMerge(
      isObject(existing) ? existing : {},
      client,
    );
  }
  if (Object.keys(extensions).length > 0) {
    portable.extensions = extensions;
  }
  return portable;
}

/** Whether a parsed `plugin.json` declares the Agent Plugins schema. */
export function isPackageManifest(manifest: unknown): boolean {
  return isObject(manifest) && manifest.$schema === AGENT_PLUGINS_SCHEMA;
}

/** Whether a plugin directory holds an Agent Plugins package. */
export async function hasPackageManifest(pluginDir: string): Promise<boolean> {
  const file = path.join(pluginDir, packageLayout.manifest);
  if (!(await exists(file))) {
    return false;
  }
  try {
    return isPackageManifest(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return false;
  }
}

/**
 * Validates one emitted package against the specification: the closed
 * manifest, the `mcp.json` shape, and each discovered skill — every check
 * here is something a conforming client would reject or silently skip.
 * Returns the parsed manifest, or `undefined` when it couldn't be read.
 */
export async function validatePackage(
  pluginDir: string,
  pluginName: string,
  issues: ValidationIssue[],
): Promise<Record<string, unknown> | undefined> {
  const manifest = await readJson(
    path.join(pluginDir, packageLayout.manifest),
    `${pluginName} plugin manifest`,
    issues,
  );
  if (!manifest) {
    return undefined;
  }
  validateManifest(manifest, pluginName, issues);
  await validateMcp(pluginDir, pluginName, issues);
  await validateSkills(pluginDir, pluginName, issues);
  return manifest;
}

function validateManifest(
  manifest: Record<string, unknown>,
  pluginName: string,
  issues: ValidationIssue[],
): void {
  if (manifest.$schema !== AGENT_PLUGINS_SCHEMA) {
    error(
      issues,
      `${pluginName}: plugin.json "$schema" must be "${AGENT_PLUGINS_SCHEMA}".`,
    );
  }
  if (typeof manifest.name !== "string") {
    error(issues, `${pluginName}: plugin.json "name" must be a string.`);
  } else {
    const problem = packageNameProblem(manifest.name);
    if (problem) {
      error(issues, `${pluginName}: plugin.json "name" ${problem}`);
    }
  }
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.includes(key)) {
      error(
        issues,
        `${pluginName}: plugin.json has field "${key}", which the closed Agent Plugins manifest does not allow — client data belongs under "extensions".`,
      );
    }
  }
  for (const key of STRING_FIELDS) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
      error(issues, `${pluginName}: plugin.json "${key}" must be a string.`);
    }
  }
  if (
    manifest.keywords !== undefined &&
    !(
      Array.isArray(manifest.keywords) &&
      manifest.keywords.every((keyword) => typeof keyword === "string")
    )
  ) {
    error(
      issues,
      `${pluginName}: plugin.json "keywords" must be an array of strings.`,
    );
  }
  if (manifest.author !== undefined) {
    const author = manifest.author;
    if (
      !isObject(author) ||
      Object.entries(author).some(
        ([key, value]) =>
          !AUTHOR_FIELDS.includes(key) || typeof value !== "string",
      )
    ) {
      error(
        issues,
        `${pluginName}: plugin.json "author" may only contain string "name", "email", and "url".`,
      );
    }
  }
  if (manifest.extensions !== undefined) {
    if (
      !isObject(manifest.extensions) ||
      Object.values(manifest.extensions).some((value) => !isObject(value))
    ) {
      error(
        issues,
        `${pluginName}: plugin.json "extensions" must be an object whose values are objects.`,
      );
    } else {
      for (const namespace of Object.keys(manifest.extensions)) {
        if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(namespace)) {
          error(
            issues,
            `${pluginName}: plugin.json extension namespace "${namespace}" must be a reverse-domain identifier such as "com.example.client".`,
          );
        }
      }
    }
  }
}

async function validateMcp(
  pluginDir: string,
  pluginName: string,
  issues: ValidationIssue[],
): Promise<void> {
  const file = path.join(pluginDir, packageLayout.mcp);
  if (!(await exists(file))) {
    return;
  }
  const config = await readJson(file, `${pluginName} MCP config`, issues);
  if (!config) {
    return;
  }
  if (config.$schema !== AGENT_PLUGINS_MCP_SCHEMA) {
    error(
      issues,
      `${pluginName}: mcp.json "$schema" must be "${AGENT_PLUGINS_MCP_SCHEMA}" (matching plugin.json's Agent Plugins version).`,
    );
  }
  const extra = Object.keys(config).filter(
    (key) => key !== "$schema" && key !== "mcpServers",
  );
  if (extra.length > 0) {
    error(
      issues,
      `${pluginName}: mcp.json allows only "$schema" and "mcpServers" (found ${extra.map((key) => `"${key}"`).join(", ")}).`,
    );
  }
  if (!isObject(config.mcpServers)) {
    error(issues, `${pluginName}: mcp.json "mcpServers" must be an object.`);
    return;
  }
  for (const [name, server] of Object.entries(config.mcpServers)) {
    try {
      renderMcpConfig({ [name]: server }, "agent-plugins", pluginName);
    } catch (err) {
      error(issues, (err as Error).message);
    }
  }
}

/**
 * Each immediate child of `skills/` with a `SKILL.md` is one skill; it must
 * conform to the Agent Skills specification or clients skip it.
 */
async function validateSkills(
  pluginDir: string,
  pluginName: string,
  issues: ValidationIssue[],
): Promise<void> {
  const skillsDir = path.join(pluginDir, packageLayout.skills);
  if (!(await exists(skillsDir))) {
    return;
  }
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!(await exists(skillFile))) {
      continue;
    }
    const where = `${pluginName}: skill "skills/${entry.name}"`;
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = matter(await fs.readFile(skillFile, "utf8")).data;
    } catch (err) {
      error(
        issues,
        `${where} has unparseable frontmatter: ${(err as Error).message}`,
      );
      continue;
    }
    const { name, description } = frontmatter;
    if (typeof name !== "string" || !name) {
      error(issues, `${where} is missing the required "name" field.`);
    } else {
      const problem = skillNameProblem(name);
      if (problem) {
        error(
          issues,
          `${where} has name "${name}", which ${problem} (Agent Skills specification) — conforming clients skip it.`,
        );
      } else if (name !== entry.name) {
        error(
          issues,
          `${where} has name "${name}", which must match its directory name "${entry.name}" — conforming clients skip it.`,
        );
      }
    }
    if (typeof description !== "string" || !description) {
      error(issues, `${where} is missing the required "description" field.`);
    } else if (description.length > 1024) {
      error(issues, `${where} "description" exceeds 1024 characters.`);
    }
  }
}

/** Spec §5.5. Returns a description of the violation, or `undefined`. */
function packageNameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > 64) {
    return "must be 1-64 characters.";
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)) {
    return "must use only lowercase letters, digits, hyphens, and periods, and start and end with a letter or digit.";
  }
  if (name.includes("--") || name.includes("..")) {
    return 'must not contain "--" or "..".';
  }
  return undefined;
}

function skillNameProblem(name: string): string | undefined {
  if (name.length > 64) {
    return "exceeds 64 characters";
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return "must use only lowercase letters, digits, and hyphens, and start and end with a letter or digit";
  }
  if (name.includes("--")) {
    return 'must not contain "--"';
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
