import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Project, type ProjectArgs } from "fixturify-project";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { validateOutput } from "../src/adapters.js";
import { loadConfig } from "../src/config.js";

type DirJSON = NonNullable<ProjectArgs["files"]>;

let project: Project | undefined;

afterEach(async () => {
  await project?.dispose();
  project = undefined;
});

const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const CODEX_ENTRY = `entry: {
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Productivity"
          }`;

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`;
}

/** A project with one shared source and a config whose `targets` block is supplied. */
async function setup(targets: string, source: DirJSON = {}): Promise<string> {
  project = new Project("agent-plugins-fixture", "1.0.0", {
    files: {
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "acme-plugins",
  version: "1.2.0",
  metadata: {
    description: "Acme plugins.",
    author: { name: "Acme", url: "https://acme.example" },
    license: "MIT",
    keywords: ["acme"]
  },
  targets: {
${targets}
  }
});
`,
      shared: {
        acme: {
          skills: { search: { "SKILL.md": skill("search") } },
          mcp: {
            "config.json": `${JSON.stringify(
              {
                mcpServers: {
                  local: {
                    command: "node",
                    args: ["${CLAUDE_PLUGIN_ROOT}/mcp/start.mjs"],
                  },
                },
              },
              null,
              2,
            )}\n`,
          },
          ...source,
        },
      },
    },
  });
  await project.write();
  return project.baseDir;
}

async function readJsonFile(root: string, file: string) {
  return JSON.parse(await readFile(path.join(root, file), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("codex emits Agent Plugins packages", () => {
  it("writes root plugin.json and mcp.json, moving OpenAI fields under extensions.com.openai", async () => {
    const root = await setup(`
    codex: {
      outDir: "out",
      plugins: {
        acme: {
          source: "shared/acme",
          manifest: {
            homepage: "https://acme.example/docs",
            interface: { displayName: "Acme", composerIcon: "./assets/icon.png" }
          },
          ${CODEX_ENTRY}
        }
      }
    }`);

    await build({ cwd: root });

    expect(await readJsonFile(root, "out/plugins/acme/plugin.json")).toEqual({
      $schema: PLUGIN_SCHEMA,
      name: "acme",
      version: "1.2.0",
      description: "Acme plugins.",
      author: { name: "Acme", url: "https://acme.example" },
      homepage: "https://acme.example/docs",
      license: "MIT",
      keywords: ["acme"],
      extensions: {
        "com.openai": {
          interface: { displayName: "Acme", composerIcon: "./assets/icon.png" },
        },
      },
    });
    expect(await readJsonFile(root, "out/plugins/acme/mcp.json")).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        local: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/mcp/start.mjs"],
        },
      },
    });
    expect(
      await readJsonFile(root, "out/.agents/plugins/marketplace.json"),
    ).toMatchObject({
      plugins: [{ name: "acme", source: "./plugins/acme", version: "1.2.0" }],
    });
    await expect(
      validateOutput("codex", path.join(root, "out")),
    ).resolves.toMatchObject({ ok: true, issues: [] });
  });

  it("merges authored extensions.com.openai with relocated fields", async () => {
    const root = await setup(`
    codex: {
      outDir: "out",
      plugins: {
        acme: {
          source: "shared/acme",
          manifest: {
            interface: { displayName: "Acme" },
            extensions: { "com.openai": { apps: "./.app.json" }, "com.example.other": { x: true } }
          },
          ${CODEX_ENTRY}
        }
      }
    }`);

    await build({ cwd: root });

    const manifest = await readJsonFile(root, "out/plugins/acme/plugin.json");
    expect(manifest.extensions).toEqual({
      "com.openai": { apps: "./.app.json", interface: { displayName: "Acme" } },
      "com.example.other": { x: true },
    });
  });

  it("rejects a plugin name Agent Plugins doesn't allow", async () => {
    const root = await setup(`
    codex: {
      outDir: "out",
      plugins: { "acme--tools": { source: "shared/acme", ${CODEX_ENTRY} } }
    }`);

    await expect(build({ cwd: root })).rejects.toThrow(
      `Plugin "acme--tools" can't be an Agent Plugins package: must not contain "--" or "..".`,
    );
  });

  it("reports skills that conforming clients would skip", async () => {
    const root = await setup(
      `
    codex: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    }`,
      {
        skills: {
          search: { "SKILL.md": skill("search") },
          glean_run: { "SKILL.md": skill("glean_run") },
          renamed: { "SKILL.md": skill("other-name") },
        },
      },
    );
    await build({ cwd: root });

    const result = await validateOutput("codex", path.join(root, "out"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      'acme: skill "skills/glean_run" has name "glean_run", which must use only lowercase letters, digits, and hyphens, and start and end with a letter or digit (Agent Skills specification) — conforming clients skip it.',
      'acme: skill "skills/renamed" has name "other-name", which must match its directory name "renamed" — conforming clients skip it.',
    ]);
  });

  it("reports a hand-edited manifest field outside the closed schema", async () => {
    const root = await setup(`
    codex: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    }`);
    await build({ cwd: root });
    const file = path.join(root, "out/plugins/acme/plugin.json");
    const manifest = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(file, JSON.stringify({ ...manifest, skills: "./skills/" }));

    const result = await validateOutput("codex", path.join(root, "out"));

    expect(result.issues).toContainEqual({
      level: "error",
      message:
        'acme: plugin.json has field "skills", which the closed Agent Plugins manifest does not allow — client data belongs under "extensions".',
    });
  });
});

describe("standalone agent-plugins target", () => {
  it("emits portable packages with no marketplace and validates them", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`);

    const [artifact] = await build({ cwd: root });

    expect(artifact.managedPaths).toEqual([
      "plugins/acme/mcp.json",
      "plugins/acme/plugin.json",
      "plugins/acme/skills/search/SKILL.md",
    ]);
    expect(await readJsonFile(root, "out/plugins/acme/plugin.json")).toEqual({
      $schema: PLUGIN_SCHEMA,
      name: "acme",
      version: "1.2.0",
      description: "Acme plugins.",
      author: { name: "Acme", url: "https://acme.example" },
      license: "MIT",
      keywords: ["acme"],
    });
    await expect(
      validateOutput("agent-plugins", path.join(root, "out")),
    ).resolves.toMatchObject({ ok: true, issues: [] });
  });

  it("fails the build on a manifest field with no extension namespace to hold it", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", manifest: { interface: {} } } }
    }`);

    await expect(build({ cwd: root })).rejects.toThrow(
      `Plugin "acme": manifest field(s) "interface" aren't part of the Agent Plugins manifest.`,
    );
  });

  it("rejects client-only content kinds at config load", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", include: ["skills", "agents", "hooks"] } }
    }`);

    await expect(loadConfig(root)).rejects.toThrow(
      "agents, hooks only exist inside a client extension namespace; the agent-plugins target can't include them",
    );
  });

  it("allows format only on codex", async () => {
    const root = await setup(`
    claude: {
      outDir: "out",
      format: "legacy",
      plugins: { acme: { source: "shared/acme" } }
    }`);

    await expect(loadConfig(root)).rejects.toThrow(
      "targets.claude.format: format is only supported for the codex target",
    );
  });
});
