import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
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
    const ids = records(report.operations).map((operation) => operation.operationId);
    expect(ids).toEqual([...ids].sort());

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
    ]) {
      const product = await runPlanCli(fixture, [...args, '--json']);
      expect(product.exitCode, `${args.join(' ')}\n${product.stderr}`).toBe(2);
    }
  });
});

describe('EWP-CMD-PLAN-TS04', () => {
  test('current/missing/stale/noncanonical locks enforce default resolution and strict locked refusal', async () => {
    expect(LOCK_MATRIX).toHaveLength(8);
    const current = await planFixture();
    expect((await planJson(current, ['--locked'])).artifactPair).toBeDefined();

    const missing = await planFixture([], { writeLock: false });
    expect(summary(await planJson(missing))).toMatchObject({ drift: 1 });
    expect((await planJson(missing, ['--locked'], 3)).error).toBeDefined();

    const stale = await planFixture();
    await writeFile(
      stale.lock,
      lockSource(manifestSource([]), { manifestHash: `sha256:${'c'.repeat(64)}` }),
    );
    expect(summary(await planJson(stale))).toMatchObject({ drift: 1 });
    expect((await planJson(stale, ['--locked'], 3)).error).toBeDefined();

    const noncanonical = await planFixture();
    await writeFile(noncanonical.lock, `${await readFile(noncanonical.lock, 'utf8')} `);
    expect((await planJson(noncanonical, [], 3)).error).toBeDefined();
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

    const withoutPrune = await planJson(fixture, ['--locked']);
    const withPrune = await planJson(fixture, ['--locked', '--prune']);
    expect(records(withoutPrune.operations).filter((row) => row.kind === 'remove')).toHaveLength(0);
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
  test('check exits 0/7, eager conflicts precede I/O, and actual errors outrank drift', async () => {
    expect(EXIT_MATRIX).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 130]);
    const empty = await planFixture();
    expect(
      (await runPlanCli(empty, ['plan', '--file', empty.manifest, '--locked', '--check'])).exitCode,
    ).toBe(0);

    const drift = await planFixture([{ name: 'alpha' }]);
    expect(
      (await runPlanCli(drift, ['plan', '--file', drift.manifest, '--locked', '--check'])).exitCode,
    ).toBe(7);

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
    const human = await runPlanCli(fixture, ['plan', '--file', fixture.manifest, '--locked']);
    expect(human.exitCode).toBe(0);
    const operations = records(json.operations);
    for (const operation of operations) {
      expect(human.stdout).toContain(String(operation.operationId));
      expect(human.stdout).toContain(String(operation.kind));
    }
    expect(human.stdout).toContain(String((json.summary as UnknownRecord).operations));
    expect(human.stderr).toBe('');
  });
});

describe('EWP-CMD-PLAN-TS09', () => {
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
    const observed = [
      fixture.manifest,
      fixture.lock,
      `${fixture.data}/skillsmith/placements.json`,
      `${fixture.data}/skillsmith/store`,
      `${fixture.config}/skillsmith/config.toml`,
    ];
    const before = await fileSnapshot(observed);
    const report = await planJson(fixture, ['--locked']);
    expect(summary(report).drift).toBe(1);
    expect(await fileSnapshot(observed)).toEqual(before);
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
    expect(elapsed).toBeLessThan(10_000);
    expect(records(jsonReport(first, 0, 'representative fleet').operations)).toHaveLength(128);
  });
});
