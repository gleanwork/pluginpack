import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Project, type ProjectArgs } from "fixturify-project";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { clean, prune } from "../src/cleanup.js";
import {
  exists,
  isNotFoundError,
  isSafeRelativePath,
  json,
  toPosix,
  walkFiles,
  writeArtifact,
} from "../src/fs.js";
import {
  managedManifestPath,
  normalizeManagedPath,
  readManagedManifest,
} from "../src/managed.js";
import { diffTarget } from "../src/diff.js";

type DirJSON = NonNullable<ProjectArgs["files"]>;

let project: Project | undefined;

afterEach(async () => {
  await project?.dispose();
  project = undefined;
});

/**
 * A minimal single-plugin project. `targetsBlock` is spliced into the config
 * verbatim so each test can shape the targets it needs (overlapping outDirs,
 * protected source roots) without a fixture per case.
 */
async function makeProject(
  targetsBlock: string,
  extra: DirJSON = {},
  sourceBlock = "",
): Promise<Project> {
  project = new Project("pluginpack-destructive", "1.0.0", {
    files: {
      "pluginpack.config.ts": `import { defineConfig } from "${path.resolve("src/index.ts")}";

export default defineConfig({
  name: "destructive-demo",
  version: "1.0.0",
  ${sourceBlock}
  metadata: { description: "D", author: { name: "D" }, license: "MIT" },
  targets: {
${targetsBlock}
  }
});
`,
      plugins: {
        demo: {
          skills: {
            demo: {
              "SKILL.md":
                "---\nname: demo\ndescription: Demo skill.\n---\n\nBody.\n",
            },
          },
        },
      },
      ...extra,
    },
  });
  await project.write();
  return project;
}

const cursorTarget = `    cursor: {
      outDir: "dist/cursor",
      plugins: { demo: { from: ["demo"], components: ["skills"] } }
    }`;

/**
 * Whether this host's filesystem is case-insensitive (APFS, NTFS). A couple of
 * guard behaviours only exist on such a host, and asserting them on a
 * case-sensitive one would test the filesystem rather than the guard.
 */
const caseInsensitiveFs = existsSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "DESTRUCTIVE.TEST.TS",
  ),
);

/** Rewrites a target's managed manifest, the on-disk record prune/clean/diff act on. */
async function writeManifest(
  root: string,
  outDir: string,
  target: string,
  files: string[],
): Promise<void> {
  const manifestPath = path.join(
    root,
    outDir,
    managedManifestPath(target as never),
  );
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, json({ version: 1, target, files }));
}

describe("normalizeManagedPath rejects every path shape that could escape the output dir", () => {
  const rejected: Array<[string, string]> = [
    ["an absolute posix path", "/etc/passwd"],
    ["a bare parent reference", ".."],
    ["a parent-escaping path", "../outside.txt"],
    ["a parent escape hidden mid-path", "a/b/../../../outside.txt"],
    ["an empty string", ""],
    ["a lowercase drive letter", "c:/Windows/system32"],
    ["an uppercase drive letter", "C:/Windows/system32"],
    ["a backslash drive path", "C:\\Windows\\system32"],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => normalizeManagedPath(value)).toThrow(/Unsafe managed path/);
    });
  }

  const accepted: Array<[string, string, string]> = [
    ["converts backslashes to forward slashes", "a\\b\\c.md", "a/b/c.md"],
    ["strips a leading ./", "./a/b.md", "a/b.md"],
    ["collapses an interior .. that stays inside", "a/b/../c.md", "a/c.md"],
    ["collapses interior . segments", "a/./b.md", "a/b.md"],
    ["leaves an already-normal path alone", "a/b.md", "a/b.md"],
  ];

  for (const [label, value, expected] of accepted) {
    it(label, () => {
      expect(normalizeManagedPath(value)).toBe(expected);
    });
  }
});

