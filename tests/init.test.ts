import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBintastic, type BintasticProject } from "bintastic";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { targetNames } from "../src/adapters.js";
import { loadProjectConfig } from "../src/config.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const scaffoldPaths = [
  "pluginpack.config.ts",
  "shared/example/plugin.pluginpack.json",
  "shared/example/skills/example/SKILL.md",
];
const authoredContent = Buffer.from("Authored content.\n\0\xff", "latin1");
const codexEntry = {
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Developer Tools",
};

/** Reads a generated marketplace so assertions exercise the unmodified starter config. */
function readMarketplace(root: string, relativePath: string): object {
  return JSON.parse(
    fs.readFileSync(path.join(root, relativePath), "utf8"),
  ) as object;
}

describe("init", () => {
  let project: BintasticProject;
  const { setupProject, teardownProject, runBin } = createBintastic({
    binPath: path.join(packageRoot, "dist/cli.js"),
  });

  beforeEach(async () => {
    project = await setupProject();
  });

  afterEach(() => {
    teardownProject();
  });

  /** Resolves the package import exactly as an installed pluginpack dependency would. */
  function linkPackage(): void {
    const scopeDir = path.join(project.baseDir, "node_modules/@gleanwork");
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.symlinkSync(packageRoot, path.join(scopeDir, "pluginpack"), "dir");
  }

  it("scaffolds exactly the target names registered by pluginpack", async () => {
    linkPackage();
    const result = await runBin("init");
    expect(result.exitCode, String(result.stderr)).toBe(0);

    const { config } = await loadProjectConfig(project.baseDir);
    expect(Object.keys(config.targets).sort()).toEqual([...targetNames].sort());
    const outDirs = Object.values(config.targets).map(
      (target) => target?.outDir,
    );
    expect(new Set(outDirs).size).toBe(targetNames.length);
  });

  it("builds and validates every target from a fresh, unmodified scaffold", async () => {
    linkPackage();
    const initialized = await runBin("init");
    expect(initialized.exitCode, String(initialized.stderr)).toBe(0);

    const built = await runBin("build");
    expect(built.exitCode, String(built.stderr)).toBe(0);
    for (const target of targetNames) {
      expect(built.stdout).toContain(`for ${target} ->`);
      const validated = await runBin("validate", "--target", target);
      expect(validated.exitCode, `${target}: ${validated.stderr}`).toBe(0);
      expect(validated.stdout).toContain("Validation passed.");
    }

    for (const target of ["codex", "agent-plugins"]) {
      expect(
        readMarketplace(
          project.baseDir,
          `dist/${target}/.agents/plugins/marketplace.json`,
        ),
      ).toMatchObject({ plugins: [{ name: "example", ...codexEntry }] });
    }
    expect(
      readMarketplace(
        project.baseDir,
        "dist/agent-plugins/.github/plugin/marketplace.json",
      ),
    ).toMatchObject({ plugins: [{ name: "example" }] });
  });

  it.each(scaffoldPaths)(
    "refuses existing %s before creating any scaffold files",
    async (existingPath) => {
      const destination = path.join(project.baseDir, existingPath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, authoredContent);
      const unmanaged = path.join(project.baseDir, "notes.txt");
      fs.writeFileSync(unmanaged, authoredContent);

      const result = await runBin("init");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`${existingPath} already exists`);
      expect(fs.readFileSync(destination)).toEqual(authoredContent);
      expect(fs.readFileSync(unmanaged)).toEqual(authoredContent);
      for (const otherPath of scaffoldPaths.filter(
        (file) => file !== existingPath,
      )) {
        expect(fs.existsSync(path.join(project.baseDir, otherPath))).toBe(
          false,
        );
      }
    },
  );

  it("refuses a dangling destination symlink before creating any scaffold files", async () => {
    const skillPath = path.join(project.baseDir, scaffoldPaths[2]!);
    const missingPath = path.join(project.baseDir, "authored-skill.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.symlinkSync(missingPath, skillPath);

    const result = await runBin("init");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${scaffoldPaths[2]} already exists`);
    expect(fs.lstatSync(skillPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(skillPath)).toBe(missingPath);
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(fs.existsSync(path.join(project.baseDir, scaffoldPaths[0]!))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(project.baseDir, scaffoldPaths[1]!))).toBe(
      false,
    );
  });

  it.each(scaffoldPaths)(
    "does not overwrite %s if it appears after the preflight check",
    async (existingPath) => {
      const destination = path.join(project.baseDir, existingPath);
      const preloadPath = path.join(project.baseDir, "race.mjs");
      // Inject a competing writer at the write boundary, after init's preflight.
      // The real write then proves that each destination uses exclusive creation.
      fs.writeFileSync(
        preloadPath,
        `import { promises as fs } from "node:fs";
const writeFile = fs.writeFile;
fs.writeFile = async (file, data, options) => {
  if (String(file) === ${JSON.stringify(destination)}) {
    await writeFile(file, Buffer.from(${JSON.stringify([...authoredContent])}), { flag: "wx" });
  }
  return writeFile(file, data, options);
};
`,
      );

      const result = await runBin("init", {
        env: { NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(existingPath);
      expect(result.stderr).toContain("already exists");
      expect(fs.readFileSync(destination)).toEqual(authoredContent);
    },
  );
});
