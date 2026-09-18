import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Lint flat (ESLint 9) — baseline: recomendado do JS + typescript-eslint. [hardening T3]
export default tseslint.config(
  { ignores: ["dist/**", "vendor/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // args/vars com prefixo _ são intencionalmente não usados (padrão já presente no código)
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
