---
status: proposed
---

# One package for several clients

Codex, GitHub Copilot, VS Code and Cursor all read Agent Plugins packages. A
plugin built once as a package can serve all of them, if each client also gets
its marketplace file and any client-only files. Before this change, the
`codex` target built a package with one client's profile and marketplace, and
the `agent-plugins` target built packages with none.

We add `clients` to the `agent-plugins` target instead of adding a target per
client or a list of clients to `codex`. Each listed client contributes:

- a marketplace file at the path it reads (Codex
  `.agents/plugins/marketplace.json`, Copilot `.github/plugin/marketplace.json`),
- its client-only content kinds, written to its extension directory (Copilot
  agents in `com.github.copilot/agents/`, renamed to `NAME.agent.md`).

The package itself (`plugin.json`, `mcp.json`, `skills/`) is identical for
every client, and the spec requires clients to ignore other clients'
namespaces. So the output has no per-client copies of the package that could
drift.

Manifest data for a client goes under `manifest.extensions["<namespace>"]`
explicitly. The `codex` target moves non-portable top-level fields into
`com.openai` automatically, because it serves one client. A package that
serves several clients can't know which one a field is for, so that stays a
build error.

The `codex` target stays for builds that serve only Codex, including
`format: "legacy"`. Claude Code doesn't read Agent Plugins, so it isn't a
package client; adding its manifest to the same directory is separate work.
