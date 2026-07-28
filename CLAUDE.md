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
- `npm run audit` — `npm audit --omit=dev`, also run in CI. Scoped to production
  dependencies on purpose: devDependencies (eslint, test fixtures, etc.) never
  ship in the published package, so a vulnerability there isn't a risk to
  consumers — don't add fixes/overrides for dev-only findings.
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
- `src/partials.ts` — `loadPartials`/`resolvePartials`: project-level
  `{{> name}}` text-reuse, wired into `collectPluginFiles` and
  `withRootFiles`. Thin wrapper around the real `mustache` library (view is
  always `{}` — no config/env data is ever exposed; this is not a general
  templating hook), plus one custom check `mustache` doesn't provide
  (circular partial reference detection at load time).
- `src/targets/registry.ts` — `targets: Record<TargetName, PluginTargetDefinition>`,
  one file per target (`src/targets/<name>.ts`). Everything that varies by
  target — default components, manifest/marketplace builders, output paths,
  validation, install snippet — lives on that target's own
  `PluginTargetDefinition` (`src/targets/types.ts`).
- `src/targets/engine.ts` — `emitFromDefinition`/`validateFromDefinition`: the
  one emit/validate engine every target runs through, driven by its
  `PluginTargetDefinition`. Also `withRootFiles` (injects per-target
  repo-root files into the artifact).
- `src/targets/validation-shared.ts` — validators shared across targets whose
  shape actually matches (bare-string marketplace `source`, hooks.json shape,
  frontmatter conventions); a target with a genuinely different shape (e.g.
  Codex's structured `source`) writes its own instead of forcing a fit.
- `src/adapters.ts` — `emitTarget`/`validateOutput`/`targetNames`, thin
  wrappers around the registry + engine.
- `src/build.ts` — `build()`: emit all targets → `assertNoCrossTargetCollisions`
  → write/prune/manifest. Holds the delete guard.
- `src/managed.ts` — the managed-file manifest (`.pluginpack/<target>.json`),
  `prune`/`clean`, the delete guard, and path-safety checks.
- `src/diff.ts` — `diffTarget`: build to a temp dir and compare against an
  existing target repo (the CI staleness gate).

## Targets

`copilot`, `antigravity`, `cursor`, `claude`, `codex`. Adding a target means one
new file implementing `PluginTargetDefinition` (`src/targets/<name>.ts`) plus one
new entry in `src/targets/registry.ts` — `TargetName` (`types.ts`) is still a
separate union to extend, but everything else (CLI `--target` choices, `build()`'s
target set, emit/validate dispatch) derives from the registry automatically.

## Conformance

`CONFORMANCE.md` is the reference. There is no referenceable upstream JSON
Schema for any target, so the harness uses the strongest available oracle per
target: Cursor against vendored published schemas (`tests/fixtures/cursor/`,
provenance in `SOURCE.md`); Claude via `claude plugin validate --strict` (when
the CLI is present); Copilot and Antigravity structurally against their real
formats (`github/copilot-plugins`, Antigravity CLI plugin docs). Don't fetch
schemas at runtime — vendor a pinned copy with recorded provenance.

## Shapes and gotchas

- **Recommended shape:** top-level `skills/` (the portable surface) + generated
  native outputs under `plugins/<target>/` in the same repo.
- **claude + copilot collide:** both write `.claude-plugin/marketplace.json`, so
  they need distinct `outDir`s. `build()` errors on overlapping output paths.
- **MCP:** a source plugin declares servers via a `.mcp.json` file (standard
  `{ mcpServers: {...} }`) or an `mcpServers` key in `plugin.pluginpack.json`
  (file wins). claude ships the file (auto-discovered); cursor/copilot reference
  it; antigravity writes `mcp_config.json`.

## Conventions

- Strict TypeScript, no `any` (the one exception is `readJson` in
  `src/targets/validation-shared.ts`).
- Prettier + eslint enforced by the gate.
- Conventional commits. Keep the README CLI reference regenerated.
