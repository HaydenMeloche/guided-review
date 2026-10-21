// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '.scratch/', '.gr-dev/', '.claude/'] },

  // Plain JS (bin/, eslint.config.js): syntax-level rules only.
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // TypeScript sources and tests: type-aware rules.
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      // The code deliberately matches control characters: it strips terminal escapes and C0
      // controls from untrusted PR text and model output (util/sanitize.ts, agent/guard.ts).
      'no-control-regex': 'off',
      // Async functions with no await are used on purpose to satisfy Promise-returning
      // signatures (SDK hooks and canUseTool callbacks, fakes in tests) and keep throws as rejections.
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Tests: fakes inspect JSON request bodies (JSON.parse returns any) and partial mocks.
  // Asserting on untyped payloads is the point of those tests, so the no-unsafe-* family is off here.
  {
    files: ['test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Keep formatting concerns with Prettier.
  prettier,
);
