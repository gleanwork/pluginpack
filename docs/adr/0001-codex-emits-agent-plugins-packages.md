---
status: accepted
---

# Codex emits Agent Plugins packages by default, with no dual layout

OpenAI's packaging docs make the Agent Plugins root `plugin.json` (OpenAI
settings under `extensions.com.openai`) the preferred format and keep
`.codex-plugin/plugin.json` only as a fallback. From 0.12.0 the `codex` target
therefore emits Agent Plugins packages by default.

A `format: "legacy"` option keeps the old layout for users on Codex releases
older than 0.147.0. Codex 0.146.0 reads an Agent Plugins `plugin.json`, but
0.147.0 is the first release that installs Agent Plugins packages and reads
their `mcp.json`
([release notes](https://github.com/openai/codex/releases/tag/rust-v0.147.0)).
`format: "legacy"` is deprecated in 0.12 and will be removed in 0.13. A build
that uses it prints a deprecation warning.

We deliberately do not emit both layouts in one build. A dual layout would need
two MCP files in different shapes (`mcp.json` and `.mcp.json`) and a
`.codex-plugin` overlay that current Codex ignores whenever
`extensions.com.openai` is present. That doubles what can drift, only to serve
older clients.
