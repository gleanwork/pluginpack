import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

it("materializes the README Quick Start and runs build and validate for every configured target", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const quickStart = readme
    .split("## Quick Start\n")[1]
    ?.split("\n## Mental Model")[0];
  expect(quickStart).toBeDefined();
  const files = new Map<string, string>();
  for (const match of quickStart!.matchAll(
    /<!-- quick-start-file: (.+?) -->\s*```[^\n]*\n([\s\S]*?)\n```/g,
  )) {
    files.set(match[1], `${match[2]}\n`);
  }
  expect(files.has("pluginpack.config.ts")).toBe(true);

  // The tree must match the files shown, so adding a required path to either
  // the tree or the config without updating the example fails the test.
  const tree = /```tree\n([\s\S]*?)\n```/.exec(quickStart!)?.[1];
  expect(tree).toBeDefined();
  const parents: string[] = [];
  const treeFiles: string[] = [];
  for (const line of tree!.split("\n")) {
    const name = line.trim();
    const depth = (line.length - line.trimStart().length) / 2;
    parents.length = depth;
    if (name.endsWith("/")) parents.push(name.slice(0, -1));
    else treeFiles.push([...parents, name].join("/"));
  }
  expect([...files.keys()].sort()).toEqual(treeFiles.sort());

  fixture = await mkdtemp(path.join(os.tmpdir(), "pluginpack-readme-"));
  for (const [file, contents] of files) {
    await mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
    await writeFile(path.join(fixture, file), contents);
  }
  // Use the real local package and its built CLI, not the network or tsx.
  // The config keeps its literal public package import from the README.
  await mkdir(path.join(fixture, "node_modules/@gleanwork"), {
    recursive: true,
  });
  await symlink(
    root,
    path.join(fixture, "node_modules/@gleanwork/pluginpack"),
    "dir",
  );
  await writeFile(path.join(fixture, "package.json"), '{ "type": "module" }\n');
  const commands =
    /```bash snippet=readme\/quickstart-run.bash\n([\s\S]*?)\n```/.exec(
      quickStart!,
    )?.[1];
  expect(commands).toBeDefined();
  const validated: string[] = [];
  for (const command of commands!.split("\n")) {
    expect(command).toMatch(/^npx pluginpack /);
    const args = command.slice("npx pluginpack ".length).split(" ");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), ...args],
      {
        cwd: fixture,
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    expect(
      result.status,
      `${command}\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr, command).toBe("");
    if (args[0] === "validate")
      validated.push(args[args.indexOf("--target") + 1]);
  }
  const { loadConfig } = await import("../src/config.js");
  const project = await loadConfig(fixture);
  expect(validated.sort()).toEqual(Object.keys(project.config.targets).sort());
});

it("documents oracle strength and the current CLI and target names", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const targets = readme
    .split("## Targets\n")[1]
    ?.split("\n## Agent Plugins")[0];
  expect(targets).toContain("CONFORMANCE.md#oracles-the-harness-uses");
  expect(readme).toMatch(/alt="[^"]*Codex[^"]*Agent Plugins/);
  const hero = await readFile(
    path.join(root, "assets/pluginpack-flow.svg"),
    "utf8",
  );
  for (const label of [
    "Claude",
    "Cursor",
    "Antigravity",
    "Copilot",
    "Codex",
    "Agent Plugins",
  ]) {
    expect(hero).toContain(`>${label}</text>`);
  }
  expect(readme).toContain("assets/Logo.png");
  expect(readme).toContain("assets/logo.png");
  expect(readme).not.toContain("With a custom `marketplaceDir`, retain");
  expect(readme).not.toContain("Files are emitted verbatim at the plugin root");
  expect(readme).toMatch(/clean --target codex`[\s\S]*?before removing it/);
  expect(readme).toContain("clean --target agent-plugins");
  const guide = await readFile(path.join(root, "CLAUDE.md"), "utf8");
  expect(guide).toMatch(/commander CLI:[\s\S]*?`install-info`/);
});
