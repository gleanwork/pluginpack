// Repeated project loads in prune/diff must not repeat warnings. Track the
// file and field, not module identity: config loaders may disable their cache.
const warnedKeys = new Set<string>();

export function warnOnStrippedKeys(
  input: unknown,
  output: unknown,
  filePath: string,
  kind: "config" | "manifest" = "config",
): void {
  for (const key of strippedKeys(input, output)) {
    const diagnostic = JSON.stringify([filePath, kind, key]);
    if (warnedKeys.has(diagnostic)) continue;
    warnedKeys.add(diagnostic);
    console.warn(
      `Unknown ${kind} key "${key}" in ${filePath} was ignored. Remove it or use a supported ${kind} field.`,
    );
  }
}

/** Compare parsed data, not a second schema: record passthroughs retain keys. */
function strippedKeys(input: unknown, output: unknown, prefix = ""): string[] {
  if (input === output || !isObject(input) || !isObject(output)) {
    return [];
  }
  return Object.keys(input).flatMap((key) => {
    const dotted = prefix ? `${prefix}.${key}` : key;
    return Object.hasOwn(output, key)
      ? strippedKeys(input[key], output[key], dotted)
      : [dotted];
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