describe("writeArtifact refuses to write outside its output directory", () => {
  it("rejects a parent-escaping relative path", async () => {
    const created = await makeProject(cursorTarget);
    const outDir = path.join(created.baseDir, "dist/cursor");

    await expect(
      writeArtifact(outDir, new Map([["../escaped.txt", "x"]])),
    ).rejects.toThrow(/Refusing to write outside the output directory/);
    await expect(
      exists(path.join(created.baseDir, "dist/escaped.txt")),
    ).resolves.toBe(false);
  });

  it("rejects an absolute path that resolves away from the output directory", async () => {
    const created = await makeProject(cursorTarget);
    const outDir = path.join(created.baseDir, "dist/cursor");
    const absolute = path.join(created.baseDir, "outside-absolute.txt");

    await expect(
      writeArtifact(outDir, new Map([[absolute, "x"]])),
    ).rejects.toThrow(/Refusing to write outside the output directory/);
    await expect(exists(absolute)).resolves.toBe(false);
  });

  it("rejects a path that only escapes after normalization", async () => {
    const created = await makeProject(cursorTarget);
    const outDir = path.join(created.baseDir, "dist/cursor");

    await expect(
      writeArtifact(outDir, new Map([["nested/../../sneaky.txt", "x"]])),
    ).rejects.toThrow(/Refusing to write outside the output directory/);
  });

  it("creates missing parent directories for a legitimate nested path", async () => {
    const created = await makeProject(cursorTarget);
    const outDir = path.join(created.baseDir, "dist/cursor");

    await writeArtifact(outDir, new Map([["deep/er/still/file.txt", "hi"]]));

    await expect(
      readFile(path.join(outDir, "deep/er/still/file.txt"), "utf8"),
    ).resolves.toBe("hi");
  });
});

describe("readManagedManifest rejects a manifest it cannot trust", () => {
  const invalid: Array<[string, unknown]> = [
    ["a wrong version", { version: 2, target: "cursor", files: [] }],
    ["a mismatched target", { version: 1, target: "claude", files: [] }],
    [
      "a non-array files field",
      { version: 1, target: "cursor", files: "a.md" },
    ],
    [
      "a files array holding a non-string",
      { version: 1, target: "cursor", files: ["a.md", 42] },
    ],
    ["a missing files field", { version: 1, target: "cursor" }],
    ["a null body", null],
    ["a bare string body", "nope"],
    ["a numeric body", 42],
    ["an array body", ["a.md"]],
  ];

  for (const [label, body] of invalid) {
    it(`rejects ${label}`, async () => {
      const created = await makeProject(cursorTarget);
      const outDir = path.join(created.baseDir, "dist/cursor");
      const manifestPath = path.join(outDir, managedManifestPath("cursor"));
      await mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(body));

      await expect(readManagedManifest(outDir, "cursor")).rejects.toThrow(
        /Invalid managed manifest/,
      );
    });
  }

  it("returns null when no manifest exists yet, rather than throwing", async () => {
    const created = await makeProject(cursorTarget);

    await expect(
      readManagedManifest(path.join(created.baseDir, "dist/cursor"), "cursor"),
    ).resolves.toBeNull();
  });
});

