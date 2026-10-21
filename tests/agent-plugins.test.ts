import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Project, type ProjectArgs } from "fixturify-project";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const METADATA = `{
    description: "Acme plugins.",
    author: { name: "Acme", url: "https://acme.example" },
    license: "MIT",
    keywords: ["acme"]
  }`;

/** A project with one shared source and a config whose `targets` block is supplied. */
async function setup(
  targets: string,
  source: DirJSON = {},
  metadata: string = METADATA,
): Promise<string> {
  project = new Project("agent-plugins-fixture", "1.0.0", {
    files: {
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "acme-plugins",
  version: "1.2.0",
  metadata: ${metadata},
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

  it("reports a broken root plugin.json as itself, not as a missing legacy manifest", async () => {
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
    await writeFile(
      file,
      JSON.stringify({
        ...manifest,
        $schema: "https://agent-plugins.org/schemas/9.9.9/plugin.schema.json",
      }),
    );

    const result = await validateOutput("codex", path.join(root, "out"));
    const messages = result.issues.map((issue) => issue.message);

    expect(messages).toContain(
      `acme: plugin.json "$schema" must be "${PLUGIN_SCHEMA}".`,
    );
    expect(messages.some((message) => message.includes(".codex-plugin"))).toBe(
      false,
    );
  });

  it("reports a hand-edited mcp.json server that isn't in Agent Plugins form", async () => {
    const root = await setup(`
    codex: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    }`);
    await build({ cwd: root });
    const file = path.join(root, "out/plugins/acme/mcp.json");
    const config = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      file,
      JSON.stringify({
        ...config,
        mcpServers: {
          untyped: { command: "node" },
          remote: { type: "http", url: "https://mcp.acme.example" },
        },
      }),
    );

    const result = await validateOutput("codex", path.join(root, "out"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      'acme: mcp.json server "untyped" isn\'t in Agent Plugins form (check "type"); expected {"type":"stdio","command":"node"}.',
      'acme: mcp.json server "remote" isn\'t in Agent Plugins form (check "type"); expected {"type":"streamable-http","url":"https://mcp.acme.example"}.',
    ]);
  });

  it("never runs JavaScript frontmatter while validating", async () => {
    const root = await setup(`
    codex: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    }`);
    await build({ cwd: root });
    const flag = "__pluginpackFrontmatterEval";
    await writeFile(
      path.join(root, "out/plugins/acme/skills/search/SKILL.md"),
      `---js\n{ name: (globalThis.${flag} = "search"), description: "x" }\n---\n`,
    );

    const result = await validateOutput("codex", path.join(root, "out"));

    expect((globalThis as Record<string, unknown>)[flag]).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      'acme: skill "skills/search" has unparseable frontmatter: JavaScript frontmatter is not supported; use YAML frontmatter.',
    );
  });

  it("fails the build on manifest data that validate would reject", async () => {
    const badNamespace = await setup(`
    codex: {
      outDir: "out",
      plugins: {
        acme: {
          source: "shared/acme",
          manifest: { extensions: { openai: { apps: "./.app.json" } } },
          ${CODEX_ENTRY}
        }
      }
    }`);
    await expect(build({ cwd: badNamespace })).rejects.toThrow(
      'acme: plugin.json extension namespace "openai" must be a reverse-domain identifier such as "com.example.client".',
    );
    await project?.dispose();

    const badAuthor = await setup(`
    codex: {
      outDir: "out",
      plugins: {
        acme: {
          source: "shared/acme",
          manifest: { author: { name: "Acme", twitter: "@acme" } },
          ${CODEX_ENTRY}
        }
      }
    }`);
    await expect(build({ cwd: badAuthor })).rejects.toThrow(
      'acme: plugin.json "author" may only contain string "name", "email", and "url".',
    );
  });

  it("emits hooks/hooks.json without a manifest pointer and validates it", async () => {
    const root = await setup(
      `
    codex: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    }`,
      {
        hooks: {
          "hooks.json": `${JSON.stringify({
            hooks: {
              SessionStart: [
                { hooks: [{ type: "command", command: "echo hi" }] },
              ],
            },
          })}\n`,
        },
      },
    );

    const [artifact] = await build({ cwd: root });

    expect(artifact.managedPaths).toContain("plugins/acme/hooks/hooks.json");
    const manifest = await readJsonFile(root, "out/plugins/acme/plugin.json");
    expect(manifest).not.toHaveProperty("hooks");
    expect(manifest.$schema).toBe(PLUGIN_SCHEMA);
    await expect(
      validateOutput("codex", path.join(root, "out")),
    ).resolves.toMatchObject({ ok: true, issues: [] });
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

  it("validates every package, including deep and broken ones", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      plugins: {
        acme: { source: "shared/acme" },
        deep: { source: "shared/acme", path: "a/b/c/d/deep" }
      }
    }`);
    await build({ cwd: root });
    await expect(
      validateOutput("agent-plugins", path.join(root, "out")),
    ).resolves.toMatchObject({ ok: true, issues: [] });

    await writeFile(path.join(root, "out/a/b/c/d/deep/plugin.json"), "{ nope");
    const result = await validateOutput(
      "agent-plugins",
      path.join(root, "out"),
    );

    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.message.startsWith("deep plugin manifest"),
      ),
    ).toBe(true);
  });

  it("ships scripts/ by default so a bundled MCP command resolves", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {
        scripts: { "server.sh": "#!/bin/sh\nexec node server.mjs\n" },
        mcp: {
          "config.json": `${JSON.stringify({
            mcpServers: {
              local: { command: "${CLAUDE_PLUGIN_ROOT}/scripts/server.sh" },
            },
          })}\n`,
        },
      },
    );

    const [artifact] = await build({ cwd: root });

    expect(artifact.managedPaths).toContain("plugins/acme/scripts/server.sh");
    expect(await readJsonFile(root, "out/plugins/acme/mcp.json")).toMatchObject(
      {
        mcpServers: {
          local: { type: "stdio", command: "./scripts/server.sh" },
        },
      },
    );
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

const AGENT = `---
name: reviewer
description: Reviews code.
---

Review the change.
`;

const CLIENTS_TARGET = `
    "agent-plugins": {
      outDir: "out",
      clients: {
        codex: { manifest: { interface: { displayName: "Acme for Codex" } } },
        copilot: {}
      },
      plugins: {
        acme: {
          source: "shared/acme",
          manifest: { extensions: { "com.openai": { interface: { displayName: "Acme" } } } },
          clients: { codex: { ${CODEX_ENTRY} } }
        }
      }
    }`;

describe("agent-plugins target with clients", () => {
  it("builds one package with each client's files and a marketplace per client", async () => {
    const root = await setup(CLIENTS_TARGET, {
      agents: { "reviewer.md": AGENT },
    });

    const [artifact] = await build({ cwd: root });

    expect(artifact.managedPaths).toEqual([
      ".agents/plugins/marketplace.json",
      ".github/plugin/marketplace.json",
      "plugins/acme/com.github.copilot/agents/reviewer.agent.md",
      "plugins/acme/mcp.json",
      "plugins/acme/plugin.json",
      "plugins/acme/skills/search/SKILL.md",
    ]);
    expect(
      await readFile(
        path.join(
          root,
          "out/plugins/acme/com.github.copilot/agents/reviewer.agent.md",
        ),
        "utf8",
      ),
    ).toBe(AGENT);
    expect(
      (await readJsonFile(root, "out/plugins/acme/plugin.json")).extensions,
    ).toEqual({ "com.openai": { interface: { displayName: "Acme" } } });
    expect(
      await readJsonFile(root, "out/.agents/plugins/marketplace.json"),
    ).toEqual({
      name: "acme-plugins",
      interface: { displayName: "Acme for Codex" },
      plugins: [
        {
          name: "acme",
          source: "./plugins/acme",
          description: "Acme plugins.",
          version: "1.2.0",
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    });
    expect(
      await readJsonFile(root, "out/.github/plugin/marketplace.json"),
    ).toEqual({
      name: "acme-plugins",
      owner: { name: "Acme" },
      metadata: { description: "Acme plugins.", version: "1.2.0" },
      plugins: [
        {
          name: "acme",
          source: "./plugins/acme",
          description: "Acme plugins.",
          version: "1.2.0",
        },
      ],
    });
    await expect(
      validateOutput("agent-plugins", path.join(root, "out")),
    ).resolves.toMatchObject({ ok: true, issues: [] });
  });

  it("keeps an agent file already named NAME.agent.md", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      { agents: { "reviewer.agent.md": AGENT } },
    );

    const [artifact] = await build({ cwd: root });

    expect(artifact.managedPaths).toContain(
      "plugins/acme/com.github.copilot/agents/reviewer.agent.md",
    );
    expect(artifact.managedPaths).not.toContain(
      ".agents/plugins/marketplace.json",
    );
  });

  it("fails the build when Copilot's marketplace has no owner", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {},
      `{ description: "Acme plugins." }`,
    );

    await expect(build({ cwd: root })).rejects.toThrow(
      "Copilot's marketplace requires an owner. Set metadata.owner (or metadata.author)",
    );
  });

  it("rejects a client-only kind that no listed client loads, naming the client that does", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      clients: { codex: {} },
      plugins: { acme: { source: "shared/acme", include: ["skills", "agents"] } }
    }`);

    await expect(loadConfig(root)).rejects.toThrow(
      `agents only exist inside a client extension namespace; the agent-plugins target can't include them unless targets["agent-plugins"].clients lists a client that loads them (copilot)`,
    );
  });

  it("rejects per-plugin settings for a client the target doesn't list", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      clients: { codex: {} },
      plugins: { acme: { source: "shared/acme", clients: { copilot: {} } } }
    }`);

    await expect(loadConfig(root)).rejects.toThrow(
      `client "copilot" isn't listed in targets["agent-plugins"].clients`,
    );
  });

  it("accepts agents in include when copilot is listed", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme", include: ["skills", "agents"] } }
    }`,
      { agents: { "reviewer.md": AGENT } },
    );

    const [artifact] = await build({ cwd: root });

    expect(artifact.managedPaths).toContain(
      "plugins/acme/com.github.copilot/agents/reviewer.agent.md",
    );
  });

  it("treats a client set to undefined as not listed", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      clients: { codex: {}, copilot: undefined },
      plugins: {
        acme: { source: "shared/acme", include: ["skills", "agents"], clients: { copilot: {} } }
      }
    }`);

    const rejection = loadConfig(root);

    await expect(rejection).rejects.toThrow(
      "agents only exist inside a client extension namespace",
    );
    await expect(rejection).rejects.toThrow(
      `client "copilot" isn't listed in targets["agent-plugins"].clients`,
    );
  });

  it("fails the build when two agent files would land on the same Copilot path", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      { agents: { "reviewer.md": AGENT, "reviewer.agent.md": AGENT } },
    );

    await expect(build({ cwd: root })).rejects.toThrow(
      'Target "agent-plugins" plugin "acme": "agents/reviewer.agent.md" and "agents/reviewer.md" both write "com.github.copilot/agents/reviewer.agent.md". Rename or remove one of them.',
    );
  });

  it("takes Copilot's marketplace owner from clients.copilot.manifest", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: { manifest: { owner: { name: "Acme Platform" } } } },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {},
      `{ description: "Acme plugins." }`,
    );

    await build({ cwd: root });

    expect(
      (await readJsonFile(root, "out/.github/plugin/marketplace.json")).owner,
    ).toEqual({ name: "Acme Platform" });
  });

  it("takes Copilot's marketplace owner from metadata.owner before metadata.author", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {},
      `{
    description: "Acme plugins.",
    owner: { name: "Acme Platform", email: "platform@acme.example" },
    author: { name: "Jane Doe" }
  }`,
    );

    await build({ cwd: root });

    expect(
      (await readJsonFile(root, "out/.github/plugin/marketplace.json")).owner,
    ).toEqual({ name: "Acme Platform", email: "platform@acme.example" });
  });

  it("rejects a misspelled client name", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      clients: { copliot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`);

    await expect(loadConfig(root)).rejects.toThrow(/copliot/);
  });

  it("rejects per-plugin clients on another target", async () => {
    const root = await setup(`
    codex: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY}, clients: { codex: {} } } }
    }`);

    await expect(loadConfig(root)).rejects.toThrow(
      "targets.codex.plugins.acme.clients: clients is only supported for the agent-plugins target",
    );
  });

  it("renames .markdown and .mdc agents to NAME.agent.md for Copilot", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      { agents: { "one.markdown": AGENT, "two.mdc": AGENT } },
    );

    const [artifact] = await build({ cwd: root });

    expect(
      artifact.managedPaths.filter((file) => file.includes("/agents/")),
    ).toEqual([
      "plugins/acme/com.github.copilot/agents/one.agent.md",
      "plugins/acme/com.github.copilot/agents/two.agent.md",
    ]);
  });

  it("fails the build for a file in agents/ that Copilot can't load", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      { agents: { "reviewer.md": AGENT, "notes.txt": "notes\n" } },
    );

    await expect(build({ cwd: root })).rejects.toThrow(
      'Target "agent-plugins" plugin "acme": "agents/notes.txt" isn\'t an agent file Copilot can load. Copilot loads only agents/NAME.agent.md; use a .md, .markdown or .mdc agent, or move the file out of agents/.',
    );
  });

  it("rejects entry and the target manifest, which agent-plugins doesn't use", async () => {
    const root = await setup(`
    "agent-plugins": {
      outDir: "out",
      clients: { codex: {} },
      manifest: { owner: { name: "Acme" } },
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    }`);

    const rejection = loadConfig(root);

    await expect(rejection).rejects.toThrow(
      `manifest isn't used by the agent-plugins target; set it per client in targets["agent-plugins"].clients.<client>.manifest`,
    );
    await expect(rejection).rejects.toThrow(
      `entry isn't used by the agent-plugins target; set it per client in targets["agent-plugins"].plugins.acme.clients.<client>.entry`,
    );
  });

  it("builds only the listed clients when a client is set to undefined", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { codex: {}, copilot: undefined },
      plugins: { acme: { source: "shared/acme", clients: { codex: { ${CODEX_ENTRY} } } } }
    }`,
      { agents: { "reviewer.md": AGENT } },
    );

    const [artifact] = await build({ cwd: root });

    expect(artifact.managedPaths).toContain(".agents/plugins/marketplace.json");
    expect(artifact.managedPaths).not.toContain(
      ".github/plugin/marketplace.json",
    );
    expect(
      artifact.managedPaths.filter((file) =>
        file.includes("com.github.copilot"),
      ),
    ).toEqual([]);
  });

  it("fails the build for a client-only file that no listed client loads", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {
        "plugin.pluginpack.json": `${JSON.stringify({
          additionalFiles: { "commands/run.md": "extra.md" },
        })}\n`,
        "extra.md": "# run\n",
      },
    );

    await expect(build({ cwd: root })).rejects.toThrow(
      'Target "agent-plugins" plugin "acme": "commands/run.md" is commands content, and pluginpack doesn\'t place commands for any of the listed clients (copilot). Remove it, or list a client pluginpack places commands for.',
    );
  });

  it("fails the build for a hooks file that no listed client loads", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {
        "plugin.pluginpack.json": `${JSON.stringify({
          additionalFiles: { "hooks/hooks.json": "extra.json" },
        })}\n`,
        "extra.json": "{}\n",
      },
    );

    await expect(build({ cwd: root })).rejects.toThrow(
      'Target "agent-plugins" plugin "acme": "hooks/hooks.json" is hooks content, and pluginpack doesn\'t place hooks for any of the listed clients (copilot).',
    );
  });

  it("fails the build when a ./ destination would replace a placed agent", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {
        agents: { "reviewer.md": AGENT },
        "plugin.pluginpack.json": `${JSON.stringify({
          additionalFiles: {
            "./com.github.copilot/agents/reviewer.agent.md": "extra.md",
          },
        })}\n`,
        "extra.md": "# declared\n",
      },
    );

    await expect(build({ cwd: root })).rejects.toThrow(
      'both write "com.github.copilot/agents/reviewer.agent.md"',
    );
  });

  it("places a ./ agents destination for Copilot", async () => {
    const root = await setup(
      `
    "agent-plugins": {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {
        "plugin.pluginpack.json": `${JSON.stringify({
          additionalFiles: { "./agents/reviewer.md": "extra.md" },
        })}\n`,
        "extra.md": AGENT,
      },
    );

    const [artifact] = await build({ cwd: root });

    expect(artifact.managedPaths).toContain(
      "plugins/acme/com.github.copilot/agents/reviewer.agent.md",
    );
    expect(artifact.managedPaths).not.toContain(
      "plugins/acme/agents/reviewer.md",
    );
  });

  it("reports a malformed Codex entry and accepts a remote Codex source", async () => {
    const root = await setup(CLIENTS_TARGET);
    await build({ cwd: root });
    const out = path.join(root, "out");
    const codexFile = path.join(out, ".agents/plugins/marketplace.json");
    const codex = JSON.parse(await readFile(codexFile, "utf8")) as {
      plugins: unknown[];
    };
    const [entry] = codex.plugins as Record<string, unknown>[];
    codex.plugins = [
      null,
      {
        ...entry,
        source: { source: "url", url: "https://example.com/acme.git" },
      },
    ];
    await writeFile(codexFile, JSON.stringify(codex));

    const result = await validateOutput("agent-plugins", out);

    expect(result.issues.map((issue) => issue.message)).toEqual([
      "plugins[0] must be an object.",
    ]);
  });

  it("reports a missing Copilot owner, a structured Codex source that isn't a package, and agent frontmatter Copilot rejects", async () => {
    const root = await setup(CLIENTS_TARGET, {
      agents: { "reviewer.md": AGENT },
    });
    await build({ cwd: root });
    const out = path.join(root, "out");
    const codexFile = path.join(out, ".agents/plugins/marketplace.json");
    const codex = JSON.parse(await readFile(codexFile, "utf8")) as {
      plugins: Record<string, unknown>[];
    };
    codex.plugins[0].source = { source: "local", path: "./plugins/missing" };
    await writeFile(codexFile, JSON.stringify(codex));
    const copilotFile = path.join(out, ".github/plugin/marketplace.json");
    const copilot = JSON.parse(await readFile(copilotFile, "utf8")) as Record<
      string,
      unknown
    >;
    delete copilot.owner;
    await writeFile(copilotFile, JSON.stringify(copilot));
    await writeFile(
      path.join(
        out,
        "plugins/acme/com.github.copilot/agents/reviewer.agent.md",
      ),
      "---\nname: reviewer\n---\n\nReview.\n",
    );
    await writeFile(
      path.join(out, "plugins/acme/com.github.copilot/agents/notes.txt"),
      "notes\n",
    );

    const result = await validateOutput("agent-plugins", out);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      'acme: the Codex marketplace entry\'s source "./plugins/missing" is not an Agent Plugins package in this output.',
      'Marketplace is missing required field "owner".',
      'acme (com.github.copilot): agent frontmatter error in agents/reviewer.agent.md: Missing required "description" field.',
      'acme: agent file "com.github.copilot/agents/notes.txt" must be named NAME.agent.md for Copilot to load it.',
    ]);
  });

  it("allows clients only on the agent-plugins target", async () => {
    const root = await setup(`
    codex: {
      outDir: "out",
      clients: { copilot: {} },
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    }`);

    await expect(loadConfig(root)).rejects.toThrow(
      "targets.codex.clients: clients is only supported for the agent-plugins target",
    );
  });

  it("reports marketplace entries that don't match a package, and misnamed Copilot agents", async () => {
    const root = await setup(CLIENTS_TARGET, {
      agents: { "reviewer.md": AGENT },
    });
    await build({ cwd: root });
    const out = path.join(root, "out");
    const codexFile = path.join(out, ".agents/plugins/marketplace.json");
    const codex = JSON.parse(await readFile(codexFile, "utf8")) as {
      plugins: Record<string, unknown>[];
    };
    codex.plugins[0].name = "other";
    await writeFile(codexFile, JSON.stringify(codex));
    const copilotFile = path.join(out, ".github/plugin/marketplace.json");
    const copilot = JSON.parse(await readFile(copilotFile, "utf8")) as {
      plugins: Record<string, unknown>[];
    };
    copilot.plugins[0].source = "./plugins";
    await writeFile(copilotFile, JSON.stringify(copilot));
    await writeFile(
      path.join(out, "plugins/acme/com.github.copilot/agents/stray.md"),
      AGENT,
    );

    const result = await validateOutput("agent-plugins", out);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      'other: the Codex marketplace entry name does not match plugin.json name ("acme").',
      'acme: the Copilot marketplace entry\'s source "./plugins" is not an Agent Plugins package in this output.',
      'acme: agent file "com.github.copilot/agents/stray.md" must be named NAME.agent.md for Copilot to load it.',
    ]);
  });
});

