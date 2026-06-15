import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Project, type ProjectArgs } from "fixturify-project";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { clean, prune } from "../src/cleanup.js";
import { loadConfig } from "../src/config.js";
import { diffTarget } from "../src/diff.js";
import { validateOutput } from "../src/validate.js";

type DirJSON = NonNullable<ProjectArgs["files"]>;

let project: Project | undefined;

afterEach(async () => {
  await project?.dispose();
  project = undefined;
});

describe("pluginpack core", () => {
  it("builds all supported target outputs from one source plugin", async () => {
    const project = await fixture();
    const root = project.baseDir;
    const artifacts = await build({ cwd: root });

    expect(artifacts.map((artifact) => artifact.target).sort()).toEqual([
      "antigravity",
      "claude",
      "copilot",
      "cursor",
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
      readFile(path.join(root, "dist/antigravity/demo/plugin.json"), "utf8"),
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
      validateOutput("antigravity", path.join(root, "dist/antigravity")),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateOutput("copilot", path.join(root, "dist/copilot")),
    ).resolves.toMatchObject({ ok: true });
  });

  it("uses target-specific file overrides", async () => {
    const project = await fixture();
    const root = project.baseDir;
    await mergeFixture(project, {
      plugins: {
        demo: {
          skills: {
            demo: {
              targets: {
                cursor: {
                  "SKILL.md": skill("demo", "Cursor-only description."),
                },
              },
            },
          },
        },
      },
    });

    await build({ cwd: root, target: "cursor" });

    const built = await readFile(
      path.join(root, "dist/cursor/demo/skills/demo/SKILL.md"),
      "utf8",
    );
    expect(built).toContain("Cursor-only description.");
  });

  it("emits per-target root files from source and manages them", async () => {
    const root = (
      await fixtureProject({
        "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "root-files-plugins",
  version: "1.0.0",
  metadata: { description: "Root files", author: { name: "R" }, license: "MIT" },
  targets: {
    claude: {
      outDir: "dist/claude",
      rootFiles: { "README.md": "roots/claude/README.md" },
      plugins: { demo: { from: ["demo"] } }
    }
  }
});
`,
        roots: { claude: { "README.md": "# Claude output readme\n" } },
        plugins: {
          demo: {
            skills: { demo: { "SKILL.md": skill("demo", "Demo skill.") } },
          },
        },
      })
    ).baseDir;

    await build({ cwd: root, target: "claude" });

    await expect(
      readFile(path.join(root, "dist/claude/README.md"), "utf8"),
    ).resolves.toContain("Claude output readme");

    const manifest = JSON.parse(
      await readFile(
        path.join(root, "dist/claude/.pluginpack/claude.json"),
        "utf8",
      ),
    ) as { files: string[] };
    expect(manifest.files).toContain("README.md");
  });

  it("rejects a root file that collides with a generated file", async () => {
    const root = (
      await fixtureProject({
        "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "root-collision-plugins",
  version: "1.0.0",
  metadata: { description: "Collide", author: { name: "R" }, license: "MIT" },
  targets: {
    claude: {
      outDir: "dist/claude",
      rootFiles: { ".claude-plugin/marketplace.json": "roots/x.json" },
      plugins: { demo: { from: ["demo"] } }
    }
  }
});
`,
        roots: { "x.json": "{}\n" },
        plugins: {
          demo: {
            skills: { demo: { "SKILL.md": skill("demo", "Demo skill.") } },
          },
        },
      })
    ).baseDir;

    await expect(build({ cwd: root, target: "claude" })).rejects.toThrow(
      /collides/,
    );
  });

  it("applies target component defaults and explicit component overrides", async () => {
    const project = await fixtureProject({
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "component-plugins",
  version: "1.0.0",
  metadata: { description: "Components", author: { name: "C" }, license: "MIT" },
  targets: {
    claude: {
      outDir: "dist/claude",
      plugins: {
        defaulted: { from: ["core"] },
        legacy: { from: ["core"], components: ["skills", "commands"] }
      }
    },
    cursor: {
      outDir: "dist/cursor",
      plugins: { defaulted: { from: ["core"] } }
    },
    copilot: {
      outDir: "dist/copilot",
      plugins: { defaulted: { from: ["core"] } }
    },
    antigravity: {
      outDir: "dist/antigravity",
      plugins: { defaulted: { from: ["core"] } }
    }
  }
});
`,
      plugins: {
        core: {
          skills: {
            demo: {
              "SKILL.md": skill("demo", "Demo skill."),
            },
          },
          commands: {
            "review.md": command("review", "Review command."),
          },
          "README.md": "# Core\n",
        },
      },
    });
    const root = project.baseDir;

    await build({ cwd: root });

    await expectMissing(
      path.join(root, "dist/claude/plugins/defaulted/commands/review.md"),
    );
    await access(path.join(root, "dist/claude/plugins/defaulted/README.md"));
    await access(
      path.join(root, "dist/claude/plugins/legacy/commands/review.md"),
    );
    await expectMissing(
      path.join(root, "dist/cursor/defaulted/commands/review.md"),
    );
    await expectMissing(
      path.join(root, "dist/copilot/plugins/defaulted/commands/review.md"),
    );
    await expectMissing(
      path.join(root, "dist/antigravity/defaulted/commands/review.md"),
    );

    const cursorManifest = JSON.parse(
      await readFile(
        path.join(root, "dist/cursor/defaulted/.cursor-plugin/plugin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(cursorManifest.commands).toBeUndefined();
  });

  it("uses source plugin manifests as emitted plugin metadata", async () => {
    const project = await fixture();
    const root = project.baseDir;

    await build({ cwd: root, target: "cursor" });
    await build({ cwd: root, target: "claude" });
    await build({ cwd: root, target: "antigravity" });

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
    const antigravityManifest = JSON.parse(
      await readFile(
        path.join(root, "dist/antigravity/demo/plugin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(cursorManifest.description).toBe("Source plugin description.");
    expect(cursorManifest.displayName).toBe("Demo Source");
    expect(claudeManifest.description).toBe("Source plugin description.");
    expect(antigravityManifest.description).toBe("Source plugin description.");
  });

  it("builds from a top-level skills directory source", async () => {
    const project = await rootSkillsFixture();
    const root = project.baseDir;

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
    const project = await fixture();
    const root = project.baseDir;
    await build({ cwd: root, target: "cursor" });
    await mergeFixture(project, {
      dist: {
        cursor: {
          demo: {
            skills: {
              demo: {
                "SKILL.md": skill("demo", "Stale content."),
              },
            },
          },
        },
      },
    });

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
    const project = await rootSkillsFixture();
    const root = project.baseDir;
    await mergeFixture(project, {
      skills: { "old-skill": { "SKILL.md": skill("old-skill", "Old skill.") } },
    });
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
    const project = await rootSkillsFixture();
    const root = project.baseDir;
    await mergeFixture(project, {
      skills: { "old-skill": { "SKILL.md": skill("old-skill", "Old skill.") } },
    });
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
    const project = await fixtureProject({
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

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
      skills: {
        demo: {
          "SKILL.md": skill("demo", "Demo skill."),
        },
      },
      ".pluginpack": {
        "cursor.json": `${JSON.stringify(
          { version: 1, target: "cursor", files: ["skills/demo/SKILL.md"] },
          null,
          2,
        )}\n`,
      },
    });
    const root = project.baseDir;
    // Seed a managed manifest that lists a source path as previously managed,
    // simulating manifest drift under an outDir that overlaps the source tree.

    await expect(prune({ cwd: root, target: "cursor" })).rejects.toThrow(
      /Refusing to prune/,
    );
    // A refused prune must leave the source file untouched.
    await access(path.join(root, "skills/demo/SKILL.md"));

    await prune({ cwd: root, target: "cursor", force: true });
    await expectMissing(path.join(root, "skills/demo/SKILL.md"));
  });

  it("ignores configured diff paths", async () => {
    const project = await fixture();
    const root = project.baseDir;
    const configPath = path.join(root, "pluginpack.config.ts");
    await mergeFixture(project, {
      "pluginpack.config.ts": (await readFile(configPath, "utf8")).replace(
        'plugins: {\n        demo: { from: ["demo"], components: ["skills"] }',
        'ignoredDiffPaths: ["demo/skills/demo/SKILL.md"],\n      plugins: {\n        demo: { from: ["demo"], components: ["skills"] }',
      ),
    });
    await build({ cwd: root, target: "cursor" });
    await mergeFixture(project, {
      dist: {
        cursor: {
          demo: {
            skills: {
              demo: {
                "SKILL.md": skill("demo", "Ignored stale content."),
              },
            },
          },
        },
      },
    });

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(result).toEqual({ ok: true, entries: [] });
  });

  it("builds the recommended single-repo shape with no path collisions", async () => {
    const project = await recommendedShapeFixture();
    const root = project.baseDir;

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
    const project = await recommendedShapeFixture();
    const root = project.baseDir;
    await build({ cwd: root });

    // After a build, plugins/{cursor,claude,copilot} exist as generated output.
    // Loading config again must not treat them as source plugins.
    const loaded = await loadConfig(root);

    expect([...loaded.plugins.keys()]).toEqual(["core"]);
  });

  it("merges multiple source plugins and rejects colliding files", async () => {
    const project = await fixtureProject({
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

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
      plugins: {
        a: {
          skills: {
            alpha: {
              "SKILL.md": skill("alpha", "Alpha skill."),
            },
          },
        },
        b: {
          skills: {
            beta: {
              "SKILL.md": skill("beta", "Beta skill."),
            },
          },
        },
      },
    });
    const root = project.baseDir;

    await build({ cwd: root, target: "cursor" });
    await access(path.join(root, "dist/cursor/combined/skills/alpha/SKILL.md"));
    await access(path.join(root, "dist/cursor/combined/skills/beta/SKILL.md"));

    // A skill path present in both source plugins must collide, not overwrite.
    await mergeFixture(project, {
      plugins: {
        b: {
          skills: {
            alpha: {
              "SKILL.md": skill("alpha", "Colliding alpha."),
            },
          },
        },
      },
    });

    await expect(build({ cwd: root, target: "cursor" })).rejects.toThrow(
      /Duplicate emitted file/,
    );
  });

  it("packages MCP servers across targets from both source forms", async () => {
    const project = await fixtureProject({
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "mcp-plugins",
  version: "1.0.0",
  metadata: { description: "MCP", author: { name: "X" }, license: "MIT" },
  targets: {
    cursor: { outDir: "dist/cursor", plugins: { filed: { from: ["filed"], path: "filed", components: ["skills"] } } },
    claude: { outDir: "dist/claude", plugins: { filed: { from: ["filed"] } } },
    antigravity: { outDir: "dist/antigravity", plugins: { filed: { from: ["filed"] } } },
    copilot: { outDir: "dist/copilot", plugins: { manifested: { from: ["manifested"] } } }
  }
});
`,
      plugins: {
        filed: {
          ".mcp.json": `${JSON.stringify({ mcpServers: { srv: { command: "node" } } }, null, 2)}\n`,
          skills: {
            s1: {
              "SKILL.md": skill("s1", "S1."),
            },
          },
        },
        manifested: {
          "plugin.pluginpack.json": `${JSON.stringify({ mcpServers: { msrv: { command: "py" } } }, null, 2)}\n`,
          skills: {
            s2: {
              "SKILL.md": skill("s2", "S2."),
            },
          },
        },
      },
    });
    const root = project.baseDir;

    await build({ cwd: root });

    // cursor references the copied .mcp.json
    const cursorPlugin = JSON.parse(
      await readFile(
        path.join(root, "dist/cursor/filed/.cursor-plugin/plugin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(cursorPlugin.mcpServers).toBe("./.mcp.json");
    await access(path.join(root, "dist/cursor/filed/.mcp.json"));

    // claude auto-discovers .mcp.json at the plugin root
    await access(path.join(root, "dist/claude/plugins/filed/.mcp.json"));

    // antigravity writes MCP config beside plugin.json
    const antigravityMcpConfig = JSON.parse(
      await readFile(
        path.join(root, "dist/antigravity/filed/mcp_config.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(antigravityMcpConfig.mcpServers).toMatchObject({
      srv: { command: "node" },
    });

    // copilot from a manifest-form source: generated .mcp.json + entry reference
    const copilotMarket = JSON.parse(
      await readFile(
        path.join(root, "dist/copilot/.claude-plugin/marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Record<string, unknown>[] };
    expect(copilotMarket.plugins[0].mcpServers).toBe(".mcp.json");
    await access(path.join(root, "dist/copilot/plugins/manifested/.mcp.json"));
  });

  it("rejects MCP server name collisions when merging source plugins", async () => {
    const project = await fixtureProject({
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "mcp-dup",
  version: "1.0.0",
  metadata: { description: "Dup", author: { name: "X" }, license: "MIT" },
  targets: {
    claude: { outDir: "dist/claude", plugins: { combined: { from: ["a", "b"] } } }
  }
});
`,
      plugins: {
        a: {
          ".mcp.json": `${JSON.stringify({ mcpServers: { dup: { command: "a" } } }, null, 2)}\n`,
          skills: {
            sa: {
              "SKILL.md": skill("sa", "SA."),
            },
          },
        },
        b: {
          ".mcp.json": `${JSON.stringify({ mcpServers: { dup: { command: "b" } } }, null, 2)}\n`,
          skills: {
            sb: {
              "SKILL.md": skill("sb", "SB."),
            },
          },
        },
      },
    });
    const root = project.baseDir;

    await expect(build({ cwd: root, target: "claude" })).rejects.toThrow(
      /Duplicate MCP server "dup"/,
    );
  });

  it("detects cross-target output path collisions", async () => {
    const project = await fixtureProject({
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "collide-plugins",
  version: "1.0.0",
  source: { skills: "skills", rootPlugin: { id: "core" } },
  metadata: { description: "C", author: { name: "C" }, license: "MIT" },
  targets: {
    claude: { outDir: ".", plugins: { demo: { from: ["core"] } } },
    copilot: { outDir: ".", plugins: { demo: { from: ["core"] } } }
  }
});
`,
      skills: {
        demo: {
          "SKILL.md": skill("demo", "Demo skill."),
        },
      },
    });
    const root = project.baseDir;
    // claude and copilot both write .claude-plugin/marketplace.json at outDir ".".

    await expect(build({ cwd: root })).rejects.toThrow(
      /overlapping output paths/,
    );
  });

  it("applies per-target and per-plugin version overrides", async () => {
    const project = await fixtureProject({
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "ver-plugins",
  version: "1.0.0",
  metadata: { description: "V", author: { name: "V" }, license: "MIT" },
  targets: {
    claude: {
      outDir: "dist/claude",
      version: "2.0.0",
      plugins: {
        a: { from: ["a"] },
        b: { from: ["b"], version: "3.0.0" }
      }
    }
  }
});
`,
      plugins: {
        a: {
          skills: {
            sa: {
              "SKILL.md": skill("sa", "SA."),
            },
          },
        },
        b: {
          skills: {
            sb: {
              "SKILL.md": skill("sb", "SB."),
            },
          },
        },
      },
    });
    const root = project.baseDir;

    await build({ cwd: root, target: "claude" });

    const read = async (p: string) =>
      JSON.parse(await readFile(path.join(root, p), "utf8")) as Record<
        string,
        unknown
      >;
    // Marketplace + un-overridden plugin take the target version (not config 1.0.0).
    expect(
      (await read("dist/claude/.claude-plugin/marketplace.json")).version,
    ).toBe("2.0.0");
    expect(
      (await read("dist/claude/plugins/a/.claude-plugin/plugin.json")).version,
    ).toBe("2.0.0");
    // Per-plugin override wins.
    expect(
      (await read("dist/claude/plugins/b/.claude-plugin/plugin.json")).version,
    ).toBe("3.0.0");
  });

  it("deep-merges manifest overrides without dropping sibling keys", async () => {
    const project = await fixtureProject({
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "merge-plugins",
  version: "1.0.0",
  source: { skills: "skills", rootPlugin: { id: "core" } },
  metadata: {
    description: "Base desc",
    keywords: ["a", "b"],
    author: { name: "X" },
    license: "MIT"
  },
  targets: {
    cursor: {
      outDir: "dist/cursor",
      manifest: { metadata: { description: "Overridden desc" } },
      plugins: { demo: { from: ["core"], components: ["skills"] } }
    }
  }
});
`,
      skills: {
        demo: {
          "SKILL.md": skill("demo", "Demo skill."),
        },
      },
    });
    const root = project.baseDir;

    await build({ cwd: root, target: "cursor" });

    const marketplace = JSON.parse(
      await readFile(
        path.join(root, "dist/cursor/.cursor-plugin/marketplace.json"),
        "utf8",
      ),
    ) as { metadata: { description: string; keywords: string[] } };
    // Override replaced description...
    expect(marketplace.metadata.description).toBe("Overridden desc");
    // ...but the sibling keywords survived (shallow spread would have dropped them).
    expect(marketplace.metadata.keywords).toEqual(["a", "b"]);
  });
});

