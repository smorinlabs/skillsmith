import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import { readLedgerState, writeLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { contentHashOf } from '../../src/place/store.ts';
import { prepareUndoFromObservation } from '../../src/undo/execute.ts';
import type { UndoCandidate, UndoObservation } from '../../src/undo/types.ts';
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
    expect(await prepared.value.execute()).toEqual({
      ok: true,
      value: { results: [], warnings: [] },
    });
    expect(await prepared.value.execute()).toEqual({
      ok: false,
      error: {
        code: 'undo-prepared-consumed',
        message: 'prepared undo plan has already been executed',
        exitClass: 'state',
      },
    });
  });

  test('finalizes cleanup-only and blocks cleanup/live races before mixed scheduling', async () => {
    const fleet = await buildFixtureFleet();
    open.push(fleet);
    const ledgerPath = ledgerPathOf(fleet.data);
    const skillsRoot = join(fleet.home, '.codex', 'skills');
    const placementPath = join(skillsRoot, 'review');
    const sourcePath = fleet.alphaSrc;
    const startedAt = '2026-07-22T00:00:00.000Z';
    const hashedSource = await contentHashOf(fleet.env, sourcePath);
    if (!hashedSource.ok) throw new Error('cleanup source fixture hash failed');
    const contentDigest = hashedSource.value as ArtifactDigest;
    const ledgerDigest = `sha256:${'b'.repeat(64)}` as ArtifactDigest;
    const groupId = `group:v1:${'1'.repeat(64)}`;
    const pairId = `pair:v1:${'2'.repeat(64)}`;
    const resource = {
      kind: 'live' as const,
      skill: 'review',
      tool: 'codex' as const,
      scope: 'user' as const,
      projectRoot: null,
      location: { kind: 'machine-bound' as const, path: placementPath },
    };
    const source = { kind: 'local-dev' as const, path: sourcePath, contentHash: contentDigest };
    const absent = { kind: 'absent' as const, resource };
    const development = {
      kind: 'placement' as const,
      resource,
      classification: 'dev' as const,
      representation: 'symlink' as const,
      linkTarget: { kind: 'machine-bound' as const, path: sourcePath },
      dangling: false,
      source,
      contentHash: contentDigest,
    };
    const absentActual = {
      resourceId: 'resource:live',
      role: 'live' as const,
      state: 'absent' as const,
      repositoryRevision: null,
      placementPath,
      liveKind: null,
      mode: null,
      symlinkTarget: null,
      contentHash: null,
    };
    const developmentActual = {
      resourceId: 'resource:live',
      role: 'live' as const,
      state: 'present' as const,
      repositoryRevision: { kind: 'resource' as const, digest: contentDigest },
      placementPath,
      liveKind: 'symlink' as const,
      mode: 'dev' as const,
      symlinkTarget: sourcePath,
      contentHash: contentDigest,
    };
    const ledgerActual = {
      resourceId: 'resource:ledger',
      role: 'ledger' as const,
      state: 'present' as const,
      repositoryRevision: { kind: 'resource' as const, digest: ledgerDigest },
      schemaVersion: 2 as const,
      semanticHash: ledgerDigest,
    };
    const parent: LogicalJournalV1Dto = {
      schemaVersion: 1,
      kind: 'skillsmith.transaction-journal',
      transactionId: 'transaction:parent',
      intent: {
        operationId: 'operation:parent',
        groupId,
        pairId,
        kind: 'link-dev',
        skill: 'review',
        source,
        tool: 'codex',
        scope: 'user',
        before: absent,
        after: development,
        mutates: { live: true, manifest: false, lock: false, ledger: true },
        reversibility: { kind: 'none', retentionResourceIds: [] },
        conflict: null,
      },
      context: {
        parentOperationId: null,
        command: 'skillsmith-dev',
        workflow: 'dev',
        attempt: 1,
        startedAt,
      },
      disposition: 'forward',
      phase: 'committed',
      actual: {
        before: [absentActual, ledgerActual],
        after: [developmentActual, ledgerActual],
        retained: [],
      },
      updatedAt: startedAt,
      completedAt: startedAt,
    };
    const child: LogicalJournalV1Dto = {
      ...parent,
      transactionId: 'transaction:cleanup',
      intent: {
        ...parent.intent,
        operationId: 'operation:cleanup',
        groupId: `group:v1:${'3'.repeat(64)}`,
      },
      context: {
        parentOperationId: parent.intent.operationId,
        command: 'skillsmith-undo',
        workflow: 'undo',
        attempt: 1,
        startedAt,
      },
      disposition: 'rollback',
      actual: {
        before: parent.actual.after,
        after: parent.actual.before,
        retained: parent.actual.retained,
      },
    };
    const carrier = {
      placementPath,
      mode: 'dev' as const,
      dev: {
        sourcePath,
        resolvedPath: sourcePath,
        repoRoot: fleet.checkout,
        sourceRelPath: 'plugins/fh/skills/alpha',
        remote: null,
        recordedAt: startedAt,
      },
      journal: {
        op: 'uninstall' as const,
        txId: child.transactionId,
        phase: 'committed' as const,
        startedAt,
        completedAt: startedAt,
        before: {
          mode: 'dev' as const,
          symlinkTarget: sourcePath,
          liveKind: 'symlink' as const,
        },
        stagingPath: join(skillsRoot, '.skillsmith-staging-review'),
        backupPath: join(skillsRoot, '.skillsmith-backup-review'),
      },
    };
    const ledger = {
      updatedAt: startedAt,
      skills: { review: { tools: { codex: carrier } } },
      projects: {},
      projectRegistrations: {},
      transactions: {},
      history: [parent, child],
    };
    const written = await writeLedger(fleet.env, ledgerPath, ledger);
    if (!written.ok) throw new Error('cleanup ledger fixture write failed');
    const ledgerState = await readLedgerState(fleet.env, ledgerPath);
    if (!ledgerState.ok || ledgerState.value.state !== 'present') {
      throw new Error('cleanup ledger fixture read failed');
    }
    const candidate = {
      name: 'review',
      sourceGroupId: parent.intent.groupId,
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      path: placementPath,
      placement: {
        skill: 'review',
        root: skillsRoot,
        path: placementPath,
        class: 'absent',
        symlinkTarget: null,
        dangling: false,
      },
      capabilities: ['undo'],
      exists: true,
      action: 'reverse-committed',
      outcome: 'already-reversed',
      operationFamily: 'dev',
      disposition: 'rollback',
      phase: 'committed',
      executionMode: 'resume-rollback',
      recoveryState: 'cleanup-pending',
      before: 'dev',
      eligibility: 'not-reversible',
      retention: [],
      sourceTransactionId: parent.transactionId,
      activeTransactionId: child.transactionId,
      sourceOperationId: parent.intent.operationId,
      activeOperationId: child.intent.operationId,
      parentOperationId: parent.intent.operationId,
      authority: { format: 'logical', journal: child, source: parent },
    } as const satisfies UndoCandidate;
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
        targets: ['review'],
        all: false,
        tools: ['codex'],
        scopes: ['user'],
        dryRun: false,
        yes: true,
        continueOnError: false,
      },
      selection: {
        source: 'explicit-targets',
        outcome: 'selected',
        reason: null,
        targets: ['review'],
        tools: ['codex'],
        scopes: ['user'],
      },
      projectContext,
      ledgerPath,
      ledgerState: ledgerState.value,
      ledger: ledgerState.value.model,
      migrationPending: false,
      candidates: [candidate],
    } as const satisfies UndoObservation;
    const runtimeObservation = Object.freeze({
      context: createOperationContext({
        command: 'skillsmith undo',
        workflow: 'undo',
        clock: { wallNowIso: () => startedAt, monotonicMilliseconds: () => 0 },
        id: { nextId: () => 'undo-cleanup-test' },
      }),
      emitter: createObservationEmitter({ observer: noopObserver }),
    });

    const prepared = await prepareUndoFromObservation(observed, {
      ports: fleet.env,
      projectContext,
      configuration: fleet.configuration,
      observation: runtimeObservation,
    });
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    expect(prepared.value.plan.operations).toEqual([]);
    expect(prepared.value.plan.diagnostics).toMatchObject([
      { reason: { code: 'undo-cleanup-pending' } },
    ]);
    expect(await prepared.value.execute()).toEqual({
      ok: true,
      value: { results: [], warnings: [] },
    });

    const terminal = await readLedgerState(fleet.env, ledgerPath);
    if (!terminal.ok || terminal.value.state !== 'present') {
      throw new Error('terminal cleanup ledger read failed');
    }
    expect(terminal.value.model.skills.review).toBeUndefined();
    expect(
      terminal.value.model.history.filter(
        ({ transactionId }) => transactionId === child.transactionId,
      ),
    ).toHaveLength(1);

    const rewritten = await writeLedger(fleet.env, ledgerPath, ledger);
    if (!rewritten.ok) throw new Error('cleanup race ledger fixture write failed');
    const raceLedgerState = await readLedgerState(fleet.env, ledgerPath);
    if (!raceLedgerState.ok || raceLedgerState.value.state !== 'present') {
      throw new Error('cleanup race ledger fixture read failed');
    }
    const raceObserved: UndoObservation = {
      ...observed,
      ledgerState: raceLedgerState.value,
      ledger: raceLedgerState.value.model,
    };
    const cleanupOnlyRace = await prepareUndoFromObservation(raceObserved, {
      ports: fleet.env,
      projectContext,
      configuration: fleet.configuration,
      observation: runtimeObservation,
    });
    expect(cleanupOnlyRace).toMatchObject({ ok: true });
    if (!cleanupOnlyRace.ok) return;
    await fleet.env.makeSymlink(sourcePath, placementPath);
    const cleanupOnlyFailure = await cleanupOnlyRace.value.execute();
    expect(cleanupOnlyFailure).toMatchObject({ ok: false });
    expect(cleanupOnlyFailure).not.toHaveProperty('value');
    if (cleanupOnlyFailure.ok) return;
    expect(cleanupOnlyFailure.error).toMatchObject({ exitClass: 'failure' });
    const cleanupOnlyDurable = await readLedgerState(fleet.env, ledgerPath);
    if (!cleanupOnlyDurable.ok || cleanupOnlyDurable.value.state !== 'present') {
      throw new Error('cleanup-only race ledger read failed');
    }
    expect(cleanupOnlyDurable.value.model.skills.review?.tools.codex?.journal).toMatchObject({
      txId: child.transactionId,
      phase: 'committed',
    });
    expect(cleanupOnlyDurable.value.model.transactions).toEqual({});

    await fleet.env.removeTree(placementPath);
    const actionablePath = join(skillsRoot, 'actionable');
    const actionableResource = {
      ...resource,
      skill: 'actionable',
      location: { kind: 'machine-bound' as const, path: actionablePath },
    };
    const actionableGroupId = `group:v1:${'4'.repeat(64)}`;
    const actionablePairId = `pair:v1:${'5'.repeat(64)}`;
    const actionableParent: LogicalJournalV1Dto = {
      ...parent,
      transactionId: 'transaction:actionable-parent',
      intent: {
        ...parent.intent,
        operationId: 'operation:actionable-parent',
        groupId: actionableGroupId,
        pairId: actionablePairId,
        skill: 'actionable',
        before: { kind: 'absent', resource: actionableResource },
        after: {
          ...development,
          resource: actionableResource,
        },
      },
      actual: {
        before: [{ ...absentActual, placementPath: actionablePath }, ledgerActual],
        after: [{ ...developmentActual, placementPath: actionablePath }, ledgerActual],
        retained: [],
      },
    };
    const actionablePair = {
      placementPath: actionablePath,
      mode: 'dev' as const,
      dev: {
        sourcePath,
        resolvedPath: sourcePath,
        repoRoot: fleet.checkout,
        sourceRelPath: 'plugins/fh/skills/alpha',
        remote: null,
        recordedAt: startedAt,
      },
      journal: null,
    };
    const mixedLedger = {
      ...ledger,
      skills: {
        actionable: { tools: { codex: actionablePair } },
        review: { tools: { codex: carrier } },
      },
      history: [parent, child, actionableParent],
    };
    const mixedWritten = await writeLedger(fleet.env, ledgerPath, mixedLedger);
    if (!mixedWritten.ok) throw new Error('mixed cleanup ledger fixture write failed');
    await fleet.env.makeSymlink(sourcePath, actionablePath);
    const mixedLedgerState = await readLedgerState(fleet.env, ledgerPath);
    if (!mixedLedgerState.ok || mixedLedgerState.value.state !== 'present') {
      throw new Error('mixed cleanup ledger fixture read failed');
    }
    const actionableCandidate = {
      name: 'actionable',
      sourceGroupId: actionableParent.intent.groupId,
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      path: actionablePath,
      placement: {
        skill: 'actionable',
        root: skillsRoot,
        path: actionablePath,
        class: 'dev',
        symlinkTarget: sourcePath,
        dangling: false,
      },
      capabilities: ['undo'],
      exists: true,
      action: 'reverse-committed',
      outcome: 'selected',
      operationFamily: 'dev',
      disposition: 'forward',
      phase: 'committed',
      executionMode: 'resume-rollback',
      recoveryState: 'none',
      before: 'absent',
      eligibility: 'eligible',
      retention: [],
      sourceTransactionId: actionableParent.transactionId,
      activeTransactionId: actionableParent.transactionId,
      sourceOperationId: actionableParent.intent.operationId,
      activeOperationId: actionableParent.intent.operationId,
      parentOperationId: null,
      authority: {
        format: 'logical',
        journal: actionableParent,
        source: actionableParent,
      },
    } as const satisfies UndoCandidate;
    const mixedObserved: UndoObservation = {
      ...observed,
      request: { ...observed.request, targets: ['actionable', 'review'] },
      selection: { ...observed.selection, targets: ['actionable', 'review'] },
      ledgerState: mixedLedgerState.value,
      ledger: mixedLedgerState.value.model,
      candidates: [actionableCandidate, candidate],
    };
    const mixed = await prepareUndoFromObservation(mixedObserved, {
      ports: fleet.env,
      projectContext,
      configuration: fleet.configuration,
      observation: runtimeObservation,
    });
    expect(mixed).toMatchObject({ ok: true });
    if (!mixed.ok) return;
    expect(mixed.value.plan.operations).toHaveLength(1);
    await fleet.env.makeSymlink(sourcePath, placementPath);
    const mixedFailure = await mixed.value.execute();
    expect(mixedFailure).toMatchObject({ ok: false });
    expect(mixedFailure).not.toHaveProperty('value');
    if (mixedFailure.ok) return;
    expect(mixedFailure.error).toMatchObject({ exitClass: 'failure' });
    const mixedDurable = await readLedgerState(fleet.env, ledgerPath);
    if (!mixedDurable.ok || mixedDurable.value.state !== 'present') {
      throw new Error('mixed race ledger read failed');
    }
    expect(mixedDurable.value.model.skills.review?.tools.codex?.journal).toMatchObject({
      txId: child.transactionId,
      phase: 'committed',
    });
    expect(mixedDurable.value.model.skills.actionable?.tools.codex?.journal).toBeNull();
    expect(mixedDurable.value.model.transactions).toEqual({});
    expect(mixedDurable.value.model.history).toHaveLength(3);
    expect(await fleet.env.readLink(actionablePath)).toBe(sourcePath);
  });
});
