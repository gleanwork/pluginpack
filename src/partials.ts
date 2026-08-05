import { promises as fs } from "node:fs";
import path from "node:path";
import mustache from "mustache";
import { toPosix, walkFiles } from "./fs.js";
import type { FileValue } from "./types.js";

/** File extensions partial substitution runs on. */
const TEXTUAL_EXTENSIONS = [".md", ".mdc", ".markdown", ".txt"];

/**
 * The one construct pluginpack substitutes: a `{{> name}}` partial tag. Any
 * other `{{...}}`-shaped text is left exactly as authored (see `substitute`).
 */
const PARTIAL_TAG = /\{\{>\s*([\w./-]+)\s*\}\}/;
/** Sticky, to test for a tag at one exact offset without slicing the rest of the file. */
const PARTIAL_TAG_STICKY = new RegExp(PARTIAL_TAG.source, "y");
const PARTIAL_TAG_GLOBAL = new RegExp(PARTIAL_TAG.source, "g");

/** A `{{>` opener, well-formed or not — the trigger for doing any partial work at all. */
const PARTIAL_OPENER = "{{>";

/**
 * Writing `\{{> name}}` emits a literal `{{> name}}` instead of substituting,
 * so a file can document partial syntax itself.
 */
const ESCAPE = "\\";

/**
 * Stands in for a `{{` that is not a partial tag while Mustache renders, so
 * Mustache never treats it as a tag of its own. A private-use code point:
 * never legitimately present in an authored skill file, and
 * `assertNoSentinel` rejects the file outright if it somehow is.
 */
const SENTINEL = "";

/**
 * Loads every file under `partialsDir` into a name -> content map, keyed by
 * its posix-relative path with the extension stripped (e.g. `auth/oauth`).
 * Partials may reference other partials (Mustache resolves nested partials
 * natively), but not circularly — checked here, once, before anything ever
 * calls into `Mustache.render`.
 */
export async function loadPartials(
  partialsDir: string,
): Promise<Map<string, string>> {
  const partials = new Map<string, string>();
  for (const file of await walkFiles(partialsDir)) {
    const relative = toPosix(path.relative(partialsDir, file));
    const key = relative.slice(
      0,
      relative.length - path.extname(relative).length,
    );
    if (partials.has(key)) {
      throw new Error(`Duplicate partial name "${key}" (from "${relative}").`);
    }
    partials.set(key, await fs.readFile(file, "utf8"));
  }
  assertNoPartialCycles(partials);
  return partials;
}

/**
 * Mustache.js has no protection against a circular partial reference (A
 * includes B includes A) — its own docs just say "avoid infinite loops."
 * This builds a dependency graph from each partial's own `{{> name}}`
 * references (a cheap regex scan used only to find edges, never to render)
 * and runs cycle detection over it, so a circular reference fails the build
 * clearly instead of hanging `Mustache.render` later.
 */
function assertNoPartialCycles(partials: Map<string, string>): void {
  const references = (content: string): string[] => {
    const names: string[] = [];
    for (const match of content.matchAll(PARTIAL_TAG_GLOBAL)) {
      names.push(match[1]);
    }
    return names;
  };

  const visiting = new Set<string>();
  const resolved = new Set<string>();

  const visit = (name: string, trail: string[]): void => {
    if (resolved.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      throw new Error(
        `Circular partial reference: ${[...trail, name].join(" -> ")}`,
      );
    }
    const content = partials.get(name);
    if (content === undefined) {
      return;
    }
    visiting.add(name);
    for (const referenced of references(content)) {
      visit(referenced, [...trail, name]);
    }
    visiting.delete(name);
    resolved.add(name);
  };

  for (const name of partials.keys()) {
    visit(name, []);
  }
}

/** Thrown through `Mustache.render` when it asks for a partial that does not exist. */
class UnknownPartialError extends Error {
  constructor(readonly partialName: string) {
    super(`unknown partial "${partialName}"`);
  }
}

/**
 * Substitutes `{{> name}}` partial references in a textual file's content.
 * A tag naming a partial that does not exist is an error, not an empty
 * string — silently dropping a section from a shipped skill file is worse
 * than a failed build.
 *
 * Non-textual paths, and files that never mention a partial tag at all, are
 * returned completely untouched (the original `FileValue`, byte-identical) —
 * so a file that does not use partials cannot be changed by this at all, and
 * pays no lossy UTF-8 round-trip.
 */
export function resolvePartials(
  relativePath: string,
  value: FileValue,
  partials: Map<string, string>,
): FileValue {
  if (!substitutionRunsOn(relativePath)) {
    return value;
  }
  const text = typeof value === "string" ? value : value.toString("utf8");
  if (!text.includes(PARTIAL_OPENER)) {
    return value;
  }
  try {
    return substitute(text, partials);
  } catch (error) {
    throw new Error(
      `Partial substitution failed in "${relativePath}": ${describe(error, partials)}`,
      { cause: error },
    );
  }
}

/** Whether partial substitution runs on files at this path (by extension). */
export function substitutionRunsOn(relativePath: string): boolean {
  return TEXTUAL_EXTENSIONS.includes(path.extname(relativePath));
}

