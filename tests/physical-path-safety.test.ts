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
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "../src/build.js";
import { clean, prune } from "../src/cleanup.js";
import { loadConfig } from "../src/config.js";
import { exists, json, walkFiles } from "../src/fs.js";
import { managedManifestPath, readManagedManifest } from "../src/managed.js";

type DirJSON = NonNullable<ProjectArgs["files"]>;

let project: Project | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await project?.dispose();
  project = undefined;
});

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n${name} body.\n`;

/**
 * A project with one canonical source plugin at `shared/acme` holding the
 * skills `alpha` and `beta`. `targetsBlock` and `sourceBlock` are spliced into
 * the config verbatim.
 */
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

async function makeProject(
  targetsBlock: string,
  extra: DirJSON = {},
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
      ...extra,
    },
  });
  await project.write();
  return project.baseDir;
}

/** Rewrites a target's managed manifest as an older (version 1) pluginpack would. */
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

/** Messages passed to console.warn while `fn` runs. */
async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  await fn();
  return warnings;
}

const caseInsensitiveFs = existsSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "PHYSICAL-PATH-SAFETY.TEST.TS",
  ),
);

const sourceSurvives = async (root: string) => {
  await access(path.join(root, "shared/acme/skills/alpha/SKILL.md"));
  await access(path.join(root, "shared/acme/skills/beta/SKILL.md"));
  await access(path.join(root, "pluginpack.config.ts"));
  await access(path.join(root, "UNMANAGED.txt"));
};

describe("the delete guard protects source, not generated packages under plugins/", () => {
  it("keeps outDir '.' with the default plugins/<name> package path operable through a full lifecycle", async () => {
    // The agent-plugins default writes the package to plugins/acme/, which
    // has a skills/ directory, so a guard that guesses source plugins from
    // component directories under plugins/ refuses to prune its own output.
    const root = await makeProject(`    "agent-plugins": {
      outDir: ".",
      plugins: { acme: { source: "shared/acme" } }
    }`);
    await build({ cwd: root });
    await access(path.join(root, "plugins/acme/skills/beta/SKILL.md"));
    await rm(path.join(root, "shared/acme/skills/beta"), { recursive: true });

    await expect(build({ cwd: root })).resolves.toBeDefined();
    await expect(
      exists(path.join(root, "plugins/acme/skills/beta/SKILL.md")),
    ).resolves.toBe(false);
    await expect(prune({ cwd: root })).resolves.toBeDefined();
    await expect(clean({ cwd: root })).resolves.toBeDefined();

    await expect(exists(path.join(root, "plugins/acme"))).resolves.toBe(false);
    await access(path.join(root, "shared/acme/skills/alpha/SKILL.md"));
    await access(path.join(root, "UNMANAGED.txt"));
  });

  it("still protects a plugins/<name> directory that carries plugin.pluginpack.json", async () => {
    const root = await makeProject(
      `    "agent-plugins": {
      outDir: ".",
      plugins: { acme: { source: "shared/acme", path: "out/acme" } }
    }`,
      {
        plugins: {
          authored: {
            "plugin.pluginpack.json": "{}\n",
            skills: { gamma: { "SKILL.md": skill("gamma") } },
          },
        },
      },
    );
    await build({ cwd: root });
    await writeManifest(root, ".", "agent-plugins", [
      "plugins/authored/skills/gamma/SKILL.md",
    ]);

    await expect(clean({ cwd: root })).rejects.toThrow(
      /Refusing to clean 1 path\(s\)[\s\S]*resolves inside .*plugins\/authored/,
    );
    await access(path.join(root, "plugins/authored/skills/gamma/SKILL.md"));
  });
});

describe("source protection compares physical paths", () => {
  async function aliasedSource(): Promise<string> {
    const root = await makeProject(`    "agent-plugins": {
      outDir: "linked-out",
      plugins: { acme: { source: "shared/acme", path: "." } }
    }`);
    await symlink(
      path.join(root, "shared/acme"),
      path.join(root, "linked-out"),
    );
    return root;
  }

  it("refuses to build when the outDir is a symlink into a source plugin", async () => {
    const root = await aliasedSource();

    await expect(build({ cwd: root })).rejects.toThrow(
      /targets\.agent-plugins\.outDir .* resolves inside .*shared\/acme \(targets\.agent-plugins\.plugins\.acme\.source\)/,
    );
    await sourceSurvives(root);
  });

  it("refuses to clean managed paths that reach source through a symlinked outDir", async () => {
    // clean never loads the source tree, so this is the delete guard on its own.
    const root = await aliasedSource();
    await writeManifest(root, "linked-out", "agent-plugins", [
      "skills/alpha/SKILL.md",
      "skills/beta/SKILL.md",
    ]);

    await expect(clean({ cwd: root })).rejects.toThrow(
      /Refusing to clean 2 path\(s\)[\s\S]*skills\/alpha\/SKILL\.md -> resolves inside .*shared\/acme/,
    );
    await sourceSurvives(root);
  });

  it("refuses to load a config whose outDir sits inside a source plugin", async () => {
    const root = await makeProject(`    antigravity: {
      outDir: "shared/acme",
      plugins: { acme: { source: "shared/acme" } }
    }`);

    await expect(loadConfig(root)).rejects.toThrow(
      /targets\.antigravity\.outDir .* resolves inside .*shared\/acme \(targets\.antigravity\.plugins\.acme\.source\)[\s\S]*Point each outDir at a directory outside/,
    );
  });

  it("refuses a --out-dir override inside source", async () => {
    const root = await makeProject(`    antigravity: {
      outDir: "dist/antigravity",
      plugins: { acme: { source: "shared/acme" } }
    }`);

    await expect(
      build({ cwd: root, target: "antigravity", outDir: "shared/acme/out" }),
    ).rejects.toThrow(/resolves inside .*shared\/acme/);
    await expect(exists(path.join(root, "shared/acme/out"))).resolves.toBe(
      false,
    );
  });

  it("still builds and cleans through an outDir symlink that points somewhere safe", async () => {
    const root = await makeProject(`    antigravity: {
      outDir: "linked-out",
      plugins: { acme: { source: "shared/acme" } }
    }`);
    await mkdir(path.join(root, "real-out"));
    await symlink(path.join(root, "real-out"), path.join(root, "linked-out"));

    await build({ cwd: root });
    await access(path.join(root, "real-out/acme/skills/alpha/SKILL.md"));
    await clean({ cwd: root });
    await sourceSurvives(root);
  });
});

describe("cross-target collision checks compare physical paths", () => {
  const codexAndAgentPlugins = (
    codexOut: string,
    apOut: string,
  ) => `    codex: {
      outDir: "${codexOut}",
      plugins: { acme: { source: "shared/acme" } }
    },
    "agent-plugins": {
      outDir: "${apOut}",
      clients: { codex: {} },
      plugins: { acme: { source: "shared/acme" } }
    }`;

  it("rejects two outDirs that alias one directory through a symlink", async () => {
    const root = await makeProject(codexAndAgentPlugins("out", "alias-out"));
    await mkdir(path.join(root, "out"));
    await symlink(path.join(root, "out"), path.join(root, "alias-out"));

    await expect(build({ cwd: root })).rejects.toThrow(
      /Targets write overlapping output paths[\s\S]*codex and agent-plugins: .*out\/\.agents\/plugins\/marketplace\.json \(same file as .*alias-out\/\.agents\/plugins\/marketplace\.json\)/,
    );
    await expect(exists(path.join(root, "out/plugins"))).resolves.toBe(false);
  });

  it.skipIf(!caseInsensitiveFs)(
    "rejects outDirs that differ only by case on a case-insensitive filesystem",
    async () => {
      const root = await makeProject(codexAndAgentPlugins("out", "OUT"));

      await expect(build({ cwd: root })).rejects.toThrow(
        /Targets write overlapping output paths[\s\S]*codex and agent-plugins/,
      );
    },
  );

  it.skipIf(!caseInsensitiveFs)(
    "rejects a --target build whose outDir aliases another target's built output by case",
    async () => {
      const root = await makeProject(codexAndAgentPlugins("out", "OUT"));
      await build({ cwd: root, target: "codex" });

      await expect(
        build({ cwd: root, target: "agent-plugins" }),
      ).rejects.toThrow(
        /overlaps a previously built target's managed files[\s\S]*codex \(previously built\) and agent-plugins/,
      );
    },
  );

  it("refuses to clean one target's manifest entries that alias another's through a symlink", async () => {
    const root = await makeProject(codexAndAgentPlugins("out", "alias-out"));
    await mkdir(path.join(root, "out"));
    await symlink(path.join(root, "out"), path.join(root, "alias-out"));
    await mkdir(path.join(root, "out/plugins/acme"), { recursive: true });
    await writeFile(path.join(root, "out/plugins/acme/plugin.json"), "{}\n");
    // Two manifests an older pluginpack could have left behind.
    await writeManifest(root, "out", "codex", ["plugins/acme/plugin.json"]);
    await writeManifest(root, "alias-out", "agent-plugins", [
      "plugins/acme/plugin.json",
    ]);

    await expect(clean({ cwd: root, target: "codex" })).rejects.toThrow(
      /Refusing to clean paths claimed by more than one target's managed manifest:[\s\S]*codex and agent-plugins/,
    );
    await access(path.join(root, "out/plugins/acme/plugin.json"));
  });
});

describe("a stale path another target now owns is left in place", () => {
  const entry = `entry: { policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }`;
  const agentPluginsWithCodex = `    "agent-plugins": {
      outDir: "out",
      clients: { codex: {} },
      plugins: { acme: { source: "shared/acme", clients: { codex: { ${entry} } } } }
    }`;
  const codexTarget = `    codex: {
      outDir: "out",
      plugins: { other: { source: "shared/acme", ${entry} } }
    }`;
  const agentPluginsWithoutCodex = `    "agent-plugins": {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`;
  const marketplace = "out/.agents/plugins/marketplace.json";

  /** Writes a later revision of the project config under its own name. */
  async function revision(
    root: string,
    name: string,
    targets: string,
  ): Promise<string> {
    const configPath = path.join(root, `${name}.config.ts`);
    await writeFile(configPath, configText(targets));
    return configPath;
  }

  it("does not delete a marketplace handed from agent-plugins to codex in one plain build", async () => {
    const root = await makeProject(agentPluginsWithCodex);
    await build({ cwd: root });
    const configPath = await revision(
      root,
      "handoff",
      `${codexTarget},\n${agentPluginsWithoutCodex}`,
    );

    await build({ cwd: root, configPath });

    const written = JSON.parse(
      await readFile(path.join(root, marketplace), "utf8"),
    ) as { plugins: Array<{ name: string }> };
    expect(written.plugins.map((plugin) => plugin.name)).toEqual(["other"]);
    expect(
      (await readManagedManifest(path.join(root, "out"), "agent-plugins"))
        ?.files,
    ).not.toContain(".agents/plugins/marketplace.json");
  });

  it("does not prune a stale path another configured target's manifest claims", async () => {
    const root = await makeProject(agentPluginsWithCodex);
    await build({ cwd: root });
    // The project swaps targets; agent-plugins' old manifest stays on disk.
    await build({
      cwd: root,
      configPath: await revision(root, "codex-only", codexTarget),
    });
    const configPath = await revision(
      root,
      "both",
      `${codexTarget},\n${agentPluginsWithoutCodex}`,
    );

    const [result] = await prune({
      cwd: root,
      configPath,
      target: "agent-plugins",
    });

    expect(result.entries.map((entry) => entry.path)).not.toContain(
      ".agents/plugins/marketplace.json",
    );
    await access(path.join(root, marketplace));
  });
});

describe("dry runs run the same destructive preflight as the real command", () => {
  async function protectedStalePath(): Promise<string> {
    const root = await makeProject(
      `    antigravity: {
      outDir: ".",
      plugins: { acme: { from: ["core"], path: "generated" } }
    }`,
      { skills: { gamma: { "SKILL.md": skill("gamma") } } },
      `source: { skills: "skills", rootPlugin: { id: "core" } },`,
    );
    await build({ cwd: root });
    const manifest = await readManagedManifest(root, "antigravity");
    await writeManifest(root, ".", "antigravity", [
      ...(manifest?.files ?? []),
      "skills/gamma/SKILL.md",
    ]);
    return root;
  }

  it("clean --dry-run fails on a protected path, as clean does", async () => {
    const root = await protectedStalePath();

    await expect(clean({ cwd: root, dryRun: true })).rejects.toThrow(
      /Refusing to clean 1 path\(s\)/,
    );
    await expect(clean({ cwd: root })).rejects.toThrow(
      /Refusing to clean 1 path\(s\)/,
    );
  });

  it("prune --dry-run fails on a protected path, as prune does", async () => {
    const root = await protectedStalePath();

    await expect(prune({ cwd: root, dryRun: true })).rejects.toThrow(
      /Refusing to prune 1 path\(s\)/,
    );
    await expect(prune({ cwd: root })).rejects.toThrow(
      /Refusing to prune 1 path\(s\)/,
    );
    await access(path.join(root, "skills/gamma/SKILL.md"));
  });

  it("build --dry-run fails where build would, and build refuses before writing", async () => {
    const root = await protectedStalePath();
    await rm(path.join(root, "generated"), { recursive: true });

    await expect(build({ cwd: root, dryRun: true })).rejects.toThrow(
      /Refusing to prune 1 path\(s\)/,
    );
    await expect(build({ cwd: root })).rejects.toThrow(
      /Refusing to prune 1 path\(s\)/,
    );
    await expect(exists(path.join(root, "generated"))).resolves.toBe(false);
    await access(path.join(root, "skills/gamma/SKILL.md"));
  });
});

describe("rootFiles cannot make an authored file a managed output", () => {
  const selfCopy = `    antigravity: {
      outDir: ".",
      rootFiles: { "README.md": "README.md" },
      plugins: { acme: { source: "shared/acme", path: "generated/acme" } }
    }`;

  it("rejects a rootFiles entry that copies a file onto itself, before writing", async () => {
    const root = await makeProject(selfCopy, {
      "README.md": "HAND-WRITTEN README\n",
    });

    await expect(build({ cwd: root })).rejects.toThrow(
      /targets\.antigravity\.rootFiles\["README\.md"\] copies .*README\.md onto itself/,
    );
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe(
      "HAND-WRITTEN README\n",
    );
    await expect(exists(path.join(root, "generated"))).resolves.toBe(false);
  });

  it("refuses to clean a rootFiles source an older build left in the manifest", async () => {
    const root = await makeProject(selfCopy, {
      "README.md": "HAND-WRITTEN README\n",
    });
    await writeManifest(root, ".", "antigravity", ["README.md"]);

    await expect(clean({ cwd: root })).rejects.toThrow(
      /README\.md -> resolves inside .*README\.md/,
    );
    await access(path.join(root, "README.md"));
  });

  it("rejects a repositoryFiles directory that is the target's own outDir", async () => {
    const root = await makeProject(
      `    antigravity: {
      outDir: "repo-root",
      repositoryFiles: "repo-root",
      plugins: { acme: { source: "shared/acme" } }
    }`,
      { "repo-root": { "README.md": "HAND-WRITTEN README\n" } },
    );

    // Caught at load, since the outDir is a protected repositoryFiles path.
    await expect(build({ cwd: root })).rejects.toThrow(
      /targets\.antigravity\.outDir .* resolves inside .*repo-root \(targets\.antigravity\.repositoryFiles\)/,
    );
    await access(path.join(root, "repo-root/README.md"));
  });
});

describe("the managed manifest records hashes and warns before losing an edit", () => {
  const target = `    antigravity: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`;

  it("writes version 2 with a sha256 for every managed file", async () => {
    const root = await makeProject(target);
    await build({ cwd: root });

    const raw = JSON.parse(
      await readFile(
        path.join(root, "out", managedManifestPath("antigravity")),
        "utf8",
      ),
    ) as { version: number; files: string[]; sha256: Record<string, string> };

    expect(raw.version).toBe(2);
    expect(Object.keys(raw.sha256).sort()).toEqual([...raw.files].sort());
    expect(raw.sha256["acme/skills/alpha/SKILL.md"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads a version 1 manifest and upgrades it on the next build", async () => {
    const root = await makeProject(target);
    await build({ cwd: root });
    await writeManifest(root, "out", "antigravity", [
      "acme/skills/alpha/SKILL.md",
    ]);

    await expect(
      readManagedManifest(path.join(root, "out"), "antigravity"),
    ).resolves.toMatchObject({ version: 2, sha256: {} });
    await build({ cwd: root });
    await expect(
      readManagedManifest(path.join(root, "out"), "antigravity"),
    ).resolves.toMatchObject({
      sha256: { "acme/skills/alpha/SKILL.md": expect.any(String) },
    });
  });

  it("warns, then still prunes, a stale managed file someone edited", async () => {
    const root = await makeProject(target);
    await build({ cwd: root });
    const generated = path.join(root, "out/acme/skills/beta/SKILL.md");
    await writeFile(generated, `${skill("beta")}HOTFIX\n`);
    await rm(path.join(root, "shared/acme/skills/beta"), { recursive: true });

    const warnings = await captureWarnings(() => build({ cwd: root }));

    expect(warnings).toEqual([
      expect.stringMatching(
        /antigravity managed file .*out\/acme\/skills\/beta\/SKILL\.md was edited after pluginpack wrote it; deleting it/,
      ),
    ]);
    await expect(exists(generated)).resolves.toBe(false);
  });

  it("reports an edited stale file from prune --dry-run without deleting it", async () => {
    const root = await makeProject(target);
    await build({ cwd: root });
    const generated = path.join(root, "out/acme/skills/beta/SKILL.md");
    await writeFile(generated, "EDITED\n");
    await rm(path.join(root, "shared/acme/skills/beta"), { recursive: true });

    const warnings = await captureWarnings(() =>
      prune({ cwd: root, dryRun: true }),
    );

    expect(warnings).toEqual([
      expect.stringMatching(
        /was edited after pluginpack wrote it; a real run would delete it/,
      ),
    ]);
    await access(generated);
  });

  it("warns before a build overwrites an edited managed file, but not an unedited one", async () => {
    const root = await makeProject(target);
    await build({ cwd: root });
    await writeFile(
      path.join(root, "out/acme/skills/alpha/SKILL.md"),
      "EDITED\n",
    );

    const warnings = await captureWarnings(() => build({ cwd: root }));

    expect(warnings).toEqual([
      expect.stringMatching(
        /acme\/skills\/alpha\/SKILL\.md was edited after pluginpack wrote it; overwriting it/,
      ),
    ]);
    expect(
      await readFile(path.join(root, "out/acme/skills/alpha/SKILL.md"), "utf8"),
    ).toBe(skill("alpha"));
  });

  it("warns before clean deletes an edited managed file", async () => {
    const root = await makeProject(target);
    await build({ cwd: root });
    await writeFile(
      path.join(root, "out/acme/skills/alpha/SKILL.md"),
      "EDITED\n",
    );

    const warnings = await captureWarnings(() => clean({ cwd: root }));

    expect(warnings).toEqual([
      expect.stringMatching(
        /alpha\/SKILL\.md was edited after pluginpack wrote it; deleting it/,
      ),
    ]);
  });

  it("tells a manifest from a newer pluginpack apart from a corrupt one", async () => {
    const root = await makeProject(target);
    const outDir = path.join(root, "out");
    const manifestPath = path.join(outDir, managedManifestPath("antigravity"));
    await mkdir(path.dirname(manifestPath), { recursive: true });

    await writeFile(
      manifestPath,
      json({ version: 3, target: "antigravity", files: [] }),
    );
    await expect(readManagedManifest(outDir, "antigravity")).rejects.toThrow(
      `Managed manifest ${manifestPath} has version 3, so a newer pluginpack wrote it. This pluginpack reads versions 1 to 2. Upgrade pluginpack`,
    );

    await writeFile(manifestPath, "{ truncated");
    await expect(readManagedManifest(outDir, "antigravity")).rejects.toThrow(
      `Invalid managed manifest: ${manifestPath} (not valid JSON)`,
    );
  });
});

describe("managed-manifest writes stay inside the output directory", () => {
  it("refuses to build through a symlinked .pluginpack directory", async () => {
    const root = await makeProject(`    antigravity: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`);
    const outside = path.join(root, "outside-state");
    await mkdir(outside);
    const state = json({
      version: 1,
      target: "antigravity",
      files: [],
      note: "USER STATE",
    });
    await writeFile(path.join(outside, "antigravity.json"), state);
    await mkdir(path.join(root, "out"));
    await symlink(outside, path.join(root, "out/.pluginpack"));

    await expect(build({ cwd: root })).rejects.toThrow(
      /Refusing to write through a symlink that leaves the output directory: \.pluginpack\/antigravity\.json/,
    );
    expect(await readFile(path.join(outside, "antigravity.json"), "utf8")).toBe(
      state,
    );
    await expect(exists(path.join(root, "out/acme"))).resolves.toBe(false);
  });
});

describe("a failed clean says how to recover", () => {
  it("names the managed manifest and the recovery step", async () => {
    const root = await makeProject(`    antigravity: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`);
    await build({ cwd: root });
    const manifest = await readManagedManifest(
      path.join(root, "out"),
      "antigravity",
    );
    await mkdir(path.join(root, "out/blocked"));
    await writeManifest(root, "out", "antigravity", [
      ...(manifest?.files ?? []),
      "blocked",
    ]);

    const manifestPath = path.join(
      root,
      "out",
      managedManifestPath("antigravity"),
    );
    await expect(clean({ cwd: root })).rejects.toThrow(
      `The managed manifest ${manifestPath} still lists every remaining path, so fix the cause and re-run the same command.`,
    );
    await access(manifestPath);
  });
});

describe("an external outDir keeps its version-control data", () => {
  it("refuses to clean a manifest entry inside the outDir's .git", async () => {
    const root = await makeProject(
      `    antigravity: {
      outDir: "../sibling",
      plugins: { acme: { source: "shared/acme" } }
    }`,
    );
    const sibling = path.join(root, "../sibling");
    await mkdir(path.join(sibling, ".git"), { recursive: true });
    await writeFile(path.join(sibling, ".git/config"), "[core]\n");
    try {
      await build({ cwd: root });
      await writeManifest(root, "../sibling", "antigravity", [".git/config"]);

      await expect(clean({ cwd: root })).rejects.toThrow(
        /\.git\/config -> resolves inside .*sibling\/\.git/,
      );
      await access(path.join(sibling, ".git/config"));
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });
});

describe("config path fields stay inside the project", () => {
  it("rejects source.partials outside the project at config load", async () => {
    const root = await makeProject(
      `    antigravity: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`,
      {},
      `source: { partials: "../outside" },`,
    );

    await expect(loadConfig(root)).rejects.toThrow(
      /Invalid pluginpack config in .*: source\.partials: must be a safe relative path/,
    );
  });

  it.each([
    ["source.partials", `source: { partials: "https://../../outside" },`, ""],
    [
      "targets.antigravity.plugins.acme.source",
      "",
      `source: "https://../../outside"`,
    ],
  ])(
    "rejects a URL-shaped %s that resolves outside the project",
    async (field, sourceBlock, pluginSource) => {
      const root = await makeProject(
        `    antigravity: {
      outDir: "out",
      plugins: { acme: { ${pluginSource || `source: "shared/acme"`} } }
    }`,
        {},
        sourceBlock,
      );
      // path.resolve reads the value as a plain path with ".." segments.
      expect(path.resolve(root, "https://../../outside")).toBe(
        path.resolve(root, "../outside"),
      );

      await expect(loadConfig(root)).rejects.toThrow(
        `${field}: must be a safe relative path`,
      );
    },
  );
});

describe("the config loader reads the config file fresh each time", () => {
  it.each(["pluginpack.config.ts", "pluginpack.config.mjs"])(
    "builds the edited %s on a second build() in the same process",
    async (name) => {
      const antigravity = `    antigravity: {
      outDir: "out",
      plugins: { acme: { source: "shared/acme" } }
    }`;
      const root = await makeProject(antigravity, {
        "pluginpack.config.ts": null as never,
        [name]: configText(antigravity),
      });
      expect(existsSync(path.join(root, "pluginpack.config.ts"))).toBe(
        name === "pluginpack.config.ts",
      );
      const [first] = await build({ cwd: root });
      expect(first.target).toBe("antigravity");

      await writeFile(
        path.join(root, name),
        configText(antigravity.replace("antigravity", "cursor")),
      );
      const [second] = await build({ cwd: root });

      expect(second.target).toBe("cursor");
    },
  );
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