describe("the delete guard protects a source tree from clean, not just prune", () => {
  const overlappingConfig = `    cursor: {
      outDir: ".",
      plugins: { demo: { from: ["core"], path: "plugins/cursor/demo" } }
    }`;

  async function overlappingProject(): Promise<Project> {
    return makeProject(
      overlappingConfig,
      {
        skills: {
          demo: { "SKILL.md": "---\nname: demo\ndescription: D.\n---\n\nB.\n" },
        },
      },
      `source: { skills: "skills", rootPlugin: { id: "core" } },`,
    );
  }

  it("refuses to clean a managed path inside source.skills", async () => {
    const created = await overlappingProject();
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    await writeManifest(root, ".", "cursor", ["skills/demo/SKILL.md"]);

    await expect(clean({ cwd: root, target: "cursor" })).rejects.toThrow(
      /Refusing to clean 1 path\(s\) that resolve inside your source tree or config/,
    );
    await access(path.join(root, "skills/demo/SKILL.md"));
  });

  it("refuses to clean the config file itself", async () => {
    const created = await overlappingProject();
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    await writeManifest(root, ".", "cursor", ["pluginpack.config.ts"]);

    await expect(clean({ cwd: root, target: "cursor" })).rejects.toThrow(
      /Refusing to clean/,
    );
    await access(path.join(root, "pluginpack.config.ts"));
  });

  it("refuses to clean the default source.plugins root even when unset in config", async () => {
    const created = await makeProject(`    cursor: {
      outDir: ".",
      plugins: { demo: { from: ["demo"], path: "out/demo", components: ["skills"] } }
    }`);
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    await writeManifest(root, ".", "cursor", [
      "plugins/demo/skills/demo/SKILL.md",
    ]);

    await expect(clean({ cwd: root, target: "cursor" })).rejects.toThrow(
      /Refusing to clean/,
    );
    await access(path.join(root, "plugins/demo/skills/demo/SKILL.md"));
  });

  it("deletes a protected path when --force is given, reporting it as deleted", async () => {
    const created = await overlappingProject();
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    await writeManifest(root, ".", "cursor", ["skills/demo/SKILL.md"]);

    const results = await clean({ cwd: root, target: "cursor", force: true });

    expect(results[0].entries.map((entry) => entry.path)).toContain(
      "skills/demo/SKILL.md",
    );
    await expect(exists(path.join(root, "skills/demo/SKILL.md"))).resolves.toBe(
      false,
    );
  });

  it("names every blocked path in the refusal, not just the first", async () => {
    const created = await overlappingProject();
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    await writeFile(path.join(root, "skills/demo/OTHER.md"), "other\n");
    await writeManifest(root, ".", "cursor", [
      "skills/demo/SKILL.md",
      "skills/demo/OTHER.md",
    ]);

    await expect(clean({ cwd: root, target: "cursor" })).rejects.toThrow(
      /Refusing to clean 2 path\(s\)[\s\S]*skills\/demo\/SKILL\.md[\s\S]*skills\/demo\/OTHER\.md/,
    );
  });

  it("names the protected root each blocked path resolved inside", async () => {
    // A bare list of refused paths does not tell the user what the collision
    // was with. Naming the root does — and when the root came from a mis-cased
    // config value, seeing it echoed back points straight at the typo.
    const created = await overlappingProject();
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    await writeManifest(root, ".", "cursor", ["skills/demo/SKILL.md"]);

    await expect(clean({ cwd: root, target: "cursor" })).rejects.toThrow(
      new RegExp(
        `skills/demo/SKILL\\.md -> resolves inside ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/skills`,
      ),
    );
  });
});

describe("clean handles targets and manifests that are not there", () => {
  it("rejects a target that is not configured", async () => {
    const created = await makeProject(cursorTarget);

    await expect(
      clean({ cwd: created.baseDir, target: "claude" }),
    ).rejects.toThrow(/Target "claude" is not configured/);
  });

  it("is a no-op for a target that was never built", async () => {
    const created = await makeProject(cursorTarget);

    const results = await clean({ cwd: created.baseDir, target: "cursor" });

    expect(results).toEqual([
      expect.objectContaining({ target: "cursor", entries: [] }),
    ]);
  });

  it("cleans every configured target when none is named", async () => {
    const created = await makeProject(`${cursorTarget},
    claude: {
      outDir: "dist/claude",
      plugins: { demo: { from: ["demo"] } }
    }`);
    const root = created.baseDir;
    await build({ cwd: root });

    const results = await clean({ cwd: root });

    expect(results.map((result) => result.target).sort()).toEqual([
      "claude",
      "cursor",
    ]);
    await expect(
      exists(path.join(root, "dist/cursor/demo/skills/demo/SKILL.md")),
    ).resolves.toBe(false);
    await expect(
      exists(path.join(root, "dist/claude/plugins/demo/skills/demo/SKILL.md")),
    ).resolves.toBe(false);
  });
});

