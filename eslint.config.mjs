import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "node_modules/**", "coverage/**", "esbuild.config.mjs", "vitest.config.ts", "vitest.gc.config.ts", "scripts/vendor-shared.mjs", "scripts/public-mirror.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {

      "obsidianmd/ui/sentence-case": ["warn", { brands: ["specgit", "GitHub", "Markdown", "Obsidian"], allowAutoFix: false }],
    },
  },
  {

    files: ["test/**/*.ts", "test/**/*.tsx"],
    rules: {
      "obsidianmd/prefer-create-el": "off",
      "obsidianmd/no-global-this": "off",
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/prefer-window-timers": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {

    files: ["test/stylesheet.ts"],
    rules: { "obsidianmd/no-forbidden-elements": "off" },
  },
]);
