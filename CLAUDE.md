# pluginpack — agent guide

`pluginpack` compiles one source of portable agent plugins (skills, agents,
commands, rules, hooks, MCP servers, assets, metadata) into the native plugin
layouts each AI app expects. It is a build tool: it copies files, writes the
manifests each target needs, and validates the result. It is not a package
manager or publisher.

## Commands

- `npm run dev -- <args>` — run the CLI from source (`tsx src/cli.ts`).
- `npm test` — vitest. A `pretest` hook builds first, because the conformance
  tests run the real built binary (`dist/cli.js`) via `bintastic`.
- `npm run check` — the full gate (`test:all`): `format:check` → `lint` →
  `typecheck` → `test` → `build` → `docs`. Run this before considering work done.
- `npm run build` — bundle with tsup.
- After changing CLI commands/options, regenerate the README CLI reference with
  `node dist/cli.js docs` (the gate's `docs --check` fails if it is stale).

Node >= 24, ESM, `moduleResolution: nodenext`, `strict: true`.

## Architecture

Data flows: **config → discover source → collect/render files → emit per target
→ artifact (in-memory file map) → write / prune / validate / diff.** The
`Artifact` (a `Map<path, contents>` plus `managedPaths`) is the seam — dry-run,
diff, prune, and validate all derive from it.

- `src/cli.ts` — commander CLI: `init`, `build`, `validate`, `diff`, `prune`,
  `clean`, `docs`.
- `src/schema.ts` — **zod schemas are the source of truth for config types**;
  the public types are derived with `z.infer`. Edit schemas here, not `types.ts`.
- `src/types.ts` — non-config types; re-exports the config types from `schema.ts`.
- `src/components.ts` — `componentDirs` + `staticFiles` (shared by render/config).
- `src/config.ts` — `loadConfig` (jiti loads `pluginpack.config.ts`), source
  plugin discovery (only dirs with a manifest or a component dir count, so
  generated output is never misread as source), and the root-skills plugin.
- `src/render.ts` — `collectPluginFiles` (component dirs + static files, with
  `targets/<name>/` override resolution) and `resolveMcpServers`.
- `src/targets.ts` — `emitTarget` + per-target emitters. `cursor`/`claude`/
  `gemini` share the `emitPlugins` engine via callbacks; `emitCopilot` is bespoke
  (no per-plugin manifest, dual marketplace). Manifest builders live here too.
- `src/build.ts` — `build()`: emit all targets → `assertNoCrossTargetCollisions`
  → write/prune/manifest. Holds the delete guard.
- `src/managed.ts` — the managed-file manifest (`.pluginpack/<target>.json`),
  `prune`/`clean`, the delete guard, and path-safety checks.
- `src/diff.ts` — `diffTarget`: build to a temp dir and compare against an
  existing target repo (the CI staleness gate).
- `src/validate.ts` — per-target output validation.

## Targets

`cursor`, `claude`, `gemini`, `copilot`. Adding a target currently touches ~5
places: the `TargetName` union (`types.ts`), the `targets` array + `parseTarget`
(`cli.ts`), `allTargets` (`build.ts`), the `emitters` map + a new `emitFoo`
(`targets.ts`), and a branch + `validateFoo` (`validate.ts`). If you are adding a
target, consider introducing a single target registry first to localize this.

## Conformance

`CONFORMANCE.md` is the reference. There is no referenceable upstream JSON
Schema for any target, so the harness uses the strongest available oracle per
target: Cursor against vendored published schemas (`tests/fixtures/cursor/`,
provenance in `SOURCE.md`); Claude via `claude plugin validate --strict` (when
the CLI is present); Copilot and Gemini structurally against their real formats
(`github/copilot-plugins`, `google-gemini/gemini-cli`). Don't fetch schemas at
runtime — vendor a pinned copy with recorded provenance.

## Shapes and gotchas

- **Recommended shape:** top-level `skills/` (the portable surface) + generated
  native outputs under `plugins/<target>/` in the same repo.
- **claude + copilot collide:** both write `.claude-plugin/marketplace.json`, so
  they need distinct `outDir`s. `build()` errors on overlapping output paths.
- **MCP:** a source plugin declares servers via a `.mcp.json` file (standard
  `{ mcpServers: {...} }`) or an `mcpServers` key in `plugin.pluginpack.json`
  (file wins). claude ships the file (auto-discovered); cursor/copilot reference
  it; gemini inlines the map into `gemini-extension.json`.

## Conventions

- Strict TypeScript, no `any` (the one exception is `readJson` in `validate.ts`).
- Prettier + eslint enforced by the gate.
- Conventional commits. Keep the README CLI reference regenerated.
