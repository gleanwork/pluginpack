import { promises as fs } from "node:fs";
import path from "node:path";
import mustache from "mustache";
import { toPosix, walkFiles } from "./fs.js";
import type { FileValue } from "./types.js";

const TEXTUAL_EXTENSIONS = [".md", ".mdc", ".markdown", ".txt"];

/** A `{{> name}}` reference, used only to build the cycle-detection graph below — never to render. */
const PARTIAL_REFERENCE = /\{\{>\s*([\w./-]+)\s*\}\}/g;

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
    for (const match of content.matchAll(PARTIAL_REFERENCE)) {
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

/**
 * Substitutes `{{> name}}` partial references in a textual file's content,
 * via the real `mustache` library — an empty view (`{}`) is always passed,
 * so no config/environment data is ever exposed to interpolation; only
 * partials resolve to real content, everything else Mustache-shaped resolves
 * to `""` per its own documented missing-key behavior (a known, documented
 * limitation, not a bug — see README).
 *
 * Non-textual paths, and textual files with no `{{` at all, are returned
 * completely untouched (the original `FileValue`, byte-identical) — avoids a
 * lossy UTF-8 round-trip for files that don't use partials at all.
 */
export function resolvePartials(
  relativePath: string,
  value: FileValue,
  partials: Map<string, string>,
): FileValue {
  if (!TEXTUAL_EXTENSIONS.includes(path.extname(relativePath))) {
    return value;
  }
  const text = typeof value === "string" ? value : value.toString("utf8");
  if (!text.includes("{{")) {
    return value;
  }
  return mustache.render(text, {}, Object.fromEntries(partials));
}
