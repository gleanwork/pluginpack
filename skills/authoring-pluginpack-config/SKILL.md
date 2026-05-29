---
name: authoring-pluginpack-config
description: Use when someone wants to ship one set of agent skills/plugins to multiple AI apps (Claude Code, Cursor, Gemini CLI, GitHub Copilot) from a single source, and needs to create or update a pluginpack.config.ts — choosing targets, source layout, MCP servers, and output directories.
---

# Authoring a pluginpack config

pluginpack compiles one portable source into each app's native plugin format.
The config (`pluginpack.config.ts`) declares the source layout and the targets
to emit.

## Fastest start

`npx @gleanwork/pluginpack init` scaffolds a `pluginpack.config.ts` and an
example source plugin. Then edit to taste.

## Config shape

```ts
import { defineConfig } from "@gleanwork/pluginpack";

export default defineConfig({
  name: "acme-plugins",
  version: "0.1.0",
  source: {
    // Recommended: portable skills at the repo-level skills/ directory.
    skills: "skills",
    rootPlugin: { id: "core", description: "Acme portable skills." },
    // Alternatively, richer source plugins live under plugins/<id>/.
    // plugins: "plugins",
  },
  metadata: {
    description: "Acme agent plugins.",
    author: { name: "Acme" },
    owner: { name: "Acme", email: "support@acme.com" },
    license: "MIT",
  },
  targets: {
    cursor: {
      outDir: ".",
      plugins: {
        acme: {
          from: ["core"],
          path: "plugins/cursor/acme",
          components: ["skills"],
        },
      },
    },
    claude: {
      outDir: ".",
      pluginRoot: "plugins/claude",
      plugins: { acme: { from: ["core"] } },
    },
    gemini: { outDir: "plugins/gemini", plugins: { acme: { from: ["core"] } } },
    copilot: {
      outDir: "plugins/copilot",
      plugins: { acme: { from: ["core"] } },
    },
  },
});
```

- `source.skills` is the portable surface; `source.rootPlugin.id` is the source
  plugin name targets reference via `from`.
- Each emitted plugin's `from` lists the source plugin id(s) to include; multiple
  ids merge (a colliding file path is an error).
- `path` / `pluginRoot` control where a target places the emitted plugin.

## Critical: avoid output collisions

`claude` and `copilot` both write `.claude-plugin/marketplace.json`, so they
cannot share an `outDir`. Give them distinct roots (e.g. claude at `.`, copilot
at `plugins/copilot`). `pluginpack build` errors on overlapping output paths.

## MCP servers

Add a `.mcp.json` (`{ "mcpServers": { "name": { ... } } }`) at the source plugin
root, or an `mcpServers` key in `plugin.pluginpack.json`. pluginpack wires it
into each target natively.

## Verify

After editing: `pluginpack build` then `pluginpack validate --target <t>`. See
the build-and-verify skill.
