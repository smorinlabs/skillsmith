import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

const unwrapTypeScriptExpression = (node) => {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }
  return current;
};

export const hermeticTestSpawnRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missingHermeticEnv:
        'test Bun.spawn/Bun.spawnSync options must include env: hermeticGitEnv(...) to isolate Git state and config',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'Bun'
        ) {
          return;
        }

        const method = callee.computed
          ? callee.property.type === 'Literal' && typeof callee.property.value === 'string'
            ? callee.property.value
            : null
          : callee.property.type === 'Identifier'
            ? callee.property.name
            : null;
        if (method !== 'spawn' && method !== 'spawnSync') return;

        const options = unwrapTypeScriptExpression(node.arguments[1]);
        const hasHermeticEnv =
          options?.type === 'ObjectExpression' &&
          options.properties.some(
            (property) =>
              property.type === 'Property' &&
              !property.computed &&
              property.key.type === 'Identifier' &&
              property.key.name === 'env' &&
              property.value.type === 'CallExpression' &&
              property.value.callee.type === 'Identifier' &&
              property.value.callee.name === 'hermeticGitEnv',
          );

        if (!hasHermeticEnv) context.report({ node, messageId: 'missingHermeticEnv' });
      },
    };
  },
};

const importedName = (specifier) => {
  if (specifier.type !== 'ImportSpecifier') return null;
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : String(specifier.imported.value);
};

const memberName = (node) => {
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return node.computed && node.property.type === 'Literal' ? String(node.property.value) : null;
};

export const capabilityOwnershipRule = {
  meta: {
    type: 'problem',
    schema: [],
    docs: {
      description:
        'Own process.env, process.cwd, process.getuid, ScanEnv, RuntimePorts, Date.now, Math.random, randomUUID, fetch, and ports/default',
    },
    messages: { forbidden: '{{capability}} belongs to the runtime capability adapter' },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    const is = (suffix) => filename.endsWith(suffix);
    const defaultAdapter = is('/packages/core/src/ports/default.ts');
    const httpAdapter = is('/packages/core/src/ports/http.ts');
    const rawRuntimeComposition =
      is('/packages/cli/src/runtime/context.ts') || is('/packages/cli/src/runtime/environment.ts');
    const scanEnvOwner =
      is('/packages/core/src/env/types.ts') ||
      is('/packages/core/src/env/default.ts') ||
      is('/packages/core/src/ports/compatibility.ts');
    const runtimePortsOwner =
      defaultAdapter ||
      is('/packages/core/src/ports/types.ts') ||
      is('/packages/core/src/ports/compatibility.ts') ||
      is('/packages/core/src/application/types.ts') ||
      is('/packages/cli/src/runtime/context.ts');
    const defaultAdapterConsumer =
      is('/packages/core/src/env/default.ts') || is('/packages/core/src/index.ts');
    const report = (node, capability) =>
      context.report({ node, messageId: 'forbidden', data: { capability } });

    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        const names = node.specifiers.map(importedName);
        if (names.includes('ScanEnv') && !scanEnvOwner) report(node, 'ScanEnv');
        if (names.includes('RuntimePorts') && !runtimePortsOwner) report(node, 'RuntimePorts');
        if (/ports\/default(?:\.ts)?$/.test(source) && !defaultAdapterConsumer)
          report(node, 'ports/default');
        if (
          (/^node:(?:fs|os)(?:\/|$)/.test(source) || source === 'proper-lockfile') &&
          !defaultAdapter
        )
          report(node, source);
      },
      MemberExpression(node) {
        const property = memberName(node);
        if (node.object.type === 'Identifier' && node.object.name === 'process') {
          if (
            (property === 'env' || property === 'cwd') &&
            !defaultAdapter &&
            !rawRuntimeComposition
          )
            report(node, `process.${property}`);
          if (property === 'getuid' && !defaultAdapter) report(node, 'process.getuid');
        }
        if (
          node.object.type === 'Identifier' &&
          ((node.object.name === 'Date' && property === 'now') ||
            (node.object.name === 'Math' && property === 'random') ||
            (node.object.name === 'crypto' && property === 'randomUUID')) &&
          !defaultAdapter
        )
          report(node, `${node.object.name}.${property}`);
        if (
          node.object.type === 'Identifier' &&
          node.object.name === 'Bun' &&
          (property === 'spawn' || property === 'spawnSync') &&
          !defaultAdapter
        )
          report(node, `Bun.${property}`);
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'fetch' && !httpAdapter)
          report(node, 'fetch');
      },
    };
  },
};

