// eslint.config.js — flat config (ESLint 9)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      '.wrangler/**',
      'examples/**',
      'scripts/**',
      '*.config.js',
      '*.config.ts',
      '*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Honor the leading-underscore convention for intentionally-unused args/vars
    // (e.g. `_ctx: ExecutionContext` in the Worker fetch handler).
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test stubs legitimately use `any` to construct minimal Env/binding fakes.
    files: ['__tests__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // The GAM canary/rollback composite action's modules run on the ACTIONS RUNNER under Node,
    // not in the Worker runtime, so they legitimately use Node globals. Without this block
    // `no-undef` (from js.configs.recommended) flags every `process`/`console`/timer/fetch use.
    // Declared explicitly rather than via the `globals` package to avoid adding a devDependency.
    files: ['.github/actions/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
