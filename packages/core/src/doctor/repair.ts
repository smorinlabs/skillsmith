import { createHash } from 'node:crypto';
import type { ArtifactMutationError } from '../artifacts/coordinator-types.ts';
import { commitArtifactPair } from '../artifacts/coordinator.ts';
import { parseArtifactDigest } from '../artifacts/hash.ts';
import type { LedgerActualV1Dto, LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type { LedgerMigrationJournalSequence } from '../artifacts/ledger-types.ts';
import { type LedgerWriterError, createTestNodeLedgerWriter } from '../artifacts/ledger-writer.ts';
import { executeProjectConfigMigration } from '../artifacts/migration-executor.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import type { PlanDigestV1, PlanImageV1 } from '../artifacts/plan-types.ts';
import { safeErrorCode } from '../errors.ts';
import { scheduleOperationPlan } from '../execution/scheduler.ts';
import type { ValidatedExecutionBinding } from '../execution/types.ts';
import { withLedgerLock } from '../place/ledger.ts';
import {
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPlan,
} from '../planning/create.ts';
import type {
  ExecutableOperation,
  MutationFlags,
  OperationExecutionResult,
} from '../planning/types.ts';
import { redactSensitiveValue } from '../safety/redaction.ts';
import type {
  DoctorMutationSummary,
  DoctorRepairAuthorization,
  DoctorRepairExecutionRequest,
  DoctorRepairExecutor,
  DoctorRepairOperation,
  DoctorRepairPlan,
  DoctorRepairResult,
  Finding,
  IdentifiedFinding,
} from './types.ts';

const canonicalPublicFinding = (finding: Finding): Omit<IdentifiedFinding, 'findingId'> => {
  const projected: Record<string, unknown> = {
    checkId: finding.checkId,
    severity: finding.severity,
    title: finding.title,
    message: finding.message,
  };
  for (const key of [
    'remediation',
    'tool',
    'scope',
    'path',
    'operation',
    'reason',
    'scopeInUse',
  ] as const) {
    if (finding[key] !== undefined) projected[key] = finding[key];
  }
  return redactSensitiveValue(projected) as Omit<IdentifiedFinding, 'findingId'>;
};

export const identifyDoctorFindings = (findings: readonly Finding[]): IdentifiedFinding[] => {
  const occurrences = new Map<string, number>();
  return findings.map((finding) => {
    const projected = canonicalPublicFinding(finding);
    const canonical = JSON.stringify(projected);
    const occurrence = occurrences.get(canonical) ?? 0;
    occurrences.set(canonical, occurrence + 1);
    const digest = createHash('sha256')
      .update(JSON.stringify({ finding: projected, occurrence }))
      .digest('hex');
    return Object.freeze({
      ...projected,
      findingId: `finding:v1:${digest}` as const,
      ...(finding.repair === undefined ? {} : { repair: finding.repair }),
      ...(finding.failureClass === undefined ? {} : { failureClass: finding.failureClass }),
    });
  });
};

const mutationFlags = (kind: DoctorRepairAuthorization['kind']): MutationFlags =>
  kind === 'migrate-ledger'
    ? { live: false, manifest: false, lock: false, ledger: true }
    : kind === 'migrate-project-config'
      ? { live: false, manifest: true, lock: false, ledger: false }
      : { live: false, manifest: false, lock: true, ledger: false };

const authorizationKey = (authorization: DoctorRepairAuthorization): string =>
  JSON.stringify({
    kind: authorization.kind,
    artifact: authorization.artifact,
    path: authorization.path,
    before: authorization.before,
    after: authorization.after,
  });

const artifactPairKey = (authorization: DoctorRepairAuthorization): string | null =>
  authorization.artifactPair === undefined
    ? null
    : JSON.stringify([authorization.artifactPair.file, authorization.artifactPair.lockfile]);

export const createDoctorRepairPlan = (
  findings: readonly IdentifiedFinding[],
): DoctorRepairPlan => {
  const grouped = new Map<
    string,
    { authorization: DoctorRepairAuthorization; findingIds: IdentifiedFinding['findingId'][] }
  >();
  for (const finding of findings) {
    if (finding.repair === undefined) continue;
    const key = authorizationKey(finding.repair);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { authorization: finding.repair, findingIds: [finding.findingId] });
    } else {
      existing.findingIds.push(finding.findingId);
    }
  }

  const executableOperations: ExecutableOperation[] = [];
  const byOperationId = new Map<string, DoctorRepairAuthorization>();
  const wireByOperationId = new Map<string, DoctorRepairOperation>();
  const targets = new Set<string>();
  const pendingProjectMigrations = new Set(
    [...grouped.values()]
      .filter(({ authorization }) => authorization.kind === 'migrate-project-config')
      .map(({ authorization }) => artifactPairKey(authorization))
      .filter((key): key is string => key !== null),
  );
  for (const { authorization, findingIds } of grouped.values()) {
    const pairKey = artifactPairKey(authorization);
    if (
      authorization.kind === 'write-lock' &&
      pairKey !== null &&
      pendingProjectMigrations.has(pairKey)
    ) {
      continue;
    }
    const groupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'doctor',
      skill: null,
      source: null,
      scope: null,
      target: authorization.path,
    });
    const operationId = createOperationId({
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId,
      pairId: null,
      kind: authorization.kind,
      skill: null,
      source: null,
      tool: null,
      scope: null,
    });
    const operation: ExecutableOperation = {
      operationId,
      groupId,
      pairId: null,
      kind: authorization.kind,
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill: null,
      source: null,
      tool: null,
      scope: null,
      before: authorization.beforeImage,
      after: authorization.afterImage,
      reason: {
        code: `doctor.${authorization.kind}`,
        message: `repair the selected ${authorization.artifact} artifact`,
      },
      selectionSource: 'explicit-targets',
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: { kind: 'none', retentionResourceIds: [] },
      mutates: mutationFlags(authorization.kind),
      conflict: null,
    };
    executableOperations.push(operation);
    byOperationId.set(operationId, authorization);
    targets.add(authorization.path);
    wireByOperationId.set(
      operationId,
      Object.freeze({
        operationId,
        kind: authorization.kind,
        artifact: authorization.artifact,
        path: authorization.path,
        before: authorization.before,
        after: authorization.after,
        findingIds: Object.freeze([...new Set(findingIds)].sort()),
      }),
    );
  }

  const plan = createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'doctor',
    selection: {
      source: 'explicit-targets',
      targets: [...targets],
      tools: [],
      scopes: [],
      groupIds: executableOperations.map((operation) => operation.groupId),
    },
    batchPolicy: 'continue-on-error',
    operations: executableOperations,
    checks: [],
    diagnostics: [],
  });
  return Object.freeze({
    plan,
    executableOperations: plan.operations,
    operations: Object.freeze(
      plan.operations.map((operation) => {
        const wireOperation = wireByOperationId.get(operation.operationId);
        if (wireOperation === undefined) {
          throw new TypeError('doctor repair plan lost operation correlation');
        }
        return wireOperation;
      }),
    ),
    authorizations: byOperationId,
  });
};

