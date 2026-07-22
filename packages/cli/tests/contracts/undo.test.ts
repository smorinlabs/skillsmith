import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  UNDO_SECRET_CANARIES,
  type UndoCliProduct,
  type UndoFleet,
  crashPublicCommandAt,
  createUndoFleet,
  destroyUndoFleet,
  runUndoCli,
  seedDev,
  seedInstall,
  seedPromote,
  seedUninstall,
  snapshotUndoState,
  writeLegacyPendingDev,
  writeUndoLedgerText,
} from '../../../../tests/ergonomics/fixtures/p5-undo/fleet.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../core/src/application/current-services.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';

setDefaultTimeout(90_000);

type UnknownRecord = Record<string, unknown>;

const openFleets: UndoFleet[] = [];

afterEach(async () => {
  await Promise.all(openFleets.splice(0).map(destroyUndoFleet));
});

const fleet = async (): Promise<UndoFleet> => {
  const selected = await createUndoFleet();
  openFleets.push(selected);
  return selected;
};

const requireUndoBoundary = (): void => {
  expect(
    {
      commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith undo'),
      applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'undo'),
    },
    'public undo CommandSpec/application service boundary is absent',
  ).toEqual({ commandSpec: true, applicationService: true });
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const requireJsonObject = (product: UndoCliProduct, expectedExit = 0): UnknownRecord => {
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  expect(product.stderr).toBe('');
  const parsed: unknown = JSON.parse(product.stdout);
  expect(isRecord(parsed)).toBeTrue();
  if (!isRecord(parsed)) throw new Error('undo JSON report was not an object');
  return parsed;
};

const requireUndoReport = (product: UndoCliProduct, expectedExit = 0): UnknownRecord => {
  const report = requireJsonObject(product, expectedExit);
  expect(report).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.undo',
    command: 'undo',
  });
  return report;
};

const pathKind = async (path: string): Promise<'absent' | 'directory' | 'file' | 'symlink'> => {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    return 'file';
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return 'absent';
    throw error;
  }
};

