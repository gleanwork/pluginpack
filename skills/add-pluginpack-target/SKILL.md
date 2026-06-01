---
name: add-pluginpack-target
description: Use when extending pluginpack itself with support for a new AI app or plugin format — i.e. adding a target adapter to the pluginpack codebase. This is for contributors hacking ON pluginpack, not for end users packaging their plugins.
---

# Adding a pluginpack target

A target adapter owns one app's native layout, manifests, and validation.

## First: get the real format, do not guess

Find the app's actual plugin format from official docs or a real published
plugin repo (the way the existing adapters were derived from `github/copilot-plugins`,
`gleanwork/cursor-plugins`, and the Claude plugins reference). Capture an
external oracle you can validate against — a published JSON Schema, the app's
own validator CLI, or a real repo to `diff` against. Record it in
`CONFORMANCE.md`.

## Touch points

Adding a target currently means editing ~5 places:

1. `src/types.ts` — add the name to the `TargetName` union.
2. `src/cli.ts` — add it to the `targets` array and `parseTarget`.
3. `src/build.ts` — add it to `allTargets`.
4. `src/targets.ts` — add an `emitFoo` and register it in the `emitters` map,
   plus a manifest builder. Reuse the `emitPlugins` engine if the target has a
   per-plugin manifest + a marketplace (like cursor/claude); write a bespoke
   emitter otherwise (like copilot).
5. `src/validate.ts` — add a branch and a `validateFoo`.

> Because the touch points are spread across five files, consider introducing a
> single target registry (one object per target carrying its emitter, validator,
> and defaults) before or as part of adding the target. The cost of the registry
> is repaid immediately by the target you are adding.

## Wire MCP

If the app supports MCP servers, decide whether it reads a `.mcp.json` file
(reference it from the manifest, like cursor/copilot, or rely on auto-discovery,
like claude), a target-specific config file (like Antigravity's
`mcp_config.json`), or another native shape. `resolveMcpServers` already merges
a plugin's servers; thread the result into your emitter.

## Verify

Add conformance tests in `tests/` against the external oracle, extend
`CONFORMANCE.md`, then run `npm run check`.