describe("MCP config in packages", () => {
  const openaiAuth = {
    "com.openai": {
      auth: { type: "oauth", client: { mode: "dcr" } },
    },
  };
  const remoteWithAuth = {
    "config.json": `${JSON.stringify({
      mcpServers: {
        docs: {
          type: "streamable-http",
          url: "https://mcp.acme.example/mcp",
          extensions: openaiAuth,
        },
      },
    })}\n`,
  };

  it("carries Codex MCP auth under extensions on the codex target and validates it", async () => {
    const root = await setup(
      `
    codex: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    }`,
      { mcp: remoteWithAuth },
    );

    await build({ cwd: root });

    expect(await readJsonFile(root, "out/plugins/acme/mcp.json")).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        docs: {
          type: "streamable-http",
          url: "https://mcp.acme.example/mcp",
          extensions: openaiAuth,
        },
      },
    });
    await expect(
      validateOutput("codex", path.join(root, "out")),
    ).resolves.toMatchObject({ ok: true, issues: [] });
  });

  it("keeps the strict server shape on the agent-plugins target, even with clients.codex", async () => {
    for (const clients of ["", "clients: { codex: {} },"]) {
      const root = await setup(
        `
    "agent-plugins": {
      outDir: "out",
      ${clients}
      plugins: { acme: { source: "shared/acme" } }
    }`,
        { mcp: remoteWithAuth },
      );
      await expect(build({ cwd: root })).rejects.toThrow(
        'MCP server "docs" has field "extensions"',
      );
      await project?.dispose();
      project = undefined;
    }
  });

  it("warns at build time when a ./ command names a file the plugin doesn't ship, and validate fails", async () => {
    const root = await setup(
      `
    codex: {
      outDir: "codex",
      plugins: { acme: { source: "shared/acme", ${CODEX_ENTRY} } }
    },
    claude: {
      outDir: "claude",
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {
        scripts: { "server.sh": "#!/bin/sh\n" },
        mcp: {
          "config.json": `${JSON.stringify({
            mcpServers: {
              shipped: { command: "./scripts/server.sh" },
              missing: { command: "./bin/missing" },
              rooted: { command: "${CLAUDE_PLUGIN_ROOT}/bin/also-missing" },
            },
          })}\n`,
        },
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await build({ cwd: root });
      const warnings = warn.mock.calls.map((call) => String(call[0]));
      const fix =
        'Add the file to the plugin source (an MCP server file goes in mcp/pluginpack.json "files"), or fix the command.';
      expect(warnings).toEqual(
        ["claude", "codex"].flatMap((target) => [
          `Target "${target}" plugin "acme": MCP server "missing" "command" is "./bin/missing", but the plugin does not ship "bin/missing". ${fix}`,
          `Target "${target}" plugin "acme": MCP server "rooted" "command" is "\${CLAUDE_PLUGIN_ROOT}/bin/also-missing", but the plugin does not ship "bin/also-missing". ${fix}`,
        ]),
      );
    } finally {
      warn.mockRestore();
    }

    const result = await validateOutput("codex", path.join(root, "codex"));
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      'acme: mcp.json server "missing" "command" is "./bin/missing", but the package has no file "bin/missing" — the client can\'t start the server.',
      'acme: mcp.json server "rooted" "command" is "./bin/also-missing", but the package has no file "bin/also-missing" — the client can\'t start the server.',
    ]);
  });
});
