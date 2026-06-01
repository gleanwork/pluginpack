# Conformance

How pluginpack verifies that emitted output matches each target app's real plugin
format.

## Why this is hard

There is no single, referenceable, upstream JSON Schema for any supported target.
Each app's source of truth is something other than a stable schema URL:

| Target        | Canonical source of truth                                                                                   | Referenceable schema?                                                                                                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`      | `claude plugin validate` CLI + [plugins-reference docs](https://code.claude.com/docs/en/plugins-reference)  | **No.** The `$schema` URL the manifest declares (`https://anthropic.com/claude-code/marketplace.schema.json`) returns 404.                                                                                                         |
| `cursor`      | Glean-authored schemas in `gleanwork/cursor-plugins/schemas/`                                               | **No upstream.** The schema `$id` (`https://cursor.com/schemas/cursor-plugin/...`) 500s; no Cursor-published schema found.                                                                                                         |
| `antigravity` | Antigravity CLI plugin docs (`plugin.json`, optional `mcp_config.json`)                                     | **No.** Defined by product docs and observed CLI layout, not a published schema.                                                                                                                                                   |
| `copilot`     | [`github/copilot-plugins`](https://github.com/github/copilot-plugins) — a Claude-marketplace-derived format | **Structural.** Copilot shares the Claude marketplace base but extends entries (`skills[]`, `mcpServers` as a path), which `claude plugin validate` rejects — so conformance is asserted structurally against the official format. |

## Oracles the harness uses

Conformance tests live in `tests/conformance.test.ts` and run the real built CLI
against a temp fixture via [`bintastic`](https://github.com/scalvert/bintastic).

- **claude** — runs `claude plugin validate --strict` against the emitted
  marketplace and plugin directories when the `claude` CLI is on `PATH` (skipped
  otherwise, e.g. CI). This is Anthropic's own validator — the same check their
  submission pipeline runs — so it is a genuinely external oracle that tracks
  upstream automatically. A structural golden assertion also pins the exact
  emitted shape.
- **cursor** — validates the emitted `marketplace.json` and `plugin.json` against
  the vendored schemas in `tests/fixtures/cursor/` (provenance in
  `tests/fixtures/cursor/SOURCE.md`). Caveat: those schemas are authored by
  Glean, not Cursor, so this check is partly self-referential. The external
  signal is empirical — `gleanwork/cursor-plugins` is live in Cursor's
  marketplace and loads. The published schema's `additionalProperties: false` is
  also stricter than Cursor's runtime: the marketplace `version` field is
  tolerated in practice, so the test allows that one key explicitly while still
  rejecting any other unexpected field.
- **copilot** — asserted structurally against the official `github/copilot-plugins`
  format: the marketplace is written to both `.claude-plugin/marketplace.json` and
  `.github/plugin/marketplace.json` (the test checks the copies are identical) and
  entries carry `skills[]`, `version`, and `mcpServers`. `claude plugin validate` is
  deliberately **not** used here: Copilot derives from the Claude marketplace but
  extends entries (e.g. `mcpServers` as a `.mcp.json` path), which Claude's stricter
  schema rejects. Because it shares the Claude marketplace path, the `claude` and
  `copilot` targets need separate output roots.
- **antigravity** — covered structurally by the cross-target build test in
  `tests/core.test.ts` (required `plugin.json` fields present; optional
  `mcp_config.json` written when MCP servers are present). Antigravity CLI does
  not expose a published schema to validate against.

## Refreshing vendored schemas

The Cursor schemas are pinned copies. To update them, re-fetch from the source
recorded in `tests/fixtures/cursor/SOURCE.md`, then re-run the suite. Do not
hand-edit — they are an oracle.

## Why vendor instead of fetch at runtime?

Even where a canonical URL existed, tests should not fetch it at runtime:
network flakiness makes tests non-deterministic, and a moving upstream would
break builds unpredictably. Pinning a copy with recorded provenance — plus, for
Claude, shelling out to the installed official validator — keeps the checks
deterministic and hermetic.
