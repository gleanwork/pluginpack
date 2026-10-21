import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

// Keep the schemas as the only config model. Ask the TypeScript checker for
// their evaluated input/output types instead of shipping Zod's implementation
// types (or maintaining a second, handwritten set of config interfaces).
const configPath = path.resolve("tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
  );
}
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  process.cwd(),
);
const schemaPath = path.resolve("src/schema.ts");
const program = ts.createProgram([schemaPath], parsed.options);
const checker = program.getTypeChecker();
const schema = program.getSourceFile(schemaPath);
if (!schema) throw new Error(`Cannot read schema types from ${schemaPath}`);

const aliases = new Map();
const schemaValues = new Set();
for (const node of schema.statements) {
  if (ts.isTypeAliasDeclaration(node)) {
    const type = checker.getTypeAtLocation(node);
    const structuralType = checker.typeToTypeNode(
      type,
      undefined,
      ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.InTypeAlias,
    );
    if (!structuralType) {
      throw new Error(
        `Cannot materialize schema-derived type ${node.name.text}`,
      );
    }
    aliases.set(node.name.text, structuralType);
  } else if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name))
        schemaValues.add(declaration.name.text);
    }
  }
}

const declarationPath = path.resolve("dist/index.d.ts");
const declaration = ts.createSourceFile(
  declarationPath,
  await readFile(declarationPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const statements = declaration.statements.flatMap((node) => {
  if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "zod") {
    return [];
  }
  if (
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.every(
      (item) => ts.isIdentifier(item.name) && schemaValues.has(item.name.text),
    )
  ) {
    // These schema values were reachable only through the aliases below.
    return [];
  }
  if (ts.isTypeAliasDeclaration(node) && aliases.has(node.name.text)) {
    return [
      ts.factory.updateTypeAliasDeclaration(
        node,
        node.modifiers,
        node.name,
        node.typeParameters,
        aliases.get(node.name.text),
      ),
    ];
  }
  if (
    ts.isExportDeclaration(node) &&
    node.exportClause &&
    ts.isNamedExports(node.exportClause)
  ) {
    for (const exported of node.exportClause.elements) {
      if (schemaValues.has((exported.propertyName ?? exported.name).text)) {
        throw new Error(
          "Schema values are not public API. Update declaration generation before exporting one.",
        );
      }
    }
  }
  return [node];
});
const result = ts
  .createPrinter()
  .printFile(ts.factory.updateSourceFile(declaration, statements));
if (/\bzod\b|\bz\.(?:core|input|infer|output)\b/.test(result)) {
  throw new Error(
    `${declarationPath} still references Zod; update schema type materialization before publishing.`,
  );
}
await writeFile(declarationPath, result);
