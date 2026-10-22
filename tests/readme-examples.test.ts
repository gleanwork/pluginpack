/**
 * Runs the README's shell and config examples with the built CLI, so a
 * documented command or config that stops working fails CI instead of
 * shipping. `markdown-code check` only keeps four blocks in sync with
 * `snippets/`; it runs nothing.
 *
 * Every fenced bash/sh/ts/json block in README.md must appear in `inventory`
 * below, either as run here, run by another check, or not runnable with a
 * reason. A new block fails the inventory test until someone decides which.
 *
 * Overlap: the Quick Start blocks are run by `tests/readme-quick-start.test.ts`
 * (added on fix/target-conformance, which also makes the Quick Start
 * complete), and its `npm install` by `scripts/verify-packed-install.mjs`.
 * This file covers the rest: the CLI Reference examples, Install Snippet, CI
 * Change Detection, Components, One package for several clients, MCP
 * Directory and the Programmatic API import list.
 */
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exists, toPosix } from "../src/fs.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(repoRoot, "dist/cli.js");

type Block = { key: string; lang: string; body: string };

/**
 * Fenced blocks by `<nearest heading> > <lang> #<n>`, counting per heading
 * and language. Only languages a reader might paste and run are listed.
 */
function readmeBlocks(readme: string): Block[] {
  const blocks: Block[] = [];
  const counts = new Map<string, number>();
  let heading = "";
  let fence: { lang: string; lines: string[] } | undefined;
  for (const line of readme.split("\n")) {
    if (fence) {
      if (line.startsWith("```")) {
        if (["bash", "sh", "ts", "json"].includes(fence.lang)) {
          const base = `${heading} > ${fence.lang}`;
          const n = (counts.get(base) ?? 0) + 1;
          counts.set(base, n);
          blocks.push({
            key: `${base} #${n}`,
            lang: fence.lang,
            body: fence.lines.join("\n"),
          });
        }
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
    } else if (line.startsWith("```")) {
      fence = { lang: line.slice(3).split(/\s/)[0], lines: [] };
    } else if (/^#{1,6} /.test(line)) {
      heading = line.replace(/^#+ /, "");
    }
  }
  return blocks;
}

/** How each README block is covered. `run` blocks are executed in this file. */
const inventory: Record<string, string> = {
  "Quick Start > bash #1":
    "verify-packed-install.mjs installs the packed tarball",
  "Quick Start > ts #1": "readme-quick-start.test.ts (fix/target-conformance)",
  "Quick Start > bash #2":
    "readme-quick-start.test.ts (fix/target-conformance)",
  "Components > ts #1": "run",
  "One package for several clients > ts #1": "run",
  "Update Check (claude, cursor) > ts #1":
    "not runnable: a fragment with `...` placeholders",
  "Install Snippet > bash #1": "run",
  "MCP Directory > json #1": "run",
  "Legacy Additional Plugin-Root Files > json #1":
    "not run: legacy 0.10 sources, covered by core.test.ts",
  "Partials > ts #1":
    "not runnable: a fragment; partials are run by lifecycle-journeys.test.ts",
  "CI Change Detection > bash #1": "run",
  "Programmatic API > ts #1": "run",
  "Claude Code > bash #1":
    "not runnable: host CLI commands; install-snippet.test.ts checks install-info",
  "Antigravity > bash #1":
    "not runnable: host CLI commands; install-snippet.test.ts checks install-info",
  ...Object.fromEntries(
    [
      "init",
      "build",
      "validate",
      "diff",
      "prune",
      "clean",
      "install-info",
      "docs",
    ].map((command) => [
      `\`${command}\` > bash #1`,
      "not runnable: a usage synopsis; its Examples are run",
    ]),
  ),
};

let readme = "";
let blocks: Block[] = [];
let workspace = "";

function block(key: string): string {
  expect(inventory[key], key).toBe("run");
  const found = blocks.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`README.md has no block "${key}".`);
  }
  return found.body;
}

/** Runs `pluginpack <args>` with the built CLI; throws with its output on a non-zero exit. */
function pluginpack(cwd: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, CI: "1" },
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    throw new Error(
      `pluginpack ${args.join(" ")} failed in ${cwd}:\n${failed.stdout ?? ""}${failed.stderr ?? ""}`,
      { cause: error },
    );
  }
}