describe('undo command contract', () => {
  test('EWP-CMD-UNDO-TS01 — pending abort, scope inference, legacy preservation, and no guessing', async () => {
    requireUndoBoundary();
    const selected = await fleet();
    const emptyBefore = await snapshotUndoState(selected);
    expect((await runUndoCli(selected, ['undo', '--json'])).exitCode).toBe(2);
    expect(await snapshotUndoState(selected)).toBe(emptyBefore);

    const legacy = await writeLegacyPendingDev(selected);
    const before = await snapshotUndoState(selected);
    const preview = requireUndoReport(
      await runUndoCli(selected, ['undo', 'review', '--project', '--dry-run', '--json']),
    );
    expect(preview).toMatchObject({
      mode: 'dry-run',
      selection: { source: 'explicit-targets', targets: ['review'], scopes: ['project'] },
      groups: [
        {
          skill: 'review',
          tool: 'claude-code',
          scope: 'project',
          action: 'abort-pending',
          sourceTransactionId: legacy.transactionId,
          executionMode: 'resume-rollback',
        },
      ],
    });
    expect(records(preview.operations).map((operation) => operation.kind)).toEqual([
      'migrate-ledger',
      expect.stringMatching(/rollback|restore/),
    ]);
    expect(await snapshotUndoState(selected)).toBe(before);

    const executed = requireUndoReport(
      await runUndoCli(selected, ['undo', 'review', '--project', '--yes', '--json']),
    );
    expect(executed).toMatchObject({ mode: 'execute', summary: { succeeded: 1, failed: 0 } });
    expect(await pathKind(legacy.placementPath)).toBe('absent');
  });

  test('EWP-CMD-UNDO-TS02 — retained committed operation families reverse without crossing scope', async () => {
    requireUndoBoundary();
    const cases = [
      { family: 'dev', seed: seedDev },
      { family: 'promote', seed: seedPromote },
      { family: 'install', seed: seedInstall },
      { family: 'uninstall', seed: seedUninstall },
    ] as const;
    for (const scenario of cases) {
      const selected = await fleet();
      await scenario.seed(selected, { scope: 'project', tool: 'claude-code' });
      const preview = requireUndoReport(
        await runUndoCli(selected, ['undo', 'review', '--project', '--dry-run', '--json']),
      );
      expect(preview).toMatchObject({
        groups: [
          {
            skill: 'review',
            scope: 'project',
            tool: 'claude-code',
            action: 'reverse-committed',
            operationFamily: scenario.family,
            disposition: 'rollback',
          },
        ],
      });
      expect(records(preview.groups)[0]?.parentOperationId).toBeString();
      expect(records(preview.groups)[0]?.activeOperationId).not.toBe(
        records(preview.groups)[0]?.sourceOperationId,
      );
      const executed = requireUndoReport(
        await runUndoCli(selected, ['undo', 'review', '--project', '--yes', '--json']),
      );
      expect(executed).toMatchObject({
        mode: 'execute',
        summary: { succeeded: 1, failed: 0 },
      });
    }

    const isolated = await fleet();
    await seedDev(isolated, { scope: 'user', tool: 'claude-code' });
    await seedDev(isolated, { scope: 'project', tool: 'claude-code' });
    expect((await runUndoCli(isolated, ['undo', 'review', '--dry-run', '--json'])).exitCode).toBe(
      2,
    );
    const scoped = requireUndoReport(
      await runUndoCli(isolated, ['undo', 'review', '--user', '--dry-run', '--json']),
    );
    expect(scoped).toMatchObject({ groups: [{ scope: 'user' }] });
  });

  test('EWP-CMD-UNDO-TS04 — pending wins and stale or unrestorable newest state never falls back', async () => {
    requireUndoBoundary();
    const pending = await fleet();
    await seedPromote(pending);
    await crashPublicCommandAt(
      pending,
      ['dev', 'review', '--project', '--tool', 'claude-code', '--no-verify', '--json'],
      'live',
    );
    const preview = requireUndoReport(
      await runUndoCli(pending, ['undo', 'review', '--project', '--dry-run', '--json']),
    );
    expect(preview).toMatchObject({
      groups: [
        {
          action: 'abort-pending',
          phase: 'live',
          executionMode: expect.stringMatching(/rollback/),
        },
      ],
    });

    const stale = await fleet();
    await seedPromote(stale);
    await rm(stale.paths.projectClaude, { recursive: true, force: true });
    await mkdir(stale.paths.projectClaude, { recursive: true });
    await writeFile(join(stale.paths.projectClaude, 'SKILL.md'), 'edited after commit\n');
    const refusal = requireJsonObject(
      await runUndoCli(stale, ['undo', 'review', '--project', '--dry-run', '--json']),
      3,
    );
    expect(refusal).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(refusal)).toMatch(/stale|unrestorable|expected/i);
  });

  test('EWP-CMD-UNDO-TS05 — status relates abort, same-operation resume, and terminal rollback', async () => {
    requireUndoBoundary();
    const pending = await fleet();
    await writeLegacyPendingDev(pending);
    const pendingStatus = requireJsonObject(
      await runUndoCli(pending, ['status', 'review', '--json']),
    );
    expect(pendingStatus).toMatchObject({ kind: 'skillsmith.status', schemaVersion: 1 });
    expect(JSON.stringify(pendingStatus)).toMatch(/resume/i);
    expect(JSON.stringify(pendingStatus)).toMatch(/abort|undo/i);

    const selected = await fleet();
    await seedPromote(selected);
    requireUndoReport(
      await runUndoCli(selected, ['undo', 'review', '--project', '--yes', '--json']),
    );
    const terminalStatus = requireJsonObject(
      await runUndoCli(selected, ['status', 'review', '--json']),
    );
    expect(JSON.stringify(terminalStatus)).toMatch(/not-reversible/);
    expect(JSON.stringify(terminalStatus)).not.toMatch(/"reverse"\s*:\s*\[/);

    const repeated = requireUndoReport(
      await runUndoCli(selected, ['undo', 'review', '--project', '--dry-run', '--json']),
    );
    expect(repeated).toMatchObject({
      groups: [
        {
          disposition: 'rollback',
          outcome: 'already-reversed',
          operations: [],
        },
      ],
    });
  });

  test('EWP-CMD-UNDO-TS06 — target, tool, scope, all, confirmation, and scheduling stay bounded', async () => {
    requireUndoBoundary();
    const selected = await fleet();
    for (const args of [
      ['undo', '--json'],
      ['undo', 'review', '--all', '--json'],
      ['undo', 'missing', '--dry-run', '--json'],
      ['undo', 'review', '--scope', 'user', '--project', '--dry-run', '--json'],
    ]) {
      expect((await runUndoCli(selected, args)).exitCode, args.join(' ')).toBe(2);
    }
    await seedDev(selected, { scope: 'user', tool: 'claude-code' });
    await seedDev(selected, { scope: 'project', tool: 'codex' });
    expect((await runUndoCli(selected, ['undo', 'review', '--dry-run', '--json'])).exitCode).toBe(
      2,
    );

    const filtered = requireUndoReport(
      await runUndoCli(selected, [
        'undo',
        '--all',
        '--project',
        '--tool',
        'claude-code',
        '--dry-run',
        '--json',
      ]),
    );
    expect(filtered).toMatchObject({
      selection: { source: 'explicit-all', outcome: 'filter-zero' },
      operations: [],
      summary: { selected: 0 },
    });

    const bulk = requireUndoReport(
      await runUndoCli(selected, ['undo', '--all', '--dry-run', '--json']),
    );
    expect(bulk).toMatchObject({
      selection: {
        source: 'explicit-all',
        scopes: ['user', 'project'],
        batchPolicy: 'fail-fast',
      },
    });
    expect(records(bulk.groups).map((group) => [group.scope, group.tool])).toEqual([
      ['user', 'claude-code'],
      ['project', 'codex'],
    ]);

    const continued = requireUndoReport(
      await runUndoCli(selected, ['undo', '--all', '--continue-on-error', '--dry-run', '--json']),
    );
    expect(continued).toMatchObject({ selection: { batchPolicy: 'continue-on-error' } });
  });

  test('EWP-CMD-UNDO-TS07 — dry-run and JSON never write and validate before discovery', async () => {
    requireUndoBoundary();
    const selected = await fleet();
    await writeUndoLedgerText(selected, '{ definitely not a ledger');
    const malformed = await snapshotUndoState(selected);
    expect((await runUndoCli(selected, ['undo', '--json'])).exitCode).toBe(2);
    expect(await snapshotUndoState(selected)).toBe(malformed);
    expect(
      (await runUndoCli(selected, ['undo', 'review', '--dry-run', '--yes', '--json'])).exitCode,
    ).toBe(2);
    expect(await snapshotUndoState(selected)).toBe(malformed);

    const planned = await fleet();
    await seedPromote(planned);
    const before = await snapshotUndoState(planned);
    requireUndoReport(
      await runUndoCli(planned, ['undo', 'review', '--project', '--dry-run', '--json']),
    );
    expect(await snapshotUndoState(planned)).toBe(before);
    const noninteractive = await runUndoCli(planned, [
      '--no-prompt',
      'undo',
      'review',
      '--project',
      '--json',
    ]);
    expect(noninteractive.exitCode).toBe(2);
    expect(await snapshotUndoState(planned)).toBe(before);
  });

  test('EWP-CMD-UNDO-TS08 — rollback aliases share undo behavior and emit deprecation', async () => {
    requireUndoBoundary();
    const directFleet = await fleet();
    const aliasFleet = await fleet();
    await seedPromote(directFleet);
    await seedPromote(aliasFleet);
    const direct = requireUndoReport(
      await runUndoCli(directFleet, ['undo', 'review', '--project', '--dry-run', '--json']),
    );
    const aliasProduct = await runUndoCli(aliasFleet, [
      'promote',
      '--rollback',
      'review',
      '--project',
      '--dry-run',
      '--json',
    ]);
    const alias = requireJsonObject(aliasProduct);
    expect(alias).toMatchObject({ kind: 'skillsmith.flip', schemaVersion: 4, op: 'rollback' });
    expect({
      operations: alias.operations,
      checks: alias.checks,
      diagnostics: alias.diagnostics,
    }).toEqual({
      operations: direct.operations,
      checks: direct.checks,
      diagnostics: direct.diagnostics,
    });
    expect(JSON.stringify(alias)).toMatch(/deprecated|skillsmith undo/i);
  });

  test('EWP-CMD-UNDO-TS09 — migration and crash retries converge without toggling history', async () => {
    requireUndoBoundary();
    const legacy = await fleet();
    await writeLegacyPendingDev(legacy);
    await crashPublicCommandAt(legacy, ['undo', 'review', '--project', '--yes', '--json'], 'live');
    const legacyResumed = requireUndoReport(
      await runUndoCli(legacy, ['undo', 'review', '--project', '--yes', '--json']),
    );
    expect(legacyResumed).toMatchObject({ summary: { failed: 0 } });

    for (const phase of ['prepared', 'staged', 'backed-up'] as const) {
      const selected = await fleet();
      await seedPromote(selected);
      await crashPublicCommandAt(
        selected,
        ['undo', 'review', '--project', '--yes', '--json'],
        phase,
      );
      const resumed = requireUndoReport(
        await runUndoCli(selected, ['undo', 'review', '--project', '--yes', '--json']),
      );
      expect(resumed).toMatchObject({ summary: { failed: 0 } });
      const converged = await snapshotUndoState(selected);
      const repeated = requireUndoReport(
        await runUndoCli(selected, ['undo', 'review', '--project', '--yes', '--json']),
      );
      expect(repeated).toMatchObject({ groups: [{ outcome: 'already-reversed' }] });
      expect(await snapshotUndoState(selected)).toBe(converged);
      const encoded = JSON.stringify({ resumed, repeated });
      for (const canary of UNDO_SECRET_CANARIES) {
        expect(encoded).not.toContain(canary);
      }
    }
    for (const canary of UNDO_SECRET_CANARIES) {
      expect(JSON.stringify(legacyResumed)).not.toContain(canary);
    }
  });
});
