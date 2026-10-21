import path from "node:path";

/**
 * Recovers a configured marketplaceDir from this target's managed files.
 * A custom directory holds both the marketplace and each plugin manifest.
 * With no managed manifest, validate the host's standard layout as before.
 */
export function marketplaceDirectory(
  root: string,
  defaultDir: string,
  managedPaths: string[],
): string {
  const candidates = managedPaths
    .filter((file) => path.basename(file) === "marketplace.json")
    .map((file) => path.relative(root, path.dirname(file)))
    .filter((dir) =>
      managedPaths.some((file) => file.endsWith(path.join(dir, "plugin.json"))),
    );
  return candidates.includes(defaultDir)
    ? defaultDir
    : candidates.length === 1
      ? candidates[0]
      : defaultDir;
}

/** Deletes keys whose value is `undefined`, mutating and returning `value`. */
export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges an override onto a generated manifest. Nested objects merge so
 * a sibling key isn't lost; arrays and scalars from the override replace
 * (not concatenate, so keywords/tags don't double up). This is the general
 * escape hatch that lets any field, at any depth, be overridden via a
 * target/plugin `manifest`.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : value;
  }
  return result;
}

/** Converts a kebab/snake/dot-cased string to Title Case. */
export function titleCase(value: string): string {
  return value
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
