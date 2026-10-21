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
  if (ts.isTypeAliasDeclaration(node) && schemaDerivation(node.type)) {
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
    aliases.set(node.name.text, {
      structuralType,
      derivation: schemaDerivation(node.type),
    });
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
const printer = ts.createPrinter();
const namedStructures = new Map();
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
    const alias = aliases.get(node.name.text);
    const derivation = schemaDerivation(node.type);
    if (
      !derivation ||
      derivation.mode !== alias.derivation.mode ||
      derivation.schema !== alias.derivation.schema
    ) {
      throw new Error(
        `${declarationPath}: ${node.name.text} collides with a schema-derived alias. Rename the conflicting type or update declaration generation before publishing.`,
      );
    }
    const transformed = ts.transform(alias.structuralType, [
      (context) => {
        const visit = (child) => {
          if (ts.isTypeLiteralNode(child)) {
            const name = namedStructures.get(structureKey(child));
            if (name) return ts.factory.createTypeReferenceNode(name);
            const visited = ts.visitEachChild(child, visit, context);
            // Checker-created literals carry single-line emit flags. Fresh
            // literals use the printer's readable, multiline form instead.
            return ts.factory.createTypeLiteralNode(visited.members);
          }
          return ts.visitEachChild(child, visit, context);
        };
        return (root) => ts.visitNode(root, visit);
      },
    ]);
    const materialized = transformed.transformed[0];
    transformed.dispose();
    // Only reference aliases already emitted, so generated references cannot
    // create cycles or name a schema alias absent from the public bundle.
    if (ts.isTypeLiteralNode(alias.structuralType)) {
      const key = structureKey(alias.structuralType);
      if (!namedStructures.has(key)) namedStructures.set(key, node.name.text);
    }
    return [
      ts.factory.updateTypeAliasDeclaration(
        node,
        node.modifiers,
        node.name,
        node.typeParameters,
        materialized,
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
const result = printer.printFile(
  ts.factory.updateSourceFile(declaration, statements),
);
if (/\bzod\b|\bz\.(?:core|input|infer|output)\b/.test(result)) {
  throw new Error(
    `${declarationPath} still references Zod; update schema type materialization before publishing.`,
  );
}
// Validate the exact publishable file, not the source program with ambient
// Node types and skipLibCheck enabled. A textual Zod guard cannot catch an
// unqualified implementation helper such as $brand.
const declarationOptions = {
  ...parsed.options,
  types: [],
  skipLibCheck: false,
  noEmit: true,
};
const host = ts.createCompilerHost(declarationOptions);
const read = host.readFile.bind(host);
host.readFile = (file) => (file === declarationPath ? result : read(file));
const declarationProgram = ts.createProgram(
  [declarationPath],
  declarationOptions,
  host,
);
const diagnostics = ts.getPreEmitDiagnostics(declarationProgram);
if (diagnostics.length > 0) {
  throw new Error(
    `Invalid declarations in ${declarationPath}; update schema type materialization before publishing.\n` +
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
  );
}
await writeFile(declarationPath, result);

function structureKey(node) {
  return printer.printNode(ts.EmitHint.Unspecified, node, schema);
}

/** Only aliases directly derived from a schema are eligible for replacement. */
function schemaDerivation(node) {
  if (
    !ts.isTypeReferenceNode(node) ||
    !ts.isQualifiedName(node.typeName) ||
    !ts.isIdentifier(node.typeName.left) ||
    node.typeName.left.text !== "z" ||
    !["input", "infer", "output"].includes(node.typeName.right.text) ||
    node.typeArguments?.length !== 1
  )
    return undefined;
  const argument = node.typeArguments[0];
  if (!ts.isTypeQueryNode(argument) || !ts.isIdentifier(argument.exprName))
    return undefined;
  return { mode: node.typeName.right.text, schema: argument.exprName.text };
}
