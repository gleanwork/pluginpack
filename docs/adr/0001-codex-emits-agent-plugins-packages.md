---
status: accepted
---

# Codex emits Agent Plugins packages by default, with no dual layout

OpenAI's packaging docs make the Agent Plugins root `plugin.json` (OpenAI
settings under `extensions.com.openai`) the preferred format and keep
`.codex-plugin/plugin.json` only as a fallback. From 0.12.0 the `codex` target
therefore emits Agent Plugins packages by default. A `format: "legacy"` option
keeps the old layout for one release window, for users on Codex older than
v0.146.

We deliberately do not emit both layouts in one build. A dual layout would need
two MCP files in different shapes (`mcp.json` and `.mcp.json`) and a
`.codex-plugin` overlay that current Codex ignores whenever
`extensions.com.openai` is present. That doubles what can drift, only to serve
older clients.
