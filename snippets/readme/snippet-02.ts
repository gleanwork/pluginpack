import { defineConfig } from "@gleanwork/pluginpack";

export default defineConfig({
  name: "acme-plugins",
  version: "0.1.0",
  metadata: {
    description: "Acme agent plugins.",
    author: { name: "Acme" },
    license: "MIT",
  },
  targets: {
    cursor: {
      outDir: ".",
      plugins: {
        acme: {
          source: "shared/acme",
          overrides: "overrides/cursor/acme",
          path: "plugins/cursor/acme",
        },
      },
    },
    claude: {
      outDir: ".",
      pluginRoot: "plugins/claude",
      plugins: {
        acme: { source: "shared/acme" },
      },
    },
    antigravity: {
      outDir: "plugins/antigravity",
      plugins: {
        acme: { source: "shared/acme" },
      },
    },
    copilot: {
      outDir: "plugins/copilot",
      plugins: {
        acme: { source: "shared/acme" },
      },
    },
    codex: {
      outDir: "plugins/codex",
      plugins: {
        acme: { source: "shared/acme" },
      },
    },
  },
});
