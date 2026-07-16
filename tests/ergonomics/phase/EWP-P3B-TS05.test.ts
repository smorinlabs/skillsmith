import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { resolveRuntimeConfiguration } from '../../../packages/core/src/config/runtime.ts';
import {
  emptyLedgerModel,
  getLedgerPairAt,
  withLedgerPairAt,
  withoutLedgerPairAt,
} from '../../../packages/core/src/place/ledger.ts';

type UnknownRecord = Record<string, unknown>;
type AnyFunction = (...args: unknown[]) => unknown;

const ROOT = resolve(import.meta.dir, '../../..');
const ACQUIRE_RUN_MAX_LINES = 3_955;
const PLACE_RUN_MAX_LINES = 2_917;

const FUTURE_MODULES = Object.freeze([
  'packages/core/src/acquire/execute.ts',
  'packages/core/src/acquire/plan.ts',
  'packages/core/src/acquire/recovery.ts',
  'packages/core/src/artifacts/ledger-history.ts',
  'packages/core/src/artifacts/ledger-repository.ts',
  'packages/core/src/place/execute.ts',
  'packages/core/src/place/live-repository.ts',
  'packages/core/src/place/recovery.ts',
  'packages/core/src/place/store-repository.ts',
  'packages/core/src/planning/legacy-action.ts',
  'packages/core/src/state/ownership.ts',
  'packages/core/src/state/read.ts',
  'packages/core/src/state/repositories.ts',
  'packages/core/src/state/types.ts',
]);

const OWNED_SOURCE = Object.freeze([
  'packages/core/src/application/lifecycle-services.ts',
  'packages/core/src/application/read-services.ts',
  'packages/core/src/acquire/execute.ts',
  'packages/core/src/acquire/plan.ts',
  'packages/core/src/acquire/recovery.ts',
  'packages/core/src/acquire/run.ts',
  'packages/core/src/acquire/types.ts',
  'packages/core/src/artifacts/ledger-history.ts',
  'packages/core/src/artifacts/ledger-repository.ts',
  'packages/core/src/artifacts/ledger-types.ts',
  'packages/core/src/artifacts/ledger-writer.ts',
  'packages/core/src/artifacts/repository.ts',
  'packages/core/src/execution/coordinator.ts',
  'packages/core/src/execution/preconditions.ts',
  'packages/core/src/execution/types.ts',
  'packages/core/src/place/execute.ts',
  'packages/core/src/place/history.ts',
  'packages/core/src/place/ledger-migration.ts',
  'packages/core/src/place/ledger-persistence.ts',
  'packages/core/src/place/ledger.ts',
  'packages/core/src/place/live-repository.ts',
  'packages/core/src/place/logical-transactions.ts',
  'packages/core/src/place/plan.ts',
  'packages/core/src/place/recovery.ts',
  'packages/core/src/place/run.ts',
  'packages/core/src/place/store-repository.ts',
  'packages/core/src/place/store.ts',
  'packages/core/src/place/swap.ts',
  'packages/core/src/place/types.ts',
  'packages/core/src/planning/compatibility.ts',
  'packages/core/src/planning/create.ts',
  'packages/core/src/planning/legacy-action.ts',
  'packages/core/src/planning/types.ts',
  'packages/core/src/ports/types.ts',
  'packages/core/src/state/ownership.ts',
  'packages/core/src/state/read.ts',
  'packages/core/src/state/repositories.ts',
  'packages/core/src/state/types.ts',
  'packages/core/src/status/join.ts',
  'packages/core/src/status/read.ts',
]);

const absolute = (path: string): string => join(ROOT, path);
const present = (path: string): boolean => existsSync(absolute(path));
const source = (path: string): string =>
  present(path) ? readFileSync(absolute(path), 'utf8') : '';
const syntax = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineCount = (path: string): number => {
  const text = source(path);
  if (text === '') return 0;
  return text.replace(/\r?\n$/u, '').split(/\r?\n/u).length;
};

const relativeImports = (path: string): readonly string[] => {
  const file = syntax(path);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers.filter((specifier) => specifier.startsWith('.'));
};

const exportedNames = (path: string): readonly string[] => {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        node.name !== undefined
      ) {
        names.add(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause !== undefined) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) names.add(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax(path));
  return [...names].sort();
};

