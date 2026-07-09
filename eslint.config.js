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
            { target: './packages/core/src/env', from: './packages/core/src/agents' },
            { target: './packages/core/src/env', from: './packages/core/src/detect' },
            { target: './packages/core/src/detect', from: './packages/core/src/agents' },
            // config is a sibling leaf — may import agent TYPES (SupportedTool) but
            // no detection/scanner/orchestration logic.
            { target: './packages/core/src/config', from: './packages/core/src/detect' },
            { target: './packages/core/src/config', from: './packages/core/src/scan' },
            // completion renderers receive a Command from the caller; no cli-internal imports
            { target: './packages/cli/src/completion', from: './packages/cli/src/commands' },
            { target: './packages/cli/src/completion', from: './packages/cli/src/output' },
            { target: './packages/cli/src/completion', from: './packages/cli/src/help' },
            // skills domain is agent-agnostic; do not import from agents/** (except types)
            { target: './packages/core/src/skills', from: './packages/core/src/scan' },
            { target: './packages/core/src/skills', from: './packages/core/src/doctor' },
            // plugins is a leaf — no logic imports from domain modules
            // (type-only re-use from skills/types.ts is allowed)
            { target: './packages/core/src/plugins', from: './packages/core/src/agents' },
            {
              target: './packages/core/src/plugins',
              from: './packages/core/src/skills',
              except: ['./types.ts'],
            },
            { target: './packages/core/src/plugins', from: './packages/core/src/commands' },
            { target: './packages/core/src/plugins', from: './packages/core/src/scan' },
            { target: './packages/core/src/plugins', from: './packages/core/src/doctor' },
            // commands domain is agent-agnostic; same rules as skills
            // (SupportedTool type from agents/types.ts is allowed)
            {
              target: './packages/core/src/commands',
              from: './packages/core/src/agents',
              except: ['./types.ts'],
            },
            { target: './packages/core/src/commands', from: './packages/core/src/scan' },
            { target: './packages/core/src/commands', from: './packages/core/src/doctor' },
            // verify is a high-level orchestrator; leaves must not import it
            { target: './packages/core/src/skills', from: './packages/core/src/verify' },
            { target: './packages/core/src/plugins', from: './packages/core/src/verify' },
            { target: './packages/core/src/commands', from: './packages/core/src/verify' },
            // place is a high-level orchestrator; leaves must not import it. place imports verify
            // (promote gate), so verify must never import place back.
            { target: './packages/core/src/skills', from: './packages/core/src/place' },
            { target: './packages/core/src/plugins', from: './packages/core/src/place' },
            { target: './packages/core/src/commands', from: './packages/core/src/place' },
            { target: './packages/core/src/verify', from: './packages/core/src/place' },
            // acquire is the topmost core orchestrator (install/uninstall); nothing may import it back.
            { target: './packages/core/src/skills', from: './packages/core/src/acquire' },
            { target: './packages/core/src/plugins', from: './packages/core/src/acquire' },
            { target: './packages/core/src/commands', from: './packages/core/src/acquire' },
            { target: './packages/core/src/verify', from: './packages/core/src/acquire' },
            { target: './packages/core/src/place', from: './packages/core/src/acquire' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'commander', message: 'CLI-only: do not import in @skillsmith/core' },
            { name: 'chalk', message: 'CLI-only: @skillsmith/core must produce no color' },
            { name: 'consola', message: 'CLI-only: use Logger via ScanEnv in core' },
            {
              name: '@clack/prompts',
              message: 'CLI-only: @skillsmith/core must be non-interactive',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='process'][callee.property.name='exit']",
          message:
            'core must not call process.exit — return Result<_, SkillSmithError> and let the CLI decide the exit code',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='console'][callee.property.name=/^(log|info|warn|error|debug)$/]",
          message: 'core must not use console.* — accept a Logger via ScanEnv',
        },
        {
          selector: "ImportDeclaration[source.value='node:console']",
          message: 'core must not import from node:console — accept a Logger via ScanEnv',
        },
      ],
    },
  },
];
