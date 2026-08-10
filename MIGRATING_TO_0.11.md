# Migrating pluginpack 0.10 to 0.11

This guide is intentionally procedural. An agent can execute it without making
architectural choices. It migrates one repository at a time while preserving
the generated artifact.

## Contract change

| 0.10                                    | 0.11                                          |
| --------------------------------------- | --------------------------------------------- |
| Discovered source plugins plus `from`   | One direct `source` per emitted plugin        |
| Root-level `skills/` special case       | `shared/<plugin>/skills/`                     |
| `targets/<host>/` replacement files     | `overrides/<host>/<plugin>/` target overrides |
| `components`                            | `include` or `exclude`                        |
| Root `.mcp.json` plus `additionalFiles` | `mcp/config.json` plus `mcp/pluginpack.json`  |
| `rootFiles` map                         | `repositoryFiles` directory                   |

Pluginpack 0.11 still reads the 0.10 fields for one migration window. Do not
mix `source` with `from`, or `components` with `include`/`exclude`, on the same
emitted plugin.

## 1. Establish the artifact baseline

From the consumer repository:

```bash
npm ci
npm run build
```

Record every target's managed paths and hashes. If the repository has published
output checkouts, also run `pluginpack diff --target <target> --against <path>`.
Do not proceed while the existing build or validation fails.

## 2. Create one shared directory per emitted plugin

For every key below `targets.<target>.plugins`, choose a canonical plugin name.
Create `shared/<plugin-name>/` and move that plugin's portable files beneath it:

```text
shared/<plugin-name>/
  skills/
  agents/
  commands/
  rules/
  hooks/
  assets/
  README.md
  CHANGELOG.md
  LICENSE
```

If several 0.10 `from` entries fed one emitted plugin, merge their non-colliding
files into this one directory. A path collision must be resolved explicitly;
do not pick a winner based on old `from` order because 0.10 rejected collisions.

## 3. Move target-specific content

For each target, create `overrides/<target>/<plugin-name>/`.

- Move every old `targets/<target>/<path>` replacement to the same `<path>`
  below the overrides directory.
- Move every target-only source file into the overrides directory.
- Keep shared files in `shared/<plugin-name>/`.

Overrides may replace a shared file or add a new one.

## 4. Move MCP content

For a plugin with an MCP server, create:

```text
shared/<plugin-name>/mcp/
  config.json
  pluginpack.json
  # server source, tests, build files, and generated shipping files
```

Move the old `.mcp.json` to `mcp/config.json` without changing its JSON shape.
Move the local server implementation under `mcp/`.

Convert `plugin.pluginpack.json.additionalFiles` into
`mcp/pluginpack.json.files`. Paths on the left remain emitted-plugin-relative;
paths on the right become relative to `mcp/`:

```json
{
  "files": {
    "mcp/start.mjs": "start.mjs",
    "mcp/dist/index.js": "dist/index.js",
    "mcp/package.json": "package.json"
  }
}
```

Update commands in `mcp/config.json` to point at the new emitted paths. Put a
target-specific MCP config at
`overrides/<target>/<plugin-name>/mcp/config.json` when necessary.

Use `exclude: ["mcp"]` for a target that must omit both the MCP configuration
and its declared shipping files.

## 5. Move generated-repository files

For each target using `rootFiles`, create `repositories/<target>/` and move each
mapped source file to its output-relative location below that directory. Replace
the entire `rootFiles` map with:

```ts
repositoryFiles: "repositories/<target>";
```

## 6. Rewrite the config

Before:

```ts
plugins: {
  acme: {
    from: ["core", "cursor"],
    components: ["skills", "agents", "rules"]
  }
}
```

After:

```ts
plugins: {
  acme: {
    source: "shared/acme",
    include: ["skills", "agents", "rules", "static"],
    overrides: "overrides/cursor/acme"
  }
}
```

Omit `overrides` when that directory does not exist. Prefer `exclude` when a
target differs from pluginpack's defaults by only one or two content kinds.

Delete `source.skills`, `source.rootPlugin`, and `source.plugins` after every
emitted plugin uses a direct `source`. Keep `source.partials` temporarily if the
repository uses partials.

## 7. Update scripts and ignored paths

Search the repository for every old path and config field:

```bash
rg -n 'source\.skills|source\.plugins|rootPlugin|from:|components:|rootFiles|targets/' \
  -g '!node_modules/**' -g '!dist/**'
```

Update build scripts, TypeScript project roots, test roots, release metadata
sync, lint rules, documentation, and `.gitignore` entries. Ensure source code
under `mcp/src` and tests under `mcp/tests` are not accidentally emitted; only
files declared by `mcp/pluginpack.json` ship.

## 8. Verify equivalence

Install pluginpack 0.11, then run the repository's complete test gate. At
minimum:

```bash
npm run build
npm run validate
npm test
```

Compare the new managed path and hash inventory with the baseline. Every change
must be one of:

- an intentional emitted path change recorded in the migration;
- a target-only addition that was previously impossible to express as an
  override;
- removal of an accidentally shipped file.

Verify each MCP command resolves from the installed plugin directory, not only
from the source checkout.

## 9. Commit and rollback

Commit the consumer migration separately from behavioral content changes. To
roll back, revert that commit and restore the 0.10 dependency and lockfile; do
not hand-edit generated output.

## Completion checklist

- [ ] Every emitted plugin has exactly one `source`.
- [ ] Shared content lives below `shared/<plugin>/`.
- [ ] Target content lives below `overrides/<target>/<plugin>/`.
- [ ] MCP configuration and implementation live together below `mcp/`.
- [ ] Only `mcp/pluginpack.json` shipping files are emitted.
- [ ] Generated-repository files live below `repositories/<target>/`.
- [ ] No canonical config uses `from`, `components`, or `rootFiles`.
- [ ] All target builds and validators pass.
- [ ] Generated artifact differences are reviewed and explained.