const interfaceMembers = (path: string, name: string): readonly string[] => {
  const members: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      for (const member of node.members) {
        if (member.name !== undefined) {
          if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
            members.push(member.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax(path));
  return members.sort();
};

const declaredFrameworks = (path: string): readonly string[] => {
  const matches = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      const name = node.name?.text;
      if (
        name === 'UnitOfWork' ||
        name === 'DependencyInjectionContainer' ||
        name === 'EventStore' ||
        name === 'ObjectRelationalMapper' ||
        (name === 'Repository' && (node.typeParameters?.length ?? 0) > 0)
      ) {
        matches.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax(path));
  return [...matches].sort();
};

const usedPrivateSymbols = (path: string): readonly string[] => {
  const privateNames = new Set([
    'ObservedStateSnapshotV1',
    'ExpectedRevisionV1',
    'RevisionCursor',
    'ManifestRepository',
    'LockRepository',
    'LedgerRepository',
    'LivePlacementRepository',
    'StoreRepository',
  ]);
  const matches = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && privateNames.has(node.text)) matches.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(syntax(path));
  return [...matches].sort();
};

const loadFutureModule = async (path: string): Promise<UnknownRecord | null> => {
  if (!present(path)) return null;
  return (await import(pathToFileURL(absolute(path)).href)) as UnknownRecord;
};

const requiredFunction = (module: UnknownRecord | null, name: string): AnyFunction => {
  expect(module, `${name} module must exist`).not.toBeNull();
  const candidate = module?.[name];
  expect(typeof candidate, `${name} must be exported`).toBe('function');
  return candidate as AnyFunction;
};

const resultRecord = (value: unknown, label: string): UnknownRecord => {
  expect(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} result shape`,
  ).toBeTrue();
  return value as UnknownRecord;
};

const unwrapResult = (value: unknown, label: string): unknown => {
  const result = resultRecord(value, label);
  expect(result.ok, `${label} must succeed`).toBeTrue();
  return result.value;
};

const HEX = Object.freeze({
  a: 'a'.repeat(64),
  b: 'b'.repeat(64),
  c: 'c'.repeat(64),
  d: 'd'.repeat(64),
});

const semanticRevision = (domain: 'project' | 'capabilities', resourceId: string, hex: string) =>
  Object.freeze({
    schemaVersion: 1 as const,
    domain,
    resourceId,
    state: 'present' as const,
    targetKind: 'semantic' as const,
    semanticRevision: `sha256:${hex}`,
    revisionDigest: `revision:v1:${hex}`,
  });

const absentRevision = (
  domain: 'manifest' | 'lock' | 'ledger' | 'live' | 'store',
  resourceId: string,
  targetIdentity: string,
  parentIdentity: string,
  hex: string,
) =>
  Object.freeze({
    schemaVersion: 1 as const,
    domain,
    resourceId,
    state: 'absent' as const,
    targetIdentity,
    targetKind: 'absent' as const,
    parentIdentity,
    parentKind: 'directory' as const,
    parentMetadataIdentity: `metadata:v1:${hex}`,
    absenceDigest: `absence:v1:${hex}`,
    revisionDigest: `revision:v1:${hex}`,
  });

const snapshotFixture = () =>
  Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: `snapshot:v1:${HEX.a}`,
    project: Object.freeze({
      revision: semanticRevision('project', 'project:/fixture', HEX.a),
      value: Object.freeze({
        invocationCwd: '/fixture',
        effectiveCwd: '/fixture',
        projectRoot: '/fixture',
        projectIdentity: '/fixture',
        projectKind: 'git',
        discoveredConfigPath: null,
        explicitConfigPath: null,
      }),
    }),
    manifest: Object.freeze({
      revision: absentRevision(
        'manifest',
        'manifest:/fixture/skillsmith.toml',
        '/fixture/skillsmith.toml',
        '/fixture',
        HEX.a,
      ),
      value: null,
    }),
    lock: Object.freeze({
      revision: absentRevision(
        'lock',
        'lock:/fixture/skillsmith.lock',
        '/fixture/skillsmith.lock',
        '/fixture',
        HEX.b,
      ),
      value: null,
    }),
    ledger: Object.freeze({
      revision: absentRevision(
        'ledger',
        'ledger:user',
        '/fixture/data/placements.json',
        '/fixture/data',
        HEX.c,
      ),
      value: null,
    }),
    live: Object.freeze([
      Object.freeze({
        revision: absentRevision(
          'live',
          'live:user:codex:alpha',
          '/fixture/live/alpha',
          '/fixture/live',
          HEX.d,
        ),
        value: null,
      }),
    ]),
    store: Object.freeze([
      Object.freeze({
        revision: absentRevision(
          'store',
          'store:alpha',
          '/fixture/store/alpha',
          '/fixture/store',
          HEX.a,
        ),
        value: null,
      }),
    ]),
    capabilities: Object.freeze({
      revision: semanticRevision('capabilities', 'capabilities:fixture', HEX.b),
      value: Object.freeze({ adapters: ['codex'] }),
    }),
  });

const resolveOwnedImport = (from: string, specifier: string): string | null => {
  const target = resolve(dirname(absolute(from)), specifier);
  const candidates = [target, `${target}.ts`, join(target, 'index.ts')];
  for (const candidate of candidates) {
    const path = relative(ROOT, candidate).replaceAll('\\', '/');
    if (OWNED_SOURCE.includes(path)) return path;
  }
  return null;
};

const ownedCycles = (): readonly string[] => {
  const files = OWNED_SOURCE.filter(present);
  const graph = new Map(
    files.map((file) => [
      file,
      relativeImports(file)
        .map((specifier) => resolveOwnedImport(file, specifier))
        .filter((target): target is string => target !== null),
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      cycles.add([...stack.slice(start), file].join(' -> '));
      return;
    }
    visiting.add(file);
    stack.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of files) visit(file);
  return [...cycles].sort();
};

const filesBelow = (path: string): readonly string[] => {
  const root = absolute(path);
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /\.(?:ts|md)$/u.test(entry.name)) output.push(child);
    }
  };
  walk(root);
  return output.sort();
};

describe('EWP-P3B-TS05 — immutable observation, pure planning, and repositories', () => {
  test('characterizes the accepted private architecture and existing durability authorities', () => {
    const adr = source('docs/adr/0006-immutable-observed-state-and-repositories.md');
    expect(adr).toContain('**Status:** Accepted (2026-07-15)');
    expect(adr).toContain('ObservedStateSnapshotV1');
    expect(adr).toContain('ManifestRepository');
    expect(adr).toContain('coordinator owns an immutable revision cursor');
    expect(source('packages/core/src/artifacts/registry.ts')).toContain(
      'export const artifactContractRegistry',
    );
    expect(source('packages/core/src/artifacts/ledger-writer.ts')).toContain(
      'export const createNodeLedgerWriter',
    );
    expect(source('packages/core/src/artifacts/coordinator.ts')).toContain(
      'export const commitArtifactPair',
    );
    expect(source('packages/core/src/execution/coordinator.ts')).toContain(
      'export const executeOperationPlan',
    );
  });

  test('characterizes immutable planning, precondition validation, and read-only status inputs', () => {
    const planning = source('packages/core/src/planning/create.ts');
    const preconditions = source('packages/core/src/execution/preconditions.ts');
    const coordinator = source('packages/core/src/execution/coordinator.ts');
    const statusTypes = source('packages/core/src/status/types.ts');
    expect(planning).toContain('export function createOperationId');
    expect(planning).toContain('export function createOperationPlan');
    expect(planning).toContain('utilTypes.isProxy');
    expect(planning).toContain('Object.freeze');
    expect(preconditions).toContain('export const validateExecutionPreconditions');
    expect(coordinator.lastIndexOf('validateExecutionPreconditions')).toBeLessThan(
      coordinator.lastIndexOf('scheduleValidatedOperationPlan'),
    );
    expect(statusTypes).toContain(
      'export type StatusReadPorts = InventoryReadPorts & FileMetadataReadPort',
    );
    expect(statusTypes).not.toMatch(/\b(?:FileWritePort|LockPort|ProcessPort|ClockPort|IdPort)\b/u);
  });

  test('characterizes existing ledger reducers as detached copy-on-write transforms', () => {
    const before = emptyLedgerModel('2026-07-15T00:00:00.000Z');
    const beforeSnapshot = structuredClone(before);
    const pair = {
      placementPath: '/fixture/live/alpha',
      mode: 'dev' as const,
      dev: {
        sourcePath: '/fixture/source/alpha',
        resolvedPath: '/fixture/source/alpha',
        repoRoot: '/fixture/source',
        sourceRelPath: 'alpha',
        remote: 'fixture/repo',
        recordedAt: '2026-07-15T00:00:00.000Z',
      },
      pinned: null,
      journal: null,
    };
    const added = withLedgerPairAt(before, null, 'alpha', 'codex', pair);
    expect(added.ok).toBeTrue();
    expect(before).toEqual(beforeSnapshot);
    if (!added.ok) return;
    expect(added.value).not.toBe(before);
    expect(getLedgerPairAt(added.value, null, 'alpha', 'codex')).toEqual(pair);
    pair.dev.sourcePath = '/fixture/caller-mutation';
    expect(getLedgerPairAt(added.value, null, 'alpha', 'codex')?.dev?.sourcePath).toBe(
      '/fixture/source/alpha',
    );
    const removed = withoutLedgerPairAt(added.value, null, 'alpha', 'codex');
    expect(removed.ok).toBeTrue();
    if (removed.ok) {
      expect(getLedgerPairAt(removed.value, null, 'alpha', 'codex')).toBeNull();
      expect(getLedgerPairAt(added.value, null, 'alpha', 'codex')).not.toBeNull();
    }
  });

  test('deeply owns and freezes hostile ordinary data through one shared boundary', async () => {
    const module = await loadFutureModule('packages/core/src/state/ownership.ts');
    const ownOrdinaryData = requiredFunction(module, 'ownOrdinaryData');
    const input = { branch: { values: [1, { label: 'alpha' }] } };
    const owned = unwrapResult(
      ownOrdinaryData(input, () => true),
      'ordinary ownership',
    ) as typeof input;
    expect(owned).toEqual(input);
    expect(owned).not.toBe(input);
    expect(owned.branch).not.toBe(input.branch);
    expect(owned.branch.values).not.toBe(input.branch.values);
    expect(Object.isFrozen(owned)).toBeTrue();
    expect(Object.isFrozen(owned.branch)).toBeTrue();
    expect(Object.isFrozen(owned.branch.values)).toBeTrue();
    input.branch.values[1] = { label: 'caller-mutation' };
    expect(owned.branch.values[1]).toEqual({ label: 'alpha' });

    const accessor = {};
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'trap' });
    const symbolic = { [Symbol('trap')]: true };
    const sparse = Array(2);
    sparse[1] = 'value';
    const cyclic: UnknownRecord = {};
    cyclic.self = cyclic;
    const hostile = [
      [new Proxy({}, {}), 'proxy'],
      [accessor, 'accessor'],
      [symbolic, 'symbol-key'],
      [sparse, 'sparse'],
      [cyclic, 'cycle'],
      [Number.POSITIVE_INFINITY, 'non-finite'],
    ] as const;
    for (const [candidate, reason] of hostile) {
      const refused = resultRecord(
        ownOrdinaryData(candidate, () => true),
        reason,
      );
      expect(refused.ok, `${reason} must be refused`).toBeFalse();
      expect((refused.error as UnknownRecord | undefined)?.reason, `${reason} reason`).toBe(reason);
    }
  });

  test('constructs stable present revisions and revisioned absence with target and parent identity', async () => {
    const module = await loadFutureModule('packages/core/src/state/types.ts');
    const createExpectedRevisionV1 = requiredFunction(module, 'createExpectedRevisionV1');
    const sameExpectedRevisionV1 = requiredFunction(module, 'sameExpectedRevisionV1');
    const presentInput = {
      schemaVersion: 1,
      domain: 'manifest',
      resourceId: 'manifest:/fixture/skillsmith.toml',
      state: 'present',
      targetIdentity: '/fixture/skillsmith.toml',
      targetKind: 'file',
      targetMetadataIdentity: `metadata:v1:${HEX.a}`,
      parentIdentity: '/fixture',
      parentKind: 'directory',
      parentMetadataIdentity: `metadata:v1:${HEX.b}`,
      byteRevision: `sha256:${HEX.c}`,
      semanticRevision: `sha256:${HEX.d}`,
    };
    const present = unwrapResult(createExpectedRevisionV1(presentInput), 'present revision');
    const repeated = unwrapResult(createExpectedRevisionV1(presentInput), 'repeated revision');
    expect(present).toEqual(repeated);
    expect(sameExpectedRevisionV1(present, repeated)).toBeTrue();
    expect(Object.isFrozen(present)).toBeTrue();

    const absentInput = {
      schemaVersion: 1,
      domain: 'live',
      resourceId: 'live:user:codex:alpha',
      state: 'absent',
      targetIdentity: '/fixture/live/alpha',
      targetKind: 'absent',
      parentIdentity: '/fixture/live',
      parentKind: 'directory',
      parentMetadataIdentity: `metadata:v1:${HEX.a}`,
    };
    const absent = unwrapResult(createExpectedRevisionV1(absentInput), 'absent revision') as
      | UnknownRecord
      | undefined;
    expect(absent?.absenceDigest).toMatch(/^absence:v1:[0-9a-f]{64}$/u);
    const targetChanged = unwrapResult(
      createExpectedRevisionV1({ ...absentInput, targetIdentity: '/fixture/live/beta' }),
      'target-changed absence',
    );
    const parentChanged = unwrapResult(
      createExpectedRevisionV1({
        ...absentInput,
        parentMetadataIdentity: `metadata:v1:${HEX.b}`,
      }),
      'parent-changed absence',
    );
    expect(sameExpectedRevisionV1(absent, targetChanged)).toBeFalse();
    expect(sameExpectedRevisionV1(absent, parentChanged)).toBeFalse();
    const special = resultRecord(
      createExpectedRevisionV1({ ...absentInput, targetKind: 'symlink' }),
      'special-node absence',
    );
    expect(special.ok).toBeFalse();
  });

  test('reads one canonical two-pass snapshot and refuses a mixed revision without retry', async () => {
    const module = await loadFutureModule('packages/core/src/state/read.ts');
    const readObservedStateSnapshotV1 = requiredFunction(module, 'readObservedStateSnapshotV1');
    const fixture = snapshotFixture();
    const request = Object.freeze({
      schemaVersion: 1,
      projectResourceId: fixture.project.revision.resourceId,
      manifestResourceId: fixture.manifest.revision.resourceId,
      lockResourceId: fixture.lock.revision.resourceId,
      ledgerResourceId: fixture.ledger.revision.resourceId,
      liveResourceIds: Object.freeze([fixture.live[0]?.revision.resourceId]),
      storeResourceIds: Object.freeze([fixture.store[0]?.revision.resourceId]),
      capabilitiesResourceId: fixture.capabilities.revision.resourceId,
    });
    const order = [
      'project:project:/fixture',
      'manifest:manifest:/fixture/skillsmith.toml',
      'lock:lock:/fixture/skillsmith.lock',
      'ledger:ledger:user',
      'live:live:user:codex:alpha',
      'store:store:alpha',
      'capabilities:capabilities:fixture',
    ];
    const okResult = (value: unknown) => Object.freeze({ ok: true as const, value });
    const repositories = (calls: string[], changeLedgerRevision: boolean): UnknownRecord => ({
      project: {
        observe: async (resourceId: string) => {
          calls.push(`observe:project:${resourceId}`);
          return okResult(fixture.project);
        },
        observeRevision: async (resourceId: string) => {
          calls.push(`revision:project:${resourceId}`);
          return okResult(fixture.project.revision);
        },
      },
      manifest: {
        observe: async (resourceId: string) => {
          calls.push(`observe:manifest:${resourceId}`);
          return okResult(fixture.manifest);
        },
        observeRevision: async (resourceId: string) => {
          calls.push(`revision:manifest:${resourceId}`);
          return okResult(fixture.manifest.revision);
        },
      },
      lock: {
        observe: async (resourceId: string) => {
          calls.push(`observe:lock:${resourceId}`);
          return okResult(fixture.lock);
        },
        observeRevision: async (resourceId: string) => {
          calls.push(`revision:lock:${resourceId}`);
          return okResult(fixture.lock.revision);
        },
      },
      ledger: {
        observe: async (resourceId: string) => {
          calls.push(`observe:ledger:${resourceId}`);
          return okResult(fixture.ledger);
        },
        observeRevision: async (resourceId: string) => {
          calls.push(`revision:ledger:${resourceId}`);
          return okResult(
            changeLedgerRevision
              ? Object.freeze({
                  ...fixture.ledger.revision,
                  parentMetadataIdentity: `metadata:v1:${HEX.d}`,
                  absenceDigest: `absence:v1:${HEX.d}`,
                  revisionDigest: `revision:v1:${HEX.d}`,
                })
              : fixture.ledger.revision,
          );
        },
      },
      live: {
        observe: async (resourceId: string) => {
          calls.push(`observe:live:${resourceId}`);
          return okResult(fixture.live[0]);
        },
        observeRevision: async (resourceId: string) => {
          calls.push(`revision:live:${resourceId}`);
          return okResult(fixture.live[0]?.revision);
        },
      },
      store: {
        observe: async (resourceId: string) => {
          calls.push(`observe:store:${resourceId}`);
          return okResult(fixture.store[0]);
        },
        observeRevision: async (resourceId: string) => {
          calls.push(`revision:store:${resourceId}`);
          return okResult(fixture.store[0]?.revision);
        },
      },
      capabilities: {
        observe: async (resourceId: string) => {
          calls.push(`observe:capabilities:${resourceId}`);
          return okResult(fixture.capabilities);
        },
        observeRevision: async (resourceId: string) => {
          calls.push(`revision:capabilities:${resourceId}`);
          return okResult(fixture.capabilities.revision);
        },
      },
    });

    const stableCalls: string[] = [];
    const stable = resultRecord(
      await readObservedStateSnapshotV1(request, repositories(stableCalls, false)),
      'stable snapshot',
    );
    expect(stable.ok).toBeTrue();
    expect((stable.value as UnknownRecord | undefined)?.snapshotId).toMatch(
      /^snapshot:v1:[0-9a-f]{64}$/u,
    );
    expect(stableCalls).toEqual([
      ...order.map((item) => `observe:${item}`),
      ...order.map((item) => `revision:${item}`),
    ]);
    expect(Object.isFrozen(stable.value)).toBeTrue();

    const changedCalls: string[] = [];
    const changed = resultRecord(
      await readObservedStateSnapshotV1(request, repositories(changedCalls, true)),
      'changed snapshot',
    );
    expect(changed.ok).toBeFalse();
    expect((changed.error as UnknownRecord | undefined)?.code).toBe('snapshot-changed');
    expect(changedCalls).toEqual([
      ...order.map((item) => `observe:${item}`),
      ...order.map((item) => `revision:${item}`),
    ]);
  });

  test('creates deterministic immutable acquisition plans from only request and snapshot', async () => {
    const module = await loadFutureModule('packages/core/src/acquire/plan.ts');
    const createAcquisitionPlan = requiredFunction(module, 'createAcquisitionPlan');
    const snapshot = structuredClone(snapshotFixture());
    const request = {
      schemaVersion: 1,
      command: 'install',
      selection: {
        source: 'explicit-targets',
        skills: ['alpha'],
        tools: ['codex'],
        scopes: ['user'],
      },
      batchPolicy: 'fail-fast',
      intents: [
        {
          kind: 'install',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectRoot: null,
          source: {
            kind: 'portable',
            identity: { host: 'example.test', repository: 'fixture/repo', path: 'skills/alpha' },
            requestedRef: null,
            resolvedSha: 'c'.repeat(40),
            sourcePath: 'skills/alpha',
            contentHash: `sha256:${HEX.a}`,
          },
          placement: {
            classification: 'pinned',
            representation: 'copy',
            location: { kind: 'portable', token: 'skills/user/codex/alpha' },
          },
          store: {
            location: { kind: 'portable', token: 'store/fixture/alpha' },
            contentHash: `sha256:${HEX.a}`,
            snapshotIdentity: `snapshot:v1:${HEX.b}`,
          },
        },
      ],
    };
    const requestBefore = structuredClone(request);
    const snapshotBefore = structuredClone(snapshot);
    const first = unwrapResult(
      createAcquisitionPlan(request, snapshot),
      'first acquisition plan',
    ) as UnknownRecord;
    const second = unwrapResult(
      createAcquisitionPlan(request, snapshot),
      'second acquisition plan',
    ) as UnknownRecord;
    expect(first).toEqual(second);
    expect(request).toEqual(requestBefore);
    expect(snapshot).toEqual(snapshotBefore);
    expect(first.snapshotId).toBe(snapshot.snapshotId);
    expect(Object.isFrozen(first)).toBeTrue();
    expect(Object.isFrozen(first.expectedRevisions)).toBeTrue();
    const plan = resultRecord(first.plan, 'acquisition operation plan');
    const operations = plan.operations as readonly UnknownRecord[];
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.map((operation) => operation.operationId)).toEqual(
      (
        resultRecord(second.plan, 'repeated acquisition plan')
          .operations as readonly UnknownRecord[]
      ).map((operation) => operation.operationId),
    );
    for (const operation of operations) {
      expect(operation.operationId).toMatch(/^operation:v1:[0-9a-f]{64}$/u);
    }
  });

  test('creates deterministic immutable placement plans without ports, repositories, or replanning', async () => {
    const module = await loadFutureModule('packages/core/src/place/plan.ts');
    const createPlacementPlan = requiredFunction(module, 'createPlacementPlan');
    const snapshot = structuredClone(snapshotFixture());
    const request = {
      schemaVersion: 1,
      command: 'promote',
      selection: {
        source: 'explicit-targets',
        skills: ['alpha'],
        tools: ['codex'],
        scopes: ['user'],
      },
      batchPolicy: 'fail-fast',
      intents: [
        {
          kind: 'promote',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectRoot: null,
          liveResourceId: 'live:user:codex:alpha',
          storeResourceId: 'store:alpha',
          representation: 'copy',
          desiredContentHash: `sha256:${HEX.a}`,
        },
      ],
    };
    const requestBefore = structuredClone(request);
    const snapshotBefore = structuredClone(snapshot);
    const first = unwrapResult(
      createPlacementPlan(request, snapshot),
      'first placement plan',
    ) as UnknownRecord;
    const second = unwrapResult(
      createPlacementPlan(request, snapshot),
      'second placement plan',
    ) as UnknownRecord;
    expect(first).toEqual(second);
    expect(request).toEqual(requestBefore);
    expect(snapshot).toEqual(snapshotBefore);
    expect(first.snapshotId).toBe(snapshot.snapshotId);
    expect(Object.isFrozen(first)).toBeTrue();
    const plan = resultRecord(first.plan, 'placement operation plan');
    const operations = plan.operations as readonly UnknownRecord[];
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.map((operation) => operation.operationId)).toEqual(
      (
        resultRecord(second.plan, 'repeated placement plan').operations as readonly UnknownRecord[]
      ).map((operation) => operation.operationId),
    );
  });

  test('creates deterministic logical stages and refuses stale or newly appeared resources', async () => {
    const module = await loadFutureModule('packages/core/src/state/repositories.ts');
    const stageLogicalRepositoryEditV1 = requiredFunction(module, 'stageLogicalRepositoryEditV1');
    const fixture = snapshotFixture();
    const expected = fixture.ledger.revision;
    const after = Object.freeze({
      ...expected,
      parentMetadataIdentity: `metadata:v1:${HEX.d}`,
      absenceDigest: `absence:v1:${HEX.d}`,
      revisionDigest: `revision:v1:${HEX.d}`,
    });
    const request = {
      schemaVersion: 1,
      operationId: `operation:v1:${HEX.c}`,
      domain: 'ledger',
      resourceId: expected.resourceId,
      expectedRevision: expected,
      observedRevision: expected,
      afterRevision: after,
      editDigest: `sha256:${HEX.a}`,
    };
    const first = unwrapResult(
      stageLogicalRepositoryEditV1(request),
      'logical repository stage',
    ) as UnknownRecord;
    const second = unwrapResult(
      stageLogicalRepositoryEditV1(request),
      'repeated logical repository stage',
    );
    expect(first).toEqual(second);
    expect(first.stageId).toMatch(/^stage:v1:[0-9a-f]{64}$/u);
    expect(first.changed).toBeTrue();
    expect(Object.isFrozen(first)).toBeTrue();
    expect(first.beforeRevision).toEqual(expected);
    expect(first.afterRevision).toEqual(after);

    const parentChanged = Object.freeze({
      ...expected,
      parentMetadataIdentity: `metadata:v1:${HEX.b}`,
      absenceDigest: `absence:v1:${HEX.b}`,
      revisionDigest: `revision:v1:${HEX.b}`,
    });
    const appeared = Object.freeze({
      schemaVersion: 1,
      domain: 'ledger',
      resourceId: expected.resourceId,
      state: 'present',
      targetIdentity: '/fixture/data/placements.json',
      targetKind: 'file',
      targetMetadataIdentity: `metadata:v1:${HEX.c}`,
      parentIdentity: '/fixture/data',
      parentKind: 'directory',
      parentMetadataIdentity: `metadata:v1:${HEX.a}`,
      byteRevision: `sha256:${HEX.a}`,
      semanticRevision: `sha256:${HEX.b}`,
      revisionDigest: `revision:v1:${HEX.c}`,
    });
    for (const observedRevision of [parentChanged, appeared]) {
      const refused = resultRecord(
        stageLogicalRepositoryEditV1({ ...request, observedRevision }),
        'stale logical repository stage',
      );
      expect(refused.ok).toBeFalse();
      expect((refused.error as UnknownRecord).code).toBe('stale-revision');
    }
  });

  test('advances an immutable revision cursor only from truthful durability receipts', async () => {
    const module = await loadFutureModule('packages/core/src/execution/coordinator.ts');
    const createRevisionCursorV1 = requiredFunction(module, 'createRevisionCursorV1');
    const applyDurabilityReceiptV1 = requiredFunction(module, 'applyDurabilityReceiptV1');
    const fixture = snapshotFixture();
    const beforeLedger = fixture.ledger.revision;
    const beforeLive = fixture.live[0]?.revision;
    const afterLedger = Object.freeze({
      ...beforeLedger,
      parentMetadataIdentity: `metadata:v1:${HEX.d}`,
      absenceDigest: `absence:v1:${HEX.d}`,
      revisionDigest: `revision:v1:${HEX.d}`,
    });
    const operationId = `operation:v1:${HEX.a}`;
    const plan = Object.freeze({
      schemaVersion: 1,
      snapshotId: fixture.snapshotId,
      expectedRevisions: Object.freeze([beforeLedger, beforeLive]),
      plan: Object.freeze({ operations: Object.freeze([{ operationId }]) }),
    });
    const cursor = createRevisionCursorV1(plan) as UnknownRecord;
    expect(Object.isFrozen(cursor)).toBeTrue();
    expect(Object.isFrozen(cursor.revisions)).toBeTrue();
    const cursorBefore = structuredClone(cursor);
    const committed = unwrapResult(
      applyDurabilityReceiptV1(cursor, {
        schemaVersion: 1,
        operationId,
        disposition: 'committed',
        revisions: [
          {
            resourceId: beforeLedger.resourceId,
            beforeRevision: beforeLedger,
            afterRevision: afterLedger,
          },
        ],
      }),
      'committed cursor receipt',
    ) as UnknownRecord;
    expect(cursor).toEqual(cursorBefore);
    expect(committed).not.toBe(cursor);
    const committedRevisions = committed.revisions as readonly UnknownRecord[];
    expect(
      committedRevisions.find((revision) => revision.resourceId === beforeLedger.resourceId),
    ).toEqual(afterLedger);
    expect(
      committedRevisions.find((revision) => revision.resourceId === beforeLive?.resourceId),
    ).toEqual(beforeLive);

    const rolledBack = unwrapResult(
      applyDurabilityReceiptV1(cursor, {
        schemaVersion: 1,
        operationId,
        disposition: 'rolled-back',
        revisions: [
          {
            resourceId: beforeLedger.resourceId,
            beforeRevision: beforeLedger,
            afterRevision: beforeLedger,
          },
        ],
      }),
      'rolled-back cursor receipt',
    );
    expect(rolledBack).toEqual(cursor);
    for (const receipt of [
      {
        schemaVersion: 1,
        operationId,
        disposition: 'indeterminate',
        revisions: [],
      },
      {
        schemaVersion: 1,
        operationId,
        disposition: 'committed',
        revisions: [
          {
            resourceId: beforeLedger.resourceId,
            beforeRevision: afterLedger,
            afterRevision: beforeLedger,
          },
        ],
      },
    ]) {
      const refused = resultRecord(applyDurabilityReceiptV1(cursor, receipt), 'refused receipt');
      expect(refused.ok).toBeFalse();
    }
  });

  test('preserves an earlier committed pair when a later pair refuses before staging', async () => {
    const module = await loadFutureModule('packages/core/src/execution/coordinator.ts');
    const createRevisionCursorV1 = requiredFunction(module, 'createRevisionCursorV1');
    const applyDurabilityReceiptV1 = requiredFunction(module, 'applyDurabilityReceiptV1');
    const executeRepositoryLifecycleV1 = requiredFunction(module, 'executeRepositoryLifecycleV1');
    const fixture = snapshotFixture();
    const beforeA = fixture.ledger.revision;
    const beforeB = fixture.live[0]?.revision;
    const afterA = Object.freeze({
      ...beforeA,
      parentMetadataIdentity: `metadata:v1:${HEX.d}`,
      absenceDigest: `absence:v1:${HEX.d}`,
      revisionDigest: `revision:v1:${HEX.d}`,
    });
    const operationA = `operation:v1:${HEX.a}`;
    const operationB = `operation:v1:${HEX.b}`;
    const initial = createRevisionCursorV1({
      schemaVersion: 1,
      snapshotId: fixture.snapshotId,
      expectedRevisions: [beforeA, beforeB],
      plan: { operations: [{ operationId: operationA }, { operationId: operationB }] },
    });
    const afterFirst = unwrapResult(
      applyDurabilityReceiptV1(initial, {
        schemaVersion: 1,
        operationId: operationA,
        disposition: 'committed',
        revisions: [
          {
            resourceId: beforeA.resourceId,
            beforeRevision: beforeA,
            afterRevision: afterA,
          },
        ],
      }),
      'first pair commit',
    ) as UnknownRecord;
    const second = resultRecord(
      await executeRepositoryLifecycleV1(afterFirst, {
        operationId: operationB,
        stage: async () => ({
          ok: false,
          error: { code: 'stage-refused', reason: 'second-pair-stale' },
        }),
        commit: async () => {
          throw new Error('commit must not run after second-pair stage refusal');
        },
        rollback: async () => {
          throw new Error('rollback must not run after second-pair stage refusal');
        },
        cleanup: async () => {
          throw new Error('cleanup must not run after second-pair stage refusal');
        },
      }),
      'second pair refusal',
    );
    expect(second.ok).toBeFalse();
    const returnedCursor = (second.error as UnknownRecord).cursor as UnknownRecord;
    const revisions = returnedCursor.revisions as readonly UnknownRecord[];
    expect(revisions.find((revision) => revision.resourceId === beforeA.resourceId)).toEqual(
      afterA,
    );
    expect(revisions.find((revision) => revision.resourceId === beforeB?.resourceId)).toEqual(
      beforeB,
    );
  });

  test('runs stage, commit, rollback, and cleanup with truthful cursor state on every fault', async () => {
    const module = await loadFutureModule('packages/core/src/execution/coordinator.ts');
    const createRevisionCursorV1 = requiredFunction(module, 'createRevisionCursorV1');
    const executeRepositoryLifecycleV1 = requiredFunction(module, 'executeRepositoryLifecycleV1');
    const fixture = snapshotFixture();
    const before = fixture.ledger.revision;
    const after = Object.freeze({
      ...before,
      parentMetadataIdentity: `metadata:v1:${HEX.d}`,
      absenceDigest: `absence:v1:${HEX.d}`,
      revisionDigest: `revision:v1:${HEX.d}`,
    });
    const operationId = `operation:v1:${HEX.b}`;
    const cursor = createRevisionCursorV1({
      schemaVersion: 1,
      snapshotId: fixture.snapshotId,
      expectedRevisions: [before],
      plan: { operations: [{ operationId }] },
    });
    const stage = Object.freeze({
      schemaVersion: 1,
      stageId: `stage:v1:${HEX.a}`,
      operationId,
      domain: 'ledger',
      resourceId: before.resourceId,
      expectedRevision: before,
      beforeRevision: before,
      afterRevision: after,
      changed: true,
      editDigest: `sha256:${HEX.a}`,
    });
    const receipt = (disposition: 'committed' | 'rolled-back' | 'indeterminate') =>
      Object.freeze({
        schemaVersion: 1,
        operationId,
        disposition,
        revisions: Object.freeze([
          Object.freeze({
            resourceId: before.resourceId,
            beforeRevision: before,
            afterRevision: disposition === 'committed' ? after : before,
          }),
        ]),
      });
    const okResult = (value: unknown) => Object.freeze({ ok: true as const, value });
    const errResult = (code: string) =>
      Object.freeze({ ok: false as const, error: Object.freeze({ code }) });

    const successfulCalls: string[] = [];
    const successful = resultRecord(
      await executeRepositoryLifecycleV1(cursor, {
        operationId,
        stage: async () => {
          successfulCalls.push('stage');
          return okResult([stage]);
        },
        commit: async () => {
          successfulCalls.push('commit');
          return okResult(receipt('committed'));
        },
        rollback: async () => {
          successfulCalls.push('rollback');
          return okResult(receipt('rolled-back'));
        },
        cleanup: async (_stages: unknown, disposition: string) => {
          successfulCalls.push(`cleanup:${disposition}`);
          return okResult(undefined);
        },
      }),
      'successful repository lifecycle',
    );
    expect(successful.ok).toBeTrue();
    expect(successfulCalls).toEqual(['stage', 'commit', 'cleanup:committed']);
    expect(((successful.value as UnknownRecord).cursor as UnknownRecord).revisions).toContainEqual(
      after,
    );

    const stageCalls: string[] = [];
    const stageRefusal = resultRecord(
      await executeRepositoryLifecycleV1(cursor, {
        operationId,
        stage: async () => {
          stageCalls.push('stage');
          return errResult('stage-refused');
        },
        commit: async () => {
          stageCalls.push('commit');
          return okResult(receipt('committed'));
        },
        rollback: async () => {
          stageCalls.push('rollback');
          return okResult(receipt('rolled-back'));
        },
        cleanup: async () => {
          stageCalls.push('cleanup');
          return okResult(undefined);
        },
      }),
      'stage refusal',
    );
    expect(stageRefusal.ok).toBeFalse();
    expect(stageCalls).toEqual(['stage']);
    expect((stageRefusal.error as UnknownRecord).cursor).toEqual(cursor);

    const rollbackCalls: string[] = [];
    const rolledBack = resultRecord(
      await executeRepositoryLifecycleV1(cursor, {
        operationId,
        stage: async () => {
          rollbackCalls.push('stage');
          return okResult([stage]);
        },
        commit: async () => {
          rollbackCalls.push('commit');
          return errResult('commit-failed');
        },
        rollback: async () => {
          rollbackCalls.push('rollback');
          return okResult(receipt('rolled-back'));
        },
        cleanup: async (_stages: unknown, disposition: string) => {
          rollbackCalls.push(`cleanup:${disposition}`);
          return okResult(undefined);
        },
      }),
      'rolled-back repository lifecycle',
    );
    expect(rolledBack.ok).toBeFalse();
    expect(rollbackCalls).toEqual(['stage', 'commit', 'rollback', 'cleanup:rolled-back']);
    expect((rolledBack.error as UnknownRecord).cursor).toEqual(cursor);

    const cleanupCalls: string[] = [];
    const cleanupFailure = resultRecord(
      await executeRepositoryLifecycleV1(cursor, {
        operationId,
        stage: async () => {
          cleanupCalls.push('stage');
          return okResult([stage]);
        },
        commit: async () => {
          cleanupCalls.push('commit');
          return okResult(receipt('committed'));
        },
        rollback: async () => {
          cleanupCalls.push('rollback');
          return okResult(receipt('rolled-back'));
        },
        cleanup: async (_stages: unknown, disposition: string) => {
          cleanupCalls.push(`cleanup:${disposition}`);
          return errResult('cleanup-failed');
        },
      }),
      'cleanup failure after commit',
    );
    expect(cleanupFailure.ok).toBeFalse();
    expect(cleanupCalls).toEqual(['stage', 'commit', 'cleanup:committed']);
    expect(
      ((cleanupFailure.error as UnknownRecord).cursor as UnknownRecord).revisions,
    ).toContainEqual(after);

    const rollbackFailureCalls: string[] = [];
    const rollbackFailure = resultRecord(
      await executeRepositoryLifecycleV1(cursor, {
        operationId,
        stage: async () => {
          rollbackFailureCalls.push('stage');
          return okResult([stage]);
        },
        commit: async () => {
          rollbackFailureCalls.push('commit');
          return errResult('commit-failed-after-boundary');
        },
        rollback: async () => {
          rollbackFailureCalls.push('rollback');
          return errResult('rollback-failed');
        },
        cleanup: async () => {
          rollbackFailureCalls.push('cleanup');
          return okResult(undefined);
        },
      }),
      'rollback failure',
    );
    expect(rollbackFailure.ok).toBeFalse();
    expect(rollbackFailureCalls).toEqual(['stage', 'commit', 'rollback']);
    expect((rollbackFailure.error as UnknownRecord).disposition).toBe('indeterminate');
    expect((rollbackFailure.error as UnknownRecord).cursor).toBeNull();

    const indeterminateCalls: string[] = [];
    const indeterminate = resultRecord(
      await executeRepositoryLifecycleV1(cursor, {
        operationId,
        stage: async () => {
          indeterminateCalls.push('stage');
          return okResult([stage]);
        },
        commit: async () => {
          indeterminateCalls.push('commit');
          return okResult(receipt('indeterminate'));
        },
        rollback: async () => {
          indeterminateCalls.push('rollback');
          return okResult(receipt('rolled-back'));
        },
        cleanup: async () => {
          indeterminateCalls.push('cleanup');
          return okResult(undefined);
        },
      }),
      'indeterminate repository lifecycle',
    );
    expect(indeterminate.ok).toBeFalse();
    expect(indeterminateCalls).toEqual(['stage', 'commit']);
    expect((indeterminate.error as UnknownRecord).cursor).toEqual(cursor);
  });

  test('derives status from the approved snapshot without receiving write capabilities', async () => {
    const module = await loadFutureModule('packages/core/src/status/read.ts');
    const createStatusReportFromSnapshot = requiredFunction(
      module,
      'createStatusReportFromSnapshot',
    );
    const snapshot = structuredClone(snapshotFixture());
    const request = {
      projectContext: snapshot.project.value,
      projectPlacement: { state: 'unselected' },
      configuration: resolveRuntimeConfiguration({}),
      targets: [],
      tools: ['codex'],
      toolSelectionSource: 'explicit',
      scopes: ['system'],
      scopeSelectionSource: 'explicit',
      selectionSource: 'bounded-default',
      artifactSelection: { state: 'unselected', reason: 'live-only-scope' },
    };
    const requestBefore = structuredClone(request);
    const snapshotBefore = structuredClone(snapshot);
    const result = resultRecord(
      await Promise.resolve(createStatusReportFromSnapshot(request, snapshot)),
      'status from snapshot',
    );
    expect(result.ok).toBeTrue();
    const report = result.value as UnknownRecord;
    expect((report.summary as UnknownRecord).entries).toBe(0);
    expect(report.entries).toEqual([]);
    expect(Object.isFrozen(report)).toBeTrue();
    expect(request).toEqual(requestBefore);
    expect(snapshot).toEqual(snapshotBefore);
  });

  test('closes the artifacts-to-place and foundational-planning dependency reversals', () => {
    const artifactViolations = OWNED_SOURCE.filter(
      (path) =>
        path.includes('/artifacts/') &&
        relativeImports(path).some((specifier) => /(?:^|\/)place\//u.test(specifier)),
    );
    const planningViolations = OWNED_SOURCE.filter(
      (path) =>
        path.includes('/planning/') &&
        relativeImports(path).some((specifier) => /(?:^|\/)(?:acquire|place)\//u.test(specifier)),
    );
    expect(
      { artifactViolations, planningViolations },
      'foundational artifacts/planning modules must not import mutation runners',
    ).toEqual({ artifactViolations: [], planningViolations: [] });
  });

  test('adds the exact responsibility modules without replacing proven durability engines', () => {
    const missing = FUTURE_MODULES.filter((path) => !present(path));
    expect(missing, 'G3B-04 responsibility module inventory').toEqual([]);
    expect(source('packages/core/src/artifacts/ledger-writer.ts')).toContain(
      'export const createNodeLedgerWriter',
    );
    expect(source('packages/core/src/artifacts/repository.ts')).toContain(
      'artifactContractRegistry',
    );
  });

  test('owns hostile ordinary data and defines exact present and revisioned-absence identities', () => {
    const ownership = source('packages/core/src/state/ownership.ts');
    const types = source('packages/core/src/state/types.ts');
    for (const marker of [
      'isProxy',
      'getOwnPropertyDescriptor',
      'Reflect.ownKeys',
      'MAX_OWNED_NODES',
      'MAX_OWNED_DEPTH',
      'Object.freeze',
    ]) {
      expect(ownership, `ordinary-data ownership must enforce ${marker}`).toContain(marker);
    }
    for (const marker of [
      'ExpectedRevisionV1',
      'targetIdentity',
      'targetKind',
      'parentIdentity',
      'parentKind',
      'parentMetadataIdentity',
      'absenceDigest',
    ]) {
      expect(types, `revision contract must include ${marker}`).toContain(marker);
    }
  });

  test('builds one deterministic two-pass immutable snapshot and refuses mixed revisions', () => {
    const stateTypes = source('packages/core/src/state/types.ts');
    const reader = source('packages/core/src/state/read.ts');
    for (const marker of [
      'ObservedStateSnapshotV1',
      'snapshotId',
      'manifest',
      'lock',
      'ledger',
      'live',
      'store',
      'capabilities',
    ]) {
      expect(stateTypes, `observed snapshot must include ${marker}`).toContain(marker);
    }
    expect(reader).toContain('snapshot-changed');
    expect(reader).toMatch(/readRevisionVector|revisionVector/iu);
    expect(reader).toMatch(/snapshot:v1:|createHash\(['"]sha256['"]\)/u);
    expect(reader).not.toMatch(/\b(?:Date\.now|Math\.random|nextId|wallNowIso)\b/u);
  });

  test('makes acquisition and placement planners synchronous, port-free, and repository-free', () => {
    const placementPlanner = source('packages/core/src/place/plan.ts');
    const acquisitionPlanner = source('packages/core/src/acquire/plan.ts');
    for (const path of ['packages/core/src/place/plan.ts', 'packages/core/src/acquire/plan.ts']) {
      const forbidden = relativeImports(path).filter(
        (specifier) =>
          /^node:(?:fs|child_process|cluster|dgram|dns|http|https|net|process|tls|worker_threads)(?:\/|$)/u.test(
            specifier,
          ) ||
          /(?:^|\/)(?:ports|execution|application)(?:\/|$)/u.test(specifier) ||
          /(?:^|\/)state\/repositories(?:\.ts)?$/u.test(specifier) ||
          /(?:^|\/)(?:acquire|place)\/run(?:\.ts)?$/u.test(specifier) ||
          /(?:^|\/)run(?:\.ts)?$/u.test(specifier),
      );
      expect(forbidden, `${path} effect/orchestrator imports`).toEqual([]);
    }
    expect(
      /export const create(?:Dev|Promote|Rollback|Placement)Plan/u.test(placementPlanner),
      'placement planner entry point',
    ).toBeTrue();
    expect(
      /export const create(?:Install|Uninstall|Acquisition)Plan/u.test(acquisitionPlanner),
      'acquisition planner entry point',
    ).toBeTrue();
    expect(
      /export const create[A-Za-z]+Plan\s*=\s*async\b/u.test(
        `${placementPlanner}\n${acquisitionPlanner}`,
      ),
      'planners must remain synchronous',
    ).toBeFalse();
  });

  test('defines five behavior-specific isolated repositories with an explicit stage lifecycle', () => {
    const contracts = source('packages/core/src/state/repositories.ts');
    for (const name of [
      'ManifestRepository',
      'LockRepository',
      'LedgerRepository',
      'LivePlacementRepository',
      'StoreRepository',
    ]) {
      expect(contracts, `missing focused ${name}`).toContain(name);
    }
    for (const phase of ['stage', 'commit', 'rollback', 'cleanup']) {
      expect(contracts, `repository lifecycle must expose ${phase}`).toMatch(
        new RegExp(`\\b${phase}\\b`, 'u'),
      );
    }
    expect(contracts).not.toMatch(/\b(?:interface|type|class)\s+Repository\s*</u);

    const adapters = [
      'packages/core/src/artifacts/ledger-repository.ts',
      'packages/core/src/place/live-repository.ts',
      'packages/core/src/place/store-repository.ts',
    ];
    for (const adapter of adapters) {
      expect(
        relativeImports(adapter).filter((specifier) => /-repository\.ts$/u.test(specifier)),
        `${adapter} must not call another repository`,
      ).toEqual([]);
    }
  });

  test('keeps revision comparison and advancement in the execution coordinator only', () => {
    const coordinator = source('packages/core/src/execution/coordinator.ts');
    const types = source('packages/core/src/execution/types.ts');
    expect(
      coordinator.includes('../planning/create.ts'),
      'execution-to-planner reversal',
    ).toBeFalse();
    expect(
      `${types}\n${coordinator}`.includes('RevisionCursor'),
      'execution revision cursor type',
    ).toBeTrue();
    for (const marker of [
      'beforeRevision',
      'afterRevision',
      'advanceRevisionCursor',
      'restoreRevisionCursor',
      'indeterminate',
    ]) {
      expect(coordinator.includes(marker), `coordinator cursor must own ${marker}`).toBeTrue();
    }
  });

  test('retires mutable ledger authority from SwapCtx and keeps reducers copy-on-write', () => {
    const reducers = `${source('packages/core/src/place/ledger.ts')}\n${source(
      'packages/core/src/place/logical-transactions.ts',
    )}`;
    const forbiddenMembers = new Set(['ledger', 'persist', 'now', 'newTxId']);
    expect(
      interfaceMembers('packages/core/src/place/types.ts', 'SwapCtx').filter((member) =>
        forbiddenMembers.has(member),
      ),
      'SwapCtx must not own mutable ledger/persistence/time/id authority',
    ).toEqual([]);
    expect(reducers).toContain('withLedgerPairAt');
    expect(reducers).toContain('withoutLedgerPairAt');
    expect(reducers).not.toMatch(/\b(?:writeFile|rename|fsync|nextId|wallNowIso)\s*\(/u);
    expect(source('packages/core/src/artifacts/ledger-history.ts')).toContain(
      'selectBoundedHistory',
    );
    expect(source('packages/core/src/place/history.ts')).toMatch(
      /export\s+\{[\s\S]*selectBoundedHistory[\s\S]*\}\s+from\s+['"]\.\.\/artifacts\/ledger-history\.ts['"]/u,
    );
  });

  test('makes status a read-only consumer of the shared observed snapshot', () => {
    const status = `${source('packages/core/src/status/read.ts')}\n${source(
      'packages/core/src/status/join.ts',
    )}`;
    expect(
      /from ['"]\.\.\/state\/(?:read|types)\.ts['"]/u.test(status),
      'status must import the shared state boundary',
    ).toBeTrue();
    expect(status.includes('ObservedStateSnapshotV1'), 'status shared snapshot input').toBeTrue();
    expect(
      /\b(?:FileWritePort|LockPort|ProcessPort|ClockPort|IdPort|InteractionPort)\b/u.test(status),
      'status must not receive write/effect capabilities',
    ).toBeFalse();
  });

  test('characterizes the Ready runner no-growth baselines', () => {
    expect(lineCount('packages/core/src/acquire/run.ts')).toBeLessThanOrEqual(
      ACQUIRE_RUN_MAX_LINES,
    );
    expect(lineCount('packages/core/src/place/run.ts')).toBeLessThanOrEqual(PLACE_RUN_MAX_LINES);
  });

  test('moves planning, execution, and recovery behind delegated responsibility exports', () => {
    const responsibilities = [
      ['packages/core/src/acquire/plan.ts', /^(?:create|plan).+Plan$/u],
      ['packages/core/src/acquire/execute.ts', /^execute.+Plan$/u],
      ['packages/core/src/acquire/recovery.ts', /^recover/u],
      ['packages/core/src/place/plan.ts', /^(?:create|plan).+Plan$/u],
      ['packages/core/src/place/execute.ts', /^execute.+Plan$/u],
      ['packages/core/src/place/recovery.ts', /^recover/u],
    ] as const;
    for (const [path, expectedExport] of responsibilities) {
      expect(
        exportedNames(path).some((name) => expectedExport.test(name)),
        `${path} must export its assigned responsibility`,
      ).toBeTrue();
    }
    for (const domain of ['acquire', 'place'] as const) {
      const imports = relativeImports(`packages/core/src/${domain}/run.ts`);
      for (const responsibility of ['plan', 'execute', 'recovery']) {
        expect(
          imports.some((specifier) =>
            new RegExp(`^\\./${responsibility}(?:\\.ts)?$`, 'u').test(specifier),
          ),
          `${domain}/run.ts must delegate ${responsibility}`,
        ).toBeTrue();
      }
    }
  });

  test('removes every cycle from the complete owned source import graph', () => {
    expect(ownedCycles(), 'owned source import cycles').toEqual([]);
  });

  test('characterizes the anti-framework and private-surface boundary', () => {
    const frameworks = OWNED_SOURCE.flatMap((path) =>
      declaredFrameworks(path).map((name) => `${path}:${name}`),
    );
    expect(frameworks, 'generic persistence/framework declarations').toEqual([]);

    const publicPaths = [
      'packages/core/src/index.ts',
      'packages/core/src/public-types.ts',
      ...filesBelow('packages/cli/src'),
    ];
    const leaked = publicPaths
      .filter((path) => existsSync(path))
      .flatMap((path) =>
        usedPrivateSymbols(path).map(
          (name) => `${relative(ROOT, path).replaceAll('\\', '/')}:${name}`,
        ),
      );
    expect(leaked, 'G3B-04 private types must not enter public or CLI surfaces').toEqual([]);
  });
});
