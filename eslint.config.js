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
);
