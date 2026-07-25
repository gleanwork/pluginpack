import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeClaudeHooks,
  mergeCursorHooks,
  renderUpdateCheckScript,
} from "../src/update-check.js";

const run = promisify(execFile);

describe("update-check hooks.json merging", () => {
  it("creates a claude hooks.json from scratch", () => {
    const merged = JSON.parse(mergeClaudeHooks(undefined)) as {
      hooks: {
        SessionStart: {
          matcher: string;
          hooks: { type: string; command: string; timeout: number }[];
        }[];
      };
    };
    expect(merged.hooks.SessionStart).toHaveLength(1);
    expect(merged.hooks.SessionStart[0].matcher).toBe("startup|resume");
    expect(merged.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: "command",
      command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/pluginpack-update-check.sh"',
      timeout: 15,
    });
  });

  it("appends to an existing claude hooks.json, preserving other content", () => {
    const existing = JSON.stringify({
      description: "mine",
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "echo x" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo y" }] }],
      },
    });
    const merged = JSON.parse(mergeClaudeHooks(existing)) as {
      description: string;
      hooks: { PostToolUse: unknown[]; SessionStart: unknown[] };
    };
    expect(merged.description).toBe("mine");
    expect(merged.hooks.PostToolUse).toHaveLength(1);
    expect(merged.hooks.SessionStart).toHaveLength(2);
  });

  it("is idempotent once the update-check command is present", () => {
    const once = mergeClaudeHooks(undefined);
    expect(mergeClaudeHooks(once)).toBe(once);
    const cursorOnce = mergeCursorHooks(undefined);
    expect(mergeCursorHooks(cursorOnce)).toBe(cursorOnce);
  });

  it("creates a cursor hooks.json with version and sessionStart", () => {
    const merged = JSON.parse(mergeCursorHooks(undefined)) as {
      version: number;
      hooks: { sessionStart: { command: string; timeout: number }[] };
    };
    expect(merged.version).toBe(1);
    expect(merged.hooks.sessionStart).toEqual([
      { command: "sh ./scripts/pluginpack-update-check.sh", timeout: 15 },
    ]);
  });

  it("preserves an existing cursor version and events", () => {
    const existing = JSON.stringify({
      version: 2,
      hooks: { beforeShellExecution: [{ command: "./guard.sh" }] },
    });
    const merged = JSON.parse(mergeCursorHooks(existing)) as {
      version: number;
      hooks: { beforeShellExecution: unknown[]; sessionStart: unknown[] };
    };
    expect(merged.version).toBe(2);
    expect(merged.hooks.beforeShellExecution).toHaveLength(1);
    expect(merged.hooks.sessionStart).toHaveLength(1);
  });

  it("rejects malformed hooks files", () => {
    expect(() => mergeClaudeHooks("{ nope")).toThrow(/not valid JSON/);
    expect(() => mergeClaudeHooks("[]")).toThrow(/must be a JSON object/);
    expect(() => mergeClaudeHooks('{ "hooks": [] }')).toThrow(
      /"hooks" must be an object/,
    );
    expect(() =>
      mergeCursorHooks('{ "hooks": { "sessionStart": {} } }'),
    ).toThrow(/"hooks.sessionStart" must be an array/);
  });
});

