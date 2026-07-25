import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CreateUpdateFleetOptions,
  UPDATE_SECRET_CANARIES,
  type UpdateFleet,
  createUpdateFleet,
  destroyUpdateFleet,
  pushFactorUpdateCandidate,
  runUpdateCli,
  snapshotUpdateState,
} from '../../../../tests/ergonomics/fixtures/p5-update/fleet.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../core/src/application/current-services.ts';
import type { LogicalJournalV1Dto } from '../../../core/src/artifacts/journal-types.ts';
import { encodeRetainedArtifactPreimageV1 } from '../../../core/src/artifacts/retained-preimage-codec.ts';
import {
  hashSourceContentV1,
  projectSourceContent,
} from '../../../core/src/artifacts/source-content.ts';
import { readLedgerState, writeLedger } from '../../../core/src/place/ledger.ts';
import type { ExecutableOperation } from '../../../core/src/planning/types.ts';
import { defaultRuntimePorts } from '../../../core/src/ports/default.ts';
import { createForwardUpdateArtifactJournalSequenceV1 } from '../../../core/src/update/history.ts';
import { runGit } from '../../../core/tests/fixtures/git-env.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';

const openFleets: UpdateFleet[] = [];

// Each case creates local Git remotes and seeds managed placements before exercising the CLI.
// Keep a bounded cold-start allowance while the fixture-local verifier prevents external I/O.
setDefaultTimeout(90_000);

afterEach(async () => {
  await Promise.all(openFleets.splice(0).map(destroyUpdateFleet));
});

const fleet = async (options: CreateUpdateFleetOptions = {}): Promise<UpdateFleet> => {
  const selected = await createUpdateFleet(options);
  openFleets.push(selected);
  return selected;
};

const sourceContentHashAt = async (path: string): Promise<string> => {
  const projected = await projectSourceContent(await defaultRuntimePorts(), path);
  if (!projected.ok) throw new Error(projected.error.message);
  const hashed = hashSourceContentV1(projected.value);
  if (!hashed.ok) throw new Error(hashed.error.message);
  return hashed.value;
};

const exactUpdatePlan = (report: Record<string, unknown>) => ({
  artifactPair: report.artifactPair,
  selection: report.selection,
  candidates: report.candidates,
  operations: report.operations,
  checks: report.checks,
  diagnostics: report.diagnostics,
});

const updateReport = async (
  selected: UpdateFleet,
  args: readonly string[],
  expectedExit = 0,
): Promise<Record<string, unknown>> => {
  expect(await Bun.file(selected.manifest).exists()).toBeTrue();
  expect(
    {
      commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith update'),
      applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'update'),
    },
    'update CommandSpec/application service boundary is absent',
  ).toEqual({ commandSpec: true, applicationService: true });
  const product = await runUpdateCli(selected, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const parsed: unknown = JSON.parse(product.stdout);
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.update',
    command: 'update',
  });
  return parsed as Record<string, unknown>;
};

