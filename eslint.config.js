import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'docs/**',
      'research/**',
      'scripts/**',
      'packages/*/tests/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
      },
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './packages/core/src', from: './packages/cli' },
            {
              target: './packages/cli/src',
              from: './packages/core/src',
              except: ['./index.ts'],
            },
            { target: './packages/cli/src/output', from: './packages/cli/src/commands' },
            { target: './packages/cli/src/output', from: './packages/cli/src/index.ts' },
            { target: './packages/cli/src/help', from: './packages/cli/src/commands' },
            { target: './packages/cli/src/help', from: './packages/cli/src/output' },
            { target: './packages/cli/src/help', from: './packages/cli/src/index.ts' },
            { target: './packages/cli/src/util', from: './packages/cli/src/commands' },
            { target: './packages/cli/src/util', from: './packages/cli/src/output' },
            { target: './packages/cli/src/util', from: './packages/cli/src/help' },
            { target: './packages/cli/src/util', from: './packages/cli/src/index.ts' },
          ],
        },
      ],
    },
  },
];
