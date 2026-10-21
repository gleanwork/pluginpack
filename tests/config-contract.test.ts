import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, diffTarget, loadConfig, prune } from "../src/index.js";
import { loadProjectConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function configProject(config: unknown): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pluginpack-config-contract-"),
  );
  temporaryDirectories.push(root);
  await writeFile(
    path.join(root, "pluginpack.config.mjs"),
    `export default ${JSON.stringify(config)};\n`,
  );
  return root;
}

describe("config contract", () => {
  it("keeps authoring input optional when the schema gains a default", async () => {
    const schemaPath = path.resolve("src/schema.ts");
    const original = await readFile(schemaPath, "utf8");
    // Mutate only the compiler's virtual source, not the real schema. This
    // models an additive minor release and exercises the real defineConfig.
    const changed = original.replace(
      "version: z.string().min(1),",
      'version: z.string().min(1), futureDefault: z.string().default("value"),',
    );
    expect(changed).not.toBe(original);
    const consumer = path.resolve("tests/virtual-default-consumer.mts");
    const code = `
import { defineConfig } from "../src/config.js";
import { configSchema } from "../src/schema.js";
import type { PluginpackConfig, ResolvedPluginpackConfig } from "../src/index.js";
const beforeDefault = { name: "demo", version: "1.0.0", targets: {} };
const authored: PluginpackConfig = beforeDefault;
defineConfig(authored);
defineConfig(beforeDefault);
const resolved: ResolvedPluginpackConfig = configSchema.parse(beforeDefault);
const defaultIsPresent: string = resolved.futureDefault;
// @ts-expect-error A parsed config must contain the defaulted output field.
const invalidResolved: ResolvedPluginpackConfig = beforeDefault;
void defaultIsPresent; void invalidResolved;
`;
    const config = ts.readConfigFile(
      path.resolve("tsconfig.json"),
      ts.sys.readFile,
    );
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      process.cwd(),
    );
    const host = ts.createCompilerHost(parsed.options);
    const read = host.readFile.bind(host);
    host.readFile = (file) =>
      file === schemaPath ? changed : file === consumer ? code : read(file);
    const program = ts.createProgram(
      [consumer],
      { ...parsed.options, noEmit: true },
      host,
    );
    expect(
      ts
        .getPreEmitDiagnostics(program)
        // This probe checks authoring and schema types. The full typecheck
        // separately checks runtime implementations reached by src/index.ts.
        .filter(
          (diagnostic) =>
            !diagnostic.file ||
            [
              consumer,
              schemaPath,
              path.resolve("src/config.ts"),
              path.resolve("src/types.ts"),
            ].includes(diagnostic.file.fileName),
        )
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ),
    ).toEqual([]);
  });

  it("warns with the file and dotted paths for stripped keys, including nested records", async () => {
    const root = await configProject({
      name: "demo",
      version: "1.0.0",
      targetss: {},
      targets: {
        codxe: { outDir: "unused", plugins: {} },
        cursor: {
          outDir: "out",
          plugins: {
            demo: { source: "shared/demo", component: ["skills"] },
          },
        },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await loadProjectConfig(root);
    expect(loaded.config.targets.cursor?.plugins.demo).not.toHaveProperty(
      "component",
    );
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("targetss"),
      expect.stringContaining("targets.codxe"),
      expect.stringContaining("targets.cursor.plugins.demo.component"),
    ]);
    for (const [message] of warn.mock.calls) {
      expect(message).toContain(path.join(root, "pluginpack.config.mjs"));
      expect(message).toMatch(/ignored/i);
      expect(message).toMatch(/remove|supported/i);
    }
  });

  it("warns on client setting typos but not manifest or entry passthrough data", async () => {
    const root = await configProject({
      name: "demo",
      version: "1.0.0",
      targets: {
        cursor: {
          outDir: "cursor",
          manifest: { custom: { anything: true } },
          plugins: {
            demo: {
              source: "shared/demo",
              manifest: { custom: true },
              entry: { policy: { future: true } },
            },
          },
        },
        "agent-plugins": {
          outDir: "packages",
          clients: {
            copilot: { manfiest: {}, manifest: { custom: { anything: true } } },
          },
          plugins: {
            demo: {
              source: "shared/demo",
              clients: { copilot: { entry: { custom: { anything: true } } } },
            },
          },
        },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await loadProjectConfig(root);
    expect(loaded.config.targets.cursor?.manifest).toEqual({
      custom: { anything: true },
    });
    expect(warn.mock.calls).toEqual([
      [
        expect.stringContaining(
          "targets.agent-plugins.clients.copilot.manfiest",
        ),
      ],
    ]);
  });

  it.each(["prune", "diff"] as const)(
    "%s warns once per config path and key even when the config loads twice",
    async (command) => {
      const root = await configProject({
        name: "demo",
        version: "1.0.0",
        versoin: "typo",
        targets: {
          cursor: {
            outDir: "out",
            plugins: { demo: { source: "shared/demo", include: [] } },
          },
        },
      });
      await mkdir(path.join(root, "shared/demo"), { recursive: true });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      if (command === "prune") {
        await prune({ cwd: root, dryRun: true });
      } else {
        await diffTarget({ cwd: root, target: "cursor", against: "out" });
      }
      // A fresh loader must not repeat the diagnostic, even without jiti caching.
      await loadProjectConfig(root);
      expect(warn.mock.calls).toEqual([
        [expect.stringContaining('Unknown config key "versoin"')],
      ]);
      expect(warn.mock.calls[0][0]).toContain(
        path.join(root, "pluginpack.config.mjs"),
      );
    },
  );

  it.each(["legacy", "canonical"] as const)(
    "labels unknown keys in %s source manifests as manifest warnings",
    async (layout) => {
      const sourceDir = layout === "legacy" ? "plugins/demo" : "shared/demo";
      const root = await configProject({
        name: "demo",
        version: "1.0.0",
        targets:
          layout === "legacy"
            ? {}
            : {
                cursor: {
                  outDir: "out",
                  plugins: { demo: { source: sourceDir, include: [] } },
                },
              },
      });
      await mkdir(path.join(root, sourceDir), { recursive: true });
      const manifestPath = path.join(root, sourceDir, "plugin.pluginpack.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          name: "demo",
          descripton: "typo",
          author: { name: "Demo", emali: "typo" },
          mcpServers: { future: { custom: true } },
        }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (let i = 0; i < 2; i++) {
        if (layout === "legacy") await loadConfig(root);
        else await build({ cwd: root, dryRun: true });
      }
      expect(warn.mock.calls).toEqual([
        [expect.stringContaining('Unknown manifest key "descripton"')],
        [expect.stringContaining('Unknown manifest key "author.emali"')],
      ]);
      for (const [message] of warn.mock.calls) {
        expect(message).toContain(manifestPath);
        expect(message).toContain("supported manifest field");
      }
    },
  );

  it("uses the same code-unit ordering for artifact files and managed paths", async () => {
    const plugins = Object.fromEntries(
      ["a-b", "A-tool", "_shared"].map((name) => [
        name,
        { source: "shared/demo", include: [] },
      ]),
    );
    const root = await configProject({
      name: "demo",
      version: "1.0.0",
      targets: { cursor: { outDir: "out", plugins } },
    });
    await mkdir(path.join(root, "shared/demo"), { recursive: true });
    await writeFile(
      path.join(root, "shared/demo/plugin.pluginpack.json"),
      "{}",
    );
    const [artifact] = await build({ cwd: root, dryRun: true });
    expect([...artifact.files.keys()]).toEqual(artifact.managedPaths);
    expect(artifact.managedPaths).toEqual([...artifact.managedPaths].sort());
  });
});