describe("removing a managed path cleans up after itself safely", () => {
  it("removes directories left empty by a prune, but keeps ones holding unmanaged files", async () => {
    const created = await makeProject(cursorTarget);
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    const outDir = path.join(root, "dist/cursor");

    // Two stale files the current build no longer produces: one alone in its
    // directory, one sharing a directory with a file pluginpack does not manage.
    await mkdir(path.join(outDir, "lonely/deep"), { recursive: true });
    await writeFile(path.join(outDir, "lonely/deep/stale.md"), "stale\n");
    await mkdir(path.join(outDir, "shared"), { recursive: true });
    await writeFile(path.join(outDir, "shared/stale.md"), "stale\n");
    await writeFile(path.join(outDir, "shared/hand-written.md"), "keep\n");
    const built = await readManagedManifest(outDir, "cursor");
    await writeManifest(root, "dist/cursor", "cursor", [
      ...(built?.files ?? []),
      "lonely/deep/stale.md",
      "shared/stale.md",
    ]);

    await prune({ cwd: root, target: "cursor" });

    await expect(exists(path.join(outDir, "lonely"))).resolves.toBe(false);
    await expect(exists(path.join(outDir, "shared/stale.md"))).resolves.toBe(
      false,
    );
    await access(path.join(outDir, "shared/hand-written.md"));
  });

  it("removes a symlink that points inside the output directory", async () => {
    const created = await makeProject(cursorTarget);
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    const outDir = path.join(root, "dist/cursor");

    const inside = path.join(outDir, "real.txt");
    await writeFile(inside, "real\n");
    await symlink(inside, path.join(outDir, "inside-link"));
    const built = await readManagedManifest(outDir, "cursor");
    await writeManifest(root, "dist/cursor", "cursor", [
      ...(built?.files ?? []),
      "inside-link",
    ]);

    await prune({ cwd: root, target: "cursor" });

    await expect(exists(path.join(outDir, "inside-link"))).resolves.toBe(false);
    await access(inside);
  });

  it("treats an already-missing managed file as deleted instead of failing", async () => {
    const created = await makeProject(cursorTarget);
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    await writeManifest(root, "dist/cursor", "cursor", [
      "gone/never-existed.md",
    ]);

    const results = await clean({ cwd: root, target: "cursor" });

    expect(results[0].entries.map((entry) => entry.path)).toContain(
      "gone/never-existed.md",
    );
  });
});

describe("build writes every target before pruning any target", () => {
  it("leaves the first target's stale files intact when a later target's write fails", async () => {
    // Registry order puts copilot before claude, so copilot is written first
    // and claude second.
    const created = await makeProject(`    copilot: {
      outDir: "dist/copilot",
      plugins: { demo: { from: ["demo"] } }
    },
    claude: {
      outDir: "dist/claude",
      plugins: { demo: { from: ["demo"] } }
    }`);
    const root = created.baseDir;
    await build({ cwd: root });

    // A stale file copilot's next build would prune.
    const copilotOut = path.join(root, "dist/copilot");
    const stale = path.join(copilotOut, "stale-from-last-build.md");
    await writeFile(stale, "stale\n");
    const built = await readManagedManifest(copilotOut, "copilot");
    await writeManifest(root, "dist/copilot", "copilot", [
      ...(built?.files ?? []),
      "stale-from-last-build.md",
    ]);

    // Make claude's write fail for real: replace a file it must write with a
    // directory of the same name, so fs.writeFile raises EISDIR mid-build.
    const blocked = path.join(
      root,
      "dist/claude/plugins/demo/skills/demo/SKILL.md",
    );
    await rm(blocked, { force: true });
    await mkdir(blocked, { recursive: true });

    await expect(build({ cwd: root })).rejects.toThrow();

    // Nothing was pruned, so the previous build's output is still coherent and
    // a re-run starts from the same state.
    await access(stale);
    const manifest = await readManagedManifest(copilotOut, "copilot");
    expect(manifest?.files).toContain("stale-from-last-build.md");
  });
});

