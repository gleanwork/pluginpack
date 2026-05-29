# pluginpack

Compile one source tree of agent skills and plugin assets into native plugin formats for AI apps.

`pluginpack` is intentionally boring: it copies files, writes the manifests each target expects, and validates the result. It is a build tool, not a package manager or publisher.

## Why

Agent apps increasingly support similar ideas: skills, commands, agents, rules, hooks, MCP configuration, and plugin marketplaces. The packaging formats are different enough that maintaining one repo per app quickly drifts.

`pluginpack` helps when you want to:

- keep skills and related plugin files in one source repo
- emit installable plugin directories for more than one app
- allow target-specific overrides where portability breaks down
- detect when generated plugin repos are stale

It does not try to make every app behave the same. Target adapters own target-specific layout, manifests, and validation.

## What It Builds

A source plugin can compile into different target shapes. For example, the same `plugins/assistant` source can become:

```txt
dist/cursor/
  .cursor-plugin/marketplace.json
  acme/
    .cursor-plugin/plugin.json
    skills/

dist/claude/
  .claude-plugin/marketplace.json
  plugins/
    acme-assistant/
      .claude-plugin/plugin.json
      skills/

dist/gemini/
  acme-assistant/
    gemini-extension.json
    skills/

dist/copilot/
  .github/
    skills/
```

Those outputs are meant to be checked into or published from target plugin repositories.

## Install

```bash
npm install -D @gleanwork/pluginpack
```

## Source Layout

```txt
plugins/
  assistant/
    plugin.pluginpack.json
    skills/
      release-notes/
        SKILL.md
    agents/
    commands/
    rules/
    hooks/
    assets/
pluginpack.config.ts
```

Each directory under `plugins/` is a source plugin. A target can emit that source plugin directly, rename it, or merge multiple source plugins into one emitted plugin.

## Config

```ts
import { defineConfig } from "@gleanwork/pluginpack";

export default defineConfig({
  name: "acme-plugins",
  version: "0.1.0",
  metadata: {
    description: "Acme agent plugins.",
    author: { name: "Acme" },
    license: "MIT",
  },
  targets: {
    cursor: {
      outDir: "../cursor-plugins",
      plugins: {
        acme: { from: ["assistant"] },
      },
    },
    claude: {
      outDir: "../claude-plugins",
      plugins: {
        "acme-assistant": { from: ["assistant"] },
      },
    },
  },
});
```

## Target Overrides

Skill files are not always perfectly portable. When one app needs different frontmatter or content, add a target override next to the base file:

```txt
plugins/assistant/skills/release-notes/SKILL.md
plugins/assistant/skills/release-notes/targets/cursor/SKILL.md
plugins/assistant/skills/release-notes/targets/claude/SKILL.md
```

Resolution order is target override first, then the base file.

## Current Targets

The first adapters are:

- `cursor`
- `claude`
- `gemini`
- `copilot`

`gemini` emits Gemini CLI extensions with a `gemini-extension.json` manifest. `copilot` emits project skills under `.github/skills`; that is a native skills target, not a plugin marketplace.

More targets should be added from official docs or real plugin examples, not guessed abstractions.

## Why Not Just Copy Files?

For one target, copying files by hand may be enough. `pluginpack` starts to earn its keep when you need deterministic manifests, target-specific overrides, validation, and CI checks across multiple target repos.

## CI Change Detection

`pluginpack diff` is designed for automation. It builds into a temporary directory, compares generated managed files against an existing plugin repo, and exits non-zero when the plugin repo is stale:

```bash
pluginpack diff --target cursor --against ../cursor-plugins
pluginpack diff --target claude --against ../claude-plugins
```

Use that in CI to fail clearly or to trigger an action that opens a PR against the generated plugin repo.

When a generated target repo intentionally owns a path, add `ignoredDiffPaths` to that target config. Entries are target-output-relative paths; a directory entry ignores everything below it.

<!-- pluginpack-cli:start -->

## CLI Reference

### `init`

Create a starter pluginpack.config.ts and source plugin layout.

```bash
pluginpack init [options]
```

Examples:

- `pluginpack init`

Exit codes:

- 0 when files are created
- 1 when files already exist or cannot be written

### `build`

Compile configured source plugins into target-native plugin payloads.

```bash
pluginpack build [--target cursor|claude|gemini|copilot] [--out-dir <path>] [--dry-run]
```

Options:

- `--target <target>`: Build only one configured target.
- `--out-dir <path>`: Override the configured output directory for the selected target.
- `--dry-run`: Resolve and print planned managed output paths without writing files.

Examples:

- `pluginpack build`
- `pluginpack build --target cursor`
- `pluginpack build --target claude --dry-run`

Exit codes:

- 0 when all selected targets build
- 1 when config, source resolution, or file output fails

### `validate`

Validate an existing target output directory for native manifest, path, and frontmatter requirements.

```bash
pluginpack validate --target cursor|claude|gemini|copilot [--dir <path>]
```

Options:

- `--target <target>`: Required target validator.
- `--dir <path>`: Directory to validate. Defaults to the configured target outDir.

Examples:

- `pluginpack validate --target cursor --dir ../cursor-plugins`

Exit codes:

- 0 when validation passes
- 1 when validation finds errors

### `diff`

Build into a temporary directory and compare generated managed files with an existing target repo.

```bash
pluginpack diff --target cursor|claude|gemini|copilot --against <path>
```

Options:

- `--target <target>`: Required target to build and compare.
- `--against <path>`: Existing target repo or output directory to compare against.

Examples:

- `pluginpack diff --target cursor --against ../cursor-plugins`

Exit codes:

- 0 when managed files match
- 1 when managed files differ or the command fails

### `docs`

Generate the README CLI reference section from command metadata.

```bash
pluginpack docs [options]
```

Options:

- `--check`: Fail if README.md is not up to date.

Examples:

- `pluginpack docs`
- `pluginpack docs --check`

Exit codes:

- 0 when docs are current or updated
- 1 when --check finds stale docs
<!-- pluginpack-cli:end -->
