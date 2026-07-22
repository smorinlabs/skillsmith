import { afterEach, describe, expect, test } from 'bun:test';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import { readLedgerState } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { prepareUndoFromObservation } from '../../src/undo/execute.ts';
import type { UndoObservation } from '../../src/undo/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const open: FixtureFleet[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map(destroyFixtureFleet));
});

describe('undo execution preparation', () => {
  test('executes an exact filter-zero plan once without manufacturing operations', async () => {
    const fleet = await buildFixtureFleet();
    open.push(fleet);
    const ledgerPath = ledgerPathOf(fleet.data);
    const ledgerState = await readLedgerState(fleet.env, ledgerPath);
    if (!ledgerState.ok) throw new Error('fixture ledger read failed');
    const projectContext = {
      invocationCwd: fleet.home,
      effectiveCwd: fleet.home,
      projectRoot: null,
      projectIdentity: null,
      projectKind: 'non-git' as const,
      discoveredConfigPath: null,
      explicitConfigPath: null,
    };
    const observed = {
      request: {
        targets: [],
        all: true,
        tools: ['codex'],
        scopes: ['user'],
        dryRun: false,
        yes: true,
        continueOnError: false,
      },
      selection: {
        source: 'explicit-all',
        outcome: 'filter-noop',
        reason: 'active filters matched no reversible placement',
        targets: [],
        tools: ['codex'],
        scopes: ['user'],
      },
      projectContext,
      ledgerPath,
      ledgerState: ledgerState.value,
      ledger: {
        updatedAt: '',
        skills: {},
        projects: {},
        projectRegistrations: {},
        transactions: {},
        history: [],
      },
      migrationPending: false,
      candidates: [],
    } as UndoObservation;
    const runtimeObservation = Object.freeze({
      context: createOperationContext({
        command: 'skillsmith undo',
        workflow: 'undo',
        clock: { wallNowIso: () => '2026-07-22T00:00:00.000Z', monotonicMilliseconds: () => 0 },
        id: { nextId: () => 'undo-execute-test' },
      }),
      emitter: createObservationEmitter({ observer: noopObserver }),
    });

    const prepared = await prepareUndoFromObservation(observed, {
      ports: fleet.env,
      projectContext,
      configuration: fleet.configuration,
      observation: runtimeObservation,
    });

    expect(prepared.ok).toBeTrue();
    if (!prepared.ok) return;
    expect(prepared.value.plan.operations).toEqual([]);
    expect(prepared.value.groups).toEqual([]);
    expect(await prepared.value.execute()).toEqual({ ok: true, value: [] });
    expect(await prepared.value.execute()).toEqual({
      ok: false,
      error: {
        code: 'undo-prepared-consumed',
        message: 'prepared undo plan has already been executed',
        exitClass: 'state',
      },
    });
  });
});