const updateError = async (
  selected: UpdateFleet,
  args: readonly string[],
  expectedExit: number,
): Promise<Record<string, unknown>> => {
  const product = await runUpdateCli(selected, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  expect(product.stderr).toBe('');
  const parsed: unknown = JSON.parse(product.stdout);
  expect(parsed).toMatchObject({ schemaVersion: 1, kind: 'error' });
  return parsed as Record<string, unknown>;
};

const seedWorkflowCorruptedArtifactJournal = async (
  selected: UpdateFleet,
  operation: ExecutableOperation,
  shape: 'cleanup' | 'forward',
): Promise<string> => {
  if (operation.kind !== 'write-manifest' || operation.after.kind !== 'manifest') {
    throw new TypeError('F16 fixture requires a manifest artifact operation');
  }
  const mode = (await lstat(selected.manifest)).mode & 0o7777;
  const envelope = encodeRetainedArtifactPreimageV1({
    operationId: operation.operationId,
    role: 'manifest',
    path: selected.manifest,
    before: { bytes: new Uint8Array(await readFile(selected.manifest)), mode },
    after: { digest: operation.after.byteHash, mode },
  });
  if (!envelope.ok) throw new TypeError(envelope.error.message);
  const transactionId = `transaction:v1:f16-${shape}`;
  const retainedPath = join(
    dirname(selected.ledger),
    `.skillsmith-artifact-${transactionId}`,
    'manifest.backup',
  );
  const sequence = createForwardUpdateArtifactJournalSequenceV1({
    operation,
    transactionId,
    startedAt: '2026-07-24T20:00:00.000Z',
    retainedPath,
    retainedBytes: envelope.value.encoded,
    expectedAfterMode: mode,
  });
  if (!sequence.ok) throw new TypeError(sequence.error.message);
  const pending: LogicalJournalV1Dto =
    shape === 'forward'
      ? {
          ...sequence.value.staged,
          context: {
            ...sequence.value.staged.context,
            workflow: 'corrupt-update-artifact-history',
          },
        }
      : {
          ...sequence.value.staged,
          context: {
            ...sequence.value.staged.context,
            workflow: 'corrupt-update-artifact-orphan-cleanup',
            attempt: sequence.value.staged.context.attempt + 1,
          },
          disposition: 'rollback',
          phase: 'prepared',
          actual: { ...sequence.value.staged.actual, after: [], retained: [] },
          updatedAt: '2026-07-24T20:01:00.000Z',
          completedAt: null,
        };
  const ports = await defaultRuntimePorts();
  const ledger = await readLedgerState(ports, selected.ledger);
  if (!ledger.ok || ledger.value.state !== 'present') {
    throw new TypeError('F16 fixture requires the existing update ledger');
  }
  const written = await writeLedger(ports, selected.ledger, {
    ...ledger.value.model,
    transactions: { ...ledger.value.model.transactions, [transactionId]: pending },
  });
  if (!written.ok) throw new TypeError(JSON.stringify(written.error));
  await mkdir(dirname(retainedPath), { recursive: true, mode: 0o700 });
  await writeFile(retainedPath, envelope.value.encoded, { mode: 0o600 });
  return retainedPath;
};

const seedAliasedArtifactJournal = async (
  selected: UpdateFleet,
  operation: ExecutableOperation,
  operationId: string,
  retention: 'missing' | 'present',
  label = `f17-${retention}`,
  phase: 'staged' | 'live' = 'staged',
): Promise<Readonly<{ transactionId: string; retainedPath: string }>> => {
  const authority =
    operation.kind === 'write-manifest' && operation.after.kind === 'manifest'
      ? {
          role: 'manifest' as const,
          path: selected.manifest,
          afterDigest: operation.after.byteHash,
        }
      : operation.kind === 'write-lock' && operation.after.kind === 'lock'
        ? { role: 'lock' as const, path: selected.lock, afterDigest: operation.after.canonicalHash }
        : null;
  if (authority === null) throw new TypeError('aliased fixture requires an artifact operation');
  const aliasedOperation: ExecutableOperation = { ...operation, operationId };
  const mode = (await lstat(authority.path)).mode & 0o7777;
  const envelope = encodeRetainedArtifactPreimageV1({
    operationId,
    role: authority.role,
    path: authority.path,
    before: { bytes: new Uint8Array(await readFile(authority.path)), mode },
    after: { digest: authority.afterDigest, mode },
  });
  if (!envelope.ok) throw new TypeError(envelope.error.message);
  const transactionId = `transaction:v1:${label}`;
  const retainedPath = join(
    dirname(selected.ledger),
    `.skillsmith-artifact-${transactionId}`,
    `${authority.role}.backup`,
  );
  const sequence = createForwardUpdateArtifactJournalSequenceV1({
    operation: aliasedOperation,
    transactionId,
    startedAt: '2026-07-25T05:00:00.000Z',
    retainedPath,
    retainedBytes: envelope.value.encoded,
    expectedAfterMode: mode,
  });
  if (!sequence.ok) throw new TypeError(sequence.error.message);
  const ports = await defaultRuntimePorts();
  const ledger = await readLedgerState(ports, selected.ledger);
  if (!ledger.ok || ledger.value.state !== 'present') {
    throw new TypeError('F17 fixture requires the existing update ledger');
  }
  const written = await writeLedger(ports, selected.ledger, {
    ...ledger.value.model,
    transactions: {
      ...ledger.value.model.transactions,
      [transactionId]: sequence.value[phase],
    },
  });
  if (!written.ok) throw new TypeError(JSON.stringify(written.error));
  if (retention === 'present') {
    await mkdir(dirname(retainedPath), { recursive: true, mode: 0o700 });
    await writeFile(retainedPath, envelope.value.encoded, { mode: 0o600 });
  }
  return Object.freeze({ transactionId, retainedPath });
};

const aliasedLiveRepairFixture = async (
  retention: 'missing' | 'present',
): Promise<
  Readonly<{
    selected: UpdateFleet;
    repairOperation: ExecutableOperation;
    transactionId: string;
    retainedPath: string;
  }>
> => {
  const selected = await fleet();
  const pinPreview = await updateReport(selected, ['update', 'factor-scan', '--pin', '--dry-run']);
  const artifactOperation = (pinPreview.operations as readonly ExecutableOperation[]).find(
    ({ kind }) => kind === 'write-manifest',
  );
  if (artifactOperation === undefined) {
    throw new TypeError('F17 fixture lacks artifact authority');
  }
  expect(await updateReport(selected, ['update', 'factor-scan', '--tool', 'codex'])).toMatchObject({
    state: 'completed',
  });
  const liveOnly = await updateReport(selected, ['update', 'factor-scan', '--check'], 7);
  expect(liveOnly).toMatchObject({
    groups: [{ skill: 'factor-scan', drift: { artifact: false, live: true } }],
  });
  const repairOperation = (liveOnly.operations as readonly ExecutableOperation[]).find(
    ({ kind }) => kind === 'repair',
  );
  if (repairOperation === undefined) throw new TypeError('F17 fixture lacks live repair authority');
  const seeded = await seedAliasedArtifactJournal(
    selected,
    artifactOperation,
    repairOperation.operationId,
    retention,
  );
  return Object.freeze({ selected, repairOperation, ...seeded });
};

const sameSnapshotBytes = (
  left: Uint8Array | null | undefined,
  right: Uint8Array | null | undefined,
): boolean => {
  if (left === undefined || right === undefined) return false;
  return left === null
    ? right === null
    : right !== null && Buffer.from(left).equals(Buffer.from(right));
};

describe('update command contract', () => {
  test('EWP-CMD-UPDATE-TS01 — exact remote candidate discovery', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, ['update', 'factor-scan', '--check'], 7);
    expect(report).toMatchObject({
      mode: 'check',
      selection: { selectionSource: 'explicit-targets' },
      candidates: [
        {
          skill: 'factor-scan',
          current: { requestedRef: 'main', kind: 'branch' },
          proposed: {
            requestedRef: 'main',
            kind: 'branch',
            resolvedSha: selected.remote.updateHead,
          },
          transition: 'preserve',
          outcome: 'available',
        },
      ],
    });
    const annotated = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      selected.remote.multiAnnotatedTag,
      '--dry-run',
    ]);
    expect(annotated.candidates).toEqual([
      expect.objectContaining({
        proposed: expect.objectContaining({
          kind: 'tag',
          resolvedSha: selected.remote.multiAnnotatedCommit,
        }),
      }),
    ]);
    expect(selected.remote.multiAnnotatedCommit).not.toBe(selected.remote.multiAnnotatedTagObject);
    const exactSha = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      selected.remote.multiTagSha,
      '--dry-run',
    ]);
    expect(exactSha.candidates).toEqual([
      expect.objectContaining({
        proposed: expect.objectContaining({
          kind: 'sha',
          resolvedSha: selected.remote.multiTagSha,
        }),
      }),
    ]);

    runGit(selected.remote.multiWork, ['branch', 'v9.9.9', selected.remote.multiTagSha]);
    runGit(selected.remote.multiWork, [
      'push',
      '--quiet',
      selected.remote.multiUrl,
      'refs/heads/v9.9.9:refs/heads/v9.9.9',
    ]);
    const versionNamedBranch = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      'v9.9.9',
      '--dry-run',
    ]);
    expect(versionNamedBranch.candidates).toEqual([
      expect.objectContaining({ proposed: expect.objectContaining({ kind: 'branch' }) }),
    ]);

    runGit(selected.remote.multiWork, ['branch', 'collision', selected.remote.multiTagSha]);
    runGit(selected.remote.multiWork, ['tag', 'collision', selected.remote.multiTagSha]);
    runGit(selected.remote.multiWork, [
      'push',
      '--quiet',
      selected.remote.multiUrl,
      'refs/heads/collision:refs/heads/collision',
      'refs/tags/collision:refs/tags/collision',
    ]);
    expect(
      await updateError(selected, ['update', 'factor-scan', '--ref', 'collision', '--dry-run'], 5),
    ).toMatchObject({ code: 'update-ref-inspection-failed' });
    expect(
      await updateError(
        selected,
        ['update', 'factor-scan', '--ref', 'missing-ref', '--dry-run'],
        5,
      ),
    ).toMatchObject({ code: 'update-ref-inspection-failed' });

    const defaultSelected = await fleet({ movingDefault: true });
    const defaultReport = await updateReport(
      defaultSelected,
      ['update', 'factor-scan', '--check'],
      7,
    );
    expect(defaultReport.candidates).toEqual([
      expect.objectContaining({
        current: expect.objectContaining({ requestedRef: null, kind: 'default' }),
        proposed: expect.objectContaining({ requestedRef: null, kind: 'default' }),
      }),
    ]);
  });

  test('EWP-CMD-UPDATE-TS02 — moving, fixed, ref, and pin policy', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const report = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      'main',
      '--pin',
      '--dry-run',
    ]);
    expect(report.candidates).toEqual([
      expect.objectContaining({
        skill: 'factor-scan',
        transition: 'pin',
        outcome: 'available',
        proposed: expect.objectContaining({
          requestedRef: selected.remote.updateHead,
          kind: 'branch',
          resolvedSha: selected.remote.updateHead,
        }),
      }),
    ]);
    const ordinary = await updateReport(selected, ['update', '--all', '--dry-run']);
    expect(ordinary.candidates).toEqual([
      expect.objectContaining({ skill: 'factor-scan', outcome: 'available' }),
      expect.objectContaining({ skill: 'review', outcome: 'skipped-fixed', proposed: null }),
    ]);
    const existingPin = await updateReport(selected, [
      'update',
      'factor-scan',
      '--pin',
      '--dry-run',
    ]);
    expect(existingPin.candidates).toEqual([
      expect.objectContaining({
        skill: 'factor-scan',
        transition: 'pin',
        proposed: expect.objectContaining({
          requestedRef: selected.remote.updateHead,
          kind: 'branch',
          resolvedSha: selected.remote.updateHead,
        }),
      }),
    ]);
    const trackedTag = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      selected.remote.multiAnnotatedTag,
      '--dry-run',
    ]);
    expect(trackedTag.candidates).toEqual([
      expect.objectContaining({
        transition: 'track',
        proposed: expect.objectContaining({
          requestedRef: selected.remote.multiAnnotatedTag,
          kind: 'tag',
          resolvedSha: selected.remote.multiAnnotatedCommit,
        }),
      }),
    ]);
    const pinnedTag = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      selected.remote.multiAnnotatedTag,
      '--pin',
      '--dry-run',
    ]);
    expect(pinnedTag.candidates).toEqual([
      expect.objectContaining({
        transition: 'pin',
        proposed: expect.objectContaining({
          requestedRef: selected.remote.multiAnnotatedCommit,
          kind: 'tag',
          resolvedSha: selected.remote.multiAnnotatedCommit,
        }),
      }),
    ]);
    const trackedSha = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      selected.remote.multiTagSha,
      '--dry-run',
    ]);
    expect(trackedSha.candidates).toEqual([
      expect.objectContaining({
        transition: 'track',
        proposed: expect.objectContaining({
          requestedRef: selected.remote.multiTagSha,
          kind: 'sha',
          resolvedSha: selected.remote.multiTagSha,
        }),
      }),
    ]);
    const bulkPin = await updateReport(selected, ['update', '--all', '--pin', '--dry-run']);
    expect(bulkPin.candidates).toEqual([
      expect.objectContaining({ skill: 'factor-scan', transition: 'pin', outcome: 'available' }),
      expect.objectContaining({ skill: 'review', outcome: 'skipped-fixed', proposed: null }),
    ]);
    expect(
      await updateError(selected, ['update', 'review', '--pin', '--dry-run'], 2),
    ).toMatchObject({
      code: 'update-pin-fixed',
    });
    expect(
      await updateError(selected, ['update', 'factor-*', '--ref', 'main', '--dry-run'], 2),
    ).toMatchObject({ code: 'update-options' });
    expect(await snapshotUpdateState(selected)).toEqual(before);
  });

  test('EWP-CMD-UPDATE-TS03 — declaration-first target and tool selection', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const report = await updateReport(selected, [
      'update',
      'factor-*',
      '--tool',
      'codex',
      '--dry-run',
    ]);
    expect(report).toMatchObject({
      selection: {
        selectionSource: 'explicit-targets',
        skills: ['factor-scan'],
        tools: ['codex'],
      },
      groups: [{ skill: 'factor-scan', tools: ['codex'] }],
    });
    const unmatched = await updateReport(selected, ['update', 'missing-*', '--dry-run']);
    expect(unmatched).toMatchObject({
      state: 'current',
      selection: {
        selectionSource: 'explicit-targets',
        selectionOutcome: 'filter-noop',
        targets: ['missing-*'],
        skills: [],
        tools: [],
        groupIds: [],
      },
      candidates: [],
      operations: [],
      groups: [],
    });
    const filtered = await updateReport(selected, [
      'update',
      'review',
      '--tool',
      'claude-code',
      '--dry-run',
    ]);
    expect(filtered).toMatchObject({
      state: 'current',
      selection: { selectionOutcome: 'filter-noop', targets: ['review'] },
      candidates: [],
      operations: [],
      groups: [],
    });
    expect(await snapshotUpdateState(selected)).toEqual(before);
  });

  test('EWP-CMD-UPDATE-TS04 — targetless bounded check and no-write modes', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const report = await updateReport(selected, ['update', '--check'], 7);
    expect(report).toMatchObject({
      mode: 'check',
      selection: { selectionSource: 'bounded-default' },
    });
    const explicitAll = await updateReport(selected, ['update', '--all', '--check'], 7);
    expect(explicitAll).toMatchObject({
      mode: 'check',
      options: { all: true },
      selection: { selectionSource: 'explicit-all' },
    });
    expect(
      (explicitAll.candidates as readonly Record<string, unknown>[]).map(
        ({ skill, outcome, proposed }) => ({ skill, outcome, proposed }),
      ),
    ).toEqual(
      (report.candidates as readonly Record<string, unknown>[]).map(
        ({ skill, outcome, proposed }) => ({ skill, outcome, proposed }),
      ),
    );
    expect((explicitAll.selection as { skills?: unknown }).skills).toEqual(
      (report.selection as { skills?: unknown }).skills,
    );
    const continued = await updateReport(
      selected,
      ['update', '--all', '--check', '--continue-on-error'],
      7,
    );
    expect(continued).toMatchObject({ options: { continueOnError: true } });
    expect(await updateError(selected, ['update'], 2)).toMatchObject({ code: 'update-options' });
    expect(await updateError(selected, ['update', '--dry-run'], 2)).toMatchObject({
      code: 'update-options',
    });
    await updateError(selected, ['update', '--all', '--check', '--dry-run'], 2);
    await updateError(selected, ['update', '--all', '--check', '--yes'], 2);
    await updateError(selected, ['update', '--all', '--dry-run', '--yes'], 2);
    expect(await snapshotUpdateState(selected)).toEqual(before);
  });

  test('EWP-CMD-UPDATE-TS05 — adapter-owned verification policy', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, ['update', 'factor-scan', '--strict', '--dry-run']);
    expect(report).toMatchObject({
      groups: [
        {
          verification: [
            { tool: 'claude-code', mode: 'static', gate: 'passed' },
            { tool: 'codex', mode: 'static+deep', gate: 'passed' },
          ],
        },
      ],
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'verification', tool: 'claude-code', mode: 'static' }),
        expect.objectContaining({ kind: 'verification', tool: 'codex', mode: 'static+deep' }),
      ]),
    );

    const warningFleet = await fleet();
    await pushFactorUpdateCandidate(warningFleet, 'not frontmatter\n');
    const warningBefore = await snapshotUpdateState(warningFleet);
    const warned = await updateReport(warningFleet, ['update', 'factor-scan', '--dry-run']);
    expect(warned).toMatchObject({
      state: 'ready',
      groups: [
        {
          verification: [
            { tool: 'claude-code', mode: 'static', gate: 'warned' },
            { tool: 'codex', mode: 'static+deep', gate: 'passed' },
          ],
          outcome: 'planned',
        },
      ],
    });
    const strict = await updateReport(
      warningFleet,
      ['update', 'factor-scan', '--strict', '--dry-run'],
      1,
    );
    expect(strict).toMatchObject({
      state: 'partial',
      groups: [
        {
          verification: [
            { tool: 'claude-code', gate: 'failed' },
            { tool: 'codex', gate: 'passed' },
          ],
          outcome: 'failed',
          failure: { code: 'update-verification-blocked' },
        },
      ],
    });
    expect(await snapshotUpdateState(warningFleet)).toEqual(warningBefore);

    const allBlocked = await fleet();
    await pushFactorUpdateCandidate(allBlocked, 'not frontmatter\n');
    const blockedBefore = await snapshotUpdateState(allBlocked);
    const blocked = await updateReport(
      allBlocked,
      ['update', 'factor-scan', '--tool', 'claude-code', '--strict'],
      1,
    );
    expect(blocked).toMatchObject({
      groups: [
        {
          tools: ['claude-code'],
          verification: [{ tool: 'claude-code', gate: 'failed' }],
          outcome: 'failed',
        },
      ],
    });
    expect(await snapshotUpdateState(allBlocked)).toEqual(blockedBefore);
  });

  test('EWP-CMD-UPDATE-TS06 — artifact and selected-tool consistency', async () => {
    const selected = await fleet();
    const manifestBefore = await Bun.file(selected.manifest).text();
    const claudeBefore = await Bun.file(`${selected.live.claude}/SKILL.md`).text();
    const report = await updateReport(selected, [
      'update',
      'factor-scan',
      '--tool',
      'codex',
      '--dry-run',
    ]);
    const groupId = (report.candidates as Array<{ groupId?: unknown }>)[0]?.groupId;
    expect(typeof groupId).toBe('string');
    const operations = report.operations as Array<{
      operationId: string;
      kind: string;
      groupId: unknown;
      dependsOn: readonly string[];
    }>;
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'write-lock', groupId }),
        expect.objectContaining({
          kind: 'update',
          groupId,
          tool: 'codex',
        }),
      ]),
    );
    const lockOperation = operations.find(({ kind }) => kind === 'write-lock');
    expect(lockOperation).toBeDefined();
    expect(
      operations
        .filter(({ kind }) => kind === 'update' || kind === 'repair')
        .every(({ dependsOn }) =>
          lockOperation === undefined ? false : dependsOn.includes(lockOperation.operationId),
        ),
    ).toBeTrue();

    const explicitSibling = await updateReport(selected, [
      'update',
      'factor-scan',
      '--file',
      selected.manifest,
      '--dry-run',
    ]);
    expect(explicitSibling).toMatchObject({
      artifactPair: {
        manifestPath: selected.manifest,
        lockPath: selected.lock,
        lockSource: 'sibling',
        selectionSource: 'explicit',
      },
    });
    const explicitPair = await updateReport(selected, [
      'update',
      'factor-scan',
      '--file',
      selected.manifest,
      '--lockfile',
      selected.lock,
      '--dry-run',
    ]);
    expect(explicitPair).toMatchObject({ artifactPair: { lockSource: 'explicit' } });
    await updateError(
      selected,
      ['update', 'factor-scan', '--lockfile', selected.lock, '--dry-run'],
      2,
    );
    await updateError(
      selected,
      [
        'update',
        'factor-scan',
        '--file',
        selected.manifest,
        '--file',
        selected.manifest,
        '--dry-run',
      ],
      2,
    );

    const codexOnly = await updateReport(selected, ['update', 'factor-scan', '--tool', 'codex']);
    expect(codexOnly).toMatchObject({
      state: 'completed',
      groups: [{ skill: 'factor-scan', tools: ['codex'], outcome: 'succeeded' }],
    });
    expect(await Bun.file(selected.manifest).text()).toBe(manifestBefore);
    expect(await Bun.file(`${selected.live.claude}/SKILL.md`).text()).toBe(claudeBefore);
    expect(await Bun.file(`${selected.live.codex}/SKILL.md`).text()).toContain('updated fixture');
    const selectedCurrent = await updateReport(
      selected,
      ['update', 'factor-scan', '--tool', 'codex', '--check'],
      0,
    );
    expect(selectedCurrent).toMatchObject({
      state: 'current',
      candidates: [{ skill: 'factor-scan', outcome: 'current' }],
      operations: [],
    });
    const remaining = await updateReport(selected, ['update', 'factor-scan', '--check'], 7);
    expect(remaining).toMatchObject({
      candidates: [{ skill: 'factor-scan', outcome: 'available' }],
      groups: [{ skill: 'factor-scan', drift: { artifact: false, live: true } }],
    });
    await writeFile(`${selected.live.claude}/SKILL.md`, `${claudeBefore}\n# local modification\n`);
    const modified = await updateReport(selected, ['update', 'factor-scan', '--check'], 7);
    expect(modified.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'claude-code',
          conflict: expect.objectContaining({ class: 'modified-managed-target' }),
        }),
      ]),
    );
    expect(await updateError(selected, ['update', 'factor-scan'], 3)).toMatchObject({
      code: 'apply-execution-conflict',
    });
    await writeFile(`${selected.live.claude}/SKILL.md`, claudeBefore);
    const converged = await updateReport(selected, ['update', 'factor-scan']);
    expect(converged).toMatchObject({ groups: [{ outcome: 'succeeded' }] });
    expect(await updateReport(selected, ['update', 'factor-scan', '--check'])).toMatchObject({
      state: 'current',
      operations: [],
    });
  });

  test.each(['forward', 'cleanup'] as const)(
    'F16 — live-only repair refuses a workflow-corrupted %s artifact journal before mutation',
    async (shape) => {
      const selected = await fleet();
      const pinPreview = await updateReport(selected, [
        'update',
        'factor-scan',
        '--pin',
        '--dry-run',
      ]);
      const artifactOperation = (pinPreview.operations as readonly ExecutableOperation[]).find(
        ({ kind }) => kind === 'write-manifest',
      );
      if (artifactOperation === undefined)
        throw new TypeError('F16 fixture lacks artifact authority');

      expect(
        await updateReport(selected, ['update', 'factor-scan', '--tool', 'codex']),
      ).toMatchObject({ state: 'completed' });
      const liveOnly = await updateReport(selected, ['update', 'factor-scan', '--check'], 7);
      expect(liveOnly).toMatchObject({
        groups: [{ skill: 'factor-scan', drift: { artifact: false, live: true } }],
      });

      const retainedPath = await seedWorkflowCorruptedArtifactJournal(
        selected,
        artifactOperation,
        shape,
      );
      const before = await snapshotUpdateState(selected);
      const retainedBefore = await readFile(retainedPath);
      const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--json']);
      const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
      const after = await snapshotUpdateState(selected);
      const retainedAfter = await readFile(retainedPath);

      expect({
        exitCode: attempted.exitCode,
        kind: parsed.kind,
        manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
        lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
        ledgerUnchanged: sameSnapshotBytes(after.ledger, before.ledger),
        codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
        claudeUnchanged: sameSnapshotBytes(after.claude, before.claude),
        retainedUnchanged: sameSnapshotBytes(retainedAfter, retainedBefore),
      }).toEqual({
        exitCode: 1,
        kind: 'error',
        manifestUnchanged: true,
        lockUnchanged: true,
        ledgerUnchanged: true,
        codexUnchanged: true,
        claudeUnchanged: true,
        retainedUnchanged: true,
      });
    },
  );

  test('F17 — live-only repair refuses an unrecoverable artifact carrier aliased to its operation ID', async () => {
    const { selected, retainedPath } = await aliasedLiveRepairFixture('missing');
    const before = await snapshotUpdateState(selected);
    const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--json']);
    const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
    const after = await snapshotUpdateState(selected);

    expect({
      exitCode: attempted.exitCode,
      kind: parsed.kind,
      manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
      lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
      ledgerUnchanged: sameSnapshotBytes(after.ledger, before.ledger),
      codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
      claudeUnchanged: sameSnapshotBytes(after.claude, before.claude),
      retainedAbsent: !(await Bun.file(retainedPath).exists()),
    }).toEqual({
      exitCode: 1,
      kind: 'error',
      manifestUnchanged: true,
      lockUnchanged: true,
      ledgerUnchanged: true,
      codexUnchanged: true,
      claudeUnchanged: true,
      retainedAbsent: true,
    });
  });

  test('F17 — live-only repair recovers an aliased artifact carrier before placement execution', async () => {
    const { selected, repairOperation, transactionId, retainedPath } =
      await aliasedLiveRepairFixture('present');
    const before = await snapshotUpdateState(selected);
    const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--json']);
    const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
    const after = await snapshotUpdateState(selected);
    const ports = await defaultRuntimePorts();
    const ledger = await readLedgerState(ports, selected.ledger);
    if (!ledger.ok || ledger.value.state !== 'present') {
      throw new TypeError('F17 recovery lost the update ledger');
    }
    const cleanupIndex = ledger.value.model.history.findIndex(
      (journal) =>
        journal.transactionId === transactionId &&
        journal.context.workflow === 'update-artifact-orphan-cleanup',
    );
    const placementIndex = ledger.value.model.history.findIndex(
      (journal) =>
        journal.intent.operationId === repairOperation.operationId &&
        journal.intent.kind === 'repair',
    );

    expect({
      exitCode: attempted.exitCode,
      kind: parsed.kind,
      manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
      lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
      codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
      claudeChanged: !sameSnapshotBytes(after.claude, before.claude),
      transactionPending: ledger.value.model.transactions[transactionId] !== undefined,
      cleanupBeforePlacement: cleanupIndex >= 0 && placementIndex > cleanupIndex,
      retainedAbsent: !(await Bun.file(retainedPath).exists()),
    }).toEqual({
      exitCode: 0,
      kind: 'skillsmith.update',
      manifestUnchanged: true,
      lockUnchanged: true,
      codexUnchanged: true,
      claudeChanged: true,
      transactionPending: false,
      cleanupBeforePlacement: true,
      retainedAbsent: true,
    });
  });

  test('F18 — pin update refuses a manifest carrier aliased to the current lock ID before mutation', async () => {
    const selected = await fleet();
    const preview = await updateReport(selected, ['update', 'factor-scan', '--pin', '--dry-run']);
    const operations = preview.operations as readonly ExecutableOperation[];
    const manifest = operations.find(({ kind }) => kind === 'write-manifest');
    const lock = operations.find(({ kind }) => kind === 'write-lock');
    if (manifest === undefined || lock === undefined) {
      throw new TypeError('F18 cross-role fixture requires manifest and lock operations');
    }
    const { retainedPath } = await seedAliasedArtifactJournal(
      selected,
      manifest,
      lock.operationId,
      'present',
      'f18-cross-role',
    );
    const before = await snapshotUpdateState(selected);
    const retainedBefore = await readFile(retainedPath);
    const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--pin', '--json']);
    const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
    const after = await snapshotUpdateState(selected);

    expect({
      exitCode: attempted.exitCode,
      kind: parsed.kind,
      manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
      lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
      ledgerUnchanged: sameSnapshotBytes(after.ledger, before.ledger),
      codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
      claudeUnchanged: sameSnapshotBytes(after.claude, before.claude),
      retainedUnchanged: sameSnapshotBytes(await readFile(retainedPath), retainedBefore),
    }).toEqual({
      exitCode: 1,
      kind: 'error',
      manifestUnchanged: true,
      lockUnchanged: true,
      ledgerUnchanged: true,
      codexUnchanged: true,
      claudeUnchanged: true,
      retainedUnchanged: true,
    });
  });

  test('F18 — pin update refuses changed current lock intent before manifest mutation', async () => {
    const selected = await fleet();
    const preview = await updateReport(selected, ['update', 'factor-scan', '--pin', '--dry-run']);
    const operations = preview.operations as readonly ExecutableOperation[];
    const manifest = operations.find(({ kind }) => kind === 'write-manifest');
    const lock = operations.find(({ kind }) => kind === 'write-lock');
    if (manifest === undefined || lock === undefined) {
      throw new TypeError('F18 changed-intent fixture requires manifest and lock operations');
    }
    const changedLock: ExecutableOperation = { ...lock, groupId: manifest.operationId };
    const { retainedPath } = await seedAliasedArtifactJournal(
      selected,
      changedLock,
      lock.operationId,
      'present',
      'f18-changed-intent',
    );
    const before = await snapshotUpdateState(selected);
    const retainedBefore = await readFile(retainedPath);
    const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--pin', '--json']);
    const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
    const after = await snapshotUpdateState(selected);

    expect({
      exitCode: attempted.exitCode,
      kind: parsed.kind,
      manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
      lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
      ledgerUnchanged: sameSnapshotBytes(after.ledger, before.ledger),
      codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
      claudeUnchanged: sameSnapshotBytes(after.claude, before.claude),
      retainedUnchanged: sameSnapshotBytes(await readFile(retainedPath), retainedBefore),
    }).toEqual({
      exitCode: 1,
      kind: 'error',
      manifestUnchanged: true,
      lockUnchanged: true,
      ledgerUnchanged: true,
      codexUnchanged: true,
      claudeUnchanged: true,
      retainedUnchanged: true,
    });
  });

  test('F18 — pin update validates exact current lock retention before manifest mutation', async () => {
    const selected = await fleet();
    const preview = await updateReport(selected, ['update', 'factor-scan', '--pin', '--dry-run']);
    const operations = preview.operations as readonly ExecutableOperation[];
    const lock = operations.find(({ kind }) => kind === 'write-lock');
    if (lock === undefined) throw new TypeError('F18 retention fixture requires a lock operation');
    const { retainedPath } = await seedAliasedArtifactJournal(
      selected,
      lock,
      lock.operationId,
      'missing',
      'f18-missing-retention',
    );
    const before = await snapshotUpdateState(selected);
    const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--pin', '--json']);
    const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
    const after = await snapshotUpdateState(selected);

    expect({
      exitCode: attempted.exitCode,
      kind: parsed.kind,
      manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
      lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
      ledgerUnchanged: sameSnapshotBytes(after.ledger, before.ledger),
      codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
      claudeUnchanged: sameSnapshotBytes(after.claude, before.claude),
      retainedAbsent: !(await Bun.file(retainedPath).exists()),
    }).toEqual({
      exitCode: 1,
      kind: 'error',
      manifestUnchanged: true,
      lockUnchanged: true,
      ledgerUnchanged: true,
      codexUnchanged: true,
      claudeUnchanged: true,
      retainedAbsent: true,
    });
  });

  test('F18 — pin update refuses duplicate carriers for the current lock ID before mutation', async () => {
    const selected = await fleet();
    const preview = await updateReport(selected, ['update', 'factor-scan', '--pin', '--dry-run']);
    const operations = preview.operations as readonly ExecutableOperation[];
    const lock = operations.find(({ kind }) => kind === 'write-lock');
    if (lock === undefined) throw new TypeError('F18 duplicate fixture requires a lock operation');
    const first = await seedAliasedArtifactJournal(
      selected,
      lock,
      lock.operationId,
      'present',
      'f18-duplicate-first',
    );
    const rawLedger = JSON.parse(await readFile(selected.ledger, 'utf8')) as {
      transactions: Record<string, LogicalJournalV1Dto>;
    };
    const firstJournal = rawLedger.transactions[first.transactionId];
    if (firstJournal === undefined) {
      throw new TypeError('F18 duplicate fixture lost its first carrier');
    }
    const secondTransactionId = 'transaction:v1:f18-duplicate-second';
    const secondRetainedPath = join(
      dirname(selected.ledger),
      `.skillsmith-artifact-${secondTransactionId}`,
      'lock.backup',
    );
    const firstRetainedBefore = await readFile(first.retainedPath);
    await mkdir(dirname(secondRetainedPath), { recursive: true, mode: 0o700 });
    await writeFile(secondRetainedPath, firstRetainedBefore, { mode: 0o600 });
    rawLedger.transactions[secondTransactionId] = {
      ...firstJournal,
      transactionId: secondTransactionId,
      actual: {
        ...firstJournal.actual,
        retained: firstJournal.actual.retained.map((retained) => ({
          ...retained,
          path: secondRetainedPath,
        })),
      },
    };
    await writeFile(selected.ledger, `${JSON.stringify(rawLedger, null, 2)}\n`);
    const before = await snapshotUpdateState(selected);
    const secondRetainedBefore = await readFile(secondRetainedPath);
    const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--pin', '--json']);
    const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
    const after = await snapshotUpdateState(selected);

    expect({
      exitCode: attempted.exitCode,
      kind: parsed.kind,
      manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
      lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
      ledgerUnchanged: sameSnapshotBytes(after.ledger, before.ledger),
      codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
      claudeUnchanged: sameSnapshotBytes(after.claude, before.claude),
      firstRetainedUnchanged: sameSnapshotBytes(
        await readFile(first.retainedPath),
        firstRetainedBefore,
      ),
      secondRetainedUnchanged: sameSnapshotBytes(
        await readFile(secondRetainedPath),
        secondRetainedBefore,
      ),
    }).toEqual({
      exitCode: 3,
      kind: 'error',
      manifestUnchanged: true,
      lockUnchanged: true,
      ledgerUnchanged: true,
      codexUnchanged: true,
      claudeUnchanged: true,
      firstRetainedUnchanged: true,
      secondRetainedUnchanged: true,
    });
  });

  test('F19 — live-only repair validates every superseded carrier before recovery mutation', async () => {
    const selected = await fleet();
    const preview = await updateReport(selected, ['update', 'factor-scan', '--pin', '--dry-run']);
    const operations = preview.operations as readonly ExecutableOperation[];
    const artifactOperation = operations.find(({ kind }) => kind === 'write-manifest');
    const lockOperation = operations.find(({ kind }) => kind === 'write-lock');
    if (artifactOperation === undefined || lockOperation === undefined) {
      throw new TypeError('F19 fixture requires manifest and lock artifact operations');
    }
    expect(
      await updateReport(selected, ['update', 'factor-scan', '--tool', 'codex']),
    ).toMatchObject({ state: 'completed' });
    expect(await updateReport(selected, ['update', 'factor-scan', '--check'], 7)).toMatchObject({
      groups: [{ skill: 'factor-scan', drift: { artifact: false, live: true } }],
    });
    const first = await seedAliasedArtifactJournal(
      selected,
      artifactOperation,
      artifactOperation.operationId,
      'present',
      'f19-a-valid',
    );
    const second = await seedAliasedArtifactJournal(
      selected,
      artifactOperation,
      lockOperation.operationId,
      'missing',
      'f19-b-missing',
    );
    const before = await snapshotUpdateState(selected);
    const firstRetainedBefore = await readFile(first.retainedPath);
    const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--json']);
    const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
    const after = await snapshotUpdateState(selected);
    const firstRetainedAfter = (await Bun.file(first.retainedPath).exists())
      ? await readFile(first.retainedPath)
      : null;

    expect({
      exitCode: attempted.exitCode,
      kind: parsed.kind,
      manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
      lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
      ledgerUnchanged: sameSnapshotBytes(after.ledger, before.ledger),
      codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
      claudeUnchanged: sameSnapshotBytes(after.claude, before.claude),
      firstRetainedUnchanged: sameSnapshotBytes(firstRetainedAfter, firstRetainedBefore),
      secondRetainedAbsent: !(await Bun.file(second.retainedPath).exists()),
    }).toEqual({
      exitCode: 1,
      kind: 'error',
      manifestUnchanged: true,
      lockUnchanged: true,
      ledgerUnchanged: true,
      codexUnchanged: true,
      claudeUnchanged: true,
      firstRetainedUnchanged: true,
      secondRetainedAbsent: true,
    });
  });

  test('F20 — pin update refuses a current live lock carrier at its physical before-image', async () => {
    const selected = await fleet();
    const preview = await updateReport(selected, ['update', 'factor-scan', '--pin', '--dry-run']);
    const lock = (preview.operations as readonly ExecutableOperation[]).find(
      ({ kind }) => kind === 'write-lock',
    );
    if (lock === undefined) throw new TypeError('F20 fixture requires a lock artifact operation');
    const { retainedPath } = await seedAliasedArtifactJournal(
      selected,
      lock,
      lock.operationId,
      'present',
      'f20-live-before',
      'live',
    );
    const before = await snapshotUpdateState(selected);
    const retainedBefore = await readFile(retainedPath);
    const attempted = await runUpdateCli(selected, ['update', 'factor-scan', '--pin', '--json']);
    const parsed = JSON.parse(attempted.stdout) as { readonly kind?: string };
    const after = await snapshotUpdateState(selected);

    expect({
      exitCode: attempted.exitCode,
      kind: parsed.kind,
      manifestUnchanged: sameSnapshotBytes(after.manifest, before.manifest),
      lockUnchanged: sameSnapshotBytes(after.lock, before.lock),
      ledgerUnchanged: sameSnapshotBytes(after.ledger, before.ledger),
      codexUnchanged: sameSnapshotBytes(after.codex, before.codex),
      claudeUnchanged: sameSnapshotBytes(after.claude, before.claude),
      retainedUnchanged: sameSnapshotBytes(await readFile(retainedPath), retainedBefore),
    }).toEqual({
      exitCode: 1,
      kind: 'error',
      manifestUnchanged: true,
      lockUnchanged: true,
      ledgerUnchanged: true,
      codexUnchanged: true,
      claudeUnchanged: true,
      retainedUnchanged: true,
    });
  });

  test('EWP-CMD-UPDATE-TS07 — update commits exact reversible artifact lineage', async () => {
    const selected = await fleet();
    await chmod(selected.manifest, 0o604);
    await chmod(selected.lock, 0o640);
    const beforeByRole = new Map([
      ['manifest', { bytes: await readFile(selected.manifest), mode: 0o604 }],
      ['lock', { bytes: await readFile(selected.lock), mode: 0o640 }],
    ] as const);
    const report = await updateReport(selected, ['update', 'factor-scan', '--pin']);
    const artifactOperations = (report.operations as readonly Record<string, unknown>[]).filter(
      ({ kind }) => kind === 'write-manifest' || kind === 'write-lock',
    );
    expect(artifactOperations.map(({ kind }) => kind)).toEqual(['write-manifest', 'write-lock']);
    for (const operation of artifactOperations) {
      expect(operation).toMatchObject({
        pairId: null,
        reversibility: { kind: 'conditional', retentionResourceIds: [expect.any(String)] },
      });
    }

    const ledger = JSON.parse(await readFile(selected.ledger, 'utf8')) as {
      history?: readonly Record<string, unknown>[];
    };
    for (const operation of artifactOperations) {
      const role = operation.kind === 'write-manifest' ? 'manifest' : 'lock';
      const carrier = ledger.history?.find((candidate) => {
        const intent = candidate.intent as Record<string, unknown> | undefined;
        return (
          intent?.kind === operation.kind &&
          intent?.operationId === operation.operationId &&
          intent?.groupId === operation.groupId
        );
      });
      expect(carrier).toMatchObject({
        disposition: 'forward',
        phase: 'committed',
        intent: { pairId: null, kind: operation.kind },
        actual: {
          retained: [
            {
              role: 'backup',
              sourceRole: role,
              repositoryRevision: { kind: 'resource' },
            },
          ],
        },
      });
      const retained = (
        carrier?.actual as
          | { retained?: readonly { path?: string; contentHash?: string }[] }
          | undefined
      )?.retained?.[0];
      expect(retained?.path).toBeString();
      const envelopePath = retained?.path as string;
      const encoded = await readFile(envelopePath, 'utf8');
      const envelope = JSON.parse(encoded) as {
        kind?: string;
        version?: number;
        role?: string;
        before?: { mode?: number; bytes?: string };
        after?: { digest?: string; mode?: number };
      };
      const expectedBefore = beforeByRole.get(role);
      if (expectedBefore === undefined) throw new Error(`missing ${role} preimage`);
      expect(envelope).toMatchObject({
        kind: 'skillsmith.retained-artifact-preimage',
        version: 1,
        role,
        before: { mode: expectedBefore.mode },
        after: {
          mode: expectedBefore.mode,
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      });
      expect(Buffer.from(envelope.before?.bytes ?? '', 'base64')).toEqual(expectedBefore.bytes);
      expect(encoded.endsWith('\n')).toBeTrue();
      expect((await lstat(envelopePath)).mode & 0o7777).toBe(0o600);
      expect((await lstat(dirname(envelopePath))).mode & 0o7777).toBe(0o700);
    }
    expect(JSON.stringify({ report, ledger })).not.toContain(UPDATE_SECRET_CANARIES[0]);
    expect(JSON.stringify({ report, ledger })).not.toContain(UPDATE_SECRET_CANARIES[1]);
  });

  test('EWP-CMD-UPDATE-TS08 — failure, continuation, and cancellation truth', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, [
      'update',
      '--all',
      '--continue-on-error',
      '--dry-run',
    ]);
    expect(report).toMatchObject({
      options: { continueOnError: true },
      candidates: [
        { skill: 'factor-scan', outcome: 'available' },
        { skill: 'review', outcome: 'skipped-fixed', proposed: null },
      ],
      groups: [
        { skill: 'factor-scan', action: 'update', outcome: 'planned' },
        { skill: 'review', action: 'skip', outcome: 'skipped' },
      ],
    });

    const partialFleet = await fleet({ reviewMoving: true, reviewSourceMissing: true });
    const partial = await updateReport(
      partialFleet,
      ['update', '--all', '--continue-on-error', '--dry-run'],
      1,
    );
    expect(partial).toMatchObject({
      state: 'partial',
      candidates: [
        { skill: 'factor-scan', outcome: 'available', failure: null },
        {
          skill: 'review',
          outcome: 'failed',
          proposed: null,
          failure: { code: 'update-source-resolution' },
        },
      ],
      groups: [
        { skill: 'factor-scan', action: 'update', outcome: 'planned' },
        { skill: 'review', action: 'refuse', outcome: 'failed' },
      ],
      summary: { candidateFailed: 1, failed: 1 },
    });
    expect(
      (partial.operations as Array<{ skill?: string | null }>).every(
        ({ skill }) => skill === null || skill === 'factor-scan',
      ),
    ).toBeTrue();

    const failFastFleet = await fleet({ reviewMoving: true, reviewSourceMissing: true });
    const failFastBefore = await snapshotUpdateState(failFastFleet);
    const failFast = await runUpdateCli(failFastFleet, ['update', '--all', '--yes', '--json']);
    expect(failFast.exitCode).toBe(5);
    expect(JSON.parse(failFast.stdout)).toMatchObject({ code: 'update-source-resolution' });
    expect(failFast.stderr).toBe('');
    expect(await snapshotUpdateState(failFastFleet)).toEqual(failFastBefore);

    const missingRefFleet = await fleet();
    const missingRefBefore = await snapshotUpdateState(missingRefFleet);
    expect(
      await updateError(
        missingRefFleet,
        ['update', 'factor-scan', '--ref', 'refs/heads/absent', '--dry-run'],
        5,
      ),
    ).toMatchObject({ code: 'update-ref-inspection-failed' });
    expect(await snapshotUpdateState(missingRefFleet)).toEqual(missingRefBefore);

    const offlineFleet = await fleet();
    const offlineBefore = await snapshotUpdateState(offlineFleet);
    const remotePath = fileURLToPath(offlineFleet.remote.multiUrl);
    const offlinePath = `${remotePath}.offline`;
    await rename(remotePath, offlinePath);
    try {
      expect(
        await updateError(offlineFleet, ['update', 'factor-scan', '--dry-run'], 5),
      ).toMatchObject({ code: 'update-ref-inspection-failed' });
      expect(await snapshotUpdateState(offlineFleet)).toEqual(offlineBefore);
    } finally {
      await rename(offlinePath, remotePath);
    }
  });

  test('EWP-CMD-UPDATE-TS09 — exact approval, JSON, and exit contracts', async () => {
    const noninteractive = await fleet({ reviewMoving: true });
    const noninteractiveBefore = await snapshotUpdateState(noninteractive);
    for (const args of [
      ['update', '--all'],
      ['--no-prompt', 'update', '--all'],
    ] as const) {
      expect(await updateError(noninteractive, args, 2)).toMatchObject({
        code: 'update-approval-required',
      });
      expect(await snapshotUpdateState(noninteractive)).toEqual(noninteractiveBefore);
    }

    const parityFleet = await fleet({ reviewMoving: true });
    const parityArgs = ['update', '--all', '--dry-run'] as const;
    const parityJson = await runUpdateCli(parityFleet, [...parityArgs, '--json']);
    const parityHuman = await runUpdateCli(parityFleet, parityArgs);
    expect(parityJson.exitCode, `${parityJson.stderr}\n${parityJson.stdout}`).toBe(0);
    expect(parityHuman.exitCode, `${parityHuman.stderr}\n${parityHuman.stdout}`).toBe(0);
    expect(parityJson.stderr).toBe('');
    expect(parityHuman.stderr).toBe('');
    const parityReport = JSON.parse(parityJson.stdout) as {
      mode: string;
      state: string;
      candidates: readonly { skill: string; proposed: { resolvedSha: string } | null }[];
      groups: readonly { skill: string; outcome: string }[];
      summary: { groups: number; available: number; planned: number };
    };
    expect(parityHuman.stdout).toContain(`Update: ${parityReport.mode} (${parityReport.state})`);
    for (const candidate of parityReport.candidates) {
      expect(parityHuman.stdout).toContain(`skill: '${candidate.skill}'`);
      if (candidate.proposed !== null) {
        expect(parityHuman.stdout).toContain(candidate.proposed.resolvedSha);
      }
    }
    for (const group of parityReport.groups) {
      expect(parityHuman.stdout).toContain(`skill: '${group.skill}'`);
      expect(parityHuman.stdout).toContain(`outcome: '${group.outcome}'`);
    }
    expect(parityHuman.stdout).toContain(`Summary: ${parityReport.summary.groups} groups,`);
    expect(parityHuman.stdout).toContain(`available: ${parityReport.summary.available}`);
    expect(parityHuman.stdout).toContain(`planned: ${parityReport.summary.planned}`);
    for (const canary of UPDATE_SECRET_CANARIES) {
      expect(`${parityJson.stdout}${parityJson.stderr}`).not.toContain(canary);
      expect(`${parityHuman.stdout}${parityHuman.stderr}`).not.toContain(canary);
    }

    const selected = await fleet();
    const report = await updateReport(selected, ['update', '--all', '--yes']);
    expect(report).toMatchObject({
      state: 'completed',
      approval: { outcome: 'approved' },
    });
    expect(report.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skill: 'factor-scan', outcome: 'succeeded' }),
      ]),
    );
    expect(await Bun.file(selected.lock).text()).toContain(selected.remote.updateHead);
    expect(await Bun.file(`${selected.live.codex}/SKILL.md`).text()).toContain('updated fixture');
    expect(await Bun.file(`${selected.live.claude}/SKILL.md`).text()).toContain('updated fixture');

    const single = await fleet();
    const singleReport = await updateReport(single, ['update', 'factor-scan']);
    expect(singleReport).toMatchObject({
      state: 'completed',
      approval: { required: false, outcome: 'not-required' },
      groups: [{ skill: 'factor-scan', outcome: 'succeeded' }],
    });

    const bulk = await fleet({ reviewMoving: true });
    const reviewLive = join(bulk.cwd, '.agents', 'skills', 'review', 'SKILL.md');
    const reviewLiveBefore = await readFile(reviewLive);
    const bulkReport = await updateReport(bulk, ['update', '--all', '--yes']);
    expect(bulkReport).toMatchObject({
      approval: { required: true, outcome: 'approved' },
      groups: [
        { skill: 'factor-scan', outcome: 'succeeded' },
        { skill: 'review', outcome: 'succeeded' },
      ],
    });
    expect(await Bun.file(join(bulk.cwd, '.agents', 'skills', 'review', 'SKILL.md')).exists()).toBe(
      true,
    );
    expect(await readFile(reviewLive)).toEqual(reviewLiveBefore);
    const ledger = JSON.parse(await Bun.file(bulk.ledger).text()) as {
      readonly projects: Readonly<
        Record<
          string,
          {
            readonly skills: Readonly<
              Record<
                string,
                {
                  readonly tools: Readonly<
                    Record<
                      string,
                      {
                        readonly pinned?: { readonly rev: string; readonly gitSha: string | null };
                        readonly origin?: { readonly refResolved: string };
                        readonly journal?: unknown;
                      }
                    >
                  >;
                }
              >
            >;
          }
        >
      >;
      readonly transactions: Readonly<Record<string, unknown>>;
      readonly history: readonly {
        readonly disposition: string;
        readonly phase: string;
        readonly intent: {
          readonly kind: string;
          readonly skill: string | null;
          readonly tool: string | null;
        };
        readonly actual: {
          readonly before: readonly { readonly role: string; readonly semanticHash?: string }[];
          readonly after: readonly { readonly role: string; readonly semanticHash?: string }[];
        };
      }[];
    };
    const reviewPair = ledger.projects[bulk.cwd]?.skills.review?.tools.codex;
    expect(reviewPair).toMatchObject({
      pinned: {
        rev: bulk.remote.updateHead.slice(0, 12),
        gitSha: bulk.remote.updateHead,
      },
      origin: { refResolved: bulk.remote.updateHead },
      journal: null,
    });
    expect(Object.keys(ledger.transactions)).toEqual([]);
    const repairHistory = ledger.history.filter(
      ({ disposition, phase, intent }) =>
        disposition === 'forward' &&
        phase === 'committed' &&
        intent.kind === 'repair' &&
        intent.skill === 'review' &&
        intent.tool === 'codex',
    );
    expect(repairHistory).toHaveLength(1);
    const repair = repairHistory[0];
    if (repair === undefined) throw new Error('missing committed review repair history');
    const ledgerBefore = repair.actual.before.find(({ role }) => role === 'ledger');
    const ledgerAfter = repair.actual.after.find(({ role }) => role === 'ledger');
    expect(ledgerBefore?.semanticHash).toStartWith('sha256:');
    expect(ledgerAfter?.semanticHash).toStartWith('sha256:');
    expect(ledgerAfter?.semanticHash).not.toBe(ledgerBefore?.semanticHash);
    const converged = await updateReport(bulk, ['update', '--all', '--check']);
    expect(converged).toMatchObject({
      state: 'current',
      candidates: [
        { skill: 'factor-scan', outcome: 'current' },
        { skill: 'review', outcome: 'current' },
      ],
      operations: [],
    });
  });

  test('EWP-CMD-UPDATE-TS10 — one exact source materialization and hash domain', async () => {
    const selected = await fleet();
    const report = await updateReport(selected, [
      'update',
      'factor-scan',
      '--ref',
      'main',
      '--dry-run',
    ]);
    const operations = report.operations as readonly Record<string, unknown>[];
    expect(operations.filter(({ kind }) => kind === 'update')).toHaveLength(2);
    expect(
      operations
        .filter(({ kind }) => kind === 'update')
        .every(
          ({ source }) =>
            (source as { resolvedSha?: string } | null)?.resolvedSha === selected.remote.updateHead,
        ),
    ).toBeTrue();
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'source-resolution' }),
        expect.objectContaining({ kind: 'content-integrity' }),
        expect.objectContaining({ kind: 'verification' }),
      ]),
    );
    expect(report.diagnostics).toBeArray();

    const identityFleet = await fleet();
    const checked = await updateReport(identityFleet, ['update', 'factor-scan', '--check'], 7);
    const dry = await updateReport(identityFleet, ['update', 'factor-scan', '--dry-run']);
    const executed = await updateReport(identityFleet, ['update', 'factor-scan']);
    expect(exactUpdatePlan(dry)).toEqual(exactUpdatePlan(checked));
    expect(exactUpdatePlan(executed)).toEqual(exactUpdatePlan(dry));

    const contentFleet = await fleet();
    const sourceRoot = join(
      contentFleet.remote.multiWork,
      'plugins',
      'fh',
      'skills',
      'factor-scan',
    );
    const skillPath = join(sourceRoot, 'SKILL.md');
    const runPath = join(sourceRoot, 'bin', 'run.sh');
    const linkPath = join(sourceRoot, 'link.md');
    const emptyPath = join(sourceRoot, 'empty');
    const originalSkill = await readFile(skillPath);
    const baseline = await sourceContentHashAt(sourceRoot);
    const variants: string[] = [];

    await writeFile(skillPath, new Uint8Array([...originalSkill, 0x0a]));
    variants.push(await sourceContentHashAt(sourceRoot));
    await writeFile(skillPath, originalSkill);

    await chmod(runPath, 0o644);
    variants.push(await sourceContentHashAt(sourceRoot));
    await chmod(runPath, 0o755);

    await rm(linkPath);
    await writeFile(linkPath, 'SKILL.md\n');
    variants.push(await sourceContentHashAt(sourceRoot));
    await rm(linkPath);
    await symlink('SKILL.md', linkPath);

    await rm(linkPath);
    await symlink('bin/run.sh', linkPath);
    variants.push(await sourceContentHashAt(sourceRoot));
    await rm(linkPath);
    await symlink('SKILL.md', linkPath);

    await mkdir(emptyPath);
    variants.push(await sourceContentHashAt(sourceRoot));
    await rm(emptyPath, { recursive: true });

    expect(variants).toHaveLength(5);
    expect(variants.every((hash) => hash !== baseline)).toBeTrue();
    expect(new Set(variants).size).toBe(variants.length);
    expect(await sourceContentHashAt(sourceRoot)).toBe(baseline);

    const updateEngineOwners = await Promise.all(
      ['artifacts.ts', 'candidates.ts', 'execute.ts', 'observe.ts', 'plan.ts', 'verify.ts'].map(
        async (file) =>
          [
            file,
            await Bun.file(join(import.meta.dir, '../../../core/src/update', file)).text(),
          ] as const,
      ),
    );
    expect(
      updateEngineOwners
        .filter(([, source]) => source.includes('hashSourceContentV1'))
        .map(([file]) => file),
    ).toEqual(['observe.ts']);
    for (const [, source] of updateEngineOwners) {
      expect(source).not.toMatch(/(?:createHash|contentHashOf|node:crypto)/u);
    }
  });
});
