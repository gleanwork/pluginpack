import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/build.js";
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
        path.join(root, "dist/copilot/.github/skills/demo/SKILL.md"),
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

function skill(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}
`;
}
