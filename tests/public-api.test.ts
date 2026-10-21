import { Buffer } from "node:buffer";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { FileValue } from "../src/index.js";

const expectedRuntimeExports = [
  "build",
  "buildInstallSnippet",
  "clean",
  "defineConfig",
  "diffTarget",
  "getInstallSnippetCitation",
  "getSupportedInstallTargets",
  "getUnsupportedInstallTargets",
  "loadConfig",
  "prune",
  "validateOutput",
];

describe("public API contract", () => {
  it("pins the source and built runtime export lists", async () => {
    expect(Object.keys(await import("../src/index.js")).sort()).toEqual(
      expectedRuntimeExports,
    );
    const built = await import(path.resolve("dist/index.js"));
    expect(Object.keys(built).sort()).toEqual(expectedRuntimeExports);
  });

  it("publishes structural config declarations without a Zod dependency", async () => {
    const declaration = await readFile("dist/index.d.ts", "utf8");
    expect(declaration).not.toMatch(/\bzod\b|\bz\.core\b/);
  });

  it("preserves schema-derived public types when materializing declarations", () => {
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(path.resolve("tsconfig.json"), ts.sys.readFile).config,
      ts.sys,
      process.cwd(),
    );
    const sourcePath = path.resolve("src/schema.ts");
    const builtPath = path.resolve("dist/index.d.ts");
    const program = ts.createProgram([sourcePath, builtPath], parsed.options);
    const checker = program.getTypeChecker();
    const moduleTypes = (file: string) => {
      const source = program.getSourceFile(file);
      const module = source && checker.getSymbolAtLocation(source);
      if (!module) throw new Error(`Cannot read exported types in ${file}`);
      return new Map(
        checker.getExportsOfModule(module).map((symbol) => {
          const resolved =
            symbol.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(symbol)
              : symbol;
          return [symbol.name, checker.getDeclaredTypeOfSymbol(resolved)];
        }),
      );
    };
    const sourceTypes = moduleTypes(sourcePath);
    const builtTypes = moduleTypes(builtPath);
    for (const [name, sourceType] of sourceTypes) {
      const builtType = builtTypes.get(name);
      if (!builtType) continue; // Some schemas are internal, not public API.
      expect(builtType.flags & ts.TypeFlags.Any, name).toBe(0);
      expect(checker.isTypeAssignableTo(sourceType, builtType), name).toBe(
        true,
      );
      expect(checker.isTypeAssignableTo(builtType, sourceType), name).toBe(
        true,
      );
    }
  });

  it("publishes byte-array types without an ambient Buffer dependency", async () => {
    const declaration = await readFile("dist/index.d.ts", "utf8");
    expect(declaration).not.toContain("Buffer");
    expectTypeOf<Buffer>().toExtend<FileValue>();
    const file: FileValue = Buffer.from([65]);
    expect(file[0]).toBe(65);
  });

  it("documents Artifact file values and explicit UTF-8 decoding", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain(
      "`Artifact.files` values are `string | Uint8Array`",
    );
    expect(readme).toContain('`Buffer.from(value).toString("utf8")`');
  });

  it("marks the reachable source-provider state as unstable", async () => {
    const declaration = await readFile("dist/index.d.ts", "utf8");
    expect(declaration).not.toContain("Deliberately not exported");
    const source = ts.createSourceFile(
      "index.d.ts",
      declaration,
      ts.ScriptTarget.Latest,
      true,
    );
    const project = source.statements.find(
      (node): node is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(node) && node.name.text === "ResolvedProject",
    );
    expect(project && ts.isTypeLiteralNode(project.type)).toBe(true);
    if (!project || !ts.isTypeLiteralNode(project.type))
      throw new Error("ResolvedProject must expose its annotated state");
    const provider = project.type.members.find(
      (member) => member.name?.getText(source) === "source",
    );
    expect(
      provider && ts.getJSDocTags(provider).map((tag) => tag.tagName.text),
    ).toContain("unstable");
  });

  it.each(["no Zod", "hoisted Zod 3"])(
    "imports every public type with skipLibCheck false, no ambient types, and %s",
    async (dependency) => {
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "pluginpack-public-api-")),
      );
      try {
        const packageDir = path.join(
          root,
          "node_modules/@gleanwork/pluginpack",
        );
        await mkdir(packageDir, { recursive: true });
        await writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ type: "module" }),
        );
        await writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({
            name: "@gleanwork/pluginpack",
            type: "module",
            exports: { ".": { types: "./index.d.ts" } },
          }),
        );
        await writeFile(
          path.join(packageDir, "index.d.ts"),
          await readFile("dist/index.d.ts"),
        );
        const consumer = path.join(root, "consumer.ts");
        let code = await readFile(
          "tests/fixtures/public-api/consumer.txt",
          "utf8",
        );
        if (dependency === "hoisted Zod 3") {
          // Zod ships its genuine v3 implementation alongside v4. Copy only v3
          // into the fixture's one hoisted dependency, with no nested v4.
          await cp(
            path.resolve("node_modules/zod/v3"),
            path.join(root, "node_modules/zod"),
            { recursive: true },
          );
          code +=
            '\nimport { z } from "zod";\nexport const legacySchema: z.ZodString = z.string();\n';
        }
        await writeFile(consumer, code);
        const program = ts.createProgram([consumer], {
          target: ts.ScriptTarget.ES2022,
          lib: ["lib.es2022.d.ts"],
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          types: [],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        });
        const checker = program.getTypeChecker();
        const declaration = program.getSourceFile(
          path.join(packageDir, "index.d.ts"),
        );
        const source = program.getSourceFile(consumer);
        if (!declaration || !source)
          throw new Error("Consumer and package declarations must resolve");
        const module = checker.getSymbolAtLocation(declaration);
        if (!module) throw new Error("Package declarations must form a module");
        const exportedTypes = checker
          .getExportsOfModule(module)
          .filter((symbol) => {
            const resolved =
              symbol.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(symbol)
                : symbol;
            return Boolean(resolved.flags & ts.SymbolFlags.Type);
          })
          .map((symbol) => symbol.name)
          .sort();
        const importedTypes = source.statements
          .flatMap((node) => {
            if (!ts.isImportDeclaration(node) || !node.importClause?.isTypeOnly)
              return [];
            const bindings = node.importClause.namedBindings;
            return bindings && ts.isNamedImports(bindings)
              ? bindings.elements.map((element) => element.name.text)
              : [];
          })
          .sort();
        expect(importedTypes).toEqual(exportedTypes);
        expect(
          ts
            .getPreEmitDiagnostics(program)
            .map((diagnostic) =>
              ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
            ),
        ).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