describe("generated update-check script", () => {
  let tmp: string;
  let scriptDir: string;
  let shimDir: string;
  let baseEnv: Record<string, string>;

  const TAGS = [
    "aaa\trefs/tags/v0.9.0",
    "bbb\trefs/tags/v1.2.0",
    "ccc\trefs/tags/v1.2.0-rc.1",
    "ddd\trefs/tags/nonsense",
    "",
  ].join("\n");

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "pluginpack-uc-"));
    scriptDir = path.join(tmp, "plugin");
    shimDir = path.join(tmp, "bin");
    await mkdir(scriptDir, { recursive: true });
    await mkdir(shimDir, { recursive: true });
    await mkdir(path.join(tmp, "home"), { recursive: true });
    // git shim: log the call, replay canned ls-remote output (fails without it).
    const shim = path.join(shimDir, "git");
    await writeFile(
      shim,
      `#!/bin/sh\nprintf 'called\\n' >> "$GIT_SHIM_LOG"\nexec cat "$GIT_SHIM_TAGS"\n`,
    );
    await chmod(shim, 0o755);
    await writeFile(path.join(tmp, "tags"), TAGS);
    baseEnv = {
      PATH: `${shimDir}:/usr/bin:/bin`,
      HOME: path.join(tmp, "home"),
      XDG_CACHE_HOME: path.join(tmp, "cache"),
      GIT_SHIM_LOG: path.join(tmp, "git.log"),
      GIT_SHIM_TAGS: path.join(tmp, "tags"),
    };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeScript(
    format: "claude" | "cursor",
    version = "1.0.0",
  ): Promise<string> {
    return writePluginScript("demo", scriptDir, format, version);
  }

  async function writePluginScript(
    pluginName: string,
    dir: string,
    format: "claude" | "cursor",
    version = "1.0.0",
    repository = "https://example.com/repo.git",
  ): Promise<string> {
    await mkdir(dir, { recursive: true });
    const scriptPath = path.join(dir, "pluginpack-update-check.sh");
    await writeFile(
      scriptPath,
      renderUpdateCheckScript({ format, pluginName, version, repository }),
    );
    return scriptPath;
  }

  async function runScript(
    scriptPath: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    const { stdout } = await run("/bin/sh", [scriptPath], {
      env: { ...baseEnv, ...env },
    });
    return stdout;
  }

  async function gitCalls(): Promise<number> {
    try {
      const log = await readFile(baseEnv.GIT_SHIM_LOG, "utf8");
      return log.split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  it("nudges with a user-visible systemMessage for claude", async () => {
    const script = await writeScript("claude");
    const stdout = await runScript(script);
    expect(stdout).toBe(
      `${JSON.stringify({
        systemMessage:
          "Plugin demo v1.2.0 is available (installed v1.0.0). Run /plugin update demo to upgrade.",
      })}\n`,
    );
  });

  it("nudges via agent context for cursor", async () => {
    const script = await writeScript("cursor");
    const stdout = await runScript(script);
    expect(stdout).toBe(
      `${JSON.stringify({
        additional_context:
          'The installed Cursor plugin "demo" is outdated (installed v1.0.0, latest v1.2.0). Briefly let the user know they can update it from Cursor\'s plugin settings.',
      })}\n`,
    );
  });

  it("stays silent when up to date or ahead of the latest tag", async () => {
    let script = await writeScript("claude", "1.2.0");
    expect(await runScript(script)).toBe("");
    script = await writeScript("claude", "2.0.0");
    expect(await runScript(script)).toBe("");
  });

  it("honors the opt-out env var and CI, without touching the network", async () => {
    const script = await writeScript("claude");
    expect(await runScript(script, { PLUGINPACK_NO_UPDATE_CHECK: "1" })).toBe(
      "",
    );
    expect(await runScript(script, { CI: "true" })).toBe("");
    expect(await gitCalls()).toBe(0);
  });

  it("stays silent when git is unavailable", async () => {
    const script = await writeScript("claude");
    expect(await runScript(script, { PATH: path.join(tmp, "empty") })).toBe("");
  });

  it("stays silent when the fetch fails (offline)", async () => {
    const script = await writeScript("claude");
    expect(
      await runScript(script, { GIT_SHIM_TAGS: path.join(tmp, "missing") }),
    ).toBe("");
  });

  it("ignores prerelease and non-semver tags", async () => {
    await writeFile(
      path.join(tmp, "tags"),
      "aaa\trefs/tags/v2.0.0-rc.1\nbbb\trefs/tags/release\n",
    );
    const script = await writeScript("claude");
    expect(await runScript(script)).toBe("");
  });

  it("bails on a non-semver installed version without fetching", async () => {
    const script = await writeScript("claude", "main");
    expect(await runScript(script)).toBe("");
    expect(await gitCalls()).toBe(0);
  });

  it("throttles to one fetch per day but keeps nudging from cache", async () => {
    const script = await writeScript("claude");
    expect(await runScript(script)).toContain("systemMessage");
    expect(await runScript(script)).toContain("systemMessage");
    expect(await gitCalls()).toBe(1);
  });

  it("shares the throttle cache across sibling plugins from the same repo", async () => {
    // Two different plugins, same repository — the cache key is derived from
    // the repo URL, so the second plugin's first run should ride the first
    // plugin's cache instead of fetching again.
    const scriptA = await writePluginScript(
      "demo-a",
      path.join(tmp, "plugin-a"),
      "claude",
    );
    const scriptB = await writePluginScript(
      "demo-b",
      path.join(tmp, "plugin-b"),
      "claude",
    );
    const stdoutA = await runScript(scriptA);
    expect(stdoutA).toContain("Plugin demo-a");
    expect(await gitCalls()).toBe(1);

    const stdoutB = await runScript(scriptB);
    expect(stdoutB).toContain("Plugin demo-b");
    expect(await gitCalls()).toBe(1);
  });

  it("recovers from a corrupt cache file", async () => {
    const script = await writeScript("claude");
    await runScript(script);
    const cacheDir = path.join(baseEnv.XDG_CACHE_HOME, "pluginpack");
    const [cacheFile] = await readdir(cacheDir);
    await writeFile(path.join(cacheDir, cacheFile), "garbage nonsense\n");
    expect(await runScript(script)).toContain("systemMessage");
    expect(await gitCalls()).toBe(2);
  });
});
