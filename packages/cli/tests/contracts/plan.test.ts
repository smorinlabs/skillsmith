import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanV1Dto } from '@skillsmith/core/contracts/v1';
import {
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../../packages/core/tests/fixtures/acquire/remote.ts';
import {
  EXIT_MATRIX,
  LOCK_MATRIX,
  OPERATION_MATRIX,
  PLAN_SELECTORS,
  PRUNE_EXCLUSIONS,
  type PlanFixture,
  createPlanFixture,
  destroyPlanFixture,
  fileSnapshot,
  jsonReport,
  lockSource,
  manifestSource,
  runPlanCli,
} from '../../../../tests/ergonomics/fixtures/p4b-plan/cases.ts';
import {
  EMPTY_SUMMARY,
  INSTALL_SUMMARY,
  PLAN_REPORT_KIND,
  REDACTION_CANARIES,
  SYNTHETIC_OPERATION_ROWS,
} from '../../../../tests/ergonomics/fixtures/p4b-plan/goldens.ts';
import { renderPlanHuman } from '../../src/output/plan-human.ts';
import { buildProgram } from '../../src/program.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;

const fixtures: PlanFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(destroyPlanFixture));
});

const planFixture = async (
  skills: Parameters<typeof createPlanFixture>[0] = [],
  options: Parameters<typeof createPlanFixture>[1] = {},
): Promise<PlanFixture> => {
  const fixture = await createPlanFixture(skills, options);
  fixtures.push(fixture);
  return fixture;
};

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is UnknownRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

const planJson = async (
  fixture: PlanFixture,
  args: readonly string[] = [],
  expectedExit = 0,
): Promise<UnknownRecord> =>
  jsonReport(
    await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--lockfile',
      fixture.lock,
      ...args,
      '--json',
    ]),
    expectedExit,
    `skillsmith plan ${args.join(' ')}`,
  );

const summary = (report: UnknownRecord): UnknownRecord => {
  expect(report.kind).toBe(PLAN_REPORT_KIND);
  expect(typeof report.summary).toBe('object');
  expect(report.summary).not.toBeNull();
  return report.summary as UnknownRecord;
};

const treeEntries = async (root: string): Promise<readonly string[]> =>
  (await readdir(root, { recursive: true, encoding: 'utf8' })).sort();

const countTotal = (value: unknown): number =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.values(value).reduce(
        (total: number, count) => total + (typeof count === 'number' ? count : 0),
        0,
      )
    : 0;

const PLAN_ERROR_EXITS = [
  ['failure', 1],
  ['usage', 2],
  ['state', 3],
  ['capability', 4],
  ['source', 5],
  ['permission', 6],
  ['cancelled', 130],
] as const;

const runInjectedPlanOutcome = async (
  fixture: PlanFixture,
  report: UnknownRecord,
  exitClass: (typeof PLAN_ERROR_EXITS)[number][0],
) => {
  const writes = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] };
  const controller = new AbortController();
  if (exitClass === 'cancelled') controller.abort();
  let calls = 0;
  let signalAborted = false;
  const program = buildProgram(controller.signal, {
    applications: {
      plan: async (_request, context) => {
        calls += 1;
        signalAborted = (context as { readonly signal?: AbortSignal }).signal?.aborted === true;
        return {
          report: { result: report },
          diagnostics: [
            {
              code: `synthetic-${exitClass}`,
              severity: 'error' as const,
              message: `synthetic local ${exitClass} fixture`,
            },
          ],
          exitClass: signalAborted ? ('cancelled' as const) : exitClass,
          mutation: { kind: 'none' as const, planned: 0, changed: 0, unchanged: 0, failed: 0 },
          deprecations: [],
        };
      },
    },
    runtimePorts: {
      stdout: { write: (value) => writes.stdout.push(value) },
      stderr: { write: (value) => writes.stderr.push(value) },
      exit: (code) => writes.exits.push(code),
    },
  });
  await program.parseAsync([
    'node',
    'skillsmith',
    'plan',
    '--file',
    fixture.manifest,
    '--lockfile',
    fixture.lock,
    '--locked',
    '--check',
    '--json',
  ]);
  return { ...writes, calls, signalAborted };
};