export const executeDoctorRepairPlan = async (
  plan: DoctorRepairPlan,
  executor: DoctorRepairExecutor,
  request: Omit<DoctorRepairExecutionRequest, 'plan' | 'authorizations'>,
): Promise<readonly DoctorRepairResult[]> =>
  executor({
    ...request,
    plan: plan.plan,
    authorizations: plan.authorizations,
  });

export const doctorMutationSummary = (
  mode: 'not-requested' | 'preview' | 'execute',
  operations: readonly DoctorRepairOperation[],
  results: readonly DoctorRepairResult[],
): DoctorMutationSummary => {
  const planned = operations.length;
  if (mode === 'not-requested' || planned === 0) {
    return { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 };
  }
  if (mode === 'preview') {
    return { kind: 'preview', planned, changed: 0, unchanged: 0, failed: 0 };
  }
  return {
    kind: 'applied',
    planned,
    changed: results.filter((result) => result.outcome === 'changed').length,
    unchanged: results.filter((result) => result.outcome === 'unchanged').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
  };
};

const transactionIdFor = (operationId: string): string =>
  `transaction:v1:${createHash('sha256').update(operationId).digest('hex')}`;

const journalDigest = (value: string): PlanDigestV1 => {
  const parsed = parseArtifactDigest(value);
  if (!parsed.ok) throw new TypeError('doctor repair plan contains an invalid artifact digest');
  return parsed.value;
};

const journalLedgerImage = (
  image: Extract<ExecutableOperation['before'], { kind: 'ledger' }>,
): Extract<PlanImageV1, { kind: 'ledger' }> => ({
  kind: 'ledger',
  projectRoot:
    image.projectRoot === null
      ? null
      : image.projectRoot.kind === 'portable'
        ? { kind: 'portable', token: image.projectRoot.token }
        : { kind: 'machine-bound', path: image.projectRoot.path },
  schemaVersion: image.schemaVersion,
  byteHash: journalDigest(image.byteHash),
  semanticHash: journalDigest(image.semanticHash),
});

