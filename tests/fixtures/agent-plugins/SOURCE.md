# Vendored Agent Plugins schemas

These are the **external oracle** for the `codex` and `agent-plugins`
conformance tests. They are the official machine-readable schemas published
with the Agent Plugins Specification 1.0.0, maintained by the Agent Plugins
TSC (not by this repo).

- Source: `agentplugins/agent-plugins-spec` → `schemas/1.0.0/`
- Commit: `ff8ab5e392cc87bd88d87c060815a87490e51003` (fetched 2026-10-02)
- SHA-256:
  - `plugin.schema.json` — `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883`
  - `mcp.schema.json` — `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb`

The specification text is authoritative where it and these schemas disagree
(spec §5.2, §7.2.1). Published schema identifiers are never reassigned to
different contents (spec §10.1), so the 1.0.0 copies shouldn't change. A new
specification version publishes new schemas under a new directory.

Do not hand-edit. Re-fetch to update:

```bash
for f in plugin mcp; do
  gh api "repos/agentplugins/agent-plugins-spec/contents/schemas/1.0.0/$f.schema.json" \
    -H "Accept: application/vnd.github.raw" > "$f.schema.json"
done
```