describe('EWP-CMD-PLAN-TS01', () => {
  test('empty/create/update/remove/move/adapt/migrations/noop render through one operation vocabulary', async () => {
    expect(PLAN_SELECTORS).toContain('EWP-CMD-PLAN-TS01');
    expect(OPERATION_MATRIX).toEqual([
      'empty',
      'install',
      'update',
      'remove',
      'move-scope',
      'adapt',
      'migrate-project-config',
      'migrate-ledger',
      'noop',
    ]);
    expect(SYNTHETIC_OPERATION_ROWS.map((row) => row.kind)).toContain('adapt');

    const empty = await planFixture();
    expect(summary(await planJson(empty, ['--locked']))).toMatchObject(EMPTY_SUMMARY);

    const install = await planFixture([{ name: 'alpha' }]);
    const report = await planJson(install, ['--locked']);
    expect(summary(report)).toMatchObject(INSTALL_SUMMARY);
    expect(records(report.operations).map((operation) => operation.kind)).toContain('install');
  });
});

describe('EWP-CMD-PLAN-TS02', () => {
  test('canonical order, IDs, report bytes, and saved bytes repeat exactly', async () => {
    const fixture = await planFixture([
      { name: 'zulu', tool: 'codex' },
      { name: 'alpha', tool: 'claude-code' },
    ]);
    const first = await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--locked',
      '--json',
    ]);
    const second = await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--locked',
      '--json',
    ]);
    expect(first.exitCode).toBe(0);
    expect(second).toEqual(first);
    const report = jsonReport(first, 0, 'first deterministic plan');
    const operations = records(report.operations);
    const ids = operations.map((operation) => operation.operationId);
    expect(operations.map((operation) => operation.skill)).toEqual(['alpha', 'zulu']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => String(id).startsWith('operation:v1:'))).toBeTrue();

    await planJson(fixture, ['--locked', '--out', fixture.out]);
    const firstArtifact = await readFile(fixture.out);
    await writeFile(fixture.out, firstArtifact);
    await planJson(fixture, ['--locked', '--out', fixture.out, '--force']);
    expect(await readFile(fixture.out)).toEqual(firstArtifact);
  });
});

describe('EWP-CMD-PLAN-TS03', () => {
  test('artifact discovery, exact custom pair, filters, roots, legacy protection, and singular grammar are bounded', async () => {
    const fixture = await planFixture([{ name: 'alpha' }]);
    const exact = await planJson(fixture, ['--locked', '--tool', 'codex', '--scope', 'user']);
    expect(exact.artifactPair).toMatchObject({
      manifestPath: fixture.manifest,
      lockPath: fixture.lock,
      lockSource: 'explicit',
    });
    expect(exact.selection).toMatchObject({ selectionSource: 'bounded-default' });

    for (const args of [
      ['plan', fixture.manifest],
      ['plan', '--file', fixture.manifest, '--file', fixture.manifest],
      ['plan', '--lockfile', fixture.lock],
      ['plan', '--file', fixture.manifest, '--scope', 'user', '--project'],
      ['plan', '--file', fixture.manifest, '--scope', 'user', '--user'],
      ['plan', '--file', fixture.manifest, '--user', '--user'],
      ['plan', '--file', fixture.manifest, '--project', '--project'],
    ]) {
      const product = await runPlanCli(fixture, [...args, '--json']);
      expect(product.exitCode, `${args.join(' ')}\n${product.stderr}`).toBe(2);
    }
  });

  test('project placements stay anchored to the discovered root from a nested cwd', async () => {
    const fixture = await planFixture([{ name: 'alpha', scope: 'project' }]);
    const nestedCwd = join(fixture.cwd, 'packages', 'client');
    await mkdir(nestedCwd, { recursive: true });
    const nestedFixture = { ...fixture, cwd: nestedCwd };

    const report = await planJson(nestedFixture, ['--locked']);
    expect(report.project).toMatchObject({
      effectiveCwd: nestedCwd,
      root: fixture.cwd,
    });
    expect(records(report.operations)).toContainEqual(
      expect.objectContaining({
        skill: 'alpha',
        after: expect.objectContaining({
          resource: {
            kind: 'live',
            skill: 'alpha',
            tool: 'codex',
            scope: 'project',
            projectRoot: { kind: 'machine-bound', path: fixture.cwd },
            location: {
              kind: 'machine-bound',
              path: join(fixture.cwd, '.agents', 'skills', 'alpha'),
            },
          },
        }),
      }),
    );
  });
});