export default [
  {
    ignores: ['**/node_modules/**', 'dist/**', 'docs/**', 'research/**', 'scripts/**', '**/*.d.ts'],
  },
  {
    files: ['packages/*/tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      skillsmith: {
        rules: { 'hermetic-test-spawn': hermeticTestSpawnRule },
      },
    },
    rules: {
      // Test children can run outside the bunfig preload (direct package commands,
      // hooks, or one-off files), so every spawn must isolate Git state and config itself.
      'skillsmith/hermetic-test-spawn': 'error',
    },
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
      skillsmith: {
        rules: { 'capability-ownership': capabilityOwnershipRule },
      },
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
      'skillsmith/capability-ownership': 'error',
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './packages/core/src', from: './packages/cli' },
            {
              target: './packages/cli/src',
              from: './packages/core/src',
              // CLI consumes core only through reviewed package entry points. Versioned wire
              // contracts intentionally remain separate from the 1.x compatibility root.
              except: [
                './index.ts',
                './contracts/index.ts',
                './contracts/index.d.ts',
                './contracts/v1/index.ts',
                './contracts/v1/index.d.ts',
                './contracts/v2/index.ts',
                './contracts/v2/index.d.ts',
                './contracts/v3/index.ts',
                './contracts/v3/index.d.ts',
              ],
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
            // The shared runtime may depend on pure compatibility helpers, but it must never
            // rediscover command-local action implementations.
            { target: './packages/cli/src/runtime', from: './packages/cli/src/commands' },
            { target: './packages/cli/src/program.ts', from: './packages/cli/src/commands' },
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
            // Application services are the top core orchestration layer. Domain modules,
            // adapters, and codecs may be composed by applications but must not import them.
            { target: './packages/core/src/acquire', from: './packages/core/src/application' },
            { target: './packages/core/src/agents', from: './packages/core/src/application' },
            { target: './packages/core/src/commands', from: './packages/core/src/application' },
            { target: './packages/core/src/config', from: './packages/core/src/application' },
            { target: './packages/core/src/context', from: './packages/core/src/application' },
            { target: './packages/core/src/detect', from: './packages/core/src/application' },
            { target: './packages/core/src/doctor', from: './packages/core/src/application' },
            { target: './packages/core/src/env', from: './packages/core/src/application' },
            { target: './packages/core/src/place', from: './packages/core/src/application' },
            { target: './packages/core/src/plugins', from: './packages/core/src/application' },
            { target: './packages/core/src/scan', from: './packages/core/src/application' },
            { target: './packages/core/src/selection', from: './packages/core/src/application' },
            { target: './packages/core/src/skills', from: './packages/core/src/application' },
            { target: './packages/core/src/verify', from: './packages/core/src/application' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/cli/src/commands/**/*.ts'],
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
            { name: 'commander', message: 'Commander declarations belong to CommandSpec runtime' },
            { name: '@clack/prompts', message: 'prompts belong to the shared interaction adapter' },
            {
              name: '@skillsmith/core',
              importNames: ['defaultScanEnv'],
              message: 'environment discovery belongs to the shared runtime context adapter',
            },
          ],
          patterns: [
            { group: ['../output/**', '../../output/**'], message: 'rendering belongs to runtime' },
            {
              group: [
                '**/runtime/context',
                '**/runtime/context.*',
                '**/runtime/environment',
                '**/runtime/environment.*',
                '**/runtime/interaction',
                '**/runtime/interaction.*',
                '**/runtime/io',
                '**/runtime/io.*',
                '**/runtime/adapter',
                '**/runtime/adapter.*',
                '**/runtime/current-renderers',
                '**/runtime/current-renderers.*',
                '**/runtime/command-spec',
                '**/runtime/command-spec.*',
                '**/runtime/preflight',
                '**/runtime/preflight.*',
                '**/spec',
                '**/spec/**',
              ],
              message: 'runtime composition and command declarations belong to the shared runtime',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='process'][property.name=/^(exit|stdout|stderr|stdin|env|cwd)$/]",
          message: 'process policy belongs to the shared runtime context and IO adapters',
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
