import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { currentWireCodecs } from '../../../packages/cli/src/contracts/wire-contracts.ts';
import { renderFlipHuman } from '../../../packages/cli/src/output/flip-human.ts';
import { renderFlipJson } from '../../../packages/cli/src/output/flip-json.ts';
import { renderInstallHuman } from '../../../packages/cli/src/output/install-human.ts';
import { renderInstallJson } from '../../../packages/cli/src/output/install-json.ts';
import { renderVerifyHuman } from '../../../packages/cli/src/output/verify-human.ts';
import { renderVerifyJson } from '../../../packages/cli/src/output/verify-json.ts';
import { createAcquisitionRepositoryLifecycleControllerV1 } from '../../../packages/core/src/acquire/execute.ts';
import {
  FLIP_TOOLS,
  SUPPORTED_TOOLS,
  VERIFIED_AGAINST,
  VERIFY_TOOLS,
  createToolRegistry,
  toolRegistry,
} from '../../../packages/core/src/agents/registry.ts';
import { createLifecycleApplicationServices } from '../../../packages/core/src/application/lifecycle-services.ts';
import { runVerifyApplication } from '../../../packages/core/src/application/read-services.ts';
import { NO_MUTATION } from '../../../packages/core/src/application/types.ts';
import { resolveRuntimeConfiguration } from '../../../packages/core/src/config/runtime.ts';
import { executeOperationPlan } from '../../../packages/core/src/execution/coordinator.ts';
import { createExecutionPrecondition } from '../../../packages/core/src/execution/preconditions.ts';
import {
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
} from '../../../packages/core/src/planning/create.ts';
import { validateSelectionRequest } from '../../../packages/core/src/selection/resolve.ts';
import {
  createCapabilityStateReaderV1,
  stageLogicalRepositoryEditV1,
} from '../../../packages/core/src/state/repositories.ts';
import { createExpectedRevisionV1 } from '../../../packages/core/src/state/types.ts';
import { runVerify } from '../../../packages/core/src/verify/run.ts';
import {
  FIXTURE_P3B_READ_TOOL,
  readOnlyFixtureAdapter,
} from '../fixtures/p3b-ts06/read-only-adapter.ts';
import {
  FIXTURE_P3B_ALTERNATE_NOTICE,
  FIXTURE_P3B_DEEP_COVERAGE_SUFFIX,
  FIXTURE_P3B_WRITE_TOOL,
  fixtureP3bInstallStaticNotice,
  writeFixtureAdapter,
} from '../fixtures/p3b-ts06/write-adapter.ts';

type UnknownRecord = Record<string, unknown>;
type AnyFunction = (...args: unknown[]) => unknown;

const ROOT = resolve(import.meta.dir, '../../..');
const absolute = (path: string): string => join(ROOT, path);
const present = (path: string): boolean => existsSync(absolute(path));
const source = (path: string): string =>
  present(path) ? readFileSync(absolute(path), 'utf8') : '';
const executableSource = (path: string): string =>
  source(path)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '');
const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
const asFunction = (value: unknown): AnyFunction | null =>
  typeof value === 'function' ? (value as AnyFunction) : null;
const optionalModule = async (path: string): Promise<UnknownRecord | null> =>
  present(path) ? ((await import(pathToFileURL(absolute(path)).href)) as UnknownRecord) : null;
const assertNoIssues = (issues: readonly string[]): void => {
  expect(issues, issues.join('\n')).toEqual([]);
};

const bindingNameContains = (name: ts.BindingName, expected: string): boolean => {
  if (ts.isIdentifier(name)) return name.text === expected;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name, expected),
  );
};