const journalSequence = (
  operation: ExecutableOperation,
  ports: DoctorRepairExecutionRequest['ports'],
): LedgerMigrationJournalSequence => {
  if (
    operation.before.kind !== 'ledger' ||
    operation.after.kind !== 'ledger' ||
    operation.before.schemaVersion !== 1 ||
    operation.after.schemaVersion !== 2
  ) {
    throw new TypeError('doctor ledger migration operation is invalid');
  }
  const transactionId = transactionIdFor(operation.operationId);
  const startedAt = ports.wallNowIso();
  const beforeImage = journalLedgerImage(operation.before);
  const afterImage = journalLedgerImage(operation.after);
  const before: LedgerActualV1Dto = {
    resourceId: 'ledger:placements',
    role: 'ledger',
    state: 'present',
    repositoryRevision: { kind: 'artifact-bytes', digest: beforeImage.byteHash },
    schemaVersion: 1,
    semanticHash: beforeImage.semanticHash,
  };
  const after: LedgerActualV1Dto = {
    resourceId: 'ledger:placements',
    role: 'ledger',
    state: 'present',
    repositoryRevision: { kind: 'artifact-bytes', digest: afterImage.byteHash },
    schemaVersion: 2,
    semanticHash: afterImage.semanticHash,
  };
  const at = (phase: LogicalJournalV1Dto['phase']): LogicalJournalV1Dto => {
    const terminal = phase === 'committed';
    const visible = phase === 'live' || terminal;
    const updatedAt = ports.wallNowIso();
    return {
      schemaVersion: 1,
      kind: 'skillsmith.transaction-journal',
      transactionId,
      intent: {
        operationId: operation.operationId,
        groupId: operation.groupId,
        pairId: null,
        kind: 'migrate-ledger',
        skill: null,
        source: null,
        tool: null,
        scope: null,
        before: beforeImage,
        after: afterImage,
        mutates: operation.mutates,
        reversibility: { kind: 'none', retentionResourceIds: [] },
        conflict: null,
      },
      context: {
        parentOperationId: null,
        command: 'skillsmith doctor',
        workflow: 'doctor',
        attempt: 1,
        startedAt,
      },
      disposition: 'forward',
      phase,
      actual: {
        before: [before],
        after: visible ? [after] : [],
        retained: [],
      },
      updatedAt,
      completedAt: terminal ? updatedAt : null,
    };
  };
  return Object.freeze({
    prepared: at('prepared'),
    staged: at('staged'),
    backedUp: at('backed-up'),
    live: at('live'),
    committed: at('committed'),
  });
};

const resolvedPair = (file: string, lockfile: string): ResolvedArtifactPair => ({
  file: { token: null, path: file, portability: 'machine-bound', portableToken: null },
  lockfile: { token: null, path: lockfile, portability: 'machine-bound', portableToken: null },
  lockfileSource: 'explicit',
});

const repairError = (
  error: LedgerWriterError | ArtifactMutationError | unknown,
): Readonly<{ code: string; message: string; remediation: string }> => {
  const candidate =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const rawCode = typeof candidate.code === 'string' ? candidate.code : 'repair-failed';
  const reason = typeof candidate.reason === 'string' ? candidate.reason : rawCode;
  const permission = rawCode === 'permission-denied' || reason === 'permission-denied';
  const stale = rawCode === 'stale-state' || reason.includes('conflict');
  return {
    code: permission ? 'permission-denied' : stale ? 'stale-state' : rawCode,
    message: permission
      ? 'repair could not write the selected artifact'
      : stale
        ? 'artifact state changed after the repair preview'
        : 'repair could not update the selected artifact',
    remediation: permission
      ? 'check ownership and rerun doctor'
      : stale
        ? 'rerun doctor to create a fresh repair plan'
        : 'inspect the artifact and rerun doctor',
  };
};