/** `pluginpack a b c` from a README line, as argv. */
function argv(command: string): string[] {
  const trimmed = command.trim();
  expect(trimmed).toMatch(/^pluginpack /);
  return trimmed.slice("pluginpack ".length).split(/\s+/);
}

/**
 * Every file under `dir` with its contents, keyed by posix relative path.
 * Skips `node_modules`, which here is a symlink to this repository.
 */
async function readTree(dir: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") {
        await walk(full);
      } else if (entry.isFile()) {
        tree[toPosix(path.relative(dir, full))] = await readFile(full, "utf8");
      }
    }
  };
  if (await exists(dir)) {
    await walk(dir);
  }
  return Object.fromEntries(Object.entries(tree).sort());
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

/**
 * A project that imports the real local package the way a README config
 * does (`from "@gleanwork/pluginpack"`), with its config and files.
 */
async function makeProject(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = path.join(workspace, name);
  await writeFiles(dir, { "package.json": '{ "type": "module" }\n', ...files });
  await mkdir(path.join(dir, "node_modules/@gleanwork"), { recursive: true });
  await symlink(
    repoRoot,
    path.join(dir, "node_modules/@gleanwork/pluginpack"),
    "dir",
  );
  return dir;
}

const sharedAcme = {
  "shared/acme/skills/release-notes/SKILL.md":
    "---\nname: release-notes\ndescription: Draft release notes.\n---\n\nGroup changes.\n",
  "shared/acme/agents/search-assistant.agent.md":
    "---\nname: search-assistant\ndescription: Find documents.\n---\n\nSearch and cite.\n",
  "shared/acme/commands/summarize.md":
    "---\nname: summarize\ndescription: Summarize the open file.\n---\n\nSummarize it.\n",
};

const codexEntry = `entry: { policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" },`;

/** One project configuring every target that `install-info` and the CLI examples name. */
const cliConfig = `import { defineConfig } from "@gleanwork/pluginpack";

export default defineConfig({
  name: "acme-plugins",
  version: "0.1.0",
  metadata: {
    description: "Acme agent plugins.",
    author: { name: "Acme" },
    license: "MIT",
    repository: "https://github.com/acme/acme-plugins",
  },
  targets: {
    cursor: { outDir: "out/cursor", plugins: { acme: { source: "shared/acme" } } },
    claude: { outDir: "out/claude", plugins: { acme: { source: "shared/acme" } } },
    antigravity: { outDir: "out/antigravity", plugins: { acme: { source: "shared/acme" } } },
    copilot: { outDir: "out/copilot", plugins: { acme: { source: "shared/acme" } } },
    codex: { outDir: "out/codex", plugins: { acme: { source: "shared/acme", ${codexEntry} } } },
  },
});
`;

