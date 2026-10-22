# Vendored Cursor schemas

These are the **external oracle** for the Cursor conformance tests — the published
plugin/marketplace JSON Schemas, authored outside this repo.

- Source: `gleanwork/cursor-plugins` → `schemas/`
- Commit: `424c3485` (fetched 2026-05-29)
- Verified-at: 2026-10-21
- Re-fetched both schemas and verified byte-identical against upstream `schemas/`
  at commit `d6077b77e56d5aa908713669ba8c72af0ef892e5` on 2026-10-21.

Do not hand-edit. Re-fetch to update:

```bash
gh api repos/gleanwork/cursor-plugins/contents/schemas/marketplace.schema.json \
  -H "Accept: application/vnd.github.raw" > marketplace.schema.json
gh api repos/gleanwork/cursor-plugins/contents/schemas/plugin.schema.json \
  -H "Accept: application/vnd.github.raw" > plugin.schema.json
```

Re-verify at least every 90 days. `tests/evidence-freshness.test.ts` enforces
this cadence in CI. Run the fetch above and diff against the vendored copies,
then update `Verified-at` and record the checked upstream commit. See
[the refresh procedure](../../../CONFORMANCE.md#evidence-refresh-cadence).
CONFORMANCE.md flags this oracle as self-referential because Glean, not Cursor,
authored these schemas.