/** The extensions substitution runs on, for error messages (`.md, .mdc, ...`). */
export function substitutedExtensions(): string {
  return TEXTUAL_EXTENSIONS.join(", ");
}

/**
 * Renders via the real `mustache` library, but only ever hands it partial
 * tags: every other `{{` is swapped for a sentinel first (`neutralize`) and
 * restored afterwards. Mustache therefore still owns the substitution
 * semantics that are genuinely subtle — standalone-line handling and partial
 * indentation — while text that merely looks like a template (Handlebars,
 * Jinja, Go, or Mustache documentation; a curly-brace code sample) survives
 * byte-for-byte instead of being rendered against an empty view and
 * vanishing. It also cannot fail to parse on such a file, since none of it
 * reaches Mustache's parser as a tag.
 *
 * An empty view (`{}`) is always passed, so no config or environment data is
 * ever exposed to interpolation.
 */
function substitute(text: string, partials: Map<string, string>): string {
  const rendered = mustache.render(prepare(text), {}, (name: string) => {
    const partial = partials.get(name);
    if (partial === undefined) {
      throw new UnknownPartialError(name);
    }
    // A partial's own body goes through Mustache too, so it needs the same
    // treatment as the file including it — otherwise a `{{ var }}` written
    // inside a partial would still be rendered away.
    return prepare(partial);
  });
  return rendered.replaceAll(SENTINEL, "{{");
}

function prepare(text: string): string {
  if (text.includes(SENTINEL)) {
    throw new Error(
      "content contains the reserved code point U+E000, which pluginpack uses internally while substituting partials",
    );
  }
  return neutralize(text);
}

/**
 * Replaces the opening `{{` of every non-partial construct with `SENTINEL`,
 * leaving real partial tags as the only tags Mustache can see. An escaped
 * tag (`\{{> name}}`) is neutralized too, and its backslash consumed, so it
 * renders as the literal tag it documents.
 */
function neutralize(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{{", index);
    if (open === -1) {
      out += text.slice(index);
      break;
    }
    const escaped = text[open - 1] === ESCAPE;
    PARTIAL_TAG_STICKY.lastIndex = open;
    const isPartialTag = PARTIAL_TAG_STICKY.test(text);
    if (isPartialTag && !escaped) {
      out += text.slice(index, open + 2);
      index = open + 2;
      continue;
    }
    if (text.startsWith(PARTIAL_OPENER, open) && !escaped) {
      throw new Error(
        `malformed partial reference "${firstLine(text.slice(open))}" — expected \`{{> name}}\``,
      );
    }
    out += text.slice(index, isPartialTag ? open - ESCAPE.length : open);
    out += SENTINEL;
    index = open + 2;
  }
  return out;
}

/** Turns a thrown error into a message, expanding an unknown partial into actionable advice. */
function describe(error: unknown, partials: Map<string, string>): string {
  if (!(error instanceof UnknownPartialError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const names = [...partials.keys()];
  if (names.length === 0) {
    return `${error.message}, and no partials are configured — set \`source.partials\` in pluginpack.config.ts`;
  }
  const suggestion = closestName(error.partialName, names);
  return [
    error.message,
    suggestion ? ` (did you mean "${suggestion}"?)` : "",
    `. Available partials: ${names.sort().join(", ")}`,
  ].join("");
}

/** The candidate within a small edit distance of `name`, if one is close enough to suggest. */
function closestName(name: string, candidates: string[]): string | undefined {
  const limit = Math.max(2, Math.floor(name.length / 4));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0].slice(0, 40);
}

/** A partial tag found in a file partial substitution never ran on. */
export type UnsubstitutedPartialTag = {
  path: string;
  tag: string;
};

/**
 * Finds `{{> name}}` tags in emitted files that substitution never ran on.
 * Substitution resolves — or rejects — every tag in the file types it covers
 * (`TEXTUAL_EXTENSIONS`), so the tags left to find are ones authored in (say)
 * a `.yaml` reference file or a `.py` script, which ship through verbatim and
 * silently break whatever reads them. Files substitution *did* run on are
 * excluded deliberately: a tag there can only be the documented `\{{>`
 * escape, which is meant to reach output. Binary files are skipped — a NUL
 * byte is the standard "not text" signal.
 */
export function findUnsubstitutedPartialTags(
  files: Iterable<readonly [string, FileValue]>,
): UnsubstitutedPartialTag[] {
  const found: UnsubstitutedPartialTag[] = [];
  for (const [relativePath, value] of files) {
    if (substitutionRunsOn(relativePath)) {
      continue;
    }
    const tag = findPartialTag(value);
    if (tag) {
      found.push({ path: relativePath, tag });
    }
  }
  return found;
}

/** The first `{{> name}}` tag in a file's contents, or `undefined` for binary/tag-free files. */
export function findPartialTag(value: FileValue): string | undefined {
  if (typeof value !== "string" && value.includes(0)) {
    return undefined;
  }
  const text = typeof value === "string" ? value : value.toString("utf8");
  return PARTIAL_TAG.exec(text)?.[0];
}
