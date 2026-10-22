import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { FileValue } from "../src/index.js";
import { applyUpdateCheck } from "../src/update-check.js";

const existingHooks = Buffer.from(
  JSON.stringify({ hooks: { PostToolUse: [] } }),
);

describe("update-check binary file values", () => {
  it.each([
    ["Buffer", existingHooks],
    ["Uint8Array", new Uint8Array(existingHooks)],
  ] as const)("decodes %s hook content as UTF-8", (_name, value) => {
    const files = new Map<string, FileValue>([["hooks/hooks.json", value]]);
    applyUpdateCheck(files, "claude", {
      format: "claude",
      pluginName: "demo",
      version: "1.0.0",
      repository: "https://github.com/acme/plugins",
    });
    expect(JSON.parse(String(files.get("hooks/hooks.json")))).toMatchObject({
      hooks: { PostToolUse: [], SessionStart: [expect.any(Object)] },
    });
  });
});
