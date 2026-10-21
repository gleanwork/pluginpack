/**
 * Golden output: builds fixed configs and compares every emitted file — its
 * path and its exact bytes — against the tree checked in under
 * `tests/golden/<case>/<target>/`, including the serialized managed manifest
 * `.pluginpack/<target>.json`. Emitted output is a compatibility surface:
 * renaming a path, reordering a manifest field or changing a byte of a
 * generated file changes what hosts and downstream repos see. This test makes
 * such a change fail CI until someone regenerates the goldens on purpose:
 *
 *   npm run test:golden:update
 *
 * then reviews `git diff tests/golden` and says in the PR why output changed.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Project, type ProjectArgs } from "fixturify-project";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "../src/build.js";
import { validateOutput } from "../src/adapters.js";
import { exists, toPosix, walkFiles } from "../src/fs.js";
import { managedManifestPath } from "../src/managed.js";
import type { TargetName } from "../src/types.js";

type DirJSON = NonNullable<ProjectArgs["files"]>;

const goldenRoot = fileURLToPath(new URL("./golden/", import.meta.url));
const update = process.env.UPDATE_GOLDEN === "1";
const updateCommand = "npm run test:golden:update";

if (update && process.env.CI) {
  throw new Error(
    "UPDATE_GOLDEN is set in CI. Golden output is regenerated locally and reviewed, never rewritten by CI.",
  );
}

const indexPath = path.resolve("src/index.ts");

let project: Project | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await project?.dispose();
  project = undefined;
});

const skillMd = `---
name: release-notes
description: Draft release notes from a list of changes.
---

# Release notes

{{> greeting}}

Group the changes by feature and fix.
`;

// A minimal valid PNG header and IHDR chunk, so binary passthrough is pinned too.
const iconPng = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

/** The authored text files every golden case builds, plus `iconPng`. Change them and the goldens change. */
function sourceFiles(): DirJSON {
  return {
    partials: { "greeting.md": "Start by reading the changelog.\n" },
    repositories: {
      all: {
        "README.md": "# Golden plugins\n\n{{> greeting}}\n",
        "CONTRIBUTING.md": "Edit shared/, not the generated output.\n",
      },
    },
    shared: {
      acme: {
        "plugin.pluginpack.json": `${JSON.stringify({ description: "Acme from the source manifest." }, null, 2)}\n`,
        "README.md": "# Acme\n\n{{> greeting}}\n",
        LICENSE: "MIT\n",
        skills: {
          "release-notes": {
            "SKILL.md": skillMd,
            references: { "template.txt": "## Features\n\n## Fixes\n" },
          },
        },
        agents: {
          "helper.agent.md":
            "---\nname: helper\ndescription: Find documents that answer a question.\n---\n\nSearch and cite sources.\n",
        },
        commands: {
          "summarize.md":
            "---\ndescription: Summarize the open file.\n---\n\nSummarize it.\n",
        },
        rules: {
          "style.mdc":
            "---\ndescription: House style.\nalwaysApply: false\n---\n\nUse short sentences.\n",
        },
        hooks: {
          "hooks.json": `${JSON.stringify(
            {
              hooks: {
                SessionStart: [
                  { hooks: [{ type: "command", command: "echo ready" }] },
                ],
              },
            },
            null,
            2,
          )}\n`,
        },
        scripts: { "run.sh": "#!/bin/sh\necho run\n" },
        mcp: {
          "config.json": `${JSON.stringify(
            {
              mcpServers: {
                acme: {
                  type: "stdio",
                  command: "./bin/server",
                  args: ["--stdio"],
                  env: { ACME_MODE: "plugin" },
                },
                docs: {
                  type: "streamable-http",
                  url: "https://mcp.example.com/mcp",
                },
              },
            },
            null,
            2,
          )}\n`,
          "pluginpack.json": `${JSON.stringify({ files: { "bin/server": "bin/server" } }, null, 2)}\n`,
          bin: { server: "#!/bin/sh\necho server\n" },
          src: { "server.ts": "export {};\n" },
        },
      },
    },
    overrides: {
      cursor: {
        acme: {
          rules: {
            "cursor-only.mdc":
              "---\ndescription: Cursor only.\nalwaysApply: true\n---\n\nOnly in Cursor.\n",
          },
        },
      },
      codex: {
        acme: {
          skills: {
            "release-notes": {
              "SKILL.md": skillMd.replace(
                "Group the changes",
                "In Codex, group the changes",
              ),
            },
          },
        },
      },
    },
  };
}

const codexEntry = `{ policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }`;