describe("the documented layouts stay operable through a full lifecycle", () => {
  // The shape of test that was missing when this class of bug shipped twice:
  // every other layout test does one fresh build and never mutates, prunes, or
  // cleans. A guard false positive is invisible until something goes stale.
  const layouts: Array<[string, string]> = [
    [
      "README Recommended Shape (output under plugins/<target>/, source.plugins unset)",
      `    antigravity: {
      outDir: "plugins/antigravity",
      plugins: { acme: { from: ["core"] } }
    }`,
    ],
    [
      "README single-repo-root shape (outDir '.', output under a pluginRoot)",
      `    claude: {
      outDir: ".",
      pluginRoot: "plugins/claude",
      plugins: { acme: { from: ["core"] } }
    }`,
    ],
    [
      "init scaffold shape (dist/<target>)",
      `    claude: {
      outDir: "dist/claude",
      plugins: { acme: { from: ["core"] } }
    }`,
    ],
  ];

  for (const [label, targetsBlock] of layouts) {
    it(`survives build -> delete a skill -> rebuild -> prune -> clean: ${label}`, async () => {
      const created = await makeProject(
        targetsBlock,
        {
          skills: {
            alpha: {
              "SKILL.md": "---\nname: alpha\ndescription: Alpha.\n---\n\nA.\n",
            },
            beta: {
              "SKILL.md": "---\nname: beta\ndescription: Beta.\n---\n\nB.\n",
            },
          },
        },
        `source: { skills: "skills", rootPlugin: { id: "core" } },`,
      );
      const root = created.baseDir;

      await build({ cwd: root });
      // A user removes a skill — the step that used to break everything after.
      await rm(path.join(root, "skills/beta"), {
        recursive: true,
        force: true,
      });

      await expect(build({ cwd: root })).resolves.toBeDefined();
      await expect(prune({ cwd: root })).resolves.toBeDefined();
      await expect(clean({ cwd: root })).resolves.toBeDefined();

      // The source tree is untouched by any of it.
      await access(path.join(root, "skills/alpha/SKILL.md"));
      await access(path.join(root, "pluginpack.config.ts"));
    });
  }

  it("still refuses to delete real source when a target writes into the source tree", async () => {
    const created = await makeProject(
      `    antigravity: {
      outDir: ".",
      plugins: { acme: { from: ["core"], path: "skills/generated" } }
    }`,
      {
        skills: {
          alpha: {
            "SKILL.md": "---\nname: alpha\ndescription: Alpha.\n---\n\nA.\n",
          },
        },
      },
      `source: { skills: "skills", rootPlugin: { id: "core" } },`,
    );
    const root = created.baseDir;
    await build({ cwd: root });

    await expect(clean({ cwd: root })).rejects.toThrow(
      /Refusing to clean .* that resolve inside your source tree or config/,
    );
    await access(path.join(root, "skills/alpha/SKILL.md"));
  });

  it("refuses a managed path differing from a protected root only by case", async () => {
    // Tests the guard's comparison directly, independent of how the host
    // filesystem resolves case: the manifest names `Skills/...` while
    // source.skills is `skills`. On a case-insensitive host fs.rm would resolve
    // these to the same file, so an exact-match guard deletes real source.
    const created = await makeProject(
      `    antigravity: {
      outDir: ".",
      plugins: { acme: { from: ["core"], path: "generated" } }
    }`,
      {
        skills: {
          alpha: {
            "SKILL.md": "---\nname: alpha\ndescription: Alpha.\n---\n\nA.\n",
          },
        },
      },
      `source: { skills: "skills", rootPlugin: { id: "core" } },`,
    );
    const root = created.baseDir;
    await build({ cwd: root });
    await writeManifest(root, ".", "antigravity", ["Skills/alpha/SKILL.md"]);

    await expect(clean({ cwd: root })).rejects.toThrow(
      /Refusing to clean .* that resolve inside your source tree or config/,
    );
    await access(path.join(root, "skills/alpha/SKILL.md"));
  });

  it.skipIf(!caseInsensitiveFs)(
    "refuses when source.skills differs from the real directory only by case",
    async () => {
      // The end-to-end version of the above, and the realistic trigger: a config
      // typo that a case-insensitive filesystem forgives, so the build succeeds
      // against `skills/` while the guard was told `Skills/`. Only meaningful on
      // a host that resolves the mismatch — on a case-sensitive one the build
      // correctly fails earlier with "Root skills source directory is missing".
      const created = await makeProject(
        `    antigravity: {
      outDir: ".",
      plugins: { acme: { from: ["core"], path: "skills/generated" } }
    }`,
        {
          skills: {
            alpha: {
              "SKILL.md": "---\nname: alpha\ndescription: Alpha.\n---\n\nA.\n",
            },
          },
        },
        `source: { skills: "Skills", rootPlugin: { id: "core" } },`,
      );
      const root = created.baseDir;
      await build({ cwd: root });

      await expect(clean({ cwd: root })).rejects.toThrow(
        /Refusing to clean .* that resolve inside your source tree or config/,
      );
      await access(path.join(root, "skills/alpha/SKILL.md"));
    },
  );
});

