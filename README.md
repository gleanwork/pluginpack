# pluginpack

One source of truth for agent plugins across AI app ecosystems.

`pluginpack` compiles portable skills, commands, agents, rules, hooks, assets, and metadata into the native plugin layouts expected by each AI app.

`pluginpack` is intentionally boring: it copies files, writes the manifests each target expects, and validates the result. It is a build tool, not a package manager or publisher.

## Why

Agent apps increasingly support similar ideas: skills, commands, agents, rules, hooks, MCP configuration, and plugin marketplaces. The packaging formats are different enough that maintaining one repo per app quickly drifts.

`pluginpack` helps when you want to:

- keep skills and related plugin files in one source repo
- emit installable plugin directories for more than one app
- allow target-specific overrides where portability breaks down
- detect when generated plugin repos are stale

It does not try to make every app behave the same. Target adapters own target-specific layout, manifests, and validation.

## Recommended Shape

The preferred path is one public plugin repository with a top-level `skills/` directory as the portable install surface, plus generated native plugin outputs in the same repo.

```txt
skills/
  release-notes/
    SKILL.md
pluginpack.config.ts

.cursor-plugin/
  marketplace.json
plugins/
  cursor/
    acme/
      .cursor-plugin/plugin.json
      skills/
  claude/
    acme/
      .claude-plugin/plugin.json
      skills/
  gemini/
    .pluginpack/
      gemini.json
    acme/
      gemini-extension.json
      skills/
.claude-plugin/
  marketplace.json
.github/
  skills/
.pluginpack/
  cursor.json
  claude.json
  copilot.json
```

Users can install the portable skills with `npx skills add owner/repo --skill release-notes`. Claude, Cursor, and other native plugin users install from the generated marketplace/plugin layout their app expects.

`pluginpack` writes a `.pluginpack/<target>.json` managed-file manifest for each built target. That manifest lets builds and cleanup commands remove stale generated files without touching source files or unmanaged repo content.

## Install

```bash
npm install -D @gleanwork/pluginpack
```

## Config

```ts
import { defineConfig } from "@gleanwork/pluginpack";

export default defineConfig({
  name: "acme-plugins",
  version: "0.1.0",
  source: {
    skills: "skills",
    rootPlugin: {
      id: "core",
      description: "Acme portable skills.",
    },
  },
  metadata: {
    description: "Acme agent plugins.",
    author: { name: "Acme" },
    license: "MIT",
  },
  targets: {
    cursor: {
      outDir: ".",
      plugins: {
        acme: {
          from: ["core"],
          path: "plugins/cursor/acme",
          components: ["skills"],
        },
      },
    },
    claude: {
      outDir: ".",
      pluginRoot: "plugins/claude",
      plugins: {
        acme: { from: ["core"] },
      },
    },
    gemini: {
      outDir: "plugins/gemini",
      plugins: {
        acme: { from: ["core"] },
      },
    },
    copilot: {
      outDir: ".",
      plugins: {
        acme: { from: ["core"] },
      },
    },
  },
});
```

`source.skills` points at the repo-level skills directory. `source.rootPlugin.id` creates the source plugin name used by each target's `from` array.

## Other Shapes

For more complex source content, keep source plugins under `plugins/` and emit them into one or more target outputs:

```txt
plugins/
  core/
    plugin.pluginpack.json
    skills/
      release-notes/
        SKILL.md
    agents/
    commands/
    rules/
    hooks/
    assets/
```

A target can emit a source plugin directly, rename it, or merge multiple source plugins into one emitted plugin.

There are two reasonable alternatives when the single-repo shape is not enough:

- Single source repo, multiple output repos: best when each target ecosystem expects its own repo root shape.
- Single source repo, release artifacts: best when users install zipped plugin payloads or release assets instead of browsing generated files in Git.

## Target Overrides

Skill files are not always perfectly portable. When one app needs different frontmatter or content, add a target override next to the base file:

```txt
skills/release-notes/SKILL.md
skills/release-notes/targets/cursor/SKILL.md
skills/release-notes/targets/claude/SKILL.md
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

### `prune`

Remove stale managed files that are no longer emitted by the current config.

```bash
pluginpack prune [--target cursor|claude|gemini|copilot] [--dry-run]
```

Options:

- `--target <target>`: Prune only one configured target.
- `--dry-run`: Print stale managed files without deleting them.

Examples:

- `pluginpack prune`
- `pluginpack prune --target claude --dry-run`

Exit codes:

- 0 when stale managed files are removed or listed
- 1 when config, source resolution, or cleanup fails

### `clean`

Remove all managed files for configured target outputs.

```bash
pluginpack clean [--target cursor|claude|gemini|copilot] [--dry-run]
```

Options:

- `--target <target>`: Clean only one configured target.
- `--dry-run`: Print managed files without deleting them.

Examples:

- `pluginpack clean`
- `pluginpack clean --target cursor --dry-run`

Exit codes:

- 0 when managed files are removed or listed
- 1 when config, manifest loading, or cleanup fails

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
