# Conformance

How pluginpack verifies that emitted output matches each target app's real plugin
format.

## Why this is hard

There is no single, referenceable, upstream JSON Schema for any supported target.
Each app's source of truth is something other than a stable schema URL:

| Target    | Canonical source of truth                                                                                  | Referenceable schema?                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `claude`  | `claude plugin validate` CLI + [plugins-reference docs](https://code.claude.com/docs/en/plugins-reference) | **No.** The `$schema` URL the manifest declares (`https://anthropic.com/claude-code/marketplace.schema.json`) returns 404. |
| `cursor`  | Glean-authored schemas in `gleanwork/cursor-plugins/schemas/`                                              | **No upstream.** The schema `$id` (`https://cursor.com/schemas/cursor-plugin/...`) 500s; no Cursor-published schema found. |
| `gemini`  | TypeScript types in `google-gemini/gemini-cli` (`packages/cli/src/config/extension.ts`) + docs             | **No.** Defined by source types, not a published schema.                                                                   |
| `copilot` | `SKILL.md` frontmatter convention                                                                          | **N/A.** pluginpack emits skills only; there is no JSON manifest to validate.                                              |

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
- **gemini / copilot** — covered structurally by the cross-target build test in
  `tests/core.test.ts` (manifest fields, file placement). No upstream schema
  exists to validate against.

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
