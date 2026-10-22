import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function materialize(schema: string, declaration: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pluginpack-materialize-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "dist"));
  await symlink(
    path.resolve("node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        types: [],
      },
    }),
  );
  await writeFile(path.join(root, "src/schema.ts"), schema);
  const declarationPath = path.join(root, "dist/index.d.ts");
  await writeFile(declarationPath, declaration);
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/materialize-config-types.mjs")],
    { cwd: root, encoding: "utf8" },
  );
  return { ...result, declaration: await readFile(declarationPath, "utf8") };
}

describe("config declaration build", () => {
  it("prints multiline config types and reuses matching materialized aliases", async () => {
    const result = await materialize(
      `import { z } from "zod";
const authorSchema = z.object({ name: z.string(), email: z.string().optional() });
const targetSchema = z.object({ author: authorSchema, outDir: z.string() });
const configSchema = z.object({ targets: z.object({ claude: targetSchema.optional(), cursor: targetSchema.optional() }) });
export type Author = z.input<typeof authorSchema>;
export type TargetConfig = z.input<typeof targetSchema>;
export type PluginpackConfig = z.input<typeof configSchema>;
export type ResolvedPluginpackConfig = z.infer<typeof configSchema>;`,
      `import { z } from "zod";
declare const authorSchema: z.ZodType;
declare const targetSchema: z.ZodType;
declare const configSchema: z.ZodType;
type Author = z.input<typeof authorSchema>;
type TargetConfig = z.input<typeof targetSchema>;
type PluginpackConfig = z.input<typeof configSchema>;
type ResolvedPluginpackConfig = z.infer<typeof configSchema>;
export type { Author, TargetConfig, PluginpackConfig, ResolvedPluginpackConfig };`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.declaration).toMatch(/type Author = \{\r?\n/);
    expect(result.declaration).toContain("author: Author;");
    expect(result.declaration).toMatch(/claude\?: TargetConfig \| undefined/);
    expect(result.declaration).toMatch(/cursor\?: TargetConfig \| undefined/);
    expect(result.declaration).toContain(
      "type ResolvedPluginpackConfig = PluginpackConfig;",
    );
  });

  it("typechecks generated declarations and rejects unqualified Zod brand types", async () => {
    const result = await materialize(
      'import { z } from "zod"; const handleSchema = z.string().brand<"Handle">(); export type Handle = z.infer<typeof handleSchema>;',
      'import { z } from "zod"; declare const handleSchema: z.ZodString; type Handle = z.infer<typeof handleSchema>; export type { Handle };',
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("$brand");
    expect(result.stderr).toContain("Cannot find name");
    expect(result.stderr).toContain("dist/index.d.ts");
  });

  it("rejects ambient Node types without relying on consumer tests", async () => {
    const result = await materialize(
      "export {};",
      "export type Bytes = Buffer;",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Buffer");
  });

  it("rejects a schema alias name colliding with an unrelated public type", async () => {
    const result = await materialize(
      'import { z } from "zod"; const authorSchema = z.object({ name: z.string() }); export type InstallParams = z.input<typeof authorSchema>;',
      "export type InstallParams = { target: string; repository: string };",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("InstallParams");
    expect(result.stderr).toContain("schema-derived");
    expect(result.declaration).toContain("target: string");
  });
});
