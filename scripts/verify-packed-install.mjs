#!/usr/bin/env node
// CI check: every existing test runs against the in-repo `dist/cli.js` or
// source, never a truly installed package. This packs the real tarball,
// installs it into a scratch project the way a real consumer would, and
// exercises the installed binary — catching a broken `bin` shebang or a
// `files`/tsup misconfig that `npm pack --dry-run` alone would miss.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const scratch = mkdtempSync(path.join(tmpdir(), "pluginpack-pack-smoke-"));

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
    JSON.stringify({ name: "pack-smoke-test", version: "0.0.0", private: true }),
  );
  execFileSync("npm", ["install", tarballPath], {
    cwd: installDir,
    stdio: "inherit",
  });

  const bin = path.join(installDir, "node_modules", ".bin", "pluginpack");
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  if (!version) {
    throw new Error("Installed CLI printed no version.");
  }
  console.log(`Installed CLI reports version: ${version}`);

  const initDir = path.join(installDir, "project");
  mkdirSync(initDir);
  execFileSync(bin, ["init"], { cwd: initDir, stdio: "inherit" });
  if (!existsSync(path.join(initDir, "pluginpack.config.ts"))) {
    throw new Error(
      "pluginpack init did not create pluginpack.config.ts from the installed package.",
    );
  }
  console.log("Installed CLI's `init` command works.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
