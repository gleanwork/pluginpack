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
    antigravity: {
      outDir: "plugins/antigravity",
      plugins: {
        acme: {
          source: "shared/acme",
          include: ["skills", "commands", "static"],
        },
      },
    },
    claude: {
      outDir: "plugins/claude",
      plugins: {
        acme: { source: "shared/acme", exclude: ["commands"] },
      },
    },
  },
});
