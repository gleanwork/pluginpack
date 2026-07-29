import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
import { createBintastic, type BintasticProject } from "bintastic";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ajv 8 ships CJS with a default export; under NodeNext tsc widens the default
// import to the module namespace, so re-bind to the real default-export types.
const Ajv = AjvImport as unknown as typeof import("ajv").default;
const addFormats =
  addFormatsImport as unknown as typeof import("ajv-formats").default;

const here = path.dirname(fileURLToPath(import.meta.url));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const cursorMarketplaceSchema = readSchema("marketplace.schema.json");
const cursorPluginSchema = readSchema("plugin.schema.json");

// Claude's canonical oracle is its own CLI, not a published schema. Run it only
// when present (skips in CI without claude installed).
function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasClaude = commandExists("claude");
if (!hasClaude) {
  console.warn(
    "[conformance] `claude` CLI not on PATH; skipping `claude plugin validate` checks.",
  );
}

function readSchema(name: string): object {
  return JSON.parse(
    fs.readFileSync(path.join(here, "fixtures", "cursor", name), "utf8"),
  ) as object;
}

function readJson(
  baseDir: string,
  relativePath: string,
): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(baseDir, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

function schemaErrors(
  schema: object,
  data: unknown,
  options: { allowExtra?: string[] } = {},
): string[] {
  const allowExtra = new Set(options.allowExtra ?? []);
  const validate = ajv.compile(schema);
  if (validate(data)) {
    return [];
  }
  return (validate.errors ?? [])
    .filter((issue) => {
      const extra = (issue.params as { additionalProperty?: string })
        .additionalProperty;
      return !(
        issue.keyword === "additionalProperties" &&
        issue.instancePath === "" &&
        extra !== undefined &&
        allowExtra.has(extra)
      );
    })
    .map((issue) => {
      const extra = (issue.params as { additionalProperty?: string })
        .additionalProperty;
      const suffix = extra ? ` (${extra})` : "";
      return `${issue.instancePath || "/"} ${issue.message ?? "invalid"}${suffix}`;
    });
}

const CONFIG = `export default {
  name: "glean-plugins",
  version: "2.1.1",
  metadata: {
    description: "Official Glean plugin.",
    owner: { name: "Glean" },
    author: { name: "Glean" },
    license: "MIT",
    repository: "https://github.com/gleanwork/plugins",
    keywords: ["glean", "enterprise-search"]
  },
  targets: {
    cursor: {
      outDir: "out-cursor",
      updateCheck: {},
      plugins: { glean: { from: ["glean"], path: "glean", components: ["skills"] } }
    },
    claude: {
      outDir: "out-claude",
      updateCheck: {},
      plugins: { glean: { from: ["glean"] } }
    },
    copilot: {
      outDir: "out-copilot",
      plugins: { glean: { from: ["glean"] } }
    },
    codex: {
      outDir: "out-codex",
      plugins: {
        glean: {
          from: ["glean"],
          entry: {
            policy: {
              installation: "AVAILABLE",
              authentication: "ON_INSTALL",
            },
            category: "Developer Tools"
          }
        }
      }
    }
  }
};
`;

const SKILL = `---
name: example
description: Example skill.
---

# Example
`;

describe("emitted output conforms to external target schemas", () => {
  let project: BintasticProject;
  const { setupProject, teardownProject, runBin } = createBintastic({
    binPath: fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
  });

  beforeEach(async () => {
    project = await setupProject();
    await project.write({
      "pluginpack.config.ts": CONFIG,
      plugins: {
        glean: {
          ".mcp.json": `${JSON.stringify(
            { mcpServers: { glean: { command: "glean-mcp" } } },
            null,
            2,
          )}\n`,
          "plugin.pluginpack.json": `${JSON.stringify(
            { description: "Official Glean plugin.", displayName: "Glean" },
            null,
            2,
          )}\n`,
          skills: {
            example: {
              "SKILL.md": SKILL,
            },
          },
        },
      },
    });
  });

  afterEach(() => {
    teardownProject();
  });

  it("cursor manifests validate against the published Cursor schemas", async () => {
    const result = await runBin("build", "--target", "cursor");
    expect(result.exitCode, String(result.stderr)).toBe(0);

    const plugin = readJson(
      project.baseDir,
      "out-cursor/glean/.cursor-plugin/plugin.json",
    );
    const marketplace = readJson(
      project.baseDir,
      "out-cursor/.cursor-plugin/marketplace.json",
    );

    expect(schemaErrors(cursorPluginSchema, plugin)).toEqual([]);
    expect(plugin.mcpServers).toBe("./.mcp.json");
    // updateCheck: the schema-validated manifest points at the generated hooks
    // dir, and the emitted hooks.json registers the sessionStart command.
    expect(plugin.hooks).toBe("./hooks/");
    const hooks = readJson(
      project.baseDir,
      "out-cursor/glean/hooks/hooks.json",
    );
    expect(
      (hooks.hooks as { sessionStart: { command: string }[] }).sessionStart[0]
        .command,
    ).toContain("pluginpack-update-check.sh");
    // Cursor tolerates a top-level marketplace `version` at runtime: the published
    // schema is stricter than reality (gleanwork/cursor-plugins ships `version` and
    // is live in Cursor's marketplace). Any OTHER unexpected key still fails here.
    expect(
      schemaErrors(cursorMarketplaceSchema, marketplace, {
        allowExtra: ["version"],
      }),
    ).toEqual([]);
  });

  it("claude manifests match the real claude-plugins shape", async () => {
    const result = await runBin("build", "--target", "claude");
    expect(result.exitCode, String(result.stderr)).toBe(0);

    const marketplace = readJson(
      project.baseDir,
      "out-claude/.claude-plugin/marketplace.json",
    );
    const plugin = readJson(
      project.baseDir,
      "out-claude/plugins/glean/.claude-plugin/plugin.json",
    );

    expect(marketplace.$schema).toBe(
      "https://anthropic.com/claude-code/marketplace.schema.json",
    );
    expect(marketplace.name).toBe("glean-plugins");
    expect(marketplace.version).toBe("2.1.1");
    expect((marketplace.plugins as unknown[])[0]).toMatchObject({
      name: "glean",
      source: "./plugins/glean",
    });

    expect(plugin).toMatchObject({ name: "glean", version: "2.1.1" });
    expect(typeof plugin.description).toBe("string");
    expect(plugin.author).toMatchObject({ name: "Glean" });

    // updateCheck: Claude discovers hooks/hooks.json by convention.
    const hooks = readJson(
      project.baseDir,
      "out-claude/plugins/glean/hooks/hooks.json",
    );
    const sessionStart = (
      hooks.hooks as {
        SessionStart: { hooks: { command: string }[] }[];
      }
    ).SessionStart;
    expect(sessionStart[0].hooks[0].command).toContain(
      "${CLAUDE_PLUGIN_ROOT}/scripts/pluginpack-update-check.sh",
    );
  });

  it.skipIf(!hasClaude)(
    "claude plugin validate --strict accepts the emitted Claude output",
    async () => {
      const result = await runBin("build", "--target", "claude");
      expect(result.exitCode, String(result.stderr)).toBe(0);

      // Anthropic's own validator — the same check their submission pipeline
      // runs. --strict also fails on runtime-tolerated issues (unknown fields,
      // missing metadata). execFileSync throws on a non-zero exit.
      const marketplaceDir = path.join(project.baseDir, "out-claude");
      const pluginDir = path.join(project.baseDir, "out-claude/plugins/glean");
      execFileSync(
        "claude",
        ["plugin", "validate", "--strict", marketplaceDir],
        {
          stdio: "pipe",
        },
      );
      execFileSync("claude", ["plugin", "validate", "--strict", pluginDir], {
        stdio: "pipe",
      });
    },
  );

  it("copilot emits the official copilot-plugins marketplace layout", async () => {
    const result = await runBin("build", "--target", "copilot");
    expect(result.exitCode, String(result.stderr)).toBe(0);

    // Copilot reads the marketplace from both locations; they must be identical.
    const rootJson = fs.readFileSync(
      path.join(project.baseDir, "out-copilot/.claude-plugin/marketplace.json"),
      "utf8",
    );
    const mirrorJson = fs.readFileSync(
      path.join(project.baseDir, "out-copilot/.github/plugin/marketplace.json"),
      "utf8",
    );
    expect(rootJson).toBe(mirrorJson);

    const marketplace = readJson(
      project.baseDir,
      "out-copilot/.claude-plugin/marketplace.json",
    );
    expect(marketplace.metadata).toMatchObject({ version: "2.1.1" });
    expect((marketplace.plugins as unknown[])[0]).toMatchObject({
      name: "glean",
      source: "./plugins/glean",
      version: "2.1.1",
      skills: ["./skills/example"],
      mcpServers: ".mcp.json",
    });

    // Per docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference:
    // "All plugins consist of a plugin directory containing, at minimum, a
    // manifest file named plugin.json."
    const pluginManifest = readJson(
      project.baseDir,
      "out-copilot/plugins/glean/plugin.json",
    );
    expect(pluginManifest).toMatchObject({
      name: "glean",
      version: "2.1.1",
      skills: "skills/",
      mcpServers: ".mcp.json",
    });

    // Real published plugins (github/copilot-advanced-security-plugin,
    // microsoft/skills-for-fabric) put plugin.json here, not at the plugin
    // root the docs' example trees show — mirror both.
    const githubPluginManifest = readJson(
      project.baseDir,
      "out-copilot/plugins/glean/.github/plugin/plugin.json",
    );
    expect(githubPluginManifest).toEqual(pluginManifest);
  });

  it("codex emits the documented Codex plugin marketplace layout", async () => {
    const result = await runBin("build", "--target", "codex");
    expect(result.exitCode, String(result.stderr)).toBe(0);

    const marketplace = readJson(
      project.baseDir,
      "out-codex/.agents/plugins/marketplace.json",
    );
    expect(marketplace).toMatchObject({
      name: "glean-plugins",
      interface: { displayName: "glean-plugins" },
    });
    // Base entry fields + the per-plugin `entry` passthrough (policy/category).
    expect((marketplace.plugins as unknown[])[0]).toMatchObject({
      name: "glean",
      source: "./plugins/glean",
      version: "2.1.1",
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Developer Tools",
    });

    const plugin = readJson(
      project.baseDir,
      "out-codex/plugins/glean/.codex-plugin/plugin.json",
    );
    expect(plugin).toMatchObject({
      name: "glean",
      version: "2.1.1",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    });
  });

  it("install-info prints every configured target's snippet by default", async () => {
    const result = await runBin("install-info");
    expect(result.exitCode, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain(
      "/plugin marketplace add https://github.com/gleanwork/plugins",
    );
    expect(result.stdout).toContain(
      "codex plugin marketplace add https://github.com/gleanwork/plugins",
    );
    expect(result.stdout).toContain(
      "copilot plugin marketplace add https://github.com/gleanwork/plugins",
    );
    expect(result.stdout).toContain("cursor / glean");
  });

  it("install-info --target restricts output to one target", async () => {
    const result = await runBin("install-info", "--target", "claude");
    expect(result.exitCode, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain("claude / glean");
    expect(result.stdout).not.toContain("codex / glean");
  });

  it("install-info --json prints a parseable, per-target-per-plugin array", async () => {
    const result = await runBin("install-info", "--target", "codex", "--json");
    expect(result.exitCode, String(result.stderr)).toBe(0);
    const entries = JSON.parse(String(result.stdout)) as Array<{
      target: string;
      plugin: string;
      snippet: { userConfigurable: boolean };
    }>;
    expect(entries).toEqual([
      {
        target: "codex",
        plugin: "glean",
        snippet: {
          userConfigurable: true,
          kind: "command",
          snippet:
            "codex plugin marketplace add https://github.com/gleanwork/plugins",
          note: "Installs the marketplace; individual plugins are then installed from Codex's plugin picker.",
        },
      },
    ]);
  });

  it("install-info fails clearly when a target has no repository configured", async () => {
    await project.write({
      "pluginpack.config.ts": CONFIG.replace(
        '    repository: "https://github.com/gleanwork/plugins",\n',
        "",
      ),
    });
    const result = await runBin("install-info", "--target", "cursor");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has no repository configured");
  });

  it("init scaffolds a starter config and source plugin in an empty project", async () => {
    project = await setupProject();

    const result = await runBin("init");
    expect(result.exitCode, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain(
      "Created pluginpack.config.ts and plugins/example.",
    );
    expect(
      fs.existsSync(path.join(project.baseDir, "pluginpack.config.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(project.baseDir, "plugins/example/skills/example/SKILL.md"),
      ),
    ).toBe(true);
  });

  it("init refuses to overwrite an existing pluginpack.config.ts", async () => {
    const result = await runBin("init");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pluginpack.config.ts already exists");
  });

  it("validate passes for a freshly built target and fails for a missing one", async () => {
    const built = await runBin("build", "--target", "cursor");
    expect(built.exitCode, String(built.stderr)).toBe(0);

    const pass = await runBin("validate", "--target", "cursor");
    expect(pass.exitCode, String(pass.stderr)).toBe(0);
    expect(pass.stdout).toContain("Validation passed.");

    const fail = await runBin(
      "validate",
      "--target",
      "claude",
      "--dir",
      "nonexistent-dir",
    );
    expect(fail.exitCode).toBe(1);
  });

  it("diff reports a match immediately after a build", async () => {
    const built = await runBin("build", "--target", "cursor");
    expect(built.exitCode, String(built.stderr)).toBe(0);

    const diffed = await runBin(
      "diff",
      "--target",
      "cursor",
      "--against",
      "out-cursor",
    );
    expect(diffed.exitCode, String(diffed.stderr)).toBe(0);
    expect(diffed.stdout).toContain("Managed files match.");
  });

  it("prune and clean remove stale and managed files via the built binary", async () => {
    const built = await runBin("build", "--target", "cursor");
    expect(built.exitCode, String(built.stderr)).toBe(0);
    const skillFile = path.join(
      project.baseDir,
      "out-cursor/glean/skills/example/SKILL.md",
    );
    expect(fs.existsSync(skillFile)).toBe(true);

    // Removing the source skill makes the previously-generated file stale.
    fs.rmSync(path.join(project.baseDir, "plugins/glean/skills/example"), {
      recursive: true,
      force: true,
    });
    const pruned = await runBin("prune", "--target", "cursor");
    expect(pruned.exitCode, String(pruned.stderr)).toBe(0);
    expect(pruned.stdout).toContain("Pruned");
    expect(fs.existsSync(skillFile)).toBe(false);

    const manifestFile = path.join(
      project.baseDir,
      "out-cursor/.pluginpack/cursor.json",
    );
    expect(fs.existsSync(manifestFile)).toBe(true);
    const cleaned = await runBin("clean", "--target", "cursor");
    expect(cleaned.exitCode, String(cleaned.stderr)).toBe(0);
    expect(cleaned.stdout).toContain("Cleaned");
    expect(fs.existsSync(manifestFile)).toBe(false);
  });

  it("docs --check reports current vs. stale README CLI reference", async () => {
    const readme = [
      "# pluginpack",
      "",
      "<!-- pluginpack-cli:start -->",
      "<!-- pluginpack-cli:end -->",
      "",
    ].join("\n");
    await project.write({ "README.md": readme });

    const sync = await runBin("docs");
    expect(sync.exitCode, String(sync.stderr)).toBe(0);
    expect(sync.stdout).toContain("Updated README.md CLI reference.");

    const check = await runBin("docs", "--check");
    expect(check.exitCode, String(check.stderr)).toBe(0);
    expect(check.stdout).toContain("README.md CLI reference is up to date.");

    await project.write({ "README.md": readme });
    const stale = await runBin("docs", "--check");
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("README.md CLI reference is out of date");
  });
});
