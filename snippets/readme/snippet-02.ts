import { defineConfig } from "@gleanwork/pluginpack";

export default defineConfig({
  name: "acme-plugins",
  version: "0.1.0",
  source: {
    skills: "skills",
    rootPlugin: {
      id: "core",
      description: "Acme portable skills.",
    },
  },
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
          from: ["core"],
          path: "plugins/cursor/acme",
        },
      },
    },
    claude: {
      outDir: ".",
      pluginRoot: "plugins/claude",
      plugins: {
        acme: { from: ["core"] },
      },
    },
    antigravity: {
      outDir: "plugins/antigravity",
      plugins: {
        acme: { from: ["core"] },
      },
    },
    copilot: {
      outDir: "plugins/copilot",
      plugins: {
        acme: { from: ["core"] },
      },
    },
  },
});
