import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { clean, prune } from "../src/cleanup.js";
import { loadConfig } from "../src/config.js";
import { diffTarget } from "../src/diff.js";
import { validateOutput } from "../src/validate.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});

describe("pluginpack core", () => {
  it("builds all supported target outputs from one source plugin", async () => {
    const root = await fixture();
    const artifacts = await build({ cwd: root });

    expect(artifacts.map((artifact) => artifact.target).sort()).toEqual([
      "claude",
      "copilot",
      "cursor",
      "gemini",
    ]);
    await expect(
      readFile(
        path.join(root, "dist/cursor/demo/.cursor-plugin/plugin.json"),
        "utf8",
      ),
    ).resolves.toContain('"name": "demo"');
    await expect(
      readFile(
        path.join(root, "dist/claude/plugins/demo/.claude-plugin/plugin.json"),
        "utf8",
      ),
    ).resolves.toContain('"name": "demo"');
    await expect(
      readFile(
        path.join(root, "dist/gemini/demo/gemini-extension.json"),
        "utf8",
      ),
    ).resolves.toContain('"name": "demo"');
    await expect(
      readFile(
        path.join(root, "dist/copilot/plugins/demo/skills/demo/SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("Demo skill.");

    await expect(
      validateOutput("cursor", path.join(root, "dist/cursor")),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateOutput("claude", path.join(root, "dist/claude")),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateOutput("gemini", path.join(root, "dist/gemini")),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateOutput("copilot", path.join(root, "dist/copilot")),
    ).resolves.toMatchObject({ ok: true });
  });

  it("uses target-specific file overrides", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "plugins/demo/skills/demo/targets/cursor"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "plugins/demo/skills/demo/targets/cursor/SKILL.md"),
      skill("demo", "Cursor-only description."),
    );

    await build({ cwd: root, target: "cursor" });

    const built = await readFile(
      path.join(root, "dist/cursor/demo/skills/demo/SKILL.md"),
      "utf8",
    );
    expect(built).toContain("Cursor-only description.");
  });

  it("uses source plugin manifests as emitted plugin metadata", async () => {
    const root = await fixture();

    await build({ cwd: root, target: "cursor" });
    await build({ cwd: root, target: "claude" });
    await build({ cwd: root, target: "gemini" });

    const cursorManifest = JSON.parse(
      await readFile(
        path.join(root, "dist/cursor/demo/.cursor-plugin/plugin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const claudeManifest = JSON.parse(
      await readFile(
        path.join(root, "dist/claude/plugins/demo/.claude-plugin/plugin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const geminiManifest = JSON.parse(
      await readFile(
        path.join(root, "dist/gemini/demo/gemini-extension.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(cursorManifest.description).toBe("Source plugin description.");
    expect(cursorManifest.displayName).toBe("Demo Source");
    expect(claudeManifest.description).toBe("Source plugin description.");
    expect(geminiManifest.description).toBe("Source plugin description.");
  });

  it("builds from a top-level skills directory source", async () => {
    const root = await rootSkillsFixture();

    await build({ cwd: root });

    await expect(
      readFile(
        path.join(root, "dist/cursor/demo/skills/demo/SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("Demo skill.");
    await expect(
      readFile(
        path.join(root, "dist/claude/plugins/demo/.claude-plugin/plugin.json"),
        "utf8",
      ),
    ).resolves.toContain('"description": "Root skills plugin."');
  });

  it("reports stale managed files with diff", async () => {
    const root = await fixture();
    await build({ cwd: root, target: "cursor" });
    await writeFile(
      path.join(root, "dist/cursor/demo/skills/demo/SKILL.md"),
      skill("demo", "Stale content."),
    );

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(result.ok).toBe(false);
    expect(result.entries).toContainEqual({
      type: "changed",
      path: "demo/skills/demo/SKILL.md",
    });
  });

  it("reports managed files that should be removed with diff", async () => {
    const root = await rootSkillsFixture();
    await mkdir(path.join(root, "skills/old-skill"), { recursive: true });
    await writeFile(
      path.join(root, "skills/old-skill/SKILL.md"),
      skill("old-skill", "Old skill."),
    );
    await build({ cwd: root, target: "cursor" });
    await rm(path.join(root, "skills/old-skill"), {
      recursive: true,
      force: true,
    });

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(result.entries).toContainEqual({
      type: "removed",
      path: "demo/skills/old-skill/SKILL.md",
    });
  });

  it("prunes stale managed files and cleans managed outputs", async () => {
    const root = await rootSkillsFixture();
    await mkdir(path.join(root, "skills/old-skill"), { recursive: true });
    await writeFile(
      path.join(root, "skills/old-skill/SKILL.md"),
      skill("old-skill", "Old skill."),
    );
    await build({ cwd: root, target: "cursor" });
    await rm(path.join(root, "skills/old-skill"), {
      recursive: true,
      force: true,
    });

    const pruneResult = await prune({ cwd: root, target: "cursor" });

    expect(pruneResult[0]?.entries).toContainEqual({
      type: "stale",
      target: "cursor",
      path: "demo/skills/old-skill/SKILL.md",
    });
    await expectMissing(
      path.join(root, "dist/cursor/demo/skills/old-skill/SKILL.md"),
    );

    await rm(path.join(root, "skills"), { recursive: true, force: true });

    const cleanResult = await clean({ cwd: root, target: "cursor" });

    expect(cleanResult[0]?.entries).toContainEqual({
      type: "deleted",
      target: "cursor",
      path: "demo/skills/demo/SKILL.md",
    });
    await expectMissing(
      path.join(root, "dist/cursor/demo/skills/demo/SKILL.md"),
    );
    await expectMissing(path.join(root, "dist/cursor/.pluginpack/cursor.json"));
  });

  it("refuses to prune source paths unless forced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pluginpack-guard-test-"));
    roots.push(root);
    await mkdir(path.join(root, "skills/demo"), { recursive: true });
    await writeFile(
      path.join(root, "skills/demo/SKILL.md"),
      skill("demo", "Demo skill."),
    );
    await writeFile(
      path.join(root, "pluginpack.config.ts"),
      `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "demo-plugins",
  version: "1.0.0",
  source: { skills: "skills", rootPlugin: { id: "core" } },
  metadata: { description: "Demo", author: { name: "Demo" }, license: "MIT" },
  targets: {
    cursor: {
      outDir: ".",
      plugins: {
        demo: { from: ["core"], components: ["skills"] }
      }
    }
  }
});
`,
    );
    // Seed a managed manifest that lists a source path as previously managed,
    // simulating manifest drift under an outDir that overlaps the source tree.
    await mkdir(path.join(root, ".pluginpack"), { recursive: true });
    await writeFile(
      path.join(root, ".pluginpack/cursor.json"),
      `${JSON.stringify(
        { version: 1, target: "cursor", files: ["skills/demo/SKILL.md"] },
        null,
        2,
      )}\n`,
    );

    await expect(prune({ cwd: root, target: "cursor" })).rejects.toThrow(
      /Refusing to prune/,
    );
    // A refused prune must leave the source file untouched.
    await access(path.join(root, "skills/demo/SKILL.md"));

    await prune({ cwd: root, target: "cursor", force: true });
    await expectMissing(path.join(root, "skills/demo/SKILL.md"));
  });

  it("ignores configured diff paths", async () => {
    const root = await fixture();
    const configPath = path.join(root, "pluginpack.config.ts");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        'plugins: {\n        demo: { from: ["demo"], components: ["skills"] }',
        'ignoredDiffPaths: ["demo/skills/demo/SKILL.md"],\n      plugins: {\n        demo: { from: ["demo"], components: ["skills"] }',
      ),
    );
    await build({ cwd: root, target: "cursor" });
    await writeFile(
      path.join(root, "dist/cursor/demo/skills/demo/SKILL.md"),
      skill("demo", "Ignored stale content."),
    );

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(result).toEqual({ ok: true, entries: [] });
  });

  it("builds the recommended single-repo shape with no path collisions", async () => {
    const root = await recommendedShapeFixture();

    await build({ cwd: root });

    await access(path.join(root, ".cursor-plugin/marketplace.json"));
    await access(
      path.join(root, "plugins/cursor/acme/skills/release-notes/SKILL.md"),
    );
    await access(path.join(root, ".claude-plugin/marketplace.json"));
    await access(
      path.join(root, "plugins/claude/acme/.claude-plugin/plugin.json"),
    );
    await access(
      path.join(root, "plugins/copilot/.claude-plugin/marketplace.json"),
    );

    await expect(validateOutput("cursor", root)).resolves.toMatchObject({
      ok: true,
    });
    await expect(validateOutput("claude", root)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("does not register generated output dirs as source plugins on rebuild", async () => {
    const root = await recommendedShapeFixture();
    await build({ cwd: root });

    // After a build, plugins/{cursor,claude,copilot} exist as generated output.
    // Loading config again must not treat them as source plugins.
    const project = await loadConfig(root);

    expect([...project.plugins.keys()]).toEqual(["core"]);
  });

  it("merges multiple source plugins and rejects colliding files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pluginpack-merge-test-"));
    roots.push(root);
    await mkdir(path.join(root, "plugins/a/skills/alpha"), { recursive: true });
    await mkdir(path.join(root, "plugins/b/skills/beta"), { recursive: true });
    await writeFile(
      path.join(root, "plugins/a/skills/alpha/SKILL.md"),
      skill("alpha", "Alpha skill."),
    );
    await writeFile(
      path.join(root, "plugins/b/skills/beta/SKILL.md"),
      skill("beta", "Beta skill."),
    );
    await writeFile(
      path.join(root, "pluginpack.config.ts"),
      `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "merge-plugins",
  version: "1.0.0",
  metadata: { description: "Merge", author: { name: "Merge" }, license: "MIT" },
  targets: {
    cursor: {
      outDir: "dist/cursor",
      plugins: {
        combined: { from: ["a", "b"], components: ["skills"] }
      }
    }
  }
});
`,
    );

    await build({ cwd: root, target: "cursor" });
    await access(path.join(root, "dist/cursor/combined/skills/alpha/SKILL.md"));
    await access(path.join(root, "dist/cursor/combined/skills/beta/SKILL.md"));

    // A skill path present in both source plugins must collide, not overwrite.
    await mkdir(path.join(root, "plugins/b/skills/alpha"), { recursive: true });
    await writeFile(
      path.join(root, "plugins/b/skills/alpha/SKILL.md"),
      skill("alpha", "Colliding alpha."),
    );

    await expect(build({ cwd: root, target: "cursor" })).rejects.toThrow(
      /Duplicate emitted file/,
    );
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pluginpack-test-"));
  roots.push(root);
  await mkdir(path.join(root, "plugins/demo/skills/demo"), { recursive: true });
  await writeFile(
    path.join(root, "pluginpack.config.ts"),
    `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "demo-plugins",
  version: "1.0.0",
  metadata: {
    description: "Demo plugins",
    author: { name: "Demo" },
    license: "MIT"
  },
  targets: {
    cursor: {
      outDir: "dist/cursor",
      plugins: {
        demo: { from: ["demo"], components: ["skills"] }
      }
    },
    claude: {
      outDir: "dist/claude",
      plugins: {
        demo: { from: ["demo"] }
      }
    },
    gemini: {
      outDir: "dist/gemini",
      plugins: {
        demo: { from: ["demo"] }
      }
    },
    copilot: {
      outDir: "dist/copilot",
      plugins: {
        demo: { from: ["demo"] }
      }
    }
  }
});
`,
  );
  await writeFile(
    path.join(root, "plugins/demo/plugin.pluginpack.json"),
    `${JSON.stringify(
      {
        description: "Source plugin description.",
        displayName: "Demo Source",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "plugins/demo/skills/demo/SKILL.md"),
    skill("demo", "Demo skill."),
  );
  return root;
}

async function rootSkillsFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pluginpack-root-test-"));
  roots.push(root);
  await mkdir(path.join(root, "skills/demo"), { recursive: true });
  await writeFile(
    path.join(root, "pluginpack.config.ts"),
    `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "demo-plugins",
  version: "1.0.0",
  source: {
    skills: "skills",
    rootPlugin: {
      id: "core",
      description: "Root skills plugin.",
      displayName: "Root Skills"
    }
  },
  metadata: {
    description: "Demo plugins",
    author: { name: "Demo" },
    license: "MIT"
  },
  targets: {
    cursor: {
      outDir: "dist/cursor",
      plugins: {
        demo: { from: ["core"], components: ["skills"] }
      }
    },
    claude: {
      outDir: "dist/claude",
      plugins: {
        demo: { from: ["core"] }
      }
    }
  }
});
`,
  );
  await writeFile(
    path.join(root, "skills/demo/SKILL.md"),
    skill("demo", "Demo skill."),
  );
  await writeFile(path.join(root, "README.md"), "# Root docs\n");
  return root;
}

async function recommendedShapeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pluginpack-recommended-"));
  roots.push(root);
  await mkdir(path.join(root, "skills/release-notes"), { recursive: true });
  await writeFile(
    path.join(root, "skills/release-notes/SKILL.md"),
    skill("release-notes", "Release notes skill."),
  );
  await writeFile(
    path.join(root, "pluginpack.config.ts"),
    `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "acme-plugins",
  version: "1.0.0",
  source: {
    skills: "skills",
    rootPlugin: { id: "core", description: "Acme skills." }
  },
  metadata: { description: "Acme", author: { name: "Acme" }, license: "MIT" },
  targets: {
    cursor: {
      outDir: ".",
      plugins: {
        acme: { from: ["core"], path: "plugins/cursor/acme", components: ["skills"] }
      }
    },
    claude: {
      outDir: ".",
      pluginRoot: "plugins/claude",
      plugins: { acme: { from: ["core"] } }
    },
    copilot: {
      outDir: "plugins/copilot",
      plugins: { acme: { from: ["core"] } }
    }
  }
});
`,
  );
  return root;
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

function skill(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}
`;
}