/** Each case is one fixed config; its targets each write to `out/<target>`. */
const cases: Record<string, string> = {
  default: `
    cursor: {
      outDir: "out/cursor",
      repositoryFiles: "repositories/all",
      updateCheck: {},
      plugins: {
        acme: {
          source: "shared/acme",
          overrides: "overrides/cursor/acme",
          path: "plugins/acme",
          displayName: "Acme",
        },
      },
    },
    claude: {
      outDir: "out/claude",
      pluginRoot: "plugins",
      repositoryFiles: "repositories/all",
      updateCheck: {},
      plugins: { acme: { source: "shared/acme", version: "1.2.4" } },
    },
    antigravity: {
      outDir: "out/antigravity",
      repositoryFiles: "repositories/all",
      plugins: { acme: { source: "shared/acme" } },
    },
    copilot: {
      outDir: "out/copilot",
      repositoryFiles: "repositories/all",
      plugins: { acme: { source: "shared/acme", description: "Acme for Copilot." } },
    },
    codex: {
      outDir: "out/codex",
      repositoryFiles: "repositories/all",
      manifest: { interface: { displayName: "Golden plugins" } },
      plugins: {
        acme: {
          source: "shared/acme",
          overrides: "overrides/codex/acme",
          entry: ${codexEntry},
          manifest: { interface: { displayName: "Acme", category: "Productivity" } },
        },
      },
    },
    "agent-plugins": {
      outDir: "out/agent-plugins",
      repositoryFiles: "repositories/all",
      clients: {
        codex: { manifest: { interface: { displayName: "Golden plugins" } } },
        copilot: {},
      },
      plugins: {
        acme: {
          source: "shared/acme",
          manifest: { extensions: { "com.openai": { interface: { displayName: "Acme" } } } },
          clients: { codex: { entry: ${codexEntry} } },
        },
      },
    },`,
  variants: `
    codex: {
      outDir: "out/codex",
      format: "legacy",
      plugins: { acme: { source: "shared/acme", entry: ${codexEntry} } },
    },
    "agent-plugins": {
      outDir: "out/agent-plugins",
      plugins: { acme: { source: "shared/acme" } },
    },`,
};

function configSource(targets: string): string {
  return `import { defineConfig } from "${indexPath}";

export default defineConfig({
  name: "golden-plugins",
  version: "1.2.3",
  source: { partials: "partials" },
  metadata: {
    displayName: "Golden Plugins",
    description: "Plugins whose output is pinned byte for byte.",
    author: { name: "Golden", email: "golden@example.com" },
    owner: { name: "Golden" },
    homepage: "https://example.com/golden",
    repository: "https://github.com/example/golden-plugins",
    license: "MIT",
    keywords: ["golden", "test"],
    category: "Productivity",
  },
  targets: {${targets}
  },
});
`;
}

/** Every file under `dir`, keyed by posix path relative to it, sorted. */
async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const tree = new Map<string, Buffer>();
  if (!(await exists(dir))) {
    return tree;
  }
  for (const file of await walkFiles(dir)) {
    tree.set(toPosix(path.relative(dir, file)), await readFile(file));
  }
  return new Map([...tree].sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function writeTree(
  dir: string,
  tree: Map<string, Buffer>,
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  for (const [relative, contents] of tree) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), contents);
  }
}

describe.each(Object.entries(cases))(
  "golden output: %s config",
  (name, targets) => {
    it("matches tests/golden byte for byte", async () => {
      project = new Project("pluginpack-golden", "1.0.0", {
        files: {
          "pluginpack.config.ts": configSource(targets),
          ...sourceFiles(),
        },
      });
      await project.write();
      const root = project.baseDir;
      // fixturify writes only text, so the binary asset is written here.
      await mkdir(path.join(root, "shared/acme/assets"), { recursive: true });
      await writeFile(path.join(root, "shared/acme/assets/icon.png"), iconPng);
      // Build warnings (such as the legacy-format deprecation) are not output.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const artifacts = await build({ cwd: root });

      const caseDir = path.join(goldenRoot, name);
      const builtTargets = artifacts.map((artifact) => artifact.target).sort();
      if (update) {
        await rm(caseDir, { recursive: true, force: true });
      }
      for (const artifact of artifacts) {
        const actual = await readTree(artifact.outDir);
        const goldenDir = path.join(caseDir, artifact.target);
        if (update) {
          await writeTree(goldenDir, actual);
          continue;
        }
        const expected = await readTree(goldenDir);
        // The managed manifest is pinned like any other output file.
        expect(actual.has(managedManifestPath(artifact.target))).toBe(true);
        expect(
          [...actual.keys()],
          `${name}/${artifact.target}: emitted paths changed. If that is intended, run \`${updateCommand}\` and review git diff tests/golden.`,
        ).toEqual([...expected.keys()]);
        for (const [relative, contents] of actual) {
          expect(
            contents.toString("utf8"),
            `${name}/${artifact.target}/${relative}: bytes changed. If that is intended, run \`${updateCommand}\` and review git diff tests/golden.`,
          ).toBe(expected.get(relative)?.toString("utf8"));
          expect(contents.equals(expected.get(relative)!)).toBe(true);
        }
      }
      // A golden directory for a target the case no longer builds is stale.
      const goldenTargets = (await exists(caseDir))
        ? [
            ...new Set(
              [...(await readTree(caseDir)).keys()].map(
                (file) => file.split("/")[0],
              ),
            ),
          ].sort()
        : [];
      expect(goldenTargets).toEqual(builtTargets as TargetName[]);

      // The pinned output is output a user could ship: every target validates.
      for (const artifact of artifacts) {
        const result = await validateOutput(artifact.target, artifact.outDir);
        expect(
          result.issues.filter((issue) => issue.level === "error"),
          `${name}/${artifact.target} validate`,
        ).toEqual([]);
      }
    });
  },
);
