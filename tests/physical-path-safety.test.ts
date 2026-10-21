import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Project } from "fixturify-project";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { loadConfig } from "../src/config.js";
import { walkFiles } from "../src/fs.js";

let project: Project | undefined;

afterEach(async () => {
  await project?.dispose();
  project = undefined;
});

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n${name} body.\n`;

function configText(targetsBlock: string, sourceBlock = ""): string {
  return `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "physical-demo",
  version: "1.0.0",
  ${sourceBlock}
  metadata: { description: "P", author: { name: "P" }, license: "MIT" },
  targets: {
${targetsBlock}
  }
});
`;
}

/**
 * A project with one canonical source plugin at `shared/acme` holding the
 * skills `alpha` and `beta`. `targetsBlock` and `sourceBlock` are spliced into
 * the config verbatim.
 */
async function makeProject(
  targetsBlock: string,
  sourceBlock = "",
): Promise<string> {
  project = new Project("pluginpack-physical", "1.0.0", {
    files: {
      "pluginpack.config.ts": configText(targetsBlock, sourceBlock),
      shared: {
        acme: {
          skills: {
            alpha: { "SKILL.md": skill("alpha") },
            beta: { "SKILL.md": skill("beta") },
          },
        },
      },
      "UNMANAGED.txt": "USER FILE\n",
    },
  });
  await project.write();
  return project.baseDir;
}

describe("config path fields stay inside the project", () => {
  it("rejects source.partials outside the project at config load", async () => {
    const root = await makeProject(
      `    antigravity: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`,
      `source: { partials: "../outside" },`,
    );

    await expect(loadConfig(root)).rejects.toThrow(
      /Invalid pluginpack config in .*: source\.partials: must be a safe relative path/,
    );
  });
});

describe("walkFiles distinguishes a missing directory from a file", () => {
  it("throws when the directory is a file", async () => {
    const root = await makeProject(`    antigravity: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`);
    await writeFile(path.join(root, "not-a-dir"), "x\n");

    await expect(walkFiles(path.join(root, "not-a-dir"))).rejects.toThrow(
      `Expected a directory but found a file: ${path.join(root, "not-a-dir")}`,
    );
    await expect(walkFiles(path.join(root, "missing"))).resolves.toEqual([]);
    await expect(
      walkFiles(path.join(root, "not-a-dir/below")),
    ).resolves.toEqual([]);
  });

  it("fails a build whose source component directory is a file", async () => {
    const root = await makeProject(`    antigravity: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`);
    await rm(path.join(root, "shared/acme/skills"), { recursive: true });
    await writeFile(path.join(root, "shared/acme/skills"), "oops\n");

    await expect(build({ cwd: root })).rejects.toThrow(
      /Expected a directory but found a file: .*shared\/acme\/skills/,
    );
  });
});