describe('EWP-CMD-PLAN-TS04', () => {
  test('current/missing/incomplete/stale and invalid locks enforce resolution or strict refusal', async () => {
    expect(LOCK_MATRIX).toEqual([
      'current',
      'missing-default-resolution',
      'missing-locked-refusal',
      'incomplete-default-resolution',
      'incomplete-locked-refusal',
      'stale-default-resolution',
      'stale-locked-refusal',
      'noncanonical-refusal',
      'semantic-correlation-refusal',
      'unknown-hash-domain-refusal',
    ]);
    const current = await planFixture();
    expect((await planJson(current, ['--locked'])).artifactPair).toBeDefined();

    const missing = await planFixture([], { writeLock: false });
    expect(summary(await planJson(missing))).toMatchObject({ drift: 1 });
    expect(await planJson(missing, ['--locked'], 3)).toMatchObject({
      schemaVersion: 1,
      kind: 'error',
      exitCode: 3,
    });

    const stale = await planFixture();
    await writeFile(
      stale.lock,
      lockSource(manifestSource([]), { manifestHash: `sha256:${'c'.repeat(64)}` }),
    );
    expect(summary(await planJson(stale))).toMatchObject({ drift: 1 });
    expect(await planJson(stale, ['--locked'], 3)).toMatchObject({
      schemaVersion: 1,
      kind: 'error',
      exitCode: 3,
    });

    const remote = await buildRemoteFixture();
    try {
      const incomplete = await planFixture();
      const incompleteManifest = [
        'version = 1',
        '',
        '[[skills]]',
        'name = "lint"',
        'source = "fixture.invalid/acme/single//tools/deep/skills/lint"',
        'tools = ["codex"]',
        'scope = "user"',
        'placement = "copy"',
        '',
      ].join('\n');
      const completeLock = lockSource(incompleteManifest);
      const incompleteLock = `${completeLock.split('\n').slice(0, 3).join('\n')}\n`;
      const gitConfig = join(incomplete.root, 'gitconfig');
      await Promise.all([
        writeFile(incomplete.manifest, incompleteManifest),
        writeFile(incomplete.lock, incompleteLock),
        writeFile(
          gitConfig,
          `[url "${remote.singleUrl}"]\n\tinsteadOf = ${remote.singleSource}\n[protocol "file"]\n\tallow = always\n`,
        ),
      ]);
      const localOnly = {
        ...incomplete,
        env: {
          ...incomplete.env,
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_ALLOW_PROTOCOL: 'file:https',
        },
      };
      const resolved = await planJson(localOnly);
      expect(records(resolved.operations).map((operation) => operation.kind)).toEqual([
        'write-lock',
        'install',
      ]);
      expect(await readFile(incomplete.lock, 'utf8')).toBe(incompleteLock);
      expect(await planJson(localOnly, ['--locked'], 3)).toMatchObject({
        kind: 'error',
        code: 'plan-locked-state',
        exitCode: 3,
      });

      await writeFile(
        incomplete.lock,
        completeLock.replace(
          'fixture.invalid/acme/single//tools/deep/skills/lint',
          'fixture.invalid/other/single//tools/deep/skills/lint',
        ),
      );
      expect(await planJson(localOnly, ['--locked'], 3)).toMatchObject({
        kind: 'error',
        code: 'plan-locked-state',
        exitCode: 3,
      });
    } finally {
      await destroyRemoteFixture(remote);
    }

    const noncanonical = await planFixture();
    await writeFile(noncanonical.lock, `${await readFile(noncanonical.lock, 'utf8')} `);
    expect(await planJson(noncanonical, [], 3)).toMatchObject({
      schemaVersion: 1,
      kind: 'error',
      exitCode: 3,
    });

    for (const [name, source] of [
      [
        'schema-version',
        `version = 1\nhash_schema_version = 99\nmanifest_hash = "sha256:${'a'.repeat(64)}"\n`,
      ],
      [
        'digest-domain',
        `version = 1\nhash_schema_version = 1\nmanifest_hash = "unknown:${'a'.repeat(64)}"\n`,
      ],
    ] as const) {
      const invalid = await planFixture();
      await writeFile(invalid.lock, source);
      expect(await planJson(invalid, ['--locked'], 3), name).toMatchObject({
        kind: 'error',
        code: 'plan-invalid-shape',
        exitCode: 3,
      });
    }
  });
});