async function fixtureProject(files: DirJSON): Promise<Project> {
  project = new Project("pluginpack-test", "1.0.0", { files });
  await project.write();
  return project;
}

async function mergeFixture(project: Project, files: DirJSON): Promise<void> {
  project.mergeFiles(files);
  await project.write();
}

async function fixture(): Promise<Project> {
  return fixtureProject({
    "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

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
    antigravity: {
      outDir: "dist/antigravity",
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
    plugins: {
      demo: {
        "plugin.pluginpack.json": `${JSON.stringify(
          {
            description: "Source plugin description.",
            displayName: "Demo Source",
          },
          null,
          2,
        )}\n`,
        skills: {
          demo: {
            "SKILL.md": skill("demo", "Demo skill."),
          },
        },
      },
    },
  });
}

async function rootSkillsFixture(): Promise<Project> {
  return fixtureProject({
    "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

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
    skills: {
      demo: {
        "SKILL.md": skill("demo", "Demo skill."),
      },
    },
    "README.md": "# Root docs\n",
  });
}

async function recommendedShapeFixture(): Promise<Project> {
  return fixtureProject({
    "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

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
    skills: {
      "release-notes": {
        "SKILL.md": skill("release-notes", "Release notes skill."),
      },
    },
  });
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

function command(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}
`;
}
