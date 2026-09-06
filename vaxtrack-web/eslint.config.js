import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'functions/node_modules']),
  // Cloud Functions are Node CommonJS, not browser modules. Without this they
  // lint against browser globals and every `require`/`module`/`process` reads
  // as undefined — so the trusted server boundary would go unchecked.
  {
    files: ['functions/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
      ecmaVersion: 2023,
    },
  },
  {
    files: ['functions/**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
  {
    files: ['src/**/*.{js,jsx}', 'tests/**/*.js', '*.js'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
])
