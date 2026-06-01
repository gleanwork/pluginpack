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
    gemini: {
      outDir: "plugins/gemini",
      plugins: {
        acme: { from: ["core"], components: ["skills", "commands"] },
      },
    },
    claude: {
      outDir: "plugins/claude",
      plugins: {
        acme: { from: ["core"], components: ["skills"] },
      },
    },
  },
});