const executeAuthorizedRepair = async (
  operation: ExecutableOperation,
  authorization: DoctorRepairAuthorization,
  request: DoctorRepairExecutionRequest,
): Promise<{ changed: boolean; error: ReturnType<typeof repairError> | null }> => {
  if (request.signal?.aborted)
    throw Object.assign(new Error('repair cancelled'), { code: 'cancelled' });
  if (authorization.kind === 'migrate-ledger') {
    const migration = authorization.ledgerMigration;
    if (migration === undefined) {
      return { changed: false, error: repairError({ code: 'invalid-state' }) };
    }
    const locked = await withLedgerLock(
      request.ports,
      authorization.path,
      async () => {
        const writer = await createTestNodeLedgerWriter(authorization.path, {
          ports: request.ports,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        return writer.migrateV1ToV2({
          expectedSourceByteRevision: migration.sourceByteRevision,
          expectedSourceSemanticRevision: migration.sourceSemanticRevision,
          journals: journalSequence(operation, request.ports),
        });
      },
      request.signal === undefined ? undefined : { signal: request.signal },
    );
    if (!locked.ok) {
      if (request.signal?.aborted || safeErrorCode(locked.error) === 'cancelled') {
        throw Object.assign(new Error('repair cancelled'), { code: 'cancelled' });
      }
      return { changed: false, error: repairError(locked.error) };
    }
    return locked.value.ok
      ? { changed: locked.value.value.changed, error: null }
      : { changed: false, error: repairError(locked.value.error) };
  }

  if (authorization.kind === 'migrate-project-config') {
    if (authorization.projectMigration === undefined) {
      return { changed: false, error: repairError({ code: 'invalid-state' }) };
    }
    const result = await executeProjectConfigMigration(
      request.artifactCoordinator,
      authorization.path,
      authorization.projectMigration,
      request.signal,
    );
    return result.ok
      ? { changed: result.value.outcome !== 'unchanged', error: null }
      : { changed: false, error: repairError(result.error) };
  }
  if (authorization.targetLock === undefined || authorization.artifactPair === undefined) {
    return { changed: false, error: repairError({ code: 'invalid-state' }) };
  }
  const result = await commitArtifactPair(request.artifactCoordinator, {
    pair: resolvedPair(authorization.artifactPair.file, authorization.artifactPair.lockfile),
    manifest: { kind: 'keep' },
    lock:
      authorization.before.state === 'present' && authorization.before.semanticRevision === null
        ? {
            kind: 'replace-invalid',
            lock: authorization.targetLock,
            expectedByteRevision: authorization.before.byteRevision,
          }
        : {
            kind: 'replace-exact',
            lock: authorization.targetLock,
            expectedByteRevision:
              authorization.before.state === 'absent' ? null : authorization.before.byteRevision,
          },
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  return result.ok
    ? { changed: result.value.outcome !== 'unchanged', error: null }
    : { changed: false, error: repairError(result.error) };
};

/** Default adapter: shared scheduler plus canonical ledger/artifact mutation authorities. */
export const executeDoctorRepairs: DoctorRepairExecutor = async (request) => {
  const outcomes = new Map<string, DoctorRepairResult>();
  const bindings: ValidatedExecutionBinding[] = request.plan.operations.map((operation) => ({
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: operation.pairId,
    actualBefore: operation.before,
    unstartedForce: null,
    execute: async (): Promise<OperationExecutionResult> => {
      const authorization = request.authorizations.get(operation.operationId);
      if (authorization === undefined) {
        throw new TypeError('doctor repair authorization is missing');
      }
      let repaired: Awaited<ReturnType<typeof executeAuthorizedRepair>>;
      try {
        repaired = await executeAuthorizedRepair(operation, authorization, request);
      } catch (error) {
        if (
          request.signal?.aborted ||
          (typeof error === 'object' &&
            error !== null &&
            (error as { code?: unknown }).code === 'cancelled')
        ) {
          return createOperationExecutionResult({
            operationId: operation.operationId,
            outcome: 'cancelled',
            actualBefore: operation.before,
            actualAfter: operation.before,
            force: null,
            error: null,
          });
        }
        repaired = { changed: false, error: repairError(error) };
      }
      const result: DoctorRepairResult =
        repaired.error === null
          ? {
              operationId: operation.operationId,
              outcome: repaired.changed ? 'changed' : 'unchanged',
              error: null,
            }
          : {
              operationId: operation.operationId,
              outcome: 'failed',
              error: repaired.error,
            };
      outcomes.set(operation.operationId, result);
      return createOperationExecutionResult({
        operationId: operation.operationId,
        outcome: repaired.error === null ? 'succeeded' : 'failed',
        actualBefore: operation.before,
        actualAfter: repaired.error === null ? operation.after : operation.before,
        force: null,
        error: repaired.error,
      });
    },
  }));
  const scheduled = await scheduleOperationPlan(request.plan, bindings, {
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (scheduled.some((result) => result.outcome === 'cancelled')) {
    throw Object.assign(new Error('repair cancelled'), { code: 'cancelled' });
  }
  return Object.freeze(
    request.plan.operations.map((operation) => {
      const result = outcomes.get(operation.operationId);
      if (result === undefined) throw new TypeError('doctor execution result correlation failed');
      return result;
    }),
  );
};