describe('EWP-CMD-PLAN-TS05', () => {
  test('selected manifest, prune visibility, filter-to-zero, and cross-scope authority never widen', async () => {
    const fixture = await planFixture([
      { name: 'alpha', tool: 'codex', scope: 'user' },
      { name: 'beta', tool: 'claude-code', scope: 'project' },
    ]);
    const narrowed = await planJson(fixture, ['--locked', '--tool', 'opencode']);
    expect(summary(narrowed)).toMatchObject({ operations: 0, drift: 0 });
    expect(narrowed.selection).toMatchObject({ tools: ['opencode'] });

    const selectedUser = await planJson(fixture, [
      '--locked',
      '--tool',
      'codex',
      '--scope',
      'user',
    ]);
    expect(records(selectedUser.operations)).toEqual([
      expect.objectContaining({ kind: 'install', skill: 'alpha', tool: 'codex', scope: 'user' }),
    ]);
    const emptyCrossProduct = await planJson(fixture, [
      '--locked',
      '--tool',
      'codex',
      '--scope',
      'project',
    ]);
    expect(summary(emptyCrossProduct)).toMatchObject({ operations: 0, drift: 0 });
    expect(emptyCrossProduct.selection).toMatchObject({
      selectionOutcome: 'filter-noop',
      requestedTools: ['codex'],
      requestedScope: 'project',
    });

    const canary = join(fixture.home, '.agents', 'skills', 'canary');
    await mkdir(canary, { recursive: true });
    await writeFile(join(canary, 'SKILL.md'), '# Undeclared canary\n');

    const withoutPrune = await planJson(fixture, ['--locked']);
    const withPrune = await planJson(fixture, ['--locked', '--prune']);
    for (const [label, report] of [
      ['without-prune', withoutPrune],
      ['with-prune', withPrune],
    ] as const) {
      expect(
        records(report.operations).filter((row) => row.kind === 'remove' && row.skill === 'canary'),
        label,
      ).toHaveLength(0);
      expect(records(report.diagnostics), label).toContainEqual(
        expect.objectContaining({
          kind: 'warning',
          severity: 'warning',
          refusalClass: null,
          affected: expect.objectContaining({
            skill: 'canary',
            tool: 'codex',
            scope: 'user',
            path: { kind: 'machine-bound', path: canary },
          }),
          reason: expect.objectContaining({ code: 'plan-undeclared-placement-preserved' }),
        }),
      );
    }
    expect(
      records(withPrune.operations).every((row) => row.selectionSource === 'bounded-default'),
    ).toBeTrue();
    expect(PRUNE_EXCLUSIONS).toContain('filter-to-zero');
  });
});

describe('EWP-CMD-PLAN-TS06', () => {
  test('conflicts, refusals, and partial capabilities stay explicit without dropping supported rows', async () => {
    const fixture = await planFixture([
      { name: 'alpha', tool: 'codex' },
      { name: 'beta', tool: 'kilo-code' },
    ]);
    const report = await planJson(fixture, ['--locked'], 4);
    expect(records(report.diagnostics).some((row) => row.kind === 'refuse')).toBeTrue();
    expect(records(report.operations).some((row) => row.tool === 'codex')).toBeTrue();
    expect(records(report.diagnostics).some((row) => row.affected && row.reason)).toBeTrue();
  });
});

