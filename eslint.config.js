import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

/**
 * Waqyay ESLint flat config (ESLint v9).
 * - typescript-eslint recommended
 * - React 19 rules + hooks + react-refresh (HMR safety with Vite)
 * - simple-import-sort: ordena imports/exports automaticamente
 * - eslint-config-prettier va AL FINAL para desactivar reglas que chocan con Prettier
 */
export default tseslint.config(
  { ignores: ["dist", "src-tauri/target", "node_modules"] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat["jsx-runtime"],
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Vite HMR: solo exports de componentes desde archivos de componentes
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],

      // React 19: no necesitamos importar React explicitamente
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",

      // Imports ordenados automaticamente via `pnpm lint --fix`
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",

      // TS: permitir _prefix para args no usados (convencion)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // shadcn exporta variants/helpers junto al componente (buttonVariants,
  // badgeVariants, etc). Es un patron estandar del upstream, silenciamos
  // el warning de react-refresh solo para ui/.
  {
    files: ["src/shared/components/ui/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  // Debe ir al final: desactiva reglas de estilo que chocan con Prettier
  eslintConfigPrettier,
);
