import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { Command } from "commander";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function docsRenderer() {
  // Load the private rendering functions without running the CLI entry point.
  // This keeps CLI-only helpers out of the package's public exports.
  const file = path.resolve(import.meta.dirname, "../src/cli.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    "renderCliReference",
    "commandUsage",
    "commandExamples",
    "commandExitCodes",
  ]);
  const functions = source.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        names.has(node.name.text),
    )
    .map((node) => node.getText(source))
    .join("\n");
  const context = createContext({});
  runInContext(ts.transpileModule(functions, {}).outputText, context);
  const render = runInContext("renderCliReference", context) as (
    program: Command,
  ) => string;
  return { context, render };
}

describe("CLI reference completeness", () => {
  it("fails generation for a new command with no examples", () => {
    const { render } = docsRenderer();
    const program = new Command();
    program.command("preview").description("Preview a package.");
    expect(() => render(program)).toThrow(
      'src/cli.ts: commandExamples is missing examples for command "preview". Add a commandExamples case.',
    );
  });

  it("fails generation when examples exist but exit codes are missing", () => {
    const { context, render } = docsRenderer();
    // Model a new command whose author added examples but forgot exit codes.
    context.commandExamples = () => ["pluginpack preview"];
    const program = new Command();
    program.command("preview").description("Preview a package.");
    expect(() => render(program)).toThrow(
      'src/cli.ts: commandExitCodes is missing exit codes for command "preview". Add a commandExitCodes case.',
    );
  });

  it("documents incomplete metadata as a docs command failure", () => {
    const { render } = docsRenderer();
    const program = new Command();
    program.command("docs").description("Generate the CLI reference.");
    expect(render(program)).toContain(
      "1 when --check finds stale docs or CLI reference metadata is missing",
    );
  });

  it("still renders examples and exit codes for a documented command", () => {
    const { render } = docsRenderer();
    const program = new Command();
    program.command("build").description("Build a package.");
    const reference = render(program);
    expect(reference).toContain("Examples:");
    expect(reference).toContain("pluginpack build --target cursor");
    expect(reference).toContain("Exit codes:");
    expect(reference).toContain("0 when all selected targets build");
  });
});
