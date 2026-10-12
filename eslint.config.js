import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";
import hooks from "eslint-plugin-react-hooks";
export default ts.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-electron/**",
      "release/**",
      ".tools/**",
      "windows/**",
      "test-results/**",
    ],
  },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: hooks.configs.recommended.rules,
  },
);
