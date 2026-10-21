/**
 * Journey tests for the current authoring shape: canonical `shared/<plugin>`
 * sources, `overrides/<target>/<plugin>`, project partials and
 * `repositories/<target>` files, walked through the whole lifecycle a user
 * runs — build, edit a skill, delete a skill, add a skill, rebuild, prune,
 * clean — for all six targets at once.
 *
 * After every step the whole project tree must be exactly: the authored
 * sources, byte for byte as the author left them; every hand-written file in
 * the output; and, for each target, the managed files the current config
 * emits plus its managed manifest. So a step that touches a source, deletes a
 * hand-written file, leaves a stale file behind or misses a file fails here.
 * Component tests elsewhere check each piece; these check that the pieces
 * still compose across rebuilds.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Project, type ProjectArgs } from "fixturify-project";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "../src/build.js";
import { clean, prune } from "../src/cleanup.js";
import { validateOutput } from "../src/adapters.js";
import { exists, toPosix, walkFiles } from "../src/fs.js";
import { managedManifestPath, readManagedManifest } from "../src/managed.js";
import type { Artifact, TargetName } from "../src/types.js";

type DirJSON = NonNullable<ProjectArgs["files"]>;

const allTargets: TargetName[] = [
  "cursor",
  "claude",
  "antigravity",
  "copilot",
  "codex",
  "agent-plugins",
];

const indexPath = path.resolve("src/index.ts");

let project: Project | undefined;
let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await project?.dispose();
  project = undefined;
});

function skill(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n${body}\n`;
}

/** Where one target writes, and which optional pieces of the shape it uses. */
type Placement = {
  outDir: string;
  /** Extra target-level config, such as `pluginRoot`. */
  target?: string;
  /** Extra plugin-level config, such as `path`. */
  plugin?: string;
  repositoryFiles: boolean;
};

const codexEntry = `entry: { policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" },`;

function targetBlock(target: TargetName, placement: Placement): string {
  const pluginEntry =
    target === "agent-plugins"
      ? `clients: { codex: { ${codexEntry} } },`
      : target === "codex"
        ? codexEntry
        : "";
  return `"${target}": {
      outDir: "${placement.outDir}",
      ${placement.repositoryFiles ? `repositoryFiles: "repositories/${target}",` : ""}
      ${target === "agent-plugins" ? "clients: { codex: {}, copilot: {} }," : ""}
      ${placement.target ?? ""}
      plugins: {
        acme: {
          source: "shared/acme",
          overrides: "overrides/${target}/acme",
          ${placement.plugin ?? ""}
          ${pluginEntry}
        },
      },
    },`;
}

function configSource(targets: string): string {
  return `import { defineConfig } from "${indexPath}";

export default defineConfig({
  name: "acme-plugins",
  version: "1.0.0",
  source: { partials: "partials" },
  metadata: {
    description: "Acme agent plugins.",
    author: { name: "Acme" },
    owner: { name: "Acme" },
    license: "MIT",
    repository: "https://github.com/acme/acme-plugins",
  },
  targets: {
    ${targets}
  },
});
`;
}

/** Files every journey project authors, apart from the config. */
function authoredFiles(): DirJSON {
  const overrides: DirJSON = {};
  const repositories: DirJSON = {};
  for (const target of allTargets) {
    overrides[target] = {
      acme: {
        assets: {
          // Replaces the shared icon, and adds a target-only file.
          "icon.svg": `<svg><title>${target}</title></svg>\n`,
          [`${target}-note.txt`]: `Only in ${target}.\n`,
        },
      },
    };
    repositories[target] = {
      "README.md": `# Acme for ${target}\n\n{{> auth}}\n`,
    };
  }
  return {
    partials: { "auth.md": "Try OAuth first, then fall back to a token.\n" },
    shared: {
      acme: {
        skills: {
          alpha: { "SKILL.md": skill("alpha", "{{> auth}}") },
          beta: { "SKILL.md": skill("beta", "Beta body.") },
        },
        agents: {
          "helper.agent.md":
            "---\nname: helper\ndescription: Find documents.\n---\n\nSearch and cite.\n",
        },
        assets: { "icon.svg": "<svg><title>shared</title></svg>\n" },
        mcp: {
          "config.json": JSON.stringify(
            {
              mcpServers: {
                acme: {
                  type: "stdio",
                  command: "node",
                  args: ["./start.mjs"],
                },
              },
            },
            null,
            2,
          ),
          "pluginpack.json": JSON.stringify(
            { files: { "start.mjs": "start.mjs" } },
            null,
            2,
          ),
          "start.mjs": "console.log('acme');\n",
          // MCP source that must not ship.
          src: { "server.ts": "export {};\n" },
        },
      },
    },
    overrides,
    repositories,
  };
}

