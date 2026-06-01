---
name: migrate-to-pluginpack
description: Use when someone has an existing native plugin repo (a Claude Code marketplace, a Cursor plugin, an Antigravity CLI plugin, or a GitHub Copilot plugin) and wants to manage it from one portable source via pluginpack — generating the source layout and config, then proving the output matches the original with diff.
---

# Migrating an existing plugin repo into pluginpack

Goal: stop hand-maintaining a native plugin repo by generating it from portable
source, verified byte-for-byte against the original.

## Steps

1. **Inspect the existing repo.** Note its marketplace manifest
   (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, …),
   the per-plugin layout, and the skill/agent/command/hook/MCP content.

2. **Create portable source.** Put skills under a repo-level `skills/` directory
   (or richer plugins under `plugins/<id>/` with `skills/`, `agents/`,
   `commands/`, `rules/`, `hooks/`, `assets/`). Add `plugin.pluginpack.json` for
   per-plugin metadata and a `.mcp.json` for MCP servers. Where a file must
   differ per app, add `targets/<target>/<file>` next to the base file.

3. **Write the config** targeting that app, mapping source → emitted plugin via
   `from`, and `path`/`pluginRoot` to reproduce the original directory layout.
   See the authoring-pluginpack-config skill.

4. **Build and diff until clean:**

   ```bash
   pluginpack build --target claude
   pluginpack diff --target claude --against ../claude-plugins
   ```

   Iterate on the source/config until `diff` exits 0. For paths the generated
   repo legitimately owns (license, CI, hand-written README), add them to the
   target's `ignoredDiffPaths`.

5. **Wire diff into CI** in the generated repo so future source changes that
   aren't regenerated are caught.

Tip: migrate one target at a time; `diff` is the source of truth for fidelity.
