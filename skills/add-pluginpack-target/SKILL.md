---
name: add-pluginpack-target
description: Use when extending pluginpack itself with support for a new AI app or plugin format — i.e. adding a target adapter to the pluginpack codebase. This is for contributors hacking ON pluginpack, not for end users packaging their plugins.
---

# Adding a pluginpack target

A target adapter owns one app's native layout, manifests, and validation.

## First: get the real format, do not guess

Find the app's actual plugin format from official docs or a real published
plugin repo (the way the existing adapters were derived from `github/copilot-plugins`,
`gleanwork/cursor-plugins`, the Claude plugins reference, and the documented
OpenAI Codex CLI plugin format). Capture an
external oracle you can validate against — a published JSON Schema, the app's
own validator CLI, or a real repo to `diff` against. Record it in
`CONFORMANCE.md`.

## Touch points

Adding a target means:

1. `src/types.ts` — add the name to the `TargetName` union.
2. `src/targets/<name>.ts` — implement `PluginTargetDefinition` (see
   `src/targets/types.ts`): emit logic, manifest/marketplace builder,
   validation, install snippet, and defaults.
3. `src/targets/registry.ts` — add one entry mapping the name to that
   definition.

Everything else — the CLI's `--target` choices, `build()`'s target set, and
emit/validate dispatch — derives from the registry automatically via the
shared engine in `src/targets/engine.ts`. Reuse `src/targets/validation-shared.ts`
for checks whose shape genuinely matches the other targets (hooks, frontmatter);
write your own where the shape is genuinely different, the way codex's
structured `source` object does.

## Wire MCP

If the app supports MCP servers, decide whether it reads a `.mcp.json` file
(reference it from the manifest, like cursor/copilot, or rely on auto-discovery,
like claude), a target-specific config file (like Antigravity's
`mcp_config.json`), or another native shape. `resolveMcpServers` already merges
a plugin's servers; thread the result into your emitter.

## Verify

Add conformance tests in `tests/` against the external oracle, extend
`CONFORMANCE.md`, then run `npm run check`.