async function makeProject(config: string, files: DirJSON): Promise<string> {
  project = new Project("pluginpack-journey", "1.0.0", {
    files: { "pluginpack.config.ts": config, ...files },
  });
  await project.write();
  return project.baseDir;
}

/**
 * Every file under `dir` (relative, posix) with its contents, sorted.
 * Skips the `package.json` fixturify writes at the project root.
 */
async function readTree(dir: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  if (!(await exists(dir))) {
    return tree;
  }
  for (const file of await walkFiles(dir)) {
    const relative = toPosix(path.relative(dir, file));
    if (relative !== "package.json") {
      tree.set(relative, await readFile(file, "utf8"));
    }
  }
  return new Map([...tree].sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Asserts each hand-written file is still on disk with the bytes it was written with. */
async function expectSurvives(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    expect(
      await readFile(path.join(root, relative), "utf8"),
      `${relative} should survive`,
    ).toBe(contents);
  }
}

/** Root-relative path of a file inside a target's output. */
function inOutput(root: string, artifact: Artifact, relative: string): string {
  return toPosix(path.relative(root, path.join(artifact.outDir, relative)));
}

/**
 * Asserts the project tree is exactly `sources` plus `unmanaged` plus each
 * artifact's managed files (with the bytes the artifact emitted) and managed
 * manifest, and that each manifest lists exactly the artifact's paths.
 */
async function expectProjectTree(
  root: string,
  step: string,
  sources: Map<string, string>,
  unmanaged: Record<string, string>,
  artifacts: Artifact[],
): Promise<void> {
  const expected = new Map<string, string | undefined>([
    ...sources,
    ...Object.entries(unmanaged),
  ]);
  for (const artifact of artifacts) {
    for (const managedPath of artifact.managedPaths) {
      const value = artifact.files.get(managedPath);
      expected.set(
        inOutput(root, artifact, managedPath),
        typeof value === "string" ? value : value?.toString("utf8"),
      );
    }
    expected.set(
      inOutput(root, artifact, managedManifestPath(artifact.target)),
      undefined,
    );
    const manifest = await readManagedManifest(
      artifact.outDir,
      artifact.target,
    );
    expect(manifest?.files, `${step}: ${artifact.target} manifest`).toEqual(
      artifact.managedPaths,
    );
  }
  const onDisk = await readTree(root);
  expect([...onDisk.keys()], `${step}: project tree`).toEqual(
    [...expected.keys()].sort(),
  );
  for (const [relative, contents] of expected) {
    if (contents !== undefined) {
      expect(onDisk.get(relative), `${step}: ${relative}`).toBe(contents);
    }
  }
}

async function expectValid(target: TargetName, outDir: string): Promise<void> {
  const result = await validateOutput(target, outDir);
  expect(
    result.issues.filter((issue) => issue.level === "error"),
    `${target} validate errors`,
  ).toEqual([]);
  expect(result.ok).toBe(true);
}

/** The managed path ending with `suffix`; throws if the artifact has none. */
function findOutput(artifact: Artifact, suffix: string): string {
  const found = artifact.managedPaths.find((managedPath) =>
    managedPath.endsWith(suffix),
  );
  if (!found) {
    throw new Error(
      `${artifact.target} emitted no path ending with ${suffix}: ${artifact.managedPaths.join(", ")}`,
    );
  }
  return found;
}

const layouts: Record<string, Record<TargetName, Placement>> = {
  "one outDir per target": Object.fromEntries(
    allTargets.map((target) => [
      target,
      { outDir: `out/${target}`, repositoryFiles: true },
    ]),
  ) as Record<TargetName, Placement>,
  // README "Recommended Shape": cursor and claude share the repository root,
  // so only cursor publishes repositories/ (both would write README.md).
  "the README's recommended shape": {
    cursor: {
      outDir: ".",
      plugin: `path: "plugins/cursor/acme",`,
      repositoryFiles: true,
    },
    claude: {
      outDir: ".",
      target: `pluginRoot: "plugins/claude",`,
      repositoryFiles: false,
    },
    antigravity: { outDir: "plugins/antigravity", repositoryFiles: true },
    copilot: { outDir: "plugins/copilot", repositoryFiles: true },
    codex: { outDir: "plugins/codex", repositoryFiles: true },
    "agent-plugins": { outDir: "plugins/agent-plugins", repositoryFiles: true },
  },
};

describe.each(Object.entries(layouts))(
  "current authoring shape across all six targets, %s",
  (_name, layout) => {
    it("survives build, edit, delete, add, rebuild, prune and clean", async () => {
      const root = await makeProject(
        configSource(
          allTargets
            .map((target) => targetBlock(target, layout[target]))
            .join("\n"),
        ),
        authoredFiles(),
      );
      // Everything on disk before the first build is authored.
      const sources = await readTree(root);
      const editSource = async (
        relative: string,
        contents: string | undefined,
      ): Promise<void> => {
        if (contents === undefined) {
          await rm(path.join(root, relative));
          sources.delete(relative);
        } else {
          await writeFiles(root, { [relative]: contents });
          sources.set(relative, contents);
        }
      };

      // --- build -------------------------------------------------------
      let artifacts = await build({ cwd: root });
      expect(artifacts.map((artifact) => artifact.target).sort()).toEqual(
        [...allTargets].sort(),
      );

      // Hand-written files: one in each output root, one beside a skill
      // that stays, and one inside the directory of the skill that will be
      // deleted.
      const unmanaged: Record<string, string> = {};
      for (const artifact of artifacts) {
        const alpha = findOutput(artifact, "skills/alpha/SKILL.md");
        const beta = findOutput(artifact, "skills/beta/SKILL.md");
        const files = {
          [`NOTES-${artifact.target}.md`]: `Notes for ${artifact.target}.\n`,
          [path.posix.join(path.posix.dirname(alpha), "LOCAL.md")]:
            "Local alpha notes.\n",
          [path.posix.join(path.posix.dirname(beta), "LOCAL.md")]:
            "Local beta notes.\n",
        };
        await writeFiles(artifact.outDir, files);
        for (const [relative, contents] of Object.entries(files)) {
          unmanaged[inOutput(root, artifact, relative)] = contents;
        }
      }

      const checkStep = async (step: string): Promise<void> => {
        await expectProjectTree(root, step, sources, unmanaged, artifacts);
        for (const artifact of artifacts) {
          await expectValid(artifact.target, artifact.outDir);
        }
      };
      await checkStep("build");

      for (const artifact of artifacts) {
        const alpha = String(
          artifact.files.get(findOutput(artifact, "skills/alpha/SKILL.md")),
        );
        // The partial resolved.
        expect(alpha).toContain("Try OAuth first, then fall back to a token.");
        expect(alpha).not.toContain("{{>");
        // The repository file was published, with its partial resolved.
        if (layout[artifact.target].repositoryFiles) {
          expect(String(artifact.files.get("README.md"))).toBe(
            `# Acme for ${artifact.target}\n\nTry OAuth first, then fall back to a token.\n`,
          );
        }
        // The override replaced the shared icon and added a target-only file.
        expect(
          String(artifact.files.get(findOutput(artifact, "assets/icon.svg"))),
        ).toBe(`<svg><title>${artifact.target}</title></svg>\n`);
        findOutput(artifact, `assets/${artifact.target}-note.txt`);
        // MCP shipped its declared file, not its source.
        findOutput(artifact, "start.mjs");
        expect(
          artifact.managedPaths.filter((managedPath) =>
            managedPath.includes("server.ts"),
          ),
        ).toEqual([]);
      }
      // One package serves both clients: a marketplace each, one package.
      const multi = artifacts.find(
        (artifact) => artifact.target === "agent-plugins",
      )!;
      expect(multi.managedPaths).toContain(".agents/plugins/marketplace.json");
      expect(multi.managedPaths).toContain(".github/plugin/marketplace.json");
      findOutput(multi, "com.github.copilot/agents/helper.agent.md");
      expect(
        multi.managedPaths.filter((managedPath) =>
          managedPath.endsWith("plugin.json"),
        ),
      ).toHaveLength(1);

      // --- edit a skill, rebuild ---------------------------------------
      await editSource(
        "shared/acme/skills/alpha/SKILL.md",
        skill("alpha", "Edited alpha.\n\n{{> auth}}"),
      );
      artifacts = await build({ cwd: root });
      await checkStep("edit");
      for (const artifact of artifacts) {
        expect(
          String(
            artifact.files.get(findOutput(artifact, "skills/alpha/SKILL.md")),
          ),
        ).toContain("Edited alpha.");
      }

      // --- delete a skill, rebuild -------------------------------------
      await editSource("shared/acme/skills/beta/SKILL.md", undefined);
      artifacts = await build({ cwd: root });
      await checkStep("delete");
      for (const artifact of artifacts) {
        expect(
          artifact.managedPaths.filter((managedPath) =>
            managedPath.includes("skills/beta/"),
          ),
        ).toEqual([]);
      }

      // --- add a skill, rebuild ----------------------------------------
      await editSource(
        "shared/acme/skills/gamma/SKILL.md",
        skill("gamma", "Gamma body."),
      );
      artifacts = await build({ cwd: root });
      await checkStep("add");
      const gammaPaths = new Map(
        artifacts.map((artifact) => [
          artifact.target,
          findOutput(artifact, "skills/gamma/SKILL.md"),
        ]),
      );

      // --- delete a skill, prune without rebuilding --------------------
      await editSource("shared/acme/skills/gamma/SKILL.md", undefined);
      const before = await readTree(root);
      const dryRun = await prune({ cwd: root, dryRun: true });
      expect(await readTree(root)).toEqual(before);
      for (const result of dryRun) {
        expect(
          result.entries.map((entry) => entry.path),
          `${result.target} prune --dry-run`,
        ).toEqual([gammaPaths.get(result.target)]);
      }
      const pruned = await prune({ cwd: root });
      expect(
        Object.fromEntries(
          pruned.map((result) => [
            result.target,
            result.entries.map((entry) => entry.path),
          ]),
        ),
      ).toEqual(
        Object.fromEntries(
          [...gammaPaths].map(([target, gamma]) => [target, [gamma]]),
        ),
      );
      for (const artifact of artifacts) {
        expect(
          await exists(
            path.join(artifact.outDir, gammaPaths.get(artifact.target)!),
          ),
        ).toBe(false);
      }
      // Rebuild: nothing left to remove, and a second prune finds nothing.
      artifacts = await build({ cwd: root });
      await checkStep("prune");
      const again = await prune({ cwd: root });
      expect(again.flatMap((result) => result.entries)).toEqual([]);

      // --- clean -------------------------------------------------------
      const cleaned = await clean({ cwd: root });
      expect(cleaned.map((result) => result.target).sort()).toEqual(
        [...allTargets].sort(),
      );
      await expectProjectTree(root, "clean", sources, unmanaged, []);
      await expectSurvives(root, unmanaged);

      // Nothing in this journey edited generated output, so nothing should
      // have warned about overwriting or deleting an edited file.
      expect(
        warnings.filter((warning) => /edited|changed since/i.test(warning)),
      ).toEqual([]);
    });
  },
);

/**
 * Moving a plugin between the `codex` target and an `agent-plugins` package
 * that lists `clients.codex`, in one output directory. Both targets write
 * `.agents/plugins/marketplace.json` and `plugins/<name>/plugin.json`, so
 * they cannot be configured over one outDir at the same time; the move is a
 * config change between builds.
 */
describe("codex <-> agent-plugins clients.codex handoff in one outDir", () => {
  const configs = {
    codex: `codex: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme", ${codexEntry} } },
    },`,
    "agent-plugins": `"agent-plugins": {
      outDir: "out",
      clients: { codex: {}, copilot: {} },
      plugins: { acme: { source: "shared/acme", clients: { codex: { ${codexEntry} } } } },
    },`,
  } as const;
  type Side = keyof typeof configs;
  const handoffs: [Side, Side][] = [
    ["codex", "agent-plugins"],
    ["agent-plugins", "codex"],
  ];
  const notes = { "out/NOTES.md": "Hand-written.\n" };

  const handoffFiles = (): DirJSON => ({
    partials: { "auth.md": "Unused here.\n" },
    shared: {
      acme: {
        skills: { alpha: { "SKILL.md": skill("alpha", "Alpha body.") } },
        // Codex ships hooks; an agent-plugins package has nowhere to put them.
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
    },
  });

  /**
   * Rewrites `pluginpack.config.ts` in place to build one side, as a user
   * editing the config would, and records the new bytes as authored.
   */
  async function useConfig(
    root: string,
    sources: Map<string, string>,
    side: Side,
  ): Promise<void> {
    const contents = configSource(configs[side]);
    await writeFiles(root, { "pluginpack.config.ts": contents });
    sources.set("pluginpack.config.ts", contents);
  }

  /** The project after building `from` and adding a hand-written file. */
  async function builtWith(from: Side) {
    const root = await makeProject(configSource(""), handoffFiles());
    const sources = await readTree(root);
    await useConfig(root, sources, from);
    const [first] = await build({ cwd: root });
    expect(first.target).toBe(from);
    await writeFiles(root, notes);
    await expectProjectTree(root, "first build", sources, notes, [first]);
    await expectValid(from, path.join(root, "out"));
    return { root, sources };
  }

  /** Builds `to`, checks its output is complete and valid, then cleans it. */
  async function buildAndCleanNew(
    root: string,
    sources: Map<string, string>,
    to: Side,
  ): Promise<void> {
    const [second] = await build({ cwd: root });
    expect(second.target).toBe(to);
    await expectProjectTree(root, "build new", sources, notes, [second]);
    await expectValid(to, path.join(root, "out"));
    expect(second.managedPaths.includes("plugins/acme/hooks/hooks.json")).toBe(
      to === "codex",
    );

    await clean({ cwd: root });
    await expectProjectTree(root, "clean new", sources, notes, []);
  }

  it.each(handoffs)(
    "%s -> %s: clean the old target first, then build the new one",
    async (from, to) => {
      const { root, sources } = await builtWith(from);

      // The documented move: clean the old target while it is still
      // configured, then switch the config and build the new one.
      await clean({ cwd: root, target: from });
      await expectProjectTree(root, "clean old", sources, notes, []);

      await useConfig(root, sources, to);
      await buildAndCleanNew(root, sources, to);
    },
  );

  // Switching first leaves the old target's manifest in `out`, and no
  // configured target would prune the files it lists (codex's hooks inside
  // an agent-plugins package, say, which fail validation). build and prune
  // refuse, name the manifest and say which clean to run; that clean finds
  // the manifest even though the old target is no longer configured.
  it.each(handoffs)(
    "%s -> %s: switching the config without cleaning refuses until the old target is cleaned",
    async (from, to) => {
      const { root, sources } = await builtWith(from);

      await useConfig(root, sources, to);
      const before = await readTree(root);
      // Names the stale manifest, then the command that removes it.
      const refusal = new RegExp(
        `${escapeRegExp(`${from}.json (${from})`)}[\\s\\S]*${escapeRegExp(`pluginpack clean --target ${from}`)}`,
      );
      await expect(build({ cwd: root }), "build refuses").rejects.toThrow(
        refusal,
      );
      await expect(prune({ cwd: root }), "prune refuses").rejects.toThrow(
        refusal,
      );
      // Refusing touched nothing.
      expect(await readTree(root)).toEqual(before);

      const cleaned = await clean({ cwd: root, target: from });
      expect(cleaned.map((result) => result.target)).toEqual([from]);
      await expectProjectTree(root, "clean old", sources, notes, []);

      await buildAndCleanNew(root, sources, to);
    },
  );
});

// A long-lived process calling the programmatic API (a watcher, a test
// harness) must build the config on disk, not a cached copy of an earlier one.
it("build() reads pluginpack.config.ts again after it changes", async () => {
  const placement = { outDir: "out", repositoryFiles: false };
  const root = await makeProject(
    configSource(targetBlock("claude", placement)),
    authoredFiles(),
  );
  const [first] = await build({ cwd: root });
  expect(first.target).toBe("claude");
  await clean({ cwd: root });
  await writeFiles(root, {
    "pluginpack.config.ts": configSource(targetBlock("cursor", placement)),
  });
  const [second] = await build({ cwd: root });
  expect(second.target).toBe("cursor");
});
