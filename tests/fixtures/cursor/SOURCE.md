# Vendored Cursor schemas

These are the **external oracle** for the Cursor conformance tests — the published
plugin/marketplace JSON Schemas, authored outside this repo.

- Source: `gleanwork/cursor-plugins` → `schemas/`
- Commit: `424c3485` (fetched 2026-05-29)
- Re-verified byte-identical against upstream `schemas/` (commit `6f3ad6e6`) on
  2026-07-28 — no re-fetch needed.

Do not hand-edit. Re-fetch to update:

```bash
gh api repos/gleanwork/cursor-plugins/contents/schemas/marketplace.schema.json \
  -H "Accept: application/vnd.github.raw" > marketplace.schema.json
gh api repos/gleanwork/cursor-plugins/contents/schemas/plugin.schema.json \
  -H "Accept: application/vnd.github.raw" > plugin.schema.json
```

Staleness has no automated check today — re-run the fetch above and diff
against the vendored copies periodically, especially before a stability-tier
bump, since CONFORMANCE.md already flags this oracle as self-referential.