describe('EWP-CMD-PLAN-TS07', () => {
  test('check exits 0/7, eager conflicts precede I/O, and exits 1..6/130 outrank drift', async () => {
    expect(EXIT_MATRIX).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 130]);
    const empty = await planFixture();
    expect(
      (await runPlanCli(empty, ['plan', '--file', empty.manifest, '--locked', '--check'])).exitCode,
    ).toBe(0);

    const drift = await planFixture([{ name: 'alpha' }]);
    expect(
      (await runPlanCli(drift, ['plan', '--file', drift.manifest, '--locked', '--check'])).exitCode,
    ).toBe(7);

    const partialPlan = await planJson(drift, ['--locked']);
    expect(summary(partialPlan).drift).toBe(1);
    for (const [exitClass, exitCode] of PLAN_ERROR_EXITS) {
      const execution = await runInjectedPlanOutcome(drift, partialPlan, exitClass);
      expect(execution.calls, exitClass).toBe(1);
      expect(execution.exits, exitClass).toEqual([exitCode]);
      expect(execution.signalAborted, exitClass).toBe(exitClass === 'cancelled');
      expect(execution.stderr, exitClass).toEqual([]);
      expect(execution.stdout, exitClass).toHaveLength(1);
      const emitted = JSON.parse(execution.stdout[0] ?? '{}') as UnknownRecord;
      expect(emitted.kind, exitClass).toBe(PLAN_REPORT_KIND);
      expect(summary(emitted).drift, exitClass).toBe(1);
    }

    const lockedState = await planFixture([{ name: 'locked-state' }], { writeLock: false });
    expect(
      (
        await runPlanCli(lockedState, [
          'plan',
          '--file',
          lockedState.manifest,
          '--locked',
          '--check',
          '--json',
        ])
      ).exitCode,
    ).toBe(3);

    const capability = await planFixture([
      { name: 'supported', tool: 'codex' },
      { name: 'unsupported', tool: 'kilo-code' },
    ]);
    const capabilityProduct = await runPlanCli(capability, [
      'plan',
      '--file',
      capability.manifest,
      '--locked',
      '--check',
      '--json',
    ]);
    expect(capabilityProduct.exitCode).toBe(4);
    expect(summary(jsonReport(capabilityProduct, 4, 'production capability refusal')).drift).toBe(
      1,
    );

    const source = await planFixture([{ name: 'source-failure' }], { writeLock: false });
    const gitConfig = join(source.root, 'gitconfig');
    await writeFile(
      gitConfig,
      `[url "file://${join(source.root, 'absent.git')}"]\n\tinsteadOf = https://fixture.invalid/acme/skills.git\n[protocol "file"]\n\tallow = always\n`,
    );
    const localFailure = {
      ...source,
      env: {
        ...source.env,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_ALLOW_PROTOCOL: 'file:https',
      },
    };
    expect(
      (await runPlanCli(localFailure, ['plan', '--file', source.manifest, '--check', '--json']))
        .exitCode,
    ).toBe(5);

    const permission = await planFixture([{ name: 'permission' }]);
    await chmod(permission.lock, 0o000);
    try {
      expect(
        (
          await runPlanCli(permission, [
            'plan',
            '--file',
            permission.manifest,
            '--locked',
            '--check',
            '--json',
          ])
        ).exitCode,
      ).toBe(6);
    } finally {
      await chmod(permission.lock, 0o600);
    }

    for (const args of [
      ['plan', '--check', '--out', drift.out],
      ['plan', '--check', '--force'],
      ['plan', '--force'],
      ['plan', '--out', '-'],
    ]) {
      const product = await runPlanCli(drift, [...args, '--file', 'does-not-exist.toml', '--json']);
      expect(product.exitCode, args.join(' ')).toBe(2);
    }
  });
});

describe('EWP-CMD-PLAN-TS08', () => {
  test('human and JSON render the same operations, selection, and summary counts', async () => {
    const fixture = await planFixture([{ name: 'alpha' }]);
    const json = await planJson(fixture, ['--locked']);
    const human = await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--lockfile',
      fixture.lock,
      '--locked',
    ]);
    expect(human.exitCode).toBe(0);
    const operations = records(json.operations);
    const checks = records(json.checks);
    const diagnostics = records(json.diagnostics);
    const reportSummary = summary(json);
    expect(reportSummary).toMatchObject({
      operations: operations.length,
      checks: checks.length,
      diagnostics: diagnostics.length,
    });
    expect(countTotal(reportSummary.operationKinds)).toBe(operations.length);
    expect(countTotal(reportSummary.checkKinds)).toBe(checks.length);
    expect(countTotal(reportSummary.diagnosticKinds)).toBe(diagnostics.length);
    expect(human.stdout).toBe(renderPlanHuman(json as unknown as PlanV1Dto));
    expect(human.stderr).toBe('');
  });
});

