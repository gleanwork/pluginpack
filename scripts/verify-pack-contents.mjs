#!/usr/bin/env node
// CI check: `npm pack --dry-run` only fails on a malformed `files` config, not
// on an accidentally-excluded runtime file (a broken tsup output path, a typo
// in package.json's `files` array). This inspects the actual tarball listing
// so a missing required file fails the build instead of just shipping broken.
import { execFileSync } from "node:child_process";

const REQUIRED_FILES = [
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "package.json",
  "README.md",
  "LICENSE",
];

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});
const [pack] = JSON.parse(raw);
const files = new Set(pack.files.map((file) => file.path));

const missing = REQUIRED_FILES.filter((file) => !files.has(file));
if (missing.length > 0) {
  console.error(
    `npm package is missing required file(s): ${missing.join(", ")}`,
  );
  console.error(`Packed contents: ${[...files].sort().join(", ")}`);
  process.exit(1);
}

console.log(`Package contents OK (${files.size} files):`);
for (const file of REQUIRED_FILES) {
  console.log(`  ${file}`);
}