describe("containment follows symlinks instead of trusting the path string", () => {
  async function projectWithSymlinkedOutputDir(): Promise<{
    root: string;
    outside: string;
  }> {
    const created = await makeProject(
      `    antigravity: {
      outDir: "out",
      plugins: { acme: { from: ["demo"], path: "shared" } }
    }`,
    );
    const root = created.baseDir;
    const outside = path.join(root, "outside-the-output-dir");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "plugin.json"), "USER FILE\n");
    await mkdir(path.join(root, "out"), { recursive: true });
    // An intermediate segment of the output path is a symlink pointing away.
    await symlink(outside, path.join(root, "out/shared"));
    return { root, outside };
  }

  it("refuses to write through a symlinked intermediate directory", async () => {
    const { root, outside } = await projectWithSymlinkedOutputDir();

    await expect(build({ cwd: root })).rejects.toThrow(
      /Refusing to write through a symlink that leaves the output directory/,
    );
    expect(await readFile(path.join(outside, "plugin.json"), "utf8")).toBe(
      "USER FILE\n",
    );
  });

  it("refuses to delete through a symlinked intermediate directory", async () => {
    const { root, outside } = await projectWithSymlinkedOutputDir();
    // A manifest naming a path whose intermediate segment is the symlink. Every
    // segment is a safe relative path, so normalizeManagedPath permits it.
    await writeManifest(root, "out", "antigravity", ["shared/plugin.json"]);

    await expect(clean({ cwd: root, target: "antigravity" })).rejects.toThrow(
      /Refusing to remove a path that resolves outside the output directory/,
    );
    await access(path.join(outside, "plugin.json"));
  });

  it("still writes and cleans normally when the output directory itself is a symlink", async () => {
    // The legitimate case: outDir is a symlink. Resolving both sides means this
    // keeps working rather than being caught as an escape.
    const created = await makeProject(
      `    antigravity: {
      outDir: "linked-out",
      plugins: { acme: { from: ["demo"] } }
    }`,
    );
    const root = created.baseDir;
    const real = path.join(root, "real-out");
    await mkdir(real, { recursive: true });
    await symlink(real, path.join(root, "linked-out"));

    await expect(build({ cwd: root })).resolves.toBeDefined();
    await access(path.join(real, "acme/plugin.json"));
    await expect(
      clean({ cwd: root, target: "antigravity" }),
    ).resolves.toBeDefined();
  });
});

