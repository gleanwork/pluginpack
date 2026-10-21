#!/usr/bin/env node
// CI check: every existing test runs against the in-repo `dist/cli.js` or
// source, never a truly installed package. This packs the real tarball,
// installs it into a scratch project the way a real consumer would, and
// walks the documented lifecycle with the installed binary: init, add a
// skill, build, validate, delete the skill, build, validate, clean. That
// catches a broken `bin` shebang or a `files`/tsup misconfig that
// `npm pack --dry-run` alone would miss, and a lifecycle step that breaks
// for a real install (such as a rebuild that cannot remove a deleted skill).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const scratch = mkdtempSync(path.join(tmpdir(), "pluginpack-pack-smoke-"));

/**
 * The targets `pluginpack init` configures, each writing to `dist/<target>`.
 * Read from the first build's output rather than listed here, so the script
 * keeps checking every scaffolded target when init gains one.
 */
let initTargets = [];

/** Every file under `dir`, as posix paths relative to it, sorted. */
function listFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

/** Every file under `dir` with its contents, skipping `skip` (relative to dir). */
function snapshot(dir, skip) {
  return Object.fromEntries(
    listFiles(dir)
      .filter((file) => !skip(file))
      .map((file) => [file, readFileSync(path.join(dir, file), "utf8")]),
  );
}

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  const packRaw = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", scratch],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(packRaw);
  const tarballPath = path.join(scratch, filename);

  const installDir = path.join(scratch, "install");
  mkdirSync(installDir);
  writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({
      name: "pack-smoke-test",
      version: "0.0.0",
      private: true,
    }),
  );
  execFileSync("npm", ["install", tarballPath], {
    cwd: installDir,
    stdio: "inherit",
  });

  const bin = path.join(installDir, "node_modules", ".bin", "pluginpack");
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  check(version, "Installed CLI printed no version.");
  console.log(`Installed CLI reports version: ${version}`);

  const project = path.join(installDir, "project");
  mkdirSync(project);
  const pluginpack = (...args) => {
    console.log(`$ pluginpack ${args.join(" ")}`);
    execFileSync(bin, args, { cwd: project, stdio: "inherit" });
  };
  const isOutput = (file) => file.startsWith("dist/");
  const outputs = () =>
    listFiles(path.join(project, "dist")).map((file) => `dist/${file}`);
  const skillOutputs = (skill) =>
    outputs().filter((file) => file.includes(`/skills/${skill}/`));

  // --- init --------------------------------------------------------------
  pluginpack("init");
  check(
    existsSync(path.join(project, "pluginpack.config.ts")),
    "pluginpack init did not create pluginpack.config.ts from the installed package.",
  );

  // --- add a skill, build, validate ---------------------------------------
  const extraSkill = path.join(project, "shared/example/skills/extra");
  mkdirSync(extraSkill, { recursive: true });
  writeFileSync(
    path.join(extraSkill, "SKILL.md"),
    "---\nname: extra\ndescription: A second skill.\n---\n\nExtra.\n",
  );
  const sources = snapshot(project, isOutput);
  pluginpack("build");
  initTargets = readdirSync(path.join(project, "dist")).sort();
  check(
    initTargets.length >= 4,
    `Expected init to scaffold at least four targets, got: ${initTargets.join(", ")}`,
  );
  for (const target of initTargets) {
    pluginpack("validate", "--target", target);
    check(
      existsSync(
        path.join(project, "dist", target, ".pluginpack", `${target}.json`),
      ),
      `build wrote no managed manifest for ${target}.`,
    );
  }
  check(
    skillOutputs("extra").length === initTargets.length,
    `Expected the extra skill in every target, got: ${skillOutputs("extra").join(", ")}`,
  );
  // A hand-written file in the output, which no command may delete.
  const notes = path.join(project, "dist/cursor/NOTES.md");
  writeFileSync(notes, "Hand-written.\n");

  // --- delete the skill, build, validate ----------------------------------
  rmSync(extraSkill, { recursive: true });
  delete sources["shared/example/skills/extra/SKILL.md"];
  pluginpack("build");
  for (const target of initTargets) {
    pluginpack("validate", "--target", target);
  }
  check(
    skillOutputs("extra").length === 0,
    `Rebuild left the deleted skill behind: ${skillOutputs("extra").join(", ")}`,
  );
  check(
    skillOutputs("example").length === initTargets.length,
    `Rebuild lost the remaining skill: ${skillOutputs("example").join(", ")}`,
  );

  // --- clean --------------------------------------------------------------
  pluginpack("clean");
  check(
    JSON.stringify(outputs()) === JSON.stringify(["dist/cursor/NOTES.md"]),
    `clean should leave only the hand-written file, left: ${outputs().join(", ")}`,
  );
  check(
    readFileSync(notes, "utf8") === "Hand-written.\n",
    "clean changed a hand-written file.",
  );
  check(
    JSON.stringify(snapshot(project, isOutput)) === JSON.stringify(sources),
    "The lifecycle changed an authored source file.",
  );
  console.log(
    "Installed CLI walks init -> build -> validate -> delete a skill -> build -> clean.",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
