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
    keywords: ["glean", "enterprise-search"]
  },
  targets: {
    cursor: {
      outDir: "out-cursor",
      plugins: { glean: { from: ["glean"], path: "glean", components: ["skills"] } }
    },
    claude: {
      outDir: "out-claude",
      plugins: { glean: { from: ["glean"] } }
    },
    copilot: {
      outDir: "out-copilot",
      plugins: { glean: { from: ["glean"] } }
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
    project.files = {
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
    };
    await project.write();
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
  });
});