describe("clean refuses paths another target's manifest also claims", () => {
  // cursor's outDir contains claude's, so a cursor manifest can name a file
  // inside dist/claude without any "../" — the shape a pre-collision-check
  // pluginpack could leave behind, and the one that would delete claude's live
  // output. cursor's own plugin lives under out/, away from the protected
  // default source.plugins root, so the source-tree guard isn't what fires.
  async function overlappingManifests(): Promise<{
    root: string;
    claudeSkill: string;
  }> {
    const created = await makeProject(`    cursor: {
      outDir: ".",
      plugins: { demo: { from: ["demo"], path: "out/cursor/demo", components: ["skills"] } }
    },
    claude: {
      outDir: "dist/claude",
      plugins: { demo: { from: ["demo"] } }
    }`);
    const root = created.baseDir;
    await build({ cwd: root });

    const claudeRelative = "dist/claude/plugins/demo/skills/demo/SKILL.md";
    await access(path.join(root, claudeRelative));
    const cursorManifest = await readManagedManifest(root, "cursor");
    await writeManifest(root, ".", "cursor", [
      ...(cursorManifest?.files ?? []),
      claudeRelative,
    ]);
    return { root, claudeSkill: path.join(root, claudeRelative) };
  }

  it("refuses rather than deleting the other target's live output", async () => {
    const { root, claudeSkill } = await overlappingManifests();

    await expect(clean({ cwd: root, target: "cursor" })).rejects.toThrow(
      // Which target is named first follows registry order, so accept either.
      /Refusing to clean paths claimed by more than one target's managed manifest:[\s\S]*(cursor and claude|claude and cursor):[\s\S]*SKILL\.md/,
    );
    await access(claudeSkill);
  });

  it("refuses when cleaning every target too, not just the named one", async () => {
    const { root, claudeSkill } = await overlappingManifests();

    await expect(clean({ cwd: root })).rejects.toThrow(
      /Refusing to clean paths claimed by more than one target/,
    );
    await access(claudeSkill);
  });

  it("proceeds under --force, so a repo can always be torn down", async () => {
    const { root, claudeSkill } = await overlappingManifests();

    await clean({ cwd: root, target: "cursor", force: true });

    await expect(exists(claudeSkill)).resolves.toBe(false);
  });

  it("leaves non-overlapping targets alone", async () => {
    const created = await makeProject(`${cursorTarget},
    claude: {
      outDir: "dist/claude",
      plugins: { demo: { from: ["demo"] } }
    }`);
    const root = created.baseDir;
    await build({ cwd: root });

    await expect(clean({ cwd: root })).resolves.toHaveLength(2);
  });
});

describe("diff classifies output drift", () => {
  it("reports nothing when the target repo matches the build", async () => {
    const created = await makeProject(cursorTarget);
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(result).toEqual({ ok: true, entries: [] });
  });

  it("reports a file missing from the target repo as added", async () => {
    const created = await makeProject(cursorTarget);
    const root = created.baseDir;

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(result.ok).toBe(false);
    expect(result.entries.every((entry) => entry.type === "added")).toBe(true);
    expect(result.entries.map((entry) => entry.path)).toContain(
      "demo/skills/demo/SKILL.md",
    );
  });

  it("reports a hand-edited file as changed", async () => {
    const created = await makeProject(cursorTarget);
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    await writeFile(
      path.join(root, "dist/cursor/demo/skills/demo/SKILL.md"),
      "---\nname: demo\ndescription: Edited by hand.\n---\n\nDrifted.\n",
    );

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(result.entries).toContainEqual({
      type: "changed",
      path: "demo/skills/demo/SKILL.md",
    });
  });

  it("ignores a whole directory subtree listed in ignoredDiffPaths", async () => {
    const created = await makeProject(`    cursor: {
      outDir: "dist/cursor",
      plugins: { demo: { from: ["demo"], components: ["skills"] } },
      ignoredDiffPaths: ["demo/skills"]
    }`);
    const root = created.baseDir;

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(
      result.entries.filter((entry) => entry.path.startsWith("demo/skills")),
    ).toEqual([]);
  });

  it("does not report a removed file that is already gone from the target repo", async () => {
    const created = await makeProject(cursorTarget);
    const root = created.baseDir;
    await build({ cwd: root, target: "cursor" });
    const built = await readManagedManifest(
      path.join(root, "dist/cursor"),
      "cursor",
    );
    // The manifest claims a file that no longer exists on disk.
    await writeManifest(root, "dist/cursor", "cursor", [
      ...(built?.files ?? []),
      "deleted-out-of-band.md",
    ]);

    const result = await diffTarget({
      cwd: root,
      target: "cursor",
      against: "dist/cursor",
    });

    expect(result.entries.map((entry) => entry.path)).not.toContain(
      "deleted-out-of-band.md",
    );
  });
});

