import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import { build } from "./build.js";
import { loadConfig } from "./config.js";
import { diffTarget } from "./diff.js";
import { validateOutput } from "./validate.js";
import type { TargetName } from "./types.js";

const targets = ["cursor", "claude", "gemini", "copilot"] as const;

async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

function createProgram(): Command {
  const program = new Command();

  program
    .name("pluginpack")
    .description(
      "Compile portable agent skills and plugin capabilities into native AI app plugin formats.",
    )
    .version(readPackageVersion());

  program
    .command("init")
    .description(
      "Create a starter pluginpack.config.ts and source plugin layout.",
    )
    .action(init);

  program
    .command("build")
    .description(
      "Compile configured source plugins into target-native plugin payloads.",
    )
    .usage(
      "[--target cursor|claude|gemini|copilot] [--out-dir <path>] [--dry-run]",
    )
    .addOption(
      new Option(
        "--target <target>",
        "Build only one configured target.",
      ).choices([...targets]),
    )
    .option(
      "--out-dir <path>",
      "Override the configured output directory for the selected target.",
    )
    .option(
      "--dry-run",
      "Resolve and print planned managed output paths without writing files.",
    )
    .action(
      async (options: {
        target?: TargetName;
        outDir?: string;
        dryRun?: boolean;
      }) => {
        const artifacts = await build({
          target: options.target,
          outDir: options.outDir,
          dryRun: options.dryRun,
        });
        for (const artifact of artifacts) {
          console.log(
            `${options.dryRun ? "Would write" : "Wrote"} ${artifact.managedPaths.length} managed files for ${artifact.target} -> ${artifact.outDir}`,
          );
          if (options.dryRun) {
            for (const managedPath of artifact.managedPaths) {
              console.log(`  ${managedPath}`);
            }
          }
        }
      },
    );

  program
    .command("validate")
    .description(
      "Validate an existing target output directory for native manifest, path, and frontmatter requirements.",
    )
    .usage("--target cursor|claude|gemini|copilot [--dir <path>]")
    .requiredOption(
      "--target <target>",
      "Required target validator.",
      parseTarget,
    )
    .option(
      "--dir <path>",
      "Directory to validate. Defaults to the configured target outDir.",
    )
    .action(async (options: { target: TargetName; dir?: string }) => {
      let dir = options.dir;
      if (!dir) {
        const project = await loadConfig();
        const targetConfig = project.config.targets[options.target];
        if (!targetConfig) {
          throw new Error(`Target "${options.target}" is not configured.`);
        }
        dir = targetConfig.outDir;
      }
      const result = await validateOutput(options.target, dir);
      for (const issue of result.issues) {
        const stream = issue.level === "error" ? console.error : console.warn;
        stream(`${issue.level}: ${issue.message}`);
      }
      if (!result.ok) {
        process.exitCode = 1;
        return;
      }
      console.log("Validation passed.");
    });

  program
    .command("diff")
    .description(
      "Build into a temporary directory and compare generated managed files with an existing target repo.",
    )
    .usage("--target cursor|claude|gemini|copilot --against <path>")
    .requiredOption(
      "--target <target>",
      "Required target to build and compare.",
      parseTarget,
    )
    .requiredOption(
      "--against <path>",
      "Existing target repo or output directory to compare against.",
    )
    .action(async (options: { target: TargetName; against: string }) => {
      const result = await diffTarget({
        target: options.target,
        against: options.against,
      });
      if (result.ok) {
        console.log("Managed files match.");
        return;
      }
      console.log("Managed files differ:");
      for (const entry of result.entries) {
        console.log(`  ${entry.type.padEnd(7)} ${entry.path}`);
      }
      process.exitCode = 1;
    });

  program
    .command("docs")
    .description(
      "Generate the README CLI reference section from command metadata.",
    )
    .option("--check", "Fail if README.md is not up to date.")
    .action(async (options: { check?: boolean }) => {
      const readmePath = path.resolve("README.md");
      const current = await fs.readFile(readmePath, "utf8");
      const next = replaceGeneratedSection(
        current,
        renderCliReference(program),
      );
      if (options.check) {
        if (next !== current) {
          console.error(
            "README.md CLI reference is out of date. Run pluginpack docs.",
          );
          process.exitCode = 1;
        } else {
          console.log("README.md CLI reference is up to date.");
        }
        return;
      }
      await fs.writeFile(readmePath, next);
      console.log("Updated README.md CLI reference.");
    });

  return program;
}

