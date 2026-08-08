// Flat ESLint config (advisory). Non-type-aware for speed on a monorepo; the
// noisy stylistic rules are downgraded to warnings so lint is a burn-down list,
// not a wall. The web/voice React apps have their own toolchains and are ignored
// here. `tsc --noEmit` (pnpm typecheck) remains the hard correctness gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.userdata/**',
      'apps/web/**',
      'apps/voice/**',
      'infra/migrations/**',
      'logs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off', // .cjs config files legitimately use require()
      'no-undef': 'off', // TypeScript already resolves identifiers; this rule false-positives on TS/DOM globals
      'no-control-regex': 'off', // we intentionally match control chars (ANSI strip, shell metacharacters)
      'no-useless-assignment': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },
);
