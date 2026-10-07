// ESLint flat config for the ProA 2.0 workspace. ESLint looks it up from the
// linted file's directory upwards, so `eslint .` inside any package uses it.
// TypeScript files are linted type-aware through the TypeScript project
// service (each file's nearest tsconfig.json).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    // 1.x tree (frozen until the cut-over, CONCEPT §9)
    'backend/',
    'frontend/',
    'scripts/',
    '.claude/',
    '.playwright-mcp/',
    // generated
    'packages/client/src/generated/',
    'apps/server/drizzle/',
    'eval/corpus/',
    // deliberate violations and inputs for tests
    '**/test/fixtures/',
  ]),

  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    // The bundle gets types from the contracts, never their zod schemas: use
    // the generated @proa/client types (constants are mirrored in src/lib/limits.ts).
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@proa/contracts',
              message: 'Import types from @proa/client; constants live in src/lib/limits.ts.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // shadcn components export their variants; TanStack route modules export
    // route objects next to their page components (full reload on change).
    files: ['apps/web/src/components/ui/**/*.tsx', 'apps/web/src/routes/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
);