async function init(): Promise<void> {
  const configPath = path.resolve("pluginpack.config.ts");
  if (await exists(configPath)) {
    throw new Error("pluginpack.config.ts already exists.");
  }
  await fs.mkdir(path.resolve("plugins", "example", "skills", "example"), {
    recursive: true,
  });
  await fs.writeFile(configPath, starterConfig());
  await fs.writeFile(
    path.resolve("plugins", "example", "plugin.pluginpack.json"),
    `${JSON.stringify(
      {
        description: "Example plugin generated by pluginpack init",
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.resolve("plugins", "example", "skills", "example", "SKILL.md"),
    starterSkill(),
  );
  console.log("Created pluginpack.config.ts and plugins/example.");
}

function parseTarget(value: string): TargetName {
  if (
    value !== "cursor" &&
    value !== "claude" &&
    value !== "gemini" &&
    value !== "copilot"
  ) {
    throw new Error("Expected cursor, claude, gemini, or copilot.");
  }
  return value;
}

function replaceGeneratedSection(readme: string, content: string): string {
  const start = "<!-- pluginpack-cli:start -->";
  const end = "<!-- pluginpack-cli:end -->";
  const startIndex = readme.indexOf(start);
  const endIndex = readme.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error("README.md is missing pluginpack CLI marker comments.");
  }
  return `${readme.slice(0, startIndex + start.length)}\n\n${content}\n${readme.slice(endIndex)}`;
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json is missing a string version.");
  }
  return packageJson.version;
}

function renderCliReference(program: Command): string {
  const lines = ["## CLI Reference", ""];
  for (const command of program.commands) {
    if (command.name() === "help") {
      continue;
    }
    lines.push(
      `### \`${command.name()}\``,
      "",
      command.description(),
      "",
      "```bash",
      commandUsage(command),
      "```",
      "",
    );
    const visibleOptions = command.options.filter(
      (option) => option.flags !== "-h, --help",
    );
    if (visibleOptions.length > 0) {
      lines.push("Options:", "");
      for (const option of visibleOptions) {
        lines.push(`- \`${option.flags}\`: ${option.description}`);
      }
      lines.push("");
    }
    const examples = commandExamples(command.name());
    if (examples.length > 0) {
      lines.push("Examples:", "");
      for (const example of examples) {
        lines.push(`- \`${example}\``);
      }
      lines.push("");
    }
    const exitCodes = commandExitCodes(command.name());
    if (exitCodes.length > 0) {
      lines.push("Exit codes:", "");
      for (const exitCode of exitCodes) {
        lines.push(`- ${exitCode}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

function commandUsage(command: Command): string {
  const usage = command.usage();
  return usage
    ? `pluginpack ${command.name()} ${usage}`
    : `pluginpack ${command.name()}`;
}

function commandExamples(commandName: string): string[] {
  switch (commandName) {
    case "init":
      return ["pluginpack init"];
    case "build":
      return [
        "pluginpack build",
        "pluginpack build --target cursor",
        "pluginpack build --target claude --dry-run",
      ];
    case "validate":
      return ["pluginpack validate --target cursor --dir ../cursor-plugins"];
    case "diff":
      return ["pluginpack diff --target cursor --against ../cursor-plugins"];
    case "docs":
      return ["pluginpack docs", "pluginpack docs --check"];
    default:
      return [];
  }
}

function commandExitCodes(commandName: string): string[] {
  switch (commandName) {
    case "init":
      return [
        "0 when files are created",
        "1 when files already exist or cannot be written",
      ];
    case "build":
      return [
        "0 when all selected targets build",
        "1 when config, source resolution, or file output fails",
      ];
    case "validate":
      return ["0 when validation passes", "1 when validation finds errors"];
    case "diff":
      return [
        "0 when managed files match",
        "1 when managed files differ or the command fails",
      ];
    case "docs":
      return [
        "0 when docs are current or updated",
        "1 when --check finds stale docs",
      ];
    default:
      return [];
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function starterConfig(): string {
  return `import { defineConfig } from "@gleanwork/pluginpack";

export default defineConfig({
  name: "example-plugins",
  version: "0.1.0",
  metadata: {
    description: "Example pluginpack plugin marketplace",
    author: { name: "Example" },
    license: "MIT"
  },
  targets: {
    cursor: {
      outDir: "dist/cursor",
      plugins: {
        example: { from: ["example"] }
      }
    },
    claude: {
      outDir: "dist/claude",
      plugins: {
        example: { from: ["example"] }
      }
    },
    gemini: {
      outDir: "dist/gemini",
      plugins: {
        example: { from: ["example"] }
      }
    },
    copilot: {
      outDir: "dist/copilot",
      plugins: {
        example: { from: ["example"] }
      }
    }
  }
});
`;
}

function starterSkill(): string {
  return `---
name: example
description: Example skill generated by pluginpack init.
---

# Example

Use this skill as a starting point.
`;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