describe('EWP-CMD-PLAN-TS09', () => {
  test('discovered project plans save identical bytes across different absolute roots', async () => {
    const first = await planFixture([{ name: 'alpha', scope: 'project' }]);
    const second = await planFixture([{ name: 'alpha', scope: 'project' }]);
    for (const fixture of [first, second]) {
      const result = await runPlanCli(fixture, [
        'plan',
        '--locked',
        '--out',
        'review.skillsmith.plan',
        '--json',
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
    }

    const firstBytes = await readFile(first.out, 'utf8');
    const secondBytes = await readFile(second.out, 'utf8');
    expect(firstBytes).toBe(secondBytes);
    expect(firstBytes).not.toContain(first.root);
    expect(secondBytes).not.toContain(second.root);
  });

  test('saved output is canonical, owner-only, create-only/atomic-force, redacted, and separate from stdout', async () => {
    const fixture = await planFixture([{ name: 'alpha' }]);
    const created = await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--locked',
      '--out',
      fixture.out,
      '--json',
    ]);
    const report = jsonReport(created, 0, 'saved output create');
    const bytes = await readFile(fixture.out, 'utf8');
    expect(JSON.parse(bytes)).toMatchObject({ schemaVersion: 1, kind: 'skillsmith.plan' });
    expect((await stat(fixture.out)).mode & 0o777).toBe(0o600);
    expect(created.stdout).not.toBe(bytes);
    expect(report.savedOutput).toMatchObject({ path: fixture.out, disposition: 'created' });
    for (const canary of REDACTION_CANARIES) expect(bytes).not.toContain(canary);

    const savedArtifact = JSON.parse(bytes) as UnknownRecord;
    const operationContract = (value: unknown) =>
      records(value).map((operation) => ({
        operationId: operation.operationId,
        kind: operation.kind,
        dependsOn: operation.dependsOn,
        requiredCheckIds: operation.requiredCheckIds,
        preconditionIds: operation.preconditionIds,
      }));
    expect(operationContract(report.operations)).toEqual(
      operationContract(savedArtifact.operations),
    );
    const checkContract = (value: unknown) =>
      records(value).map((check) => ({
        checkId: check.checkId,
        operationIds: check.operationIds,
        preconditionIds: check.preconditionIds,
      }));
    expect(checkContract(report.checks)).toEqual(checkContract(savedArtifact.checks));
    const diagnosticContract = (value: unknown) =>
      records(value).map((diagnostic) => ({
        diagnosticId: diagnostic.diagnosticId,
        correlation: diagnostic.correlation,
      }));
    expect(diagnosticContract(report.diagnostics)).toEqual(
      diagnosticContract(savedArtifact.diagnostics),
    );

    const refused = await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--locked',
      '--out',
      fixture.out,
      '--json',
    ]);
    expect(refused.exitCode).toBe(2);
    await chmod(fixture.out, 0o644);
    const replaced = await planJson(fixture, ['--locked', '--out', fixture.out, '--force']);
    expect(replaced.savedOutput).toMatchObject({ disposition: 'replaced' });
    expect((await stat(fixture.out)).mode & 0o777).toBe(0o600);
  });
});

