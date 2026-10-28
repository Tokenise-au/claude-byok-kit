import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ["*.js", "example/*.js", "example/*.mjs", "scripts/*.mjs"] } },
    },
  },
  {
    // The library must never print anything: a stray console.log is the easiest way to leak a key.
    files: ["src/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["example/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["example/**/*.mjs", "scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
);
