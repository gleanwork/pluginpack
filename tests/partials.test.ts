import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Project, type ProjectArgs } from "fixturify-project";
import { afterEach, describe, expect, it } from "vitest";
import { validateOutput } from "../src/adapters.js";
import { build } from "../src/build.js";
import { loadPartials, resolvePartials } from "../src/partials.js";

type DirJSON = NonNullable<ProjectArgs["files"]>;

let project: Project | undefined;

afterEach(async () => {
  await project?.dispose();
  project = undefined;
});

const partials = new Map([
  ["auth", "Authenticate first."],
  ["lbrace", "{"],
  ["open", "x{{"],
]);

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`;
}

/** A project with one shared source `acme`, partials, and the given targets block. */
async function setup(targets: string, files: DirJSON): Promise<string> {
  project = new Project("partials-fixture", "1.0.0", {
    files: {
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "acme-plugins",
  version: "1.0.0",
  source: { partials: "partials" },
  metadata: { description: "Acme", author: { name: "Acme" }, license: "MIT" },
  targets: {
${targets}
  }
});
`,
      partials: { "auth.md": "Authenticate first." },
      ...files,
    },
  });
  await project.write();
  return project.baseDir;
}

describe("partial substitution keeps file bytes intact", () => {
  it("refuses to substitute in a file that is not valid UTF-8 instead of emitting U+FFFD", async () => {
    const root = await setup(
      `    cursor: { outDir: "dist", plugins: { acme: { source: "shared/acme" } } }`,
      { shared: { acme: { skills: { a: { "SKILL.md": skill("a") } } } } },
    );
    const skillPath = path.join(root, "shared/acme/skills/a/SKILL.md");
    await writeFile(
      skillPath,
      Buffer.concat([
        Buffer.from(`${skill("a")}caf`),
        Buffer.from([0xe9]),
        Buffer.from(" a\n{{> auth}}\n"),
      ]),
    );

    await expect(build({ cwd: root })).rejects.toThrow(
      /Partial substitution failed in "skills\/a\/SKILL\.md": the file is not valid UTF-8/,
    );
    await expect(
      readFile(path.join(root, "dist/acme/skills/a/SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a file with a byte-order mark and NUL bytes that is not valid UTF-8", () => {
    const value = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0x41]),
      Buffer.from("\n{{> auth}}\n"),
    ]);
    expect(() => resolvePartials("rules/policy.txt", value, partials)).toThrow(
      /not valid UTF-8/,
    );
  });

  it("still substitutes in valid UTF-8 that contains NUL bytes, keeping them", () => {
    const value = Buffer.from("a\u0000b {{> auth}}");
    expect(resolvePartials("rules/policy.txt", value, partials)).toBe(
      "a\u0000b Authenticate first.",
    );
  });

  it("refuses a partial file that is not valid UTF-8", async () => {
    project = new Project("partials-latin1", "1.0.0", {
      files: { partials: { "auth.md": "placeholder" } },
    });
    await project.write();
    const partialsDir = path.join(project.baseDir, "partials");
    await writeFile(
      path.join(partialsDir, "auth.md"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    );

    await expect(loadPartials(partialsDir)).rejects.toThrow(
      /Partial "auth" \(auth\.md\) is not valid UTF-8/,
    );
  });

  it("strips a partial's byte-order mark instead of inlining U+FEFF mid-file", async () => {
    project = new Project("partials-bom", "1.0.0", {
      files: { partials: { "auth.md": "\uFEFFAuthenticate first." } },
    });
    await project.write();
    const loaded = await loadPartials(path.join(project.baseDir, "partials"));

    expect(resolvePartials("a.md", "Before {{> auth}}", loaded)).toBe(
      "Before Authenticate first.",
    );
  });

  it("writes a partial with the including file's line endings", async () => {
    project = new Project("partials-eol", "1.0.0", {
      files: {
        partials: {
          "crlf.md": "one\r\ntwo\r\n",
          "lf.md": "three\nfour\n",
          "outer.md": "outer\n{{> lf}}\n",
        },
      },
    });
    await project.write();
    const loaded = await loadPartials(path.join(project.baseDir, "partials"));

    expect(resolvePartials("a.md", "start\n{{> crlf}}\nend\n", loaded)).toBe(
      "start\none\ntwo\nend\n",
    );
    expect(
      resolvePartials("a.md", "start\r\n{{> outer}}\r\nend\r\n", loaded),
    ).toBe("start\r\nouter\r\nthree\r\nfour\r\nend\r\n");
  });
});

describe("partial substitution file types", () => {
  it.each(["NOTES.MD", "Notes.Md", "REF.TXT", "guide.Markdown", "rule.MDC"])(
    "substitutes in %s regardless of extension case",
    (file) => {
      expect(resolvePartials(`skills/a/${file}`, "{{> auth}}", partials)).toBe(
        "Authenticate first.",
      );
    },
  );

  it("builds a NOTES.MD containing a partial tag", async () => {
    const root = await setup(
      `    cursor: { outDir: "dist", plugins: { acme: { source: "shared/acme" } } }`,
      {
        shared: {
          acme: {
            skills: {
              a: { "SKILL.md": skill("a"), "NOTES.MD": "{{> auth}}\n" },
            },
          },
        },
      },
    );

    await build({ cwd: root });

    await expect(
      readFile(path.join(root, "dist/acme/skills/a/NOTES.MD"), "utf8"),
    ).resolves.toBe("Authenticate first.");
  });
});

describe("partial substitution never emits a live tag", () => {
  it("fails when a partial ending in { joins the text after it into a tag", () => {
    expect(() =>
      resolvePartials("a.md", "{{> lbrace}}{> auth}}", partials),
    ).toThrow(
      /Partial substitution failed in "a\.md": substituting partials produced the tag "\{\{> auth\}\}"/,
    );
  });

  it("fails when a partial ending in {{ joins the text after it into a tag", () => {
    expect(() =>
      resolvePartials("a.md", "{{> open}}> auth}}", partials),
    ).toThrow(/produced the tag "\{\{> auth\}\}"/);
  });

  it("fails when an extra { before a tag leaves a tag in the output", () => {
    expect(() => resolvePartials("a.md", "{{{> auth}}}", partials)).toThrow(
      /produced the tag "\{\{> auth\}\}"/,
    );
  });

  it("treats a doubled backslash as an escape, with a backslash partial as the workaround", () => {
    const withBackslash = new Map([...partials, ["backslash", "\\"]]);
    expect(resolvePartials("a.md", "\\\\{{> auth}}", withBackslash)).toBe(
      "\\{{> auth}}",
    );
    expect(
      resolvePartials("a.md", "{{> backslash}}{{> auth}}", withBackslash),
    ).toBe("\\Authenticate first.");
  });

  it("still emits an escaped tag literally, even next to a brace", () => {
    expect(
      resolvePartials(
        "a.md",
        "Write \\{{> auth}} or {\\{{> auth}}}.",
        partials,
      ),
    ).toBe("Write {{> auth}} or {{{> auth}}}.");
  });
});

describe("validate and partial tags", () => {
  it("reports nothing for an escaped tag in a substituted file type", async () => {
    const root = await setup(
      `    cursor: { outDir: "dist", plugins: { acme: { source: "shared/acme" } } }`,
      {
        shared: {
          acme: {
            skills: {
              a: {
                "SKILL.md": `${skill("a")}\nReference a partial by writing \\{{> auth}} in a skill file.\n`,
              },
            },
          },
        },
      },
    );
    await build({ cwd: root });
    await expect(
      readFile(path.join(root, "dist/acme/skills/a/SKILL.md"), "utf8"),
    ).resolves.toContain("writing {{> auth}} in");

    await expect(
      validateOutput("cursor", path.join(root, "dist")),
    ).resolves.toEqual({ ok: true, issues: [] });
  });

  // A plugin emitted at the output root (`path: "."`) shares that root with
  // authored sources and dependencies, which validate must not scan.
  // Each row: target, targets block, native manifest, native MCP file.
  const rootTargets = [
    [
      "cursor",
      `    cursor: { outDir: ".", plugins: { acme: { source: "shared/acme", path: "." } } }`,
      ".cursor-plugin/plugin.json",
      ".mcp.json",
    ],
    [
      "claude",
      `    claude: { outDir: ".", plugins: { acme: { source: "shared/acme", path: "." } } }`,
      ".claude-plugin/plugin.json",
      ".mcp.json",
    ],
    [
      "copilot",
      `    copilot: { outDir: ".", plugins: { acme: { source: "shared/acme", path: "." } } }`,
      ".github/plugin/plugin.json",
      ".mcp.json",
    ],
    [
      "codex",
      `    codex: { outDir: ".", plugins: { acme: { source: "shared/acme", path: ".", entry: { policy: { installation: "AVAILABLE", authentication: "NOT_REQUIRED" }, category: "Developer Tools" } } } }`,
      "plugin.json",
      "mcp.json",
    ],
    [
      "agent-plugins",
      `    "agent-plugins": { outDir: ".", plugins: { acme: { source: "shared/acme", path: "." } } }`,
      "plugin.json",
      "mcp.json",
    ],
  ] as const;

  it.each(rootTargets)(
    "validates a %s plugin emitted at the output root without scanning unrelated files",
    async (target, targets) => {
      const root = await setup(targets, {
        shared: {
          acme: {
            skills: { a: { "SKILL.md": `${skill("a")}\n{{> auth}}\n` } },
          },
        },
        node_modules: {
          dep: { "index.js": 'const example = "{{> x}}";\n' },
          ".cache": { jiti: { "x.mjs": "// {{> x}}\n" } },
        },
        notes: { "unrelated.yaml": "a: '{{> x}}'\n" },
      });
      await build({ cwd: root });

      await expect(validateOutput(target, root)).resolves.toEqual({
        ok: true,
        issues: [],
      });
    },
  );

  // The host reads its native manifest and MCP file from a root plugin no
  // matter which tool wrote them, so validate checks them with or without
  // the managed manifest.
  it.each(rootTargets)(
    "flags a tag in a %s root plugin's native manifest and MCP file, with or without managed state",
    async (target, targets, manifestPath, mcpPath) => {
      const root = await setup(targets, {
        shared: { acme: { skills: { a: { "SKILL.md": skill("a") } } } },
      });
      await build({ cwd: root });
      const manifestFile = path.join(root, manifestPath);
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      manifest.description = "{{> auth}}";
      await writeFile(manifestFile, JSON.stringify(manifest));
      await writeFile(
        path.join(root, mcpPath),
        JSON.stringify({ mcpServers: { s: { command: "{{> auth}}" } } }),
      );
      const expected = {
        ok: false,
        issues: expect.arrayContaining([
          {
            level: "error",
            message: expect.stringContaining(
              `${manifestPath} contains an unsubstituted partial reference {{> auth}}`,
            ),
          },
          {
            level: "error",
            message: expect.stringContaining(
              `${mcpPath} contains an unsubstituted partial reference {{> auth}}`,
            ),
          },
        ]),
      };

      await expect(validateOutput(target, root)).resolves.toEqual(expected);
      await rm(path.join(root, ".pluginpack"), { recursive: true });
      await expect(validateOutput(target, root)).resolves.toEqual(expected);
    },
  );

  it("flags a tag in a root Agent Plugins package's client extension directory without managed state", async () => {
    const root = await setup(
      `    "agent-plugins": { outDir: ".", plugins: { acme: { source: "shared/acme", path: "." } } }`,
      { shared: { acme: { skills: { a: { "SKILL.md": skill("a") } } } } },
    );
    await build({ cwd: root });
    await rm(path.join(root, ".pluginpack"), { recursive: true });
    await mkdir(path.join(root, "com.github.copilot"));
    await writeFile(
      path.join(root, "com.github.copilot/lsp.json"),
      '{"a": "{{> auth}}"}',
    );

    await expect(validateOutput("agent-plugins", root)).resolves.toEqual({
      ok: false,
      issues: [
        {
          level: "error",
          message: expect.stringContaining(
            "com.github.copilot/lsp.json contains an unsubstituted partial reference {{> auth}}",
          ),
        },
      ],
    });
  });

  it("scans only managed files and native files for a root plugin with managed state", async () => {
    const root = await setup(
      `    cursor: { outDir: ".", plugins: { acme: { source: "shared/acme", path: ".", include: ["skills"] } } }`,
      {
        shared: { acme: { skills: { a: { "SKILL.md": skill("a") } } } },
        scripts: { "check-template.mjs": 'const tag = "{{> auth}}";\n' },
      },
    );
    await build({ cwd: root });

    await expect(validateOutput("cursor", root)).resolves.toEqual({
      ok: true,
      issues: [],
    });
  });

  it("flags a tag in a managed file of a root-level plugin", async () => {
    const root = await setup(
      `    cursor: { outDir: ".", plugins: { acme: { source: "shared/acme", path: "." } } }`,
      {
        shared: {
          acme: {
            skills: { a: { "SKILL.md": skill("a"), "data.yaml": "a: 1\n" } },
          },
        },
      },
    );
    await build({ cwd: root });
    await writeFile(path.join(root, "skills/a/data.yaml"), "a: {{> auth}}\n");

    const result = await validateOutput("cursor", root);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        level: "error",
        message: expect.stringContaining(
          "skills/a/data.yaml contains an unsubstituted partial reference {{> auth}}",
        ),
      },
    ]);
  });

  it("falls back to a root-level plugin's component directories without managed state", async () => {
    const root = await setup(
      `    cursor: { outDir: ".", plugins: { acme: { source: "shared/acme", path: "." } } }`,
      { shared: { acme: { skills: { a: { "SKILL.md": skill("a") } } } } },
    );
    await build({ cwd: root });
    await rm(path.join(root, ".pluginpack"), { recursive: true });
    await writeFile(path.join(root, "skills/a/data.yaml"), "a: {{> auth}}\n");

    const result = await validateOutput("cursor", root);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        level: "error",
        message: expect.stringContaining(
          "skills/a/data.yaml contains an unsubstituted partial reference {{> auth}}",
        ),
      },
    ]);
  });
});
