# Migrating pluginpack 0.11 to 0.12

Pluginpack 0.12 reads the same config as 0.11, but it changes generated output
for four targets and makes `validate` stricter about frontmatter. Read this
guide before you publish output built with 0.12.

| Change                                                     | Who is affected                                                | What to do                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `codex` emits Agent Plugins packages                       | every `codex` target                                           | Publish the new layout, or set `format: "legacy"` until 0.13        |
| MCP config is rendered per target                          | `claude`, `cursor` and `copilot` targets that ship MCP servers | Check the rewritten `.mcp.json` files                               |
| `cursor` fails on `${CLAUDE_PLUGIN_DATA}`/`${PLUGIN_DATA}` | `cursor` targets whose MCP config uses a plugin-data variable  | Give `cursor` its own MCP config, or exclude `mcp` for `cursor`     |
| A new frontmatter parser                                   | sources with JSON frontmatter, tabs, or leading-zero numbers   | Convert the frontmatter to YAML that uses spaces and quoted strings |

## 1. Record the 0.11 output

Before you upgrade, build with 0.11:

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

## 2. The codex layout

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
needs no changes.

Agent Plugins clients skip a skill or MCP server that breaks the specification
without telling the user. Pluginpack reports these cases instead:

- `validate` rejects a skill name that isn't lowercase letters, digits and
  hyphens, such as `skill_name`. Rename the skill directory and its `name`.
- `build` rejects MCP config that 0.11 copied as authored. For example:

  ```txt
  Target "codex" plugin "acme": MCP server "local" "cwd" is "."; Agent Plugins requires a ./ path or a path under ${PLUGIN_ROOT} or ${PLUGIN_DATA} that stays inside it (omit "cwd" to use the plugin root).
  Target "codex" plugin "acme": MCP server "local" "env.TOKEN" uses ${API_TOKEN}; Agent Plugins expands only ${PLUGIN_ROOT} and ${PLUGIN_DATA} and leaves anything else literal.
  ```

  Change the config to follow the rules in the README's
  [MCP Directory](./README.md#mcp-directory) section.

### Keep the old layout with `format: "legacy"`

Set `format: "legacy"` on the `codex` target if your users run Codex releases
older than 0.147.0. That is the first Codex release that installs Agent
Plugins packages and reads their `mcp.json`. The legacy output is identical to
0.11.1 output.

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

### Move from `codex` to `agent-plugins`

The `agent-plugins` target with `clients.codex` writes the same marketplace
file as the `codex` target. To switch, follow these steps in order:

1. Run `pluginpack clean --target codex`.
2. Remove the `codex` target from the config.
3. Add the `agent-plugins` target with `clients.codex`, and run
   `pluginpack build`.

`clean` works only on a configured target. If you remove the target first,
`clean --target codex` fails with `Target "codex" is not configured.`, and
`.pluginpack/codex.json` stays behind.

## 3. MCP config for claude, cursor and copilot

Pluginpack 0.11 copied `mcp/config.json` into each target as authored.
Pluginpack 0.12 renders it into each client's MCP dialect. The README's
[MCP Directory](./README.md#mcp-directory) table lists every rule. These are
the ones that change 0.11 output. Variables are rewritten in `command`,
`args`, `env` and `cwd`.

| Authored                              | `claude`                    | `cursor`                    | `copilot`            |
| ------------------------------------- | --------------------------- | --------------------------- | -------------------- |
| `command` or `cwd` starting with `./` | `${CLAUDE_PLUGIN_ROOT}/...` | `${CURSOR_PLUGIN_ROOT}/...` | `${PLUGIN_ROOT}/...` |
| `${PLUGIN_ROOT}`                      | `${CLAUDE_PLUGIN_ROOT}`     | `${CURSOR_PLUGIN_ROOT}`     | unchanged            |
| `${CURSOR_PLUGIN_ROOT}`               | `${CLAUDE_PLUGIN_ROOT}`     | unchanged                   | `${PLUGIN_ROOT}`     |
| `${PLUGIN_DATA}`                      | `${CLAUDE_PLUGIN_DATA}`     | build error                 | unchanged            |
| `${CLAUDE_PLUGIN_DATA}`               | unchanged                   | build error                 | unchanged            |
| `"type": "streamable-http"`           | `"type": "http"`            | `type` removed              | `"type": "http"`     |
| `"type": "stdio"` or `"type": "http"` | unchanged                   | `type` removed              | unchanged            |

`${CLAUDE_PLUGIN_ROOT}` is unchanged for all three targets, because Cursor and
Copilot also expand it.

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

### Cursor and plugin-data variables

Cursor has no plugin-data variable, so it never expanded `${CLAUDE_PLUGIN_DATA}`
or `${PLUGIN_DATA}`. Pluginpack 0.11.1 shipped these variables to Cursor
anyway. Pluginpack 0.12 stops the build:

```txt
Target "cursor" plugin "acme": MCP server "local" uses ${CLAUDE_PLUGIN_DATA}, but Cursor has no plugin-data variable.
```

This error stops the whole build. A plain `pluginpack build` writes no output
for any target until you fix it. Choose one fix:

- Give Cursor its own MCP config without the variable. Set
  `overrides: "overrides/cursor/<plugin>"` on the `cursor` plugin and add
  `overrides/cursor/<plugin>/mcp/config.json`.
- Ship no MCP servers to Cursor. Add `exclude: ["mcp"]` to the `cursor` plugin.

## 4. Frontmatter parsing

Pluginpack 0.11 read skill, agent, command and rule frontmatter with
`gray-matter`, which uses js-yaml 3 (YAML 1.1). Pluginpack 0.12 reads only
YAML frontmatter, with js-yaml 4 (YAML 1.2). Only `validate` reads
frontmatter, so `build` output doesn't change. Three inputs behave
differently:

- 0.11.1 accepted a `---json` frontmatter block. 0.12 fails with
  `Frontmatter language "json" is not supported; use YAML frontmatter.`
  Rewrite the block as YAML.
- 0.11.1 accepted a tab-indented line, and read it as a separate top-level
  field. 0.12 fails with `tab characters must not be used in indentation`.
  Indent with spaces.
- 0.11.1 read an unquoted `017` as the octal number 15. 0.12 reads it as 17.
  Quote a value such as `"017"` if it must stay a string.

## 5. Check the result

Build once, then validate and diff each configured target:

```bash
npx pluginpack build
npx pluginpack validate --target <target>
npx pluginpack diff --target <target> --against <path-to-0.11-output>
```

The diff lists every managed file that 0.12 adds, changes or removes. Check
each one against this guide before you publish.
