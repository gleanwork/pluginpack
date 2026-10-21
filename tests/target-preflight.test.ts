import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { Project, type ProjectArgs } from "fixturify-project";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "../src/build.js";
import { validateOutput } from "../src/adapters.js";
import type { TargetName } from "../src/types.js";

type DirJSON = NonNullable<ProjectArgs["files"]>;
let project: Project | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await project?.dispose();
  project = undefined;
});

const SKILL =
  "---\nname: search\ndescription: Search documents.\n---\n# Search\n";
const ENTRY =
  'entry: { policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }';

async function setup(targets: string, source: DirJSON = {}): Promise<string> {
  project = new Project("target-preflight", "1.0.0", {
    files: {
      "pluginpack.config.ts": `export default {
        name: "acme-plugins", version: "1.0.0",
        metadata: { description: "Acme plugins.", author: { name: "Acme" } },
        targets: { ${targets} }
      };`,
      shared: {
        acme: { skills: { search: { "SKILL.md": SKILL } }, ...source },
      },
    },
  });
  await project.write();
  return project.baseDir;
}

describe("target build and validation agree", () => {
  it("does not point Copilot at a nonexistent hooks/hooks.json", async () => {
    const root = await setup(
      'copilot: { outDir: "out", plugins: { acme: { source: "shared/acme" } } }',
      {
        hooks: { "before-run.sh": "#!/bin/sh\necho ready\n" },
      },
    );
    await build({ cwd: root });
    const manifest = JSON.parse(
      await readFile(path.join(root, "out/plugins/acme/plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("hooks");
    await expect(
      validateOutput("copilot", path.join(root, "out")),
    ).resolves.toEqual({ ok: true, issues: [] });
  });

  it.each<TargetName>(["claude", "cursor"])(
    "validates %s output with a custom marketplaceDir",
    async (target) => {
      const root = await setup(
        `${target}: { outDir: "out", marketplaceDir: "catalog/native", plugins: { acme: { source: "shared/acme" } } }`,
      );
      await build({ cwd: root });
      await expect(
        validateOutput(target, path.join(root, "out")),
      ).resolves.toEqual({ ok: true, issues: [] });
    },
  );

  it.each(["claude", "cursor"] as const)(
    "uses the managed %s marketplace pair rather than an unrelated root file",
    async (target) => {
      const defaultDir =
        target === "claude" ? ".claude-plugin" : ".cursor-plugin";
      const root = await setup(
        `${target}: { outDir: "out", marketplaceDir: "catalog/native", rootFiles: { "${defaultDir}/marketplace.json": "unrelated.json" }, plugins: { acme: { source: "shared/acme" } } }`,
      );
      await writeFile(path.join(root, "unrelated.json"), "{}\n");
      await build({ cwd: root });
      await expect(
        validateOutput(target, path.join(root, "out")),
      ).resolves.toEqual({ ok: true, issues: [] });
    },
  );

  it.each<TargetName>([
    "claude",
    "cursor",
    "copilot",
    "antigravity",
    "codex",
    "agent-plugins",
  ])(
    "rejects two %s plugins writing the same output path before writing anything",
    async (target) => {
      const root =
        await setup(`${JSON.stringify(target)}: { outDir: "out", plugins: {
      first: { source: "shared/acme", path: "plugins/common", ${target === "codex" ? ENTRY : ""} },
      second: { source: "shared/acme", path: "plugins/common", ${target === "codex" ? ENTRY : ""} }
    } }`);
      await expect(build({ cwd: root })).rejects.toThrow(
        /first.*second.*plugins\/common/,
      );
      await expect(access(path.join(root, "out"))).rejects.toThrow();
      await expect(
        readFile(path.join(root, "shared/acme/skills/search/SKILL.md"), "utf8"),
      ).resolves.toBe(SKILL);
    },
  );

  it("rejects a plugin file colliding with another plugin's generated manifest", async () => {
    const root = await setup(
      'claude: { outDir: "out", plugins: { first: { source: "shared/acme", path: "common" }, second: { source: "shared/acme", path: "common/nested" } } }',
      {
        "plugin.pluginpack.json": JSON.stringify({
          additionalFiles: {
            "nested/.claude-plugin/plugin.json": "extra.json",
          },
        }),
        "extra.json": "{}\n",
      },
    );
    await expect(build({ cwd: root })).rejects.toThrow(
      /first.*second.*common\/nested\/\.claude-plugin\/plugin.json/,
    );
  });

  it("does not let a source file overwrite a generated marketplace", async () => {
    const root = await setup(
      'claude: { outDir: "out", plugins: { acme: { source: "shared/acme", path: "." } } }',
      {
        "plugin.pluginpack.json": JSON.stringify({
          additionalFiles: { ".claude-plugin/marketplace.json": "extra.json" },
        }),
        "extra.json": "{}\n",
      },
    );
    await expect(build({ cwd: root })).rejects.toThrow(
      /marketplace.json.*collid|collid.*marketplace.json/,
    );
  });

  it.each(["codex", "agent-plugins"] as const)(
    "reports missing Codex entry fields during %s build",
    async (target) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const root = await setup(
        `${JSON.stringify(target)}: { outDir: "out", ${target === "agent-plugins" ? "clients: { codex: {} }," : ""} plugins: { acme: { source: "shared/acme" } } }`,
      );
      await build({ cwd: root });
      const messages = warn.mock.calls.flat().join("\n");
      expect(messages).toContain("pluginpack.config.ts");
      expect(messages).toContain("policy.installation");
      expect(messages).toContain("policy.authentication");
      expect(messages).toContain("category");
      expect(messages).toContain(
        target === "codex"
          ? "plugins.acme.entry"
          : "plugins.acme.clients.codex.entry",
      );
    },
  );

  it.each(["codex", "agent-plugins"] as const)(
    "checks snake_case skill names during %s build",
    async (target) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const root = await setup(
        `${JSON.stringify(target)}: { outDir: "out", plugins: { acme: { source: "shared/acme", ${target === "codex" ? ENTRY : ""} } } }`,
        {
          skills: {
            snake_case: {
              "SKILL.md": SKILL.replace("name: search", "name: snake_case"),
            },
          },
        },
      );
      await build({ cwd: root });
      expect(warn.mock.calls.flat().join("\n")).toMatch(
        /skills\/snake_case\/SKILL.md.*name.*hyphens/,
      );
    },
  );

  it("does not warn when merged Codex entry fields are supplied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await setup(
      `"agent-plugins": { outDir: "out", clients: { codex: {} }, plugins: { acme: { source: "shared/acme", clients: { codex: { ${ENTRY} } } } } }`,
    );
    await build({ cwd: root });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports hooks omitted when moving to agent-plugins with clients.codex", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await setup(
      `"agent-plugins": { outDir: "out", clients: { codex: {} }, plugins: { acme: { source: "shared/acme", clients: { codex: { ${ENTRY} } } } } }`,
      {
        hooks: { "hooks.json": '{ "hooks": {} }\n' },
      },
    );
    await build({ cwd: root });
    expect(warn.mock.calls.flat().join("\n")).toMatch(
      /shared\/acme\/hooks.*not.*ship|shared\/acme\/hooks.*omit/,
    );
    await expect(
      access(path.join(root, "out/plugins/acme/hooks/hooks.json")),
    ).rejects.toThrow();
  });

  it("does not warn when hooks are explicitly excluded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await setup(
      `"agent-plugins": { outDir: "out", clients: { codex: {} }, plugins: { acme: { source: "shared/acme", exclude: ["hooks"], clients: { codex: { ${ENTRY} } } } } }`,
      { hooks: { "hooks.json": '{ "hooks": {} }\n' } },
    );
    await build({ cwd: root });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports omitted hooks in overrides too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await setup(
      `"agent-plugins": { outDir: "out", clients: { codex: {} }, plugins: { acme: { source: "shared/acme", overrides: "overrides/acme", clients: { codex: { ${ENTRY} } } } } }`,
    );
    await mkdir(path.join(root, "overrides/acme/hooks"), { recursive: true });
    await writeFile(
      path.join(root, "overrides/acme/hooks/hooks.json"),
      '{ "hooks": {} }\n',
    );
    await build({ cwd: root });
    expect(warn.mock.calls.flat().join("\n")).toContain("overrides/acme/hooks");
  });
});