describe('EWP-CMD-PLAN-TS10', () => {
  test('planning and in-memory migration previews leave artifacts, live, ledger, store, and config byte-identical', async () => {
    const fixture = await planFixture([{ name: 'alpha' }]);
    const ledger = `${fixture.data}/skillsmith/placements.json`;
    await mkdir(join(ledger, '..'), { recursive: true });
    await writeFile(
      ledger,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'skillsmith.placements',
          updatedAt: '2026-07-19T00:00:00.000Z',
          skills: {},
        },
        null,
        2,
      )}\n`,
    );
    const observed = [
      fixture.manifest,
      fixture.lock,
      ledger,
      `${fixture.data}/skillsmith/store`,
      `${fixture.config}/skillsmith/config.toml`,
    ];
    const before = await fileSnapshot(observed);
    const stateRoots = [fixture.cwd, fixture.home, fixture.data, fixture.config];
    const treesBefore = await Promise.all(stateRoots.map(treeEntries));
    const report = await planJson(fixture, ['--locked']);
    expect(records(report.operations).map((operation) => operation.kind)).toEqual([
      'migrate-ledger',
      'install',
    ]);
    expect(summary(report)).toMatchObject({
      drift: 2,
      operationKinds: expect.objectContaining({ 'migrate-ledger': 1, install: 1 }),
    });
    expect(await fileSnapshot(observed)).toEqual(before);
    expect(await Promise.all(stateRoots.map(treeEntries))).toEqual(treesBefore);

    const liveOutput = join(fixture.home, '.agents', 'skills', 'review.skillsmith.plan');
    const unselectedLiveOutput = join(fixture.home, '.claude', 'skills', 'review.skillsmith.plan');
    const storeOutput = join(fixture.data, 'skillsmith', 'store', 'review.skillsmith.plan');
    const configOutput = join(fixture.config, 'skillsmith', 'review.skillsmith.plan');
    const liveAlias = join(fixture.cwd, 'live-root-alias');
    const aliasedLiveOutput = join(liveAlias, 'review.skillsmith.plan');
    await Promise.all(
      [liveOutput, unselectedLiveOutput, storeOutput, configOutput].map((path) =>
        mkdir(join(path, '..'), { recursive: true }),
      ),
    );
    await symlink(join(fixture.home, '.agents', 'skills'), liveAlias, 'dir');
    const protectedOutputs = [
      fixture.manifest,
      fixture.lock,
      liveOutput,
      unselectedLiveOutput,
      aliasedLiveOutput,
      storeOutput,
      configOutput,
    ];
    const protectedBefore = await fileSnapshot(protectedOutputs);
    for (const output of protectedOutputs) {
      const product = await runPlanCli(fixture, [
        'plan',
        '--file',
        fixture.manifest,
        '--lockfile',
        fixture.lock,
        '--locked',
        '--out',
        output,
        '--force',
        '--json',
      ]);
      expect(product.exitCode, output).toBe(2);
      expect(await fileSnapshot(protectedOutputs), output).toEqual(protectedBefore);
    }
  });

  test('nested invocations protect every registered project root at the discovered root', async () => {
    const fixture = await planFixture([{ name: 'alpha', scope: 'project' }]);
    const nestedCwd = join(fixture.cwd, 'packages', 'client');
    const unselectedProjectRoot = join(fixture.cwd, '.claude', 'skills');
    const output = join(unselectedProjectRoot, 'review.skillsmith.plan');
    await Promise.all([
      mkdir(nestedCwd, { recursive: true }),
      mkdir(unselectedProjectRoot, { recursive: true }),
    ]);
    const nestedFixture = { ...fixture, cwd: nestedCwd };

    const product = await runPlanCli(nestedFixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--lockfile',
      fixture.lock,
      '--locked',
      '--out',
      output,
      '--force',
      '--json',
    ]);
    expect(product.exitCode, product.stderr).toBe(2);
    expect(await fileSnapshot([output])).toEqual({ [output]: null });
  });
});

describe('EWP-CMD-PLAN-TS12', () => {
  test('a representative fleet remains bounded and byte-deterministic', async () => {
    const skills = Array.from({ length: 128 }, (_, index) => ({
      name: `skill-${String(index).padStart(3, '0')}`,
      tool: index % 2 === 0 ? ('codex' as const) : ('claude-code' as const),
      scope: index % 3 === 0 ? ('project' as const) : ('user' as const),
    }));
    const fixture = await planFixture(skills);
    const started = performance.now();
    const first = await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--locked',
      '--json',
    ]);
    const elapsed = performance.now() - started;
    const second = await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--locked',
      '--json',
    ]);
    expect(first.exitCode).toBe(0);
    expect(second).toEqual(first);
    expect(first.stdout.endsWith('\n')).toBeTrue();
    expect(elapsed).toBeLessThan(10_000);
    expect(records(jsonReport(first, 0, 'representative fleet').operations)).toHaveLength(128);

    const saved = await runPlanCli(fixture, [
      'plan',
      '--file',
      fixture.manifest,
      '--locked',
      '--out',
      fixture.out,
      '--json',
    ]);
    expect(saved.exitCode, saved.stdout).toBe(0);
    const savedBytes = await readFile(fixture.out, 'utf8');
    expect(savedBytes.endsWith('\n')).toBeTrue();
    expect(records((JSON.parse(savedBytes) as UnknownRecord).operations)).toHaveLength(128);
  });
});
