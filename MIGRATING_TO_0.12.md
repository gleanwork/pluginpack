# Migrating pluginpack 0.11 to 0.12

Pluginpack 0.12 reads the same config fields as 0.11. Some configs and sources
that 0.11 accepted now fail, and several targets write different output. Work
through this guide in order:

1. [Before you upgrade](#before-you-upgrade): record the 0.11 output.
2. [Fix build and config errors](#1-fix-build-and-config-errors): each one
   stops a build that passed with 0.11.1.
3. [Review changed output](#2-review-changed-output): files that 0.12 writes
   differently.
4. [Read the new warnings](#3-read-the-new-warnings): messages that don't stop
   the build.
5. [Update code that uses the API](#4-update-code-that-uses-the-api): only if
   you import `@gleanwork/pluginpack` from code.
6. [Check the result](#5-check-the-result).

## Before you upgrade

Build with 0.11:

```bash
npm ci
npx pluginpack build
```

Copy each target's `outDir` to a directory outside the project. Step 5
compares the 0.12 output against this copy. If you publish output to a
separate repository, its checkout works as the copy.

Then upgrade pluginpack:

```bash
npm install --save-dev @gleanwork/pluginpack@^0.12.0
```

The first 0.12 build rewrites each managed manifest
(`.pluginpack/<target>.json`) as version 2, which records a sha256 hash for
every file. Pluginpack 0.11 cannot read version 2 and fails with
`Invalid managed manifest: <path>`. Upgrade every machine and CI job that
builds the same output at the same time. To go back to 0.11, delete the
`.pluginpack/` directory in each `outDir` first.

On a 0.11 output, the first 0.12 `build` and `prune` work without `--force`,
and `clean` works too. This holds for the README layout, a `codex` target at
`outDir: "."`, legacy 0.10 sources and the `pluginpack init` layout.

## 1. Fix build and config errors

Each error below stops a build that passed with 0.11.1. A config error stops
every command. A build error in one target stops the whole build, so
`pluginpack build` writes no output for any target until you fix it. The most
common errors come first.

### codex MCP config that breaks Agent Plugins rules

The `codex` target now writes Agent Plugins packages (see
[The codex layout](#the-codex-layout)), so its MCP config must follow the
Agent Plugins rules. Pluginpack 0.11 copied the config as authored. Agent
Plugins clients skip a server that breaks the rules without telling the user,
so 0.12 stops the build instead:

```txt
Target "codex" plugin "acme": MCP server "local" "cwd" is "."; Agent Plugins requires a ./ path or a path under ${PLUGIN_ROOT} or ${PLUGIN_DATA} that stays inside it (omit "cwd" to use the plugin root).
Target "codex" plugin "acme": MCP server "local" "env.TOKEN" uses ${API_TOKEN}; Agent Plugins expands only ${PLUGIN_ROOT} and ${PLUGIN_DATA} and leaves anything else literal.
```

A `command` must also be a single token. A value that holds arguments, such as
`"./bin/server --verbose"`, fails because clients run the whole value as one
file name. Move the arguments into `args`.

This affects `codex` and `agent-plugins` targets that ship MCP servers. Change
the config to follow the README's [MCP Directory](./README.md#mcp-directory)
rules. You can also give `codex` its own `mcp/config.json` through
`overrides`, or set `format: "legacy"` on the `codex` target until 0.13.

### Plugin-data variables on cursor

Cursor has no plugin-data variable, so it never expanded `${CLAUDE_PLUGIN_DATA}`
or `${PLUGIN_DATA}`. Pluginpack 0.11.1 shipped these variables to Cursor
anyway. Pluginpack 0.12 stops the build:

```txt
Target "cursor" plugin "acme": MCP server "local" uses ${CLAUDE_PLUGIN_DATA}, but Cursor has no plugin-data variable.
```

Choose one fix:

- Give Cursor its own MCP config without the variable. Set
  `overrides: "overrides/cursor/<plugin>"` on the `cursor` plugin and add
  `overrides/cursor/<plugin>/mcp/config.json`.
- Ship no MCP servers to Cursor. Add `exclude: ["mcp"]` to the `cursor` plugin.

### `cwd` on a claude MCP server

The `claude` target fails when a stdio MCP server sets `cwd`. Claude Code
ignores `cwd` for plugin MCP servers and starts them in the user's working
directory, so the server that 0.11 shipped never ran where you expected. Claude
Code expands `${CLAUDE_PLUGIN_ROOT}` only in `command`, `args` and `env`.

Remove `cwd`, and write paths in `args` as `${CLAUDE_PLUGIN_ROOT}/...`, for
example `"args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"]`. If other targets
need `cwd`, keep it in the shared config and add a claude-only
`overrides/claude/<plugin>/mcp/config.json` without it.

### Frontmatter that YAML 1.2 rejects

Pluginpack 0.11 read skill, agent, command and rule frontmatter with
`gray-matter`, which uses js-yaml 3 (YAML 1.1). Pluginpack 0.12 reads only
YAML frontmatter, with js-yaml 4 (YAML 1.2). `validate` reports these errors.
`build` output doesn't change, but `build` prints the same problems as warnings
for `codex` and `agent-plugins` skills. Three inputs behave differently:

- 0.11.1 accepted a `---json` frontmatter block. 0.12 fails with
  `Frontmatter language "json" is not supported; use YAML frontmatter.`
  Rewrite the block as YAML.
- 0.11.1 accepted a tab-indented line, and read it as a separate top-level
  field. 0.12 fails with `tab characters must not be used in indentation`.
  Indent with spaces.
- 0.11.1 read an unquoted `017` as the octal number 15. 0.12 reads it as 17.
  Quote a value such as `"017"` if it must stay a string.

### Skill names on codex and agent-plugins

`validate` rejects a `codex` or `agent-plugins` skill whose name isn't
lowercase letters, digits and hyphens, such as `skill_name`. Agent Plugins
clients skip that skill. Rename the skill directory and its `name`.

### MCP command files missing from a package

`validate` fails for `codex` and `agent-plugins` when a `./` command names a
file that the package doesn't ship:

```txt
error: acme: mcp.json server "a" "command" is "./bin/missing", but the package has no file "bin/missing" — the client can't start the server.
```

Ship the file by listing it in `mcp/pluginpack.json` `files`, or fix the
command. Other targets only warn (see
[the new warnings](#3-read-the-new-warnings)).

### A custom `marketplaceDir` on claude or cursor

Claude Code and Cursor read their marketplace only from `.claude-plugin/` and
`.cursor-plugin/`. A `claude` or `cursor` target with any other
`marketplaceDir` now fails at config load. Remove `marketplaceDir`, or set it
to `.claude-plugin` or `.cursor-plugin`. To move the generated repository, use
`outDir`.

### Two files at one output path

A target now fails when two plugins, or two files, write the same output path.
Pluginpack 0.11 kept the last write. Paths that differ only by case or by
Unicode normalization count as the same path, so `plugins/Acme` and
`plugins/acme` collide:

```txt
Target "claude": plugin "acme" manifest and plugin "beta" manifest collide at "plugins/acme/.claude-plugin/plugin.json". Change the plugin path or remove the conflicting file in pluginpack.config.ts.
```

Give each plugin its own `path`, or remove the conflicting file.

### Two targets in one directory

Two targets fail when their `outDir`s are the same directory and they write
the same file. Pluginpack now compares real paths, so `out` and `OUT` on a
case-insensitive filesystem, or a symlink to another `outDir`, count as the
same directory. The error starts with
`Targets write overlapping output paths; give them distinct outDirs:`. Give
each target its own `outDir`, and replace a symlinked output path with a
regular directory.

### An `outDir` inside a source

An `outDir` that resolves inside a source, `overrides`, `partials`,
`repositoryFiles` or `rootFiles` path now fails at config load, even when it
gets there through a symlink. A build there overwrites source files, and prune
or clean would delete them. Point each `outDir` at a directory outside every
source path.

### Path fields outside the project

The plugin `source`, `overrides` and `path` fields, and `source.partials`,
must be relative paths inside the project. Pluginpack 0.11 accepted a
URL-shaped value such as `https://../../x` and read it as `../x`. It also
accepted a `source.partials` directory outside the project, such as
`../partials`. Both now fail at config load:

```txt
targets.claude.plugins.acme.source: must be a safe relative path (no absolute paths or ".." segments)
```

Move the directory into the project, and use a plain relative path.

### A `rootFiles` entry that copies a file onto itself

A `rootFiles` entry whose source and destination are the same file now fails,
for example `"README.md": "README.md"` with `outDir: "."`. Pluginpack would
otherwise manage the authored file and later delete it. Map the entry to a
different destination, or remove it if the file already lives in the output
repository.

### Output left by a target you removed

`build` and `prune` now refuse when an `outDir` holds the manifest of a target
that the config no longer builds there. This happens when you switch from
`codex` to `agent-plugins` with `clients.codex` at the same `outDir`:

```txt
Found managed output from a target this config does not build there:
  /path/to/out/.pluginpack/codex.json (codex)
No configured target prunes the files these manifests list, so they would stay in the output. Run `pluginpack clean --target codex` to delete them first. To keep the files unmanaged instead, delete the manifest.
```

Run `pluginpack clean --target <old>` to delete the old files. `clean` can now
remove a target that the config no longer lists. To keep the files as
unmanaged files instead, delete the manifest.

### Partials that aren't valid UTF-8

A file that holds a `{{> name}}` tag, or a partial it includes, must be valid
UTF-8. Pluginpack 0.11 replaced the invalid bytes with U+FFFD and shipped the
result. Pluginpack 0.12 stops the build. Re-save the file as UTF-8, or remove
the partial tags from it.

### Partial tags built from neighboring text

A tag that substitution would assemble from separate pieces now fails instead
of shipping as a live `{{> name}}` tag. Examples are `{{{> auth}}}`, and a
partial that ends in `{` placed before `{> auth}}`. Separate the pieces, or
write `\{{> auth}}` to emit the tag on purpose.

### Dry runs run the same checks

`build --dry-run`, `prune --dry-run` and `clean --dry-run` now run the same
safety checks as the real command. A dry run that passed with 0.11 fails with
any of the errors above.

## 2. Review changed output

### The codex layout

The `codex` target now writes an [Agent Plugins](https://agent-plugins.org/specification)
package for each plugin. OpenAI's
[packaging docs](https://developers.openai.com/codex/plugins/build) prefer
this format, and keep `.codex-plugin/plugin.json` only as a fallback.

| 0.11                                           | 0.12                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `plugins/<name>/.codex-plugin/plugin.json`     | `plugins/<name>/plugin.json`, with `$schema`                      |
| `plugins/<name>/.mcp.json`, copied as authored | `plugins/<name>/mcp.json`, with `$schema` and a `type` per server |
| `.agents/plugins/marketplace.json`             | `.agents/plugins/marketplace.json` (unchanged)                    |

The first 0.12 build removes the old `.codex-plugin/plugin.json` and `.mcp.json`,
because pluginpack manages them. Manifest fields such as `interface`, `apps`
and `hooks` move under `extensions["com.openai"]` automatically, so the config
needs no changes. A per-server `extensions["com.openai"]` object in the MCP
config, which Codex reads for MCP auth, ships in `codex` output. The
`agent-plugins` target still rejects it.

#### Keep the old layout with `format: "legacy"`

Set `format: "legacy"` on the `codex` target if your users run Codex releases
older than 0.147.0. That is the first Codex release that installs Agent
Plugins packages and reads their `mcp.json`. The legacy layout is the 0.11.1
layout. The other changes in this section still apply to it.

```ts
targets: {
  codex: { outDir: "dist/codex", format: "legacy", plugins: { ... } },
},
```

`format: "legacy"` is deprecated in 0.12 and will be removed in 0.13. Every
build that uses it prints this warning:

```txt
warning: targets.codex.format: "legacy" is deprecated and will be removed in pluginpack 0.13. It only serves Codex releases older than 0.147.0. Remove "format" from targets.codex to emit Agent Plugins packages.
```

#### Move from `codex` to `agent-plugins`

The `agent-plugins` target with `clients.codex` writes the same marketplace
file as the `codex` target. The `agent-plugins` target doesn't ship Codex
hooks. To switch, follow these steps in order:

1. Run `pluginpack clean --target codex`.
2. Replace the `codex` target in the config with the `agent-plugins` target
   and `clients.codex`.
3. Run `pluginpack build`.

If you change the config first and the new target uses the same `outDir`,
`build` refuses until you run `pluginpack clean --target codex` (see
[Output left by a target you removed](#output-left-by-a-target-you-removed)).

### MCP config for claude, cursor and copilot

Pluginpack 0.11 copied `mcp/config.json` into each target as authored.
Pluginpack 0.12 renders it into each client's MCP dialect. The README's
[MCP Directory](./README.md#mcp-directory) table lists every rule. These are
the ones that change 0.11 output. Variables are rewritten in `command`,
`args`, `env` and `cwd`.

| Authored                              | `claude`                    | `cursor`                    | `copilot`            |
| ------------------------------------- | --------------------------- | --------------------------- | -------------------- |
| `command` starting with `./`          | `${CLAUDE_PLUGIN_ROOT}/...` | `${CURSOR_PLUGIN_ROOT}/...` | `${PLUGIN_ROOT}/...` |
| `cwd` starting with `./`              | build error                 | `${CURSOR_PLUGIN_ROOT}/...` | `${PLUGIN_ROOT}/...` |
| `${PLUGIN_ROOT}`                      | `${CLAUDE_PLUGIN_ROOT}`     | `${CURSOR_PLUGIN_ROOT}`     | unchanged            |
| `${CURSOR_PLUGIN_ROOT}`               | `${CLAUDE_PLUGIN_ROOT}`     | unchanged                   | `${PLUGIN_ROOT}`     |
| `${PLUGIN_DATA}`                      | `${CLAUDE_PLUGIN_DATA}`     | build error                 | unchanged            |
| `${CLAUDE_PLUGIN_DATA}`               | unchanged                   | build error                 | unchanged            |
| `"type": "streamable-http"`           | `"type": "http"`            | `type` removed              | `"type": "http"`     |
| `"type": "stdio"` or `"type": "http"` | unchanged                   | `type` removed              | unchanged            |

`${CLAUDE_PLUGIN_ROOT}` is unchanged for all three targets, because Cursor and
Copilot also expand it. The build errors are described in
[`cwd` on a claude MCP server](#cwd-on-a-claude-mcp-server) and
[Plugin-data variables on cursor](#plugin-data-variables-on-cursor).

For example, take this `mcp/config.json`:

```json
{
  "mcpServers": {
    "local": {
      "type": "stdio",
      "command": "./bin/server",
      "args": ["--verbose"]
    },
    "remote": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Pluginpack 0.11.1 wrote it unchanged to all three targets. Pluginpack 0.12
writes these `mcpServers`:

```txt
claude:  {"local":{"type":"stdio","command":"${CLAUDE_PLUGIN_ROOT}/bin/server","args":["--verbose"]},"remote":{"type":"http","url":"https://mcp.example.com/mcp"}}
cursor:  {"local":{"command":"${CURSOR_PLUGIN_ROOT}/bin/server","args":["--verbose"]},"remote":{"url":"https://mcp.example.com/mcp"}}
copilot: {"local":{"type":"stdio","command":"${PLUGIN_ROOT}/bin/server","args":["--verbose"]},"remote":{"type":"http","url":"https://mcp.example.com/mcp"}}
```

If you kept a per-target `mcp/config.json` override only to change variable
names, you can delete it.

### Hooks pointers

The `copilot` target and the `codex` target with `format: "legacy"` now write
a `hooks` field in `plugin.json` only when the plugin ships
`hooks/hooks.json`. Pluginpack 0.11 also wrote the field for a `hooks/`
directory without `hooks/hooks.json`, and `validate` then failed on the
missing file. No action is needed. To ship hooks, add `hooks/hooks.json`.

### Partial line endings and BOMs

An inlined partial now takes the line endings of the file that includes it,
and loses a leading byte order mark. Pluginpack 0.11 inserted the partial's
bytes unchanged, so a CRLF file could get LF lines and a BOM in the middle.
No action is needed.

### `install-info` commands

`pluginpack install-info --target claude` now prints the shell commands
`claude plugin marketplace add <url>` and `claude plugin install <plugin>@<marketplace>`
first. The interactive `/plugin` commands moved to the note.
`--target antigravity` now prints `agy plugin install https://github.com/<owner>/<repo>`,
and the note keeps the clone-and-install form. Update any docs that copied the
0.11 output.

### `pluginpack init`

`pluginpack init` now scaffolds all six targets. It also refuses to run when
any file it would create already exists. Pluginpack 0.11 scaffolded four
targets and overwrote an existing `shared/example` file.

## 3. Read the new warnings

These messages print during `build` but don't stop it. Check each one before
you publish.

- Unknown config and manifest keys. A key that pluginpack doesn't know, such
  as a misspelled `outdir`, prints
  `Unknown config key "targets.claude.outdir" in <path> was ignored.` The
  same check covers `plugin.pluginpack.json` and `mcp/pluginpack.json`. The
  key is still ignored, as in 0.11. Fix the spelling or remove the key.
  Passthrough objects such as `manifest` and `entry` don't warn.
- An MCP file that the plugin doesn't ship. A `./` or root-variable `command`,
  or an `args` entry that starts with `${PLUGIN_ROOT}/`,
  `${CLAUDE_PLUGIN_ROOT}/` or `${CURSOR_PLUGIN_ROOT}/`, names a file that the
  plugin doesn't ship. Add the file to `mcp/pluginpack.json` `files`, or fix
  the path.
- A `codex` entry, or an `agent-plugins` `clients.codex` entry, without
  `policy.installation`, `policy.authentication` or `category`. Set them in
  the plugin's `entry`.
- A `codex` or `agent-plugins` skill with an invalid name or unparseable
  frontmatter. `validate` fails on the same skill, as described in
  [Skill names](#skill-names-on-codex-and-agent-plugins).
- Hooks dropped by `agent-plugins`. A plugin with a `hooks/` directory prints
  `"shared/<plugin>/hooks" is omitted.` Keep the `codex` target if you need
  hooks, or add `"hooks"` to the plugin's `exclude`.
- A managed file edited by hand. `build`, `prune` and `clean` warn before they
  overwrite or delete a managed file whose content no longer matches its
  recorded hash, and then go ahead. Move the edit into the source, or recover
  it from version control.
- `format: "legacy"` on `codex`. See
  [Keep the old layout](#keep-the-old-layout-with-format-legacy).

One warning is gone. `validate` no longer warns about an escaped `\{{> name}}`
tag in a file type that gets partial substitution.

## 4. Update code that uses the API

Skip this section if you only run the CLI.

- `PluginpackConfig` is now the type of the config you write, and the new
  `ResolvedPluginpackConfig` is the parsed config. `ResolvedProject.config`,
  as returned by `loadConfig`, has the `ResolvedPluginpackConfig` type. The
  two types have the same shape today, so existing code compiles. Use
  `ResolvedPluginpackConfig` for parsed config.
- `FileValue`, the type of each value in `Artifact.files`, is now
  `string | Uint8Array` instead of `string | Buffer`. Runtime values are still
  Buffers, but a call such as `value.toString("utf8")` no longer type-checks.
  Decode with `Buffer.from(value).toString("utf8")` or `new TextDecoder()`.
- The published type declarations no longer import `zod`. No action is needed.

## 5. Check the result

Build once, then validate and diff each configured target:

```bash
npx pluginpack build
npx pluginpack validate --target <target>
npx pluginpack diff --target <target> --against <path-to-0.11-output>
```

The diff lists every managed file that 0.12 adds, changes or removes. Check
each one against this guide before you publish.