beforeAll(async () => {
  readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  blocks = readmeBlocks(readme);
  workspace = await mkdtemp(path.join(os.tmpdir(), "pluginpack-readme-"));
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

it("classifies every README shell and config block", () => {
  const keys = blocks.map((candidate) => candidate.key);
  expect(new Set(keys).size).toBe(keys.length);
  const unclassified = keys.filter((key) => !(key in inventory));
  expect(
    unclassified,
    "New README blocks: run each in tests/readme-examples.test.ts, or add it to `inventory` with the reason it is not run here.",
  ).toEqual([]);
  expect(
    Object.keys(inventory).filter((key) => !keys.includes(key)),
    "`inventory` names README blocks that no longer exist.",
  ).toEqual([]);
});

describe("CLI Reference examples", () => {
  /** Examples listed under each `### \`command\`` heading of the generated reference. */
  function cliExamples(): Map<string, string[]> {
    const reference = readme
      .split("<!-- pluginpack-cli:start -->")[1]
      ?.split("<!-- pluginpack-cli:end -->")[0];
    expect(reference).toBeDefined();
    const examples = new Map<string, string[]>();
    for (const section of reference!.split(/^### /m).slice(1)) {
      const command = /^`([^`]+)`/.exec(section)![1];
      const list = section.split("Examples:")[1]?.split("Exit codes:")[0] ?? "";
      examples.set(
        command,
        [...list.matchAll(/^- `(pluginpack [^`]+)`$/gm)].map(
          (match) => match[1],
        ),
      );
    }
    return examples;
  }

  it("lists examples for every command", () => {
    const examples = cliExamples();
    expect([...examples.keys()]).toEqual([
      "init",
      "build",
      "validate",
      "diff",
      "prune",
      "clean",
      "install-info",
      "docs",
    ]);
    for (const [command, list] of examples) {
      expect(list.length, command).toBeGreaterThan(0);
      for (const example of list) {
        expect(argv(example)[0]).toBe(command);
      }
    }
  });

  it("runs every example and each exits 0 in the state it documents", async () => {
    const examples = cliExamples();
    const project = await makeProject("cli/project", {
      "pluginpack.config.ts": cliConfig,
      ...sharedAcme,
    });
    // `validate --dir ../cursor-plugins` and `diff --against
    // ../cursor-plugins` document a sibling output repository.
    const prepare = (): void => {
      pluginpack(project, ["build"]);
      pluginpack(project, [
        "build",
        "--target",
        "cursor",
        "--out-dir",
        "../cursor-plugins",
      ]);
    };

    let needsBuild = true;
    for (const [command, list] of examples) {
      for (const example of list) {
        const args = argv(example);
        if (command === "init") {
          // init documents a fresh directory.
          const fresh = path.join(workspace, "cli/init");
          await mkdir(fresh, { recursive: true });
          pluginpack(fresh, args);
          expect(await exists(path.join(fresh, "pluginpack.config.ts"))).toBe(
            true,
          );
          continue;
        }
        if (command === "docs") {
          // docs rewrites ./README.md; run it on a copy of the real one.
          const docsDir = path.join(workspace, "cli/docs");
          await mkdir(docsDir, { recursive: true });
          await cp(
            path.join(repoRoot, "README.md"),
            path.join(docsDir, "README.md"),
          );
          pluginpack(docsDir, args);
          expect(
            await readFile(path.join(docsDir, "README.md"), "utf8"),
            example,
          ).toBe(readme);
          continue;
        }
        // Build the documented starting state when the last example tore it down.
        if (needsBuild) {
          prepare();
          needsBuild = false;
        }
        const before = await readTree(path.dirname(project));
        const output = pluginpack(project, args);
        const after = await readTree(path.dirname(project));
        if (args.includes("--dry-run")) {
          expect(after, `${example} must not write`).toEqual(before);
        }
        if (command === "install-info") {
          expect(output, example).toContain("acme/acme-plugins");
        }
        if (command === "clean" && !args.includes("--dry-run")) {
          needsBuild = true;
          // clean with no --target removes every configured target's output.
          expect(
            Object.keys(after).filter((file) =>
              file.startsWith("project/out/"),
            ),
            example,
          ).toEqual([]);
        }
      }
    }
  }, 30_000);
});

it("runs the Install Snippet and CI Change Detection commands", async () => {
  const project = await makeProject("snippets/project", {
    "pluginpack.config.ts": cliConfig,
    ...sharedAcme,
  });
  for (const line of block("Install Snippet > bash #1").split("\n")) {
    expect(pluginpack(project, argv(line))).toContain("acme/acme-plugins");
  }
  const diffs = block("CI Change Detection > bash #1").split("\n");
  expect(diffs.length).toBeGreaterThan(0);
  for (const line of diffs) {
    const args = argv(line);
    const target = args[args.indexOf("--target") + 1];
    const against = args[args.indexOf("--against") + 1];
    pluginpack(project, ["build", "--target", target, "--out-dir", against]);
    pluginpack(project, args);
    // And the documented point of the command: a stale repo fails.
    await writeFile(
      path.join(project, "shared/acme/skills/release-notes/SKILL.md"),
      "---\nname: release-notes\ndescription: Changed.\n---\n\nChanged.\n",
    );
    expect(() => pluginpack(project, args)).toThrow(/failed/);
    await writeFile(
      path.join(project, "shared/acme/skills/release-notes/SKILL.md"),
      sharedAcme["shared/acme/skills/release-notes/SKILL.md"],
    );
  }
});

