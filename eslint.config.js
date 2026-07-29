import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "examples/basic/dist/**",
      "examples/glean/dist/**",
      "examples/glean/plugins/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Plain Node scripts run outside the TS/`@types/node` toolchain, so
    // js.configs.recommended's no-undef doesn't otherwise know these globals.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
);