const shadowsProductionAuthority = (identifier: ts.Identifier, authority: string): boolean => {
  let child: ts.Node = identifier;
  let parent: ts.Node | undefined = identifier.parent;
  while (parent !== undefined) {
    if (
      ts.isFunctionLike(parent) &&
      parent.parameters.some((parameter) => bindingNameContains(parameter.name, authority))
    ) {
      return true;
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      for (const statement of parent.statements) {
        if (statement.pos >= child.pos) break;
        if (
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((declaration) =>
            bindingNameContains(declaration.name, authority),
          )
        ) {
          return true;
        }
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
};
const utf8Fingerprint = (value: string): readonly [number, string] =>
  Object.freeze([
    Buffer.byteLength(value, 'utf8'),
    createHash('sha256').update(value).digest('hex'),
  ]);

const declarationHasTypeParameters = (path: string, name: string): boolean => {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ((ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node)) &&
        node.name?.text === name &&
        (node.typeParameters?.length ?? 0) > 0) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
        (node.initializer.typeParameters?.length ?? 0) > 0)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

const doubleCastTargets = (path: string): readonly string[] => {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  const targets: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isAsExpression(node) &&
      ts.isAsExpression(node.expression) &&
      node.expression.type.getText(file) === 'unknown'
    ) {
      targets.push(node.type.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return targets;
};

const fixtureRegistry = () =>
  createToolRegistry([readOnlyFixtureAdapter, writeFixtureAdapter] as const);

const ENV = Object.freeze({
  homeDir: '/home/fixture',
  executableSearchPath: Object.freeze([]),
  platform: 'linux' as const,
  xdg: Object.freeze({
    config: '/xdg/config',
    data: '/xdg/data',
    cache: '/xdg/cache',
  }),
});
const CTX = Object.freeze({
  cwd: '/workspace/project',
  configuration: resolveRuntimeConfiguration({}),
});

type VirtualNode = Readonly<{ kind: 'dir' }> | Readonly<{ kind: 'symlink'; target: string }>;

const virtualPlacementPorts = (nodes: Readonly<Record<string, VirtualNode>>) => {
  const paths = Object.keys(nodes);
  return {
    ...ENV,
    fileExists: async (path: string) =>
      Object.hasOwn(nodes, path) || paths.some((candidate) => candidate.startsWith(`${path}/`)),
    pathKind: async (path: string) => nodes[path]?.kind ?? ('absent' as const),
    realpath: async (path: string) => path,
    listDir: async (path: string) =>
      paths
        .filter((candidate) => candidate.startsWith(`${path}/`))
        .map((candidate) => candidate.slice(path.length + 1).split('/')[0])
        .filter(
          (name, index, values): name is string =>
            name !== undefined && values.indexOf(name) === index,
        ),
    readText: async () => '',
    readBytes: async () => new Uint8Array(),
    readLink: async (path: string) => (nodes[path]?.kind === 'symlink' ? nodes[path].target : ''),
    isExecutable: async () => false,
    modifiedAt: async () => null,
  };
};

const emptyPlanInput = (command: string, tool: string) => ({
  domain: 'skillsmith.operation-plan',
  schemaVersion: 1,
  command,
  selection: {
    source: 'explicit-targets',
    skills: ['alpha'],
    tools: [tool],
    scopes: ['user'],
  },
  batchPolicy: 'fail-fast',
  operations: [],
  checks: [],
  diagnostics: [],
});

const lifecycleSources = Object.freeze([
  'packages/core/src/application/lifecycle-services.ts',
  'packages/core/src/selection/resolve.ts',
  'packages/core/src/acquire/run.ts',
  'packages/core/src/acquire/plan.ts',
  'packages/core/src/place/run.ts',
  'packages/core/src/place/plan.ts',
  'packages/core/src/planning/create.ts',
  'packages/core/src/planning/order.ts',
]);

const installReportFor = (tool: string) => ({
  dryRun: false,
  requested: {
    sources: ['fixture/repo/alpha'],
    tools: [tool],
    explicitTools: true,
    scope: 'user',
    explicitScope: true,
    ref: null,
    pin: false,
    direct: false,
    force: false,
    verify: 'static',
    deep: false,
  },
  results: [
    {
      source: 'fixture/repo/alpha',
      skill: 'alpha',
      tool,
      scope: 'user',
      placementPath: `/home/fixture/${tool}/alpha`,
      action: 'installed',
      reason: null,
      placement: 'symlink',
      store: null,
      origin: null,
      verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
      candidates: null,
    },
  ],
  summary: {
    installed: 1,
    updated: 0,
    repaired: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
  },
});

const verifyReportFor = (tool: string) => ({
  schemaVersion: 1,
  target: { path: '/fixture/plugin', kind: 'plugin' },
  requested: {
    tools: [tool],
    modes: ['static', 'deep'],
    strict: true,
    explicitTools: true,
  },
  verifiedAgainst: { [tool]: 'fixture-version' },
  summary: {
    verdict: 'pass',
    verified: [tool],
    failed: [],
    skipped: [],
    counts: { error: 0, warning: 0, info: 0 },
  },
  tools: [
    {
      tool,
      available: true,
      toolVersion: 'fixture-version',
      versionDrift: false,
      skipReason: null,
      verdict: 'pass',
      modes: [
        {
          mode: 'deep',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict: 'pass',
          command: 'fixture verify --deep',
          findings: [],
        },
      ],
    },
  ],
});

const flipReportFor = (tool: string, op: 'dev' | 'promote') => ({
  op,
  dryRun: false,
  requested: { targets: ['alpha'], all: false, tools: [tool], explicitTools: true },
  plan: emptyPlanInput(op, tool),
  executionResults: [],
  results: [
    {
      skill: 'alpha',
      tool,
      placementPath: `/home/fixture/${tool}/alpha`,
      action: op === 'dev' ? 'created' : 'updated',
      reason: null,
      before: null,
      after:
        op === 'dev'
          ? { mode: 'dev', symlinkTarget: '/workspace/alpha' }
          : { mode: 'pinned', storePath: '/store/alpha' },
      store: null,
      verify: { gate: 'passed', verdict: 'pass' },
    },
  ],
  summary: {
    flipped: 0,
    updated: op === 'promote' ? 1 : 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
    rolledBack: 0,
    created: op === 'dev' ? 1 : 0,
    adopted: 0,
  },
});

describe('EWP-P3B-TS06 family 1 — static lifecycle authority', () => {
  test('EWP-P3B-TS06 characterization: built-in adapter imports stay centralized', async () => {
    const violations: string[] = [];
    const glob = new Bun.Glob('packages/{core,cli}/src/**/*.ts');
    for await (const path of glob.scan({ cwd: ROOT })) {
      if (path === 'packages/core/src/agents/registry.ts') continue;
      if (
        /from\s+['"][^'"]*\/agents\/(?:claude-code|codex|kilo-code|opencode)(?:\/|['"])/u.test(
          executableSource(path),
        )
      ) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });

  test('EWP-P3B-TS06 red: generic kernels have no known-tool, global, or root-ordinal policy', () => {
    const issues: string[] = [];
    const productionAuthorities = new Set(['toolRegistry', 'SUPPORTED_TOOLS', 'FLIP_TOOLS']);
    const knownToolPolicy =
      /(?:===|!==|case\s+|\.includes\()\s*['"](?:claude-code|codex|kilo-code|opencode)['"]/gu;
    for (const path of lifecycleSources) {
      const text = executableSource(path);
      const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
      let forbiddenBodyRead = false;
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          productionAuthorities.has(node.text) &&
          !shadowsProductionAuthority(node, node.text)
        ) {
          let current: ts.Node | undefined = node.parent;
          let allowedComposition = false;
          while (current !== undefined && !ts.isSourceFile(current)) {
            if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) {
              allowedComposition = true;
              break;
            }
            if (
              ts.isParameter(current) &&
              current.initializer !== undefined &&
              node.getStart(file) >= current.initializer.getStart(file) &&
              node.getEnd() <= current.initializer.getEnd()
            ) {
              allowedComposition = true;
              break;
            }
            if (ts.isTypeNode(current)) {
              allowedComposition = true;
              break;
            }
            if (
              ts.isCallExpression(current) &&
              current.arguments.some(
                (argument) =>
                  node.getStart(file) >= argument.getStart(file) &&
                  node.getEnd() <= argument.getEnd(),
              )
            ) {
              let wrapper: ts.Node | undefined = current.parent;
              while (wrapper !== undefined && !ts.isSourceFile(wrapper)) {
                if (ts.isFunctionLike(wrapper)) break;
                wrapper = wrapper.parent;
              }
              if (wrapper !== undefined && ts.isFunctionLike(wrapper)) {
                if (
                  ts.canHaveModifiers(wrapper) &&
                  ts
                    .getModifiers(wrapper)
                    ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
                ) {
                  allowedComposition = true;
                } else {
                  let declaration: ts.Node | undefined = wrapper.parent;
                  while (
                    declaration !== undefined &&
                    !ts.isVariableStatement(declaration) &&
                    !ts.isSourceFile(declaration)
                  ) {
                    declaration = declaration.parent;
                  }
                  if (
                    declaration !== undefined &&
                    ts.isVariableStatement(declaration) &&
                    ts
                      .getModifiers(declaration)
                      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
                  ) {
                    allowedComposition = true;
                  }
                }
              }
              if (allowedComposition) break;
            }
            current = current.parent;
          }
          if (!allowedComposition) forbiddenBodyRead = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (forbiddenBodyRead) issues.push(`${path} reads production authority in generic code`);
      if (knownToolPolicy.test(text)) issues.push(`${path} contains executable known-tool policy`);
      knownToolPolicy.lastIndex = 0;
    }
    const acquire = executableSource('packages/core/src/acquire/run.ts');
    if (/skillRootsFor\([^;]+?\)\[0\]/su.test(acquire)) {
      issues.push('packages/core/src/acquire/run.ts selects a destination by root ordinal [0]');
    }
    if (/skillRootsFor\([^;]+?\)\.slice\(1\)/su.test(acquire)) {
      issues.push('packages/core/src/acquire/run.ts treats slice(1) roots as legacy policy');
    }
    const place = executableSource('packages/core/src/place/plan.ts');
    if (/currentRoot:\s*roots\[0\]/u.test(place) || /legacyRoot:\s*roots\[1\]/u.test(place)) {
      issues.push(
        'packages/core/src/place/plan.ts rebuilds destination/legacy roles from ordinals',
      );
    }
    if (
      /from\s+['"]\.\.\/claude-code\/skill-roots\.ts['"]/u.test(
        executableSource('packages/core/src/agents/codex/placement.ts'),
      )
    ) {
      issues.push('codex placement imports a sibling adapter SkillRootsCtx authority');
    }
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 2 — registry-bound selection and exits', () => {
  test('EWP-P3B-TS06 characterization: registry distinguishes unknown 2 from unsupported 4', () => {
    expect(toolRegistry.capability('missing-fixture', 'install')).toMatchObject({
      code: 'usage',
      exitCode: 2,
    });
    for (const tool of ['kilo-code', 'opencode']) {
      expect(toolRegistry.capability(tool, 'install')).toMatchObject({
        code: 'capability',
        exitCode: 4,
      });
    }
  });

  test('EWP-P3B-TS06 red: selection accepts a novel registered writable tool', () => {
    const registry = fixtureRegistry();
    const validate = validateSelectionRequest as unknown as AnyFunction;
    const result = asRecord(
      validate(
        {
          targets: ['alpha'],
          all: false,
          tools: [FIXTURE_P3B_WRITE_TOOL],
          scopes: ['user'],
          capability: 'install',
        },
        {
          requiresSelection: true,
          allowBoundedDefault: false,
          allowAbsentCreate: true,
          allowedTools: registry.toolsFor('install'),
          allowedScopes: ['user', 'project'],
          allowedCapabilities: ['install'],
        },
        registry,
      ),
    );
    const issues: string[] = [];
    if (result?.ok !== true) {
      const error = asRecord(result?.error);
      issues.push(
        `validateSelectionRequest rejected registered ${FIXTURE_P3B_WRITE_TOOL} as ${String(
          error?.code ?? 'unknown',
        )} instead of selecting it`,
      );
    }
    expect(registry.capability(FIXTURE_P3B_READ_TOOL, 'install')).toMatchObject({
      code: 'capability',
      exitCode: 4,
    });
    expect(registry.capability('fixture-p3b-unknown', 'install')).toMatchObject({
      code: 'usage',
      exitCode: 2,
    });
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 3 — fixture immutable lifecycle planning', () => {
  test('EWP-P3B-TS06 characterization: all four built-in lifecycle plans canonicalize', () => {
    for (const command of ['install', 'uninstall', 'dev', 'promote'] as const) {
      const plan = createOperationPlan(emptyPlanInput(command, 'codex'));
      expect(plan.command).toBe(command);
      expect(plan.selection.tools).toEqual(['codex']);
      expect(Object.isFrozen(plan)).toBeTrue();
    }
  });

  test('EWP-P3B-TS06 red: all four lifecycle plans carry a registered fixture ID', () => {
    const registry = fixtureRegistry();
    const create = createOperationPlan as unknown as AnyFunction;
    const issues: string[] = [];
    for (const command of ['install', 'uninstall', 'dev', 'promote']) {
      try {
        const plan = asRecord(
          create(emptyPlanInput(command, FIXTURE_P3B_WRITE_TOOL), {
            registry,
            toolOrder: registry.ids,
          }),
        );
        const selection = asRecord(plan?.selection);
        if (
          plan?.command !== command ||
          !Array.isArray(selection?.tools) ||
          selection.tools[0] !== FIXTURE_P3B_WRITE_TOOL
        ) {
          issues.push(`${command} did not retain the registered fixture tool`);
        }
      } catch (error) {
        issues.push(`${command} rejects registered fixture planning: ${String(error)}`);
      }
    }
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 4 — fixture placement and plan-to-binding identity', () => {
  test('EWP-P3B-TS06 characterization: built-in operation identity is deterministic', () => {
    const identity = {
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'install',
      skill: 'alpha',
      source: null,
      scope: 'user',
      target: null,
    } as const;
    const first = createOperationGroupId(identity);
    const second = createOperationGroupId({ ...identity });
    expect(first).toBe(second);
    expect(first).toMatch(/^group:v1:[0-9a-f]{64}$/u);
  });

  test('EWP-P3B-TS06 red: fixture scoped routing reaches the private execution binding', async () => {
    const registry = fixtureRegistry();
    const adapter = registry.get(FIXTURE_P3B_WRITE_TOOL);
    const placement = asRecord(adapter?.placement);
    const rootFacts = asFunction(placement?.rootFacts);
    const listScoped = asFunction(placement?.listScoped);
    const resolveScoped = asFunction(placement?.resolveScoped);
    const issues: string[] = [];
    const destination = '/workspace/project/.skillsmith-p3b-write/skills';
    const alternate = '/workspace/project/.skillsmith-p3b-write/alternate-skills';
    if (rootFacts === null || listScoped === null || resolveScoped === null) {
      issues.push('registered writable fixture has no complete normalized scoped placement shape');
    } else {
      const facts = rootFacts(ENV, 'project', CTX);
      expect(facts).toEqual([
        {
          path: '/workspace/project/.skillsmith-p3b-write/skills',
          role: 'destination',
        },
        {
          path: '/workspace/project/.skillsmith-p3b-write/alternate-skills',
          role: 'alternate',
        },
      ]);
      const duplicatePorts = virtualPlacementPorts({
        [`${destination}/alpha`]: { kind: 'dir' },
        [`${alternate}/alpha`]: { kind: 'dir' },
      });
      const listed = asRecord(
        await Promise.resolve(
          listScoped(duplicatePorts, CTX, '/xdg/data/skillsmith/store', 'project'),
        ),
      );
      expect(listed?.duplicates).toEqual(['alpha']);
      expect(asRecord(listed)?.currentRoot).toBe(destination);
      const duplicate = asRecord(
        await Promise.resolve(
          resolveScoped(duplicatePorts, CTX, '/xdg/data/skillsmith/store', 'alpha', 'project'),
        ),
      );
      expect(String(duplicate?.duplicateReason)).toContain('multiple adapter roots');

      const alternatePorts = virtualPlacementPorts({
        [`${alternate}/alpha`]: { kind: 'dir' },
      });
      const resolved = asRecord(
        await Promise.resolve(
          resolveScoped(alternatePorts, CTX, '/xdg/data/skillsmith/store', 'alpha', 'project'),
        ),
      );
      expect(asRecord(resolved?.placement)?.root).toBe(alternate);
      expect(resolved?.notices).toEqual([FIXTURE_P3B_ALTERNATE_NOTICE]);
    }

    const groupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'install',
      skill: 'alpha',
      source: null,
      scope: 'user',
      target: null,
    });
    const resource = {
      kind: 'live',
      skill: 'alpha',
      tool: FIXTURE_P3B_WRITE_TOOL,
      scope: 'user',
      projectRoot: null,
      location: { kind: 'portable', token: 'skills/user/fixture-p3b-write/alpha' },
    } as const;
    try {
      const pairId = createOperationPairId({
        domain: 'skillsmith.operation-pair-identity',
        schemaVersion: 1,
        groupId,
        tool: FIXTURE_P3B_WRITE_TOOL,
        resource,
      });
      const operationId = createOperationId({
        domain: 'skillsmith.operation-identity',
        schemaVersion: 1,
        groupId,
        pairId,
        kind: 'install',
        skill: 'alpha',
        source: null,
        tool: FIXTURE_P3B_WRITE_TOOL,
        scope: 'user',
      });
      expect(groupId).toBe(
        'group:v1:25c0be498bd2a451aa2b22fe83f3bddda18b98915484bfc2027c1f890608789d',
      );
      expect(pairId).toBe(
        'pair:v1:977519be13598ec2a69ad9e1c3e20a95b28a48c44383c528f5f41c646572e7e4',
      );
      expect(operationId).toBe(
        'operation:v1:d5fa7edd0c07fc866d0cc8b041fc83e0b8ef71ad81919095d2ec0afa8833a212',
      );

      const before = { kind: 'absent', resource } as const;
      const after = {
        kind: 'placement',
        resource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source: null,
        contentHash: null,
      } as const;
      const operation = {
        operationId,
        groupId,
        pairId,
        kind: 'install',
        dependencyMetadata: {
          domain: 'skillsmith.operation-dependency',
          schemaVersion: 1,
          operationIds: [],
        },
        skill: 'alpha',
        source: null,
        tool: FIXTURE_P3B_WRITE_TOOL,
        scope: 'user',
        before,
        after,
        reason: { code: 'fixture-install', message: 'fixture install selected.' },
        selectionSource: 'explicit-targets',
        preconditionIds: [] as string[],
        requiredCheckIds: [],
        reversibility: { kind: 'none', retentionResourceIds: [] },
        mutates: { live: true, manifest: false, lock: false, ledger: true },
        conflict: null,
      };
      const precondition = createExecutionPrecondition({
        operationIds: [operationId],
        resource,
        expected: before,
        observe: async () => before,
      });
      operation.preconditionIds = [precondition.preconditionId];
      const createPlan = createOperationPlan as unknown as AnyFunction;
      const plan = createPlan(
        {
          ...emptyPlanInput('install', FIXTURE_P3B_WRITE_TOOL),
          operations: [operation],
        },
        { registry, toolOrder: registry.ids },
      );
      const firstRevision = createExpectedRevisionV1({
        schemaVersion: 1,
        domain: 'live',
        resourceId: 'live:fixture-p3b-write:user:alpha',
        state: 'absent',
        targetIdentity: `${destination}/alpha`,
        targetKind: 'absent',
        parentIdentity: destination,
        parentKind: 'directory',
        parentMetadataIdentity: `metadata:v1:${'a'.repeat(64)}`,
      });
      const secondRevision = createExpectedRevisionV1({
        schemaVersion: 1,
        domain: 'live',
        resourceId: 'live:fixture-p3b-write:user:alpha',
        state: 'absent',
        targetIdentity: `${destination}/alpha`,
        targetKind: 'absent',
        parentIdentity: destination,
        parentKind: 'directory',
        parentMetadataIdentity: `metadata:v1:${'b'.repeat(64)}`,
      });
      if (!firstRevision.ok || !secondRevision.ok) {
        throw new Error('fixture repository revisions are invalid');
      }
      let currentRevision = firstRevision.value;
      let physicalExecutions = 0;
      const repository = {
        observe: async () => ({ ok: false, error: { code: 'unused' } }),
        observeRevision: async () => ({ ok: true, value: currentRevision }),
        stage: async (request: UnknownRecord) =>
          (stageLogicalRepositoryEditV1 as unknown as AnyFunction)({
            ...request,
            observedRevision: currentRevision,
          }),
      };
      const controller = (
        createAcquisitionRepositoryLifecycleControllerV1 as unknown as AnyFunction
      )({
        authority: {
          ledgerResourceId: 'ledger:fixture',
          repositories: { ledger: repository, live: repository, store: repository },
        },
        snapshotId: `snapshot:v1:${'c'.repeat(64)}`,
        expectedRevisions: [firstRevision.value],
      });
      const controllerRecord = asRecord(controller);
      const bind = asFunction(controllerRecord?.bind);
      if (bind === null) throw new Error('fixture lifecycle controller has no bind method');
      const physicalBinding = {
        operationId,
        groupId,
        pairId,
        unstartedForce: null,
        observeActualBefore: async () => before,
        execute: async () => {
          physicalExecutions += 1;
          currentRevision = secondRevision.value;
          return createOperationExecutionResult({
            operationId,
            outcome: 'succeeded',
            actualBefore: before,
            actualAfter: after,
            force: null,
            error: null,
          });
        },
      };
      const bound = bind(operation, physicalBinding, [firstRevision.value.resourceId]);
      const privatePrepared = Object.freeze({
        plan,
        executionResults: Object.freeze([]),
        bindings: Object.freeze([bound]),
      });
      expect(privatePrepared.executionResults).toEqual([]);
      expect(asRecord(privatePrepared.plan)?.operations).toHaveLength(1);

      const executePrepared = () =>
        executeOperationPlan({
          plan: privatePrepared.plan as never,
          bindings: privatePrepared.bindings as never,
          preconditions: [precondition],
          locks: [],
          lockPort: {
            withFileLock: async (_path, execute) => execute(),
          },
        });
      const first = await executePrepared();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ operationId, outcome: 'succeeded' });
      expect(physicalExecutions).toBe(1);
    } catch (error) {
      issues.push(`fixture prepared-binding identity is rejected: ${String(error)}`);
    }
    for (const path of [
      'packages/core/src/artifacts/plan-types.ts',
      'packages/core/src/artifacts/ledger-types.ts',
      'packages/core/src/contracts/v1/lifecycle.ts',
      'packages/core/src/contracts/v2/flip.ts',
    ]) {
      expect(source(path)).not.toContain(FIXTURE_P3B_WRITE_TOOL);
    }
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 5 — fixture verification and gate policy', () => {
  test('EWP-P3B-TS06 characterization: injected fixture verification runs static plus deep', async () => {
    const registry = fixtureRegistry();
    const ports = {
      ...ENV,
      fileExists: async (path: string) => path.endsWith('.fixture-p3b/plugin.json'),
      pathKind: async () => 'absent' as const,
      realpath: async (path: string) => path,
      listDir: async () => [],
      readText: async () => '',
      readBytes: async () => new Uint8Array(),
      readLink: async () => '',
      isExecutable: async () => false,
      modifiedAt: async () => null,
      makeDir: async () => {},
      writeTextFile: async () => {},
      makeSymlink: async () => {},
      rename: async () => {},
      copyTree: async () => {},
      removeTree: async () => {},
      fsyncFile: async () => {},
      fsyncDir: async () => {},
      runVersion: async () => 'unknown' as const,
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      nextId: () => 'fixture-id',
    };
    const result = await runVerify(
      ports,
      {
        path: '/fixture/plugin',
        tools: [FIXTURE_P3B_WRITE_TOOL],
        deep: true,
        strict: true,
      },
      registry,
    );
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value.requested.modes).toEqual(['static', 'deep']);
      expect(result.value.tools[0]?.verdict).toBe('pass');
      expect(result.value.verifiedAgainst).toEqual({
        [FIXTURE_P3B_WRITE_TOOL]: '3.6.0-fixture',
      });
    }
  });

  test('EWP-P3B-TS06 red: one pure gate reducer owns strict verdict semantics', async () => {
    const gateModule = await optionalModule('packages/core/src/verify/gate.ts');
    const issues: string[] = [];
    const reduceGate = asFunction(gateModule?.evaluateVerificationGate);
    if (reduceGate === null) {
      issues.push(
        'packages/core/src/verify/gate.ts exposes no evaluateVerificationGate pure authority',
      );
    } else {
      const cases = [
        { verdict: 'pass', strict: false, blocked: false, gate: 'passed' },
        { verdict: 'pass', strict: true, blocked: false, gate: 'passed' },
        { verdict: 'warn', strict: false, blocked: false, gate: 'warned' },
        { verdict: 'warn', strict: true, blocked: true, gate: 'failed' },
        { verdict: 'fail', strict: false, blocked: true, gate: 'failed' },
        { verdict: 'fail', strict: true, blocked: true, gate: 'failed' },
        { verdict: 'inconclusive', strict: false, blocked: false, gate: 'inconclusive' },
        { verdict: 'inconclusive', strict: true, blocked: true, gate: 'failed' },
      ] as const;
      for (const expected of cases) {
        const outcome = asRecord(
          await Promise.resolve(
            reduceGate({
              verdict: expected.verdict,
              strict: expected.strict,
              requestedMode: 'static',
            }),
          ),
        );
        if (
          outcome === null ||
          !Object.isFrozen(outcome) ||
          outcome.gate !== expected.gate ||
          outcome.blocked !== expected.blocked
        ) {
          issues.push(
            `gate reducer returned ${JSON.stringify(outcome)} for ${expected.verdict}/strict=${expected.strict}`,
          );
        }
      }
    }
    const acquire = executableSource('packages/core/src/acquire/run.ts');
    const place = executableSource('packages/core/src/place/run.ts');
    if (
      acquire.includes("verdict === 'warn'") &&
      place.includes("verdict === 'warn'") &&
      acquire.includes("verdict === 'inconclusive'") &&
      place.includes("verdict === 'inconclusive'")
    ) {
      issues.push('acquire/run.ts and place/run.ts still duplicate strict gate verdict reduction');
    }
    if (
      gateModule !== null &&
      (!/\bevaluateVerificationGate\b/u.test(acquire) ||
        !/\bevaluateVerificationGate\b/u.test(place))
    ) {
      issues.push('acquire and place do not both consume the shared verification gate authority');
    }
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 6 — adapter-provided renderer facts', () => {
  test('EWP-P3B-TS06 characterization: current built-in human facts remain byte-stable', () => {
    const install = (renderInstallHuman as unknown as AnyFunction)(installReportFor('codex'), 0);
    expect(String(install)).toContain(
      "codex static checks the manifest only — run 'skillsmith verify alpha --deep'",
    );
    const verify = (renderVerifyHuman as unknown as AnyFunction)(verifyReportFor('claude-code'), 0);
    expect(String(verify)).toContain('skills ✓ (presence)');
    const flip = (renderFlipHuman as unknown as AnyFunction)(flipReportFor('codex', 'dev'), 0);
    expect(String(flip)).toContain('verify   static: pass');
    expect(String(flip)).not.toContain('verify   deep: pass');
  });

  test('EWP-P3B-TS06 red: pure renderers consume already-selected adapter facts', async () => {
    const renderSelected = async (
      direct: AnyFunction,
      modulePath: string,
      factoryPattern: RegExp,
      report: unknown,
      resolver: AnyFunction,
      accepts: (rendered: string) => boolean,
    ): Promise<string> => {
      const directOutput = String(await Promise.resolve(direct(report, 0, resolver)));
      if (accepts(directOutput)) return directOutput;
      const module = await optionalModule(modulePath);
      if (module !== null) {
        for (const [name, value] of Object.entries(module)) {
          const factory = asFunction(value);
          if (factory === null || !factoryPattern.test(name)) continue;
          try {
            const renderer = asFunction(await Promise.resolve(factory(resolver)));
            if (renderer === null) continue;
            const rendered = String(await Promise.resolve(renderer(report, 0)));
            if (accepts(rendered)) return rendered;
          } catch {
            // A different exported factory shape is not the selected renderer contract.
          }
        }
      }
      return directOutput;
    };
    const expectedNotice = fixtureP3bInstallStaticNotice('alpha');
    const install = await renderSelected(
      renderInstallHuman as unknown as AnyFunction,
      'packages/cli/src/output/install-human.ts',
      /create.*install.*(?:human|render)/iu,
      installReportFor(FIXTURE_P3B_WRITE_TOOL),
      (tool: string, skill: string) =>
        tool === FIXTURE_P3B_WRITE_TOOL ? fixtureP3bInstallStaticNotice(skill) : null,
      (rendered) => rendered.includes(expectedNotice),
    );
    const verify = await renderSelected(
      renderVerifyHuman as unknown as AnyFunction,
      'packages/cli/src/output/verify-human.ts',
      /create.*verify.*(?:human|render)/iu,
      verifyReportFor(FIXTURE_P3B_WRITE_TOOL),
      (tool: string) => (tool === FIXTURE_P3B_WRITE_TOOL ? FIXTURE_P3B_DEEP_COVERAGE_SUFFIX : null),
      (rendered) => rendered.includes(`skills ✓${FIXTURE_P3B_DEEP_COVERAGE_SUFFIX}`),
    );
    const flip = await renderSelected(
      renderFlipHuman as unknown as AnyFunction,
      'packages/cli/src/output/flip-human.ts',
      /create.*flip.*(?:human|render)/iu,
      flipReportFor('codex', 'promote'),
      () => 'static',
      (rendered) =>
        rendered.includes('verify   static: pass') && !rendered.includes('verify   deep: pass'),
    );
    const issues: string[] = [];
    if (!install.includes(expectedNotice)) {
      issues.push('install renderer ignored the selected fixture static notice');
    }
    if (!verify.includes(`skills ✓${FIXTURE_P3B_DEEP_COVERAGE_SUFFIX}`)) {
      issues.push('verify renderer ignored the selected fixture deep-coverage suffix');
    }
    if (!flip.includes('verify   static: pass') || flip.includes('verify   deep: pass')) {
      issues.push(
        'flip renderer re-derived Codex static+deep policy instead of rendering recorded static mode',
      );
    }
    for (const path of [
      'packages/cli/src/output/install-human.ts',
      'packages/cli/src/output/flip-human.ts',
      'packages/cli/src/output/verify-human.ts',
    ]) {
      if (/\btoolRegistry\b/u.test(executableSource(path))) {
        issues.push(`${path} still reads the production registry during rendering`);
      }
    }
    if (
      /\bgatePolicy\.promote\b/u.test(executableSource('packages/cli/src/output/flip-human.ts'))
    ) {
      issues.push('flip-human.ts still re-derives verification mode from gatePolicy.promote');
    }
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 7 — Claude and Codex lifecycle parity', () => {
  test('EWP-P3B-TS06 characterization: exact built-in roots, gates, and notices remain', () => {
    const claude = toolRegistry.get('claude-code');
    const codex = toolRegistry.get('codex');
    expect(claude?.placement?.roots(ENV, 'user', CTX)).toEqual(['/home/fixture/.claude/skills']);
    expect(claude?.placement?.roots(ENV, 'project', CTX)).toEqual([
      '/workspace/project/.claude/skills',
    ]);
    expect(codex?.placement?.roots(ENV, 'user', CTX)).toEqual([
      '/home/fixture/.agents/skills',
      '/home/fixture/.codex/skills',
    ]);
    expect(codex?.placement?.roots(ENV, 'project', CTX)).toEqual([
      '/workspace/project/.agents/skills',
    ]);
    expect(claude?.verification?.gatePolicy).toEqual({
      installDeep: false,
      promote: 'static',
    });
    expect(codex?.verification?.gatePolicy).toEqual({
      installDeep: true,
      promote: 'static+deep',
    });
    const codexNotice = codex?.placement?.noticeForRoot('/legacy', {
      placements: [],
      duplicates: [],
      currentRoot: '/current',
      legacyRoot: '/legacy',
    });
    expect(codexNotice).toContain('legacy ~/.codex/skills');
  });

  test('EWP-P3B-TS06 red: built-ins expose exact scoped roles, notices, and routing', async () => {
    const issues: string[] = [];
    for (const tool of ['claude-code', 'codex'] as const) {
      const placement = asRecord(toolRegistry.get(tool)?.placement);
      for (const method of ['rootFacts', 'listScoped', 'resolveScoped']) {
        if (typeof placement?.[method] !== 'function') {
          issues.push(`${tool} registered placement is missing normalized ${method}`);
        }
      }
      const rootFacts = asFunction(placement?.rootFacts);
      if (rootFacts !== null) {
        expect(rootFacts(ENV, 'user', CTX)).toEqual(
          tool === 'claude-code'
            ? [{ path: '/home/fixture/.claude/skills', role: 'destination' }]
            : [
                { path: '/home/fixture/.agents/skills', role: 'destination' },
                { path: '/home/fixture/.codex/skills', role: 'alternate' },
              ],
        );
        expect(rootFacts(ENV, 'project', CTX)).toEqual([
          {
            path:
              tool === 'claude-code'
                ? '/workspace/project/.claude/skills'
                : '/workspace/project/.agents/skills',
            role: 'destination',
          },
        ]);
      }
    }
    const codexPlacement = asRecord(toolRegistry.get('codex')?.placement);
    const codexResolve = asFunction(codexPlacement?.resolveScoped);
    if (codexResolve !== null) {
      const current = '/home/fixture/.agents/skills';
      const alternate = '/home/fixture/.codex/skills';
      const alternateResolution = asRecord(
        await Promise.resolve(
          codexResolve(
            virtualPlacementPorts({ [`${alternate}/alpha`]: { kind: 'dir' } }),
            CTX,
            '/xdg/data/skillsmith/store',
            'alpha',
            'user',
          ),
        ),
      );
      expect(asRecord(alternateResolution?.placement)?.root).toBe(alternate);
      expect(String((alternateResolution?.notices as unknown[] | undefined)?.[0])).toContain(
        'legacy ~/.codex/skills',
      );
      const duplicate = asRecord(
        await Promise.resolve(
          codexResolve(
            virtualPlacementPorts({
              [`${current}/alpha`]: { kind: 'dir' },
              [`${alternate}/alpha`]: { kind: 'dir' },
            }),
            CTX,
            '/xdg/data/skillsmith/store',
            'alpha',
            'user',
          ),
        ),
      );
      expect(String(duplicate?.duplicateReason)).toContain(current);
      expect(String(duplicate?.duplicateReason)).toContain(alternate);
    }
    const claudeResolve = asFunction(
      asRecord(toolRegistry.get('claude-code')?.placement)?.resolveScoped,
    );
    if (claudeResolve !== null) {
      const projectRoot = '/workspace/project/.claude/skills';
      const project = asRecord(
        await Promise.resolve(
          claudeResolve(
            virtualPlacementPorts({ [`${projectRoot}/alpha`]: { kind: 'dir' } }),
            CTX,
            '/xdg/data/skillsmith/store',
            'alpha',
            'project',
          ),
        ),
      );
      expect(asRecord(project?.placement)?.root).toBe(projectRoot);
      expect(project?.notices).toEqual([]);
    }
    const adapterTypes = source('packages/core/src/agents/adapter-types.ts');
    for (const member of ['rootFacts', 'listScoped', 'resolveScoped']) {
      if (!new RegExp(`\\b${member}\\??\\s*\\(`, 'u').test(adapterTypes)) {
        issues.push(`PlacementBundle has no additive ${member} contract`);
      }
    }
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 8 — read-only tools stay effect-free', () => {
  test('EWP-P3B-TS06 characterization: every read-only application path is effect-free exit 4', async () => {
    let effects = 0;
    const poisonedDependency = async () => {
      effects += 1;
      throw new Error('read-only capability refusal reached a lifecycle dependency');
    };
    const services = createLifecycleApplicationServices({
      resolveContext: poisonedDependency as never,
      install: poisonedDependency as never,
      uninstall: poisonedDependency as never,
      prepareDev: poisonedDependency as never,
      preparePromote: poisonedDependency as never,
      prepareRollback: poisonedDependency as never,
    });
    const poisonedContext = new Proxy(
      {},
      {
        get: (_target, property) => {
          effects += 1;
          throw new Error(`read-only capability refusal read context.${String(property)}`);
        },
      },
    );
    const commands = [
      ['install', services.install, [['owner/repo/alpha']]],
      ['uninstall', services.uninstall, [['alpha']]],
      ['dev', services.dev, [['alpha']]],
      ['promote', services.promote, [['alpha']]],
    ] as const;
    for (const tool of ['kilo-code', 'opencode']) {
      for (const [command, service, args] of commands) {
        const outcome = await service(
          { arguments: args, options: { tool: [tool], verify: true } },
          poisonedContext as never,
        );
        expect(outcome.exitClass, `${command}/${tool}`).toBe('capability');
        expect(outcome.report).toEqual({ command, value: null });
        expect(outcome.mutation).toEqual(NO_MUTATION);
      }
      for (const deep of [false, true]) {
        const outcome = await runVerifyApplication(
          {
            arguments: ['/fixture/plugin'],
            options: { tool: [tool], ...(deep ? { deep: true } : { static: true }) },
          },
          poisonedContext as never,
        );
        expect(outcome.exitClass, `verify/${tool}/${deep ? 'deep' : 'static'}`).toBe('capability');
        expect(outcome.report).toEqual({ result: null });
        expect(outcome.mutation).toEqual(NO_MUTATION);
      }
      expect(toolRegistry.get(tool)?.placement).toBeUndefined();
      expect(toolRegistry.get(tool)?.verification).toBeUndefined();
    }
    expect(effects).toBe(0);
  });

  test('EWP-P3B-TS06 red: lifecycle application derives support from its injected registry', () => {
    const text = executableSource('packages/core/src/application/lifecycle-services.ts');
    const issues: string[] = [];
    if (/\bFLIP_TOOLS\b/u.test(text)) {
      issues.push('lifecycle-services.ts still closes mutation policy over FLIP_TOOLS');
    }
    if (!/\b(?:registry|toolRegistry|toolsFor|capability)\b/u.test(text)) {
      issues.push('lifecycle-services.ts exposes no registry-bound capability authority');
    }
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 9 — relevant capability fingerprints', () => {
  test('EWP-P3B-TS06 characterization: the complete public capability reader stays unchanged', async () => {
    const reader = createCapabilityStateReaderV1('capabilities:complete');
    const observed = await reader.observe('capabilities:complete');
    expect(observed.ok).toBeTrue();
    if (observed.ok) {
      expect(observed.value.value?.schemaVersion).toBe(1);
      expect(observed.value.value?.tools.map((tool) => tool.id)).toEqual(SUPPORTED_TOOLS);
      expect(Object.isFrozen(observed.value)).toBeTrue();
      expect(Object.isFrozen(observed.value.value)).toBeTrue();
    }
  });

  test('EWP-P3B-TS06 red: relevant queries isolate resource identity and staleness', async () => {
    const capabilities = await optionalModule('packages/core/src/agents/capabilities.ts');
    const repositories = await optionalModule('packages/core/src/state/repositories.ts');
    const issues: string[] = [];
    const readerFactory =
      asFunction(repositories?.createRelevantCapabilityStateReaderV1) ??
      asFunction(capabilities?.createRelevantCapabilityStateReaderV1);
    if (readerFactory === null) {
      issues.push(
        'no createRelevantCapabilityStateReaderV1(registry, queries) authority is exported',
      );
    } else {
      const withVersion = (adapter: typeof writeFixtureAdapter, version: number) => ({
        ...adapter,
        descriptor: { ...adapter.descriptor, capabilityVersion: version },
      });
      const withReadVersion = (version: number) => ({
        ...readOnlyFixtureAdapter,
        descriptor: { ...readOnlyFixtureAdapter.descriptor, capabilityVersion: version },
      });
      const withInstallFact = (
        fact: Readonly<{
          supported: boolean;
          scopes: readonly ('user' | 'project' | 'custom')[];
          remediation: string | null;
        }>,
      ) => ({
        ...writeFixtureAdapter,
        descriptor: {
          ...writeFixtureAdapter.descriptor,
          operations: { ...writeFixtureAdapter.descriptor.operations, install: fact },
        },
      });
      const userInstall = [
        {
          schemaVersion: 1,
          tool: FIXTURE_P3B_WRITE_TOOL,
          operation: 'install',
          scope: 'user',
        },
      ] as const;
      const projectInstall = [{ ...userInstall[0], scope: 'project' }] as const;
      const userDev = [{ ...userInstall[0], operation: 'dev' }] as const;
      const canonicalQueries = [userInstall[0], userDev[0]] as const;
      const unrelatedAddedAdapter = {
        ...readOnlyFixtureAdapter,
        descriptor: {
          ...readOnlyFixtureAdapter.descriptor,
          id: 'fixture-p3b-unrelated',
          order: 9_003,
        },
        inventory: {
          ...readOnlyFixtureAdapter.inventory,
          tool: 'fixture-p3b-unrelated',
        },
      };
      const baseRegistry = fixtureRegistry();
      const registries = {
        base: baseRegistry,
        usedVersion: createToolRegistry([
          withReadVersion(1),
          withVersion(writeFixtureAdapter, 2),
        ] as const),
        usedUnsupported: createToolRegistry([
          withReadVersion(1),
          withInstallFact({
            supported: false,
            scopes: [],
            remediation: 'fixture install support removed',
          }),
        ]),
        usedScope: createToolRegistry([
          withReadVersion(1),
          withInstallFact({ supported: true, scopes: ['project'], remediation: null }),
        ]),
        unrelatedVersion: createToolRegistry([
          withReadVersion(2),
          withVersion(writeFixtureAdapter, 1),
        ] as const),
        unrelatedAdded: (createToolRegistry as unknown as AnyFunction)([
          readOnlyFixtureAdapter,
          writeFixtureAdapter,
          unrelatedAddedAdapter,
        ]),
        unrelatedRemoved: createToolRegistry([writeFixtureAdapter] as const),
        missing: createToolRegistry([readOnlyFixtureAdapter] as const),
      } as const;

      const observe = async (
        registry: unknown,
        queries: readonly UnknownRecord[],
      ): Promise<{
        resourceId: string;
        revision: string;
        facts: readonly unknown[];
      } | null> => {
        let reader: UnknownRecord | null = null;
        try {
          reader = asRecord(await Promise.resolve(readerFactory(registry, queries)));
        } catch (error) {
          issues.push(`relevant reader construction failed: ${String(error)}`);
          return null;
        }
        const resourceId = reader?.resourceId;
        const observeReader = asFunction(reader?.observe);
        const observeRevision = asFunction(reader?.observeRevision);
        if (typeof resourceId !== 'string' || observeReader === null || observeRevision === null) {
          issues.push('relevant reader must expose frozen {resourceId,observe,observeRevision}');
          return null;
        }
        let observed: UnknownRecord | null = null;
        try {
          observed = asRecord(await Promise.resolve(observeReader(resourceId)));
        } catch (error) {
          issues.push(`relevant reader observation failed: ${String(error)}`);
          return null;
        }
        const component = asRecord(observed?.value);
        const revision = asRecord(component?.revision);
        const value = asRecord(component?.value);
        const facts = value?.facts;
        const revisionObservation = asRecord(await Promise.resolve(observeRevision(resourceId)));
        const directRevision = asRecord(revisionObservation?.value);
        if (
          observed?.ok !== true ||
          revisionObservation?.ok !== true ||
          typeof revision?.semanticRevision !== 'string' ||
          directRevision?.semanticRevision !== revision.semanticRevision ||
          !Array.isArray(facts)
        ) {
          issues.push('relevant reader returned no semantic revision/facts observation');
          return null;
        }
        if (
          !Object.isFrozen(reader) ||
          !Object.isFrozen(value) ||
          !Object.isFrozen(facts) ||
          !facts.every((fact) => Object.isFrozen(fact))
        ) {
          issues.push('relevant queries and facts are not deeply frozen');
        }
        return {
          resourceId,
          revision: revision.semanticRevision,
          facts,
        };
      };

      const observations = {
        base: await observe(registries.base, userInstall),
        canonical: await observe(registries.base, canonicalQueries),
        reorderedDuplicate: await observe(registries.base, [
          userDev[0],
          userInstall[0],
          { ...userInstall[0] },
        ]),
        usedVersion: await observe(registries.usedVersion, userInstall),
        usedUnsupported: await observe(registries.usedUnsupported, userInstall),
        usedScope: await observe(registries.usedScope, userInstall),
        unrelatedVersion: await observe(registries.unrelatedVersion, userInstall),
        unrelatedAdded: await observe(registries.unrelatedAdded, userInstall),
        unrelatedRemoved: await observe(registries.unrelatedRemoved, userInstall),
        missing: await observe(registries.missing, userInstall),
        operationQuery: await observe(registries.base, userDev),
        scopeQuery: await observe(registries.base, projectInstall),
      };
      if (Object.values(observations).every((observation) => observation !== null)) {
        const ready = observations as Record<
          keyof typeof observations,
          NonNullable<(typeof observations)[keyof typeof observations]>
        >;
        expect(ready.canonical.facts).toHaveLength(2);
        expect(ready.reorderedDuplicate.facts).toEqual(ready.canonical.facts);
        expect(ready.reorderedDuplicate.resourceId).toBe(ready.canonical.resourceId);
        expect(ready.reorderedDuplicate.revision).toBe(ready.canonical.revision);

        for (const changed of ['usedVersion', 'usedUnsupported', 'usedScope', 'missing'] as const) {
          if (ready[changed].revision === ready.base.revision) {
            issues.push(`${changed} did not stale the used relevant capability revision`);
          }
          expect(ready[changed].resourceId).toBe(ready.base.resourceId);
        }
        for (const unchanged of [
          'unrelatedVersion',
          'unrelatedAdded',
          'unrelatedRemoved',
        ] as const) {
          if (
            ready[unchanged].revision !== ready.base.revision ||
            ready[unchanged].resourceId !== ready.base.resourceId
          ) {
            issues.push(`${unchanged} incorrectly changed relevant capability state`);
          }
        }
        for (const changedQuery of ['operationQuery', 'scopeQuery'] as const) {
          if (ready[changedQuery].resourceId === ready.base.resourceId) {
            issues.push(`${changedQuery} aliased the original query-set resource ID`);
          }
          if (ready[changedQuery].revision === ready.base.revision) {
            issues.push(`${changedQuery} did not change the relevant semantic revision`);
          }
        }
        expect(ready.missing.facts).toEqual([
          {
            schemaVersion: 1,
            tool: FIXTURE_P3B_WRITE_TOOL,
            capabilityVersion: null,
            operation: 'install',
            scope: 'user',
            supported: false,
          },
        ]);
      }
    }
    for (const path of [
      'packages/core/src/acquire/execute.ts',
      'packages/core/src/place/execute.ts',
    ]) {
      if (/\bcreateCapabilityStateReaderV1\b/u.test(executableSource(path))) {
        issues.push(`${path} still binds mutation snapshots to the complete capability reader`);
      }
    }
    assertNoIssues(issues);
  });
});

describe('EWP-P3B-TS06 family 10 — public and operation compatibility', () => {
  test('EWP-P3B-TS06 characterization: current bytes, wire bindings, and operation IDs remain compatible', () => {
    expect(SUPPORTED_TOOLS).toEqual(['claude-code', 'codex', 'kilo-code', 'opencode']);
    expect(FLIP_TOOLS).toEqual(['claude-code', 'codex']);
    expect(VERIFY_TOOLS).toEqual(['claude-code', 'codex']);
    expect(Object.keys(VERIFIED_AGAINST)).toEqual(['claude-code', 'codex']);

    const fingerprints = [
      [
        String((renderInstallHuman as unknown as AnyFunction)(installReportFor('codex'), 0)),
        [318, 'd0db4a895e141e616de73706b99e3da1a83a3561b2066d1b93e9164177c04727'],
      ],
      [
        String((renderVerifyHuman as unknown as AnyFunction)(verifyReportFor('claude-code'), 0)),
        [211, 'ab39a8ffd8977db9e727c5cd5d3da30a08ea0d59c5faff44405ce329f7673ab2'],
      ],
      [
        String((renderFlipHuman as unknown as AnyFunction)(flipReportFor('codex', 'dev'), 0)),
        [254, '994df1408aeb017f45fc9f581a80de2989a95aeefe1d8fba5e21afa23552dfe2'],
      ],
      [
        String((renderInstallJson as unknown as AnyFunction)(installReportFor('codex'))),
        [967, '40f9506b84c3a29a7dcddb89650c23b444811b3e4359c809017e0aedd7ba7ee4'],
      ],
      [
        String(
          (renderVerifyJson as unknown as AnyFunction)({
            ...verifyReportFor('claude-code'),
            verifiedAgainst: VERIFIED_AGAINST,
          }),
        ),
        [1095, '09e53696ef9db571c3823f52c5278b8388a5c11d3ef2b26d2b3026f0ef15e856'],
      ],
      [
        String((renderFlipJson as unknown as AnyFunction)(flipReportFor('codex', 'dev'))),
        [603, '791e5e8e3e46a536e6f7fab572e0929f44e10d6ed25d9f2773ca281749a3a581'],
      ],
    ] as const;
    for (const [rendered, expected] of fingerprints) {
      expect(utf8Fingerprint(rendered)).toEqual(expected);
    }

    for (const [key, id, version] of [
      ['install', 'install', 1],
      ['uninstall', 'uninstall', 1],
      ['verify', 'verify', 1],
      ['dev', 'flip', 4],
      ['promote', 'flip', 4],
    ] as const) {
      const codec = currentWireCodecs[key];
      expect(codec.descriptor).toEqual({
        id,
        version,
        wireKind: `skillsmith.${id}`,
        embeddedVersion: 'schemaVersion',
        unknownFields: 'reject-recursive',
        formatting: { indent: 2, terminalLf: false },
        migrations: [],
        compatibility: 'conservative',
      });
    }
    expect(currentWireCodecs.dev).toBe(currentWireCodecs.promote);

    const identity = {
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'install',
      skill: 'alpha',
      source: null,
      scope: 'user',
      target: null,
    } as const;
    const before = createOperationGroupId(identity);
    const bumpedRegistry = createToolRegistry([
      {
        ...writeFixtureAdapter,
        descriptor: { ...writeFixtureAdapter.descriptor, capabilityVersion: 99 },
      },
    ] as const);
    expect(bumpedRegistry.get(FIXTURE_P3B_WRITE_TOOL)?.descriptor.capabilityVersion).toBe(99);
    expect(createOperationGroupId(identity)).toBe(before);
    expect(source('packages/core/src/contracts/v1/capability-snapshot.ts')).not.toContain(
      FIXTURE_P3B_WRITE_TOOL,
    );
  });

  test('EWP-P3B-TS06 red: state internals are cast-free and capability-model generic without wire widening', () => {
    const issues: string[] = [];
    if (
      !declarationHasTypeParameters('packages/core/src/state/types.ts', 'ObservedStateSnapshotV1')
    ) {
      issues.push('ObservedStateSnapshotV1 is still fixed to the complete public capability DTO');
    }
    if (
      !declarationHasTypeParameters(
        'packages/core/src/state/repositories.ts',
        'ObservedStateRepositoriesV1',
      )
    ) {
      issues.push(
        'ObservedStateRepositoriesV1 is still fixed to the complete public capability model',
      );
    }
    if (
      !declarationHasTypeParameters(
        'packages/core/src/state/read.ts',
        'readObservedStateSnapshotV1',
      )
    ) {
      issues.push('readObservedStateSnapshotV1 has no generic capability-model boundary');
    }
    const capabilitiesPath = 'packages/core/src/agents/capabilities.ts';
    const capabilities = source(capabilitiesPath);
    const capabilityFile = ts.createSourceFile(
      capabilitiesPath,
      capabilities,
      ts.ScriptTarget.Latest,
      true,
    );
    let hasPreconditionMapper = false;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isVariableDeclaration(node)) {
        const text = node.getText(capabilityFile);
        if (/\bCapabilityPreconditionV1\b/u.test(text) && /\bRelevantCapability/u.test(text)) {
          hasPreconditionMapper = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(capabilityFile);
    if (!hasPreconditionMapper || !/\bCapabilityPreconditionV1\b/u.test(capabilities)) {
      issues.push(
        'no cast-free built-in relevant-fact mapping to CapabilityPreconditionV1 is present',
      );
    }
    for (const path of [
      'packages/core/src/agents/capabilities.ts',
      'packages/core/src/state/repositories.ts',
      'packages/core/src/state/read.ts',
      'packages/core/src/acquire/execute.ts',
      'packages/core/src/place/execute.ts',
    ]) {
      const forbiddenTargets = doubleCastTargets(path).filter((target) =>
        /(?:CapabilitySnapshotV1Dto|RelevantCapabilitySnapshotV1|ObservedStateSnapshotV1|ObservedStateRepositoriesV1)/u.test(
          target,
        ),
      );
      if (forbiddenTargets.length > 0) {
        issues.push(`${path} bridges capability models through ${forbiddenTargets.join(', ')}`);
      }
    }
    for (const path of [
      'packages/core/src/artifacts/plan-types.ts',
      'packages/core/src/contracts/v1/capability-snapshot.ts',
    ]) {
      if (source(path).includes(FIXTURE_P3B_WRITE_TOOL)) {
        issues.push(`${path} widened a fixed public/wire union with the fixture tool`);
      }
    }
    assertNoIssues(issues);
  });
});