it("builds and validates the Components include/exclude config", async () => {
  const config = block("Components > ts #1");
  const project = await makeProject("components", {
    "pluginpack.config.ts": config,
    ...sharedAcme,
    "shared/acme/README.md": "# Acme\n",
  });
  pluginpack(project, ["build"]);
  for (const target of ["antigravity", "claude"]) {
    pluginpack(project, ["validate", "--target", target]);
  }
  const tree = Object.keys(await readTree(project));
  // antigravity includes commands and static files; claude excludes commands.
  expect(tree).toContain("plugins/antigravity/acme/commands/summarize.md");
  expect(tree).toContain("plugins/antigravity/acme/README.md");
  expect(tree.filter((file) => file.startsWith("plugins/claude/"))).not.toEqual(
    [],
  );
  expect(
    tree.filter(
      (file) => file.startsWith("plugins/claude/") && file.includes("commands"),
    ),
  ).toEqual([]);
});

it("builds and validates the One package for several clients config", async () => {
  const fragment = block("One package for several clients > ts #1");
  expect(fragment.trimStart()).toMatch(/^targets: \{/);
  const project = await makeProject("clients", {
    "pluginpack.config.ts": `import { defineConfig } from "@gleanwork/pluginpack";

export default defineConfig({
  name: "acme-plugins",
  version: "0.1.0",
  metadata: { description: "Acme agent plugins.", author: { name: "Acme" }, license: "MIT" },
  ${fragment}
});
`,
    ...sharedAcme,
  });
  pluginpack(project, ["build"]);
  pluginpack(project, ["validate", "--target", "agent-plugins"]);
  const out = path.join(project, "dist/agent-plugins");
  const tree = Object.keys(await readTree(out));
  expect(tree).toContain(".agents/plugins/marketplace.json");
  expect(tree).toContain(".github/plugin/marketplace.json");
  expect(tree).toContain(
    "plugins/acme/com.github.copilot/agents/search-assistant.agent.md",
  );
  const codex = JSON.parse(
    await readFile(path.join(out, ".agents/plugins/marketplace.json"), "utf8"),
  ) as { interface?: unknown; plugins: { category?: string }[] };
  expect(codex.interface).toEqual({ displayName: "Acme" });
  expect(codex.plugins[0].category).toBe("Productivity");
});

it("ships exactly the files the MCP Directory pluginpack.json declares", async () => {
  const declared = JSON.parse(block("MCP Directory > json #1")) as {
    files: Record<string, string>;
  };
  // The tree the section shows, with the declared map.
  const project = await makeProject("mcp", {
    "pluginpack.config.ts": cliConfig,
    ...sharedAcme,
    "shared/acme/mcp/config.json": JSON.stringify({
      mcpServers: {
        acme: { type: "stdio", command: "node", args: ["./mcp/start.mjs"] },
      },
    }),
    "shared/acme/mcp/pluginpack.json": JSON.stringify(declared),
    "shared/acme/mcp/start.mjs": "import './dist/index.js';\n",
    "shared/acme/mcp/dist/index.js": "export {};\n",
    "shared/acme/mcp/src/index.ts": "export {};\n",
    "shared/acme/mcp/tests/index.test.ts": "export {};\n",
  });
  pluginpack(project, ["build"]);
  const tree = Object.keys(await readTree(path.join(project, "out")));
  for (const target of [
    "cursor",
    "claude",
    "antigravity",
    "copilot",
    "codex",
  ]) {
    pluginpack(project, ["validate", "--target", target]);
    const shipped = tree
      .filter((file) => file.startsWith(`${target}/`) && file.includes("mcp/"))
      .map((file) => file.slice(file.indexOf("mcp/")))
      .sort();
    expect(shipped, target).toEqual(Object.keys(declared.files).sort());
  }
});

it("exports every function the Programmatic API import list names", async () => {
  const imports = block("Programmatic API > ts #1");
  const names = /import \{([\s\S]*?)\} from "@gleanwork\/pluginpack"/
    .exec(imports)![1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  expect(names.length).toBeGreaterThan(5);
  const project = await makeProject("api", {
    "check.mjs": `${imports}\nconst api = { ${names.join(", ")} };\nconsole.log(JSON.stringify(Object.entries(api).filter(([, value]) => typeof value !== "function").map(([name]) => name)));\n`,
  });
  const notFunctions = execFileSync(process.execPath, ["check.mjs"], {
    cwd: project,
    encoding: "utf8",
  });
  expect(JSON.parse(notFunctions)).toEqual([]);
});