describe("path-safety helpers", () => {
  const unsafe = [
    ["an empty string", ""],
    ["an absolute path", "/etc/passwd"],
    ["a bare parent reference", ".."],
    ["a parent-escaping path", "../outside"],
    ["a parent escape after normalization", "a/../../outside"],
    ["a backslash parent escape", "..\\outside"],
  ] as const;

  for (const [label, value] of unsafe) {
    it(`isSafeRelativePath rejects ${label}`, () => {
      expect(isSafeRelativePath(value)).toBe(false);
    });
  }

  const safe = [
    ["a plain relative path", "a/b.md"],
    ["an http URL", "http://example.com/x"],
    ["an https URL", "https://example.com/x"],
    ["an interior .. that stays inside", "a/b/../c.md"],
  ] as const;

  for (const [label, value] of safe) {
    it(`isSafeRelativePath accepts ${label}`, () => {
      expect(isSafeRelativePath(value)).toBe(true);
    });
  }

  it("isNotFoundError distinguishes missing paths from real IO failures", () => {
    const withCode = (code: string): Error =>
      Object.assign(new Error(code), { code });

    expect(isNotFoundError(withCode("ENOENT"))).toBe(true);
    expect(isNotFoundError(withCode("ENOTDIR"))).toBe(true);
    expect(isNotFoundError(withCode("EACCES"))).toBe(false);
    expect(isNotFoundError(withCode("ELOOP"))).toBe(false);
    expect(isNotFoundError(new Error("no code"))).toBe(false);
    expect(isNotFoundError("not an error")).toBe(false);
  });

  it("exists reports false for a path whose parent is a file (ENOTDIR)", async () => {
    const created = await makeProject(cursorTarget);
    const filePath = path.join(created.baseDir, "pluginpack.config.ts");

    await expect(exists(filePath)).resolves.toBe(true);
    await expect(exists(path.join(filePath, "child.txt"))).resolves.toBe(false);
    await expect(exists(path.join(created.baseDir, "nope.txt"))).resolves.toBe(
      false,
    );
  });

  it("walkFiles finds dotfiles and returns sorted absolute paths", async () => {
    const created = await makeProject(cursorTarget);
    const root = created.baseDir;
    await mkdir(path.join(root, "walk/.hidden"), { recursive: true });
    await writeFile(path.join(root, "walk/.dotfile"), "a\n");
    await writeFile(path.join(root, "walk/.hidden/nested.txt"), "b\n");
    await writeFile(path.join(root, "walk/visible.txt"), "c\n");

    const files = await walkFiles(path.join(root, "walk"));

    expect(files.map((file) => toPosix(path.relative(root, file)))).toEqual([
      "walk/.dotfile",
      "walk/.hidden/nested.txt",
      "walk/visible.txt",
    ]);
    expect(files.every((file) => path.isAbsolute(file))).toBe(true);
  });

  it("json emits pretty-printed output with a trailing newline", () => {
    expect(json({ b: 1, a: [2] })).toBe(
      '{\n  "b": 1,\n  "a": [\n    2\n  ]\n}\n',
    );
  });
});
