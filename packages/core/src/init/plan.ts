import { artifactManifestImageFromBytesV1 } from '../artifacts/execution.ts';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { InitManifestOperationInput } from '../artifacts/init.ts';
import { createExecutionPrecondition } from '../execution/preconditions.ts';
import {
  createOperationGroupId,
  createOperationId,
  createOperationPlan,
} from '../planning/create.ts';
import type {
  BoundedConflict,
  ExecutableOperation,
  OperationDigest,
  OperationImage,
  OperationResourceIdentity,
} from '../planning/types.ts';
import type {
  InitArtifactSelection,
  InitDefaults,
  InitObservedManifest,
  InitRequest,
  InitResult,
  PreparedInitPlan,
} from './types.ts';

const encoder = new TextEncoder();
const location = (path: string) => Object.freeze({ kind: 'machine-bound' as const, path });
const resource = (path: string): OperationResourceIdentity =>
  Object.freeze({ kind: 'manifest-bytes', location: location(path) });

const resourceDigest = (bytes: Uint8Array): ArtifactDigest => {
  const digest = hashCanonicalInput('resource', 1, bytes);
  if (!digest.ok) throw new TypeError('init manifest resource could not be hashed');
  return digest.value;
};

export const initObservationFacts = (observed: InitObservedManifest): unknown =>
  observed.state === 'absent'
    ? Object.freeze({ state: 'absent' as const })
    : Object.freeze({
        state: 'file' as const,
        resourceDigest: observed.resourceDigest,
        mode: observed.mode,
      });

const beforeOperationImage = (
  path: string,
  classification: InitManifestOperationInput,
  observed: InitObservedManifest,
): OperationImage => {
  if (observed.state === 'absent') {
    return Object.freeze({ kind: 'absent' as const, resource: resource(path) });
  }
  const before = classification.before;
  if (before === null) throw new TypeError('init create classification has present bytes');
  if (before.shape === 'legacy' || (before.shape === 'canonical' && before.semanticHash !== null)) {
    return artifactManifestImageFromBytesV1(path, observed.bytes);
  }
  if (before.shape === 'future') {
    throw new TypeError('refused init shape cannot enter an operation plan');
  }
  return Object.freeze({
    kind: 'opaque-manifest' as const,
    location: location(path),
    shape: before.shape,
    byteHash: observed.resourceDigest as OperationDigest,
  });
};

const afterOperationImage = (path: string, classification: InitManifestOperationInput) => {
  if (classification.after === null) throw new TypeError('init noop has no operation after-image');
  return artifactManifestImageFromBytesV1(path, encoder.encode(classification.after.source));
};

const resultBefore = (classification: InitManifestOperationInput) =>
  classification.before === null
    ? Object.freeze({ state: 'absent' as const, shape: null, byteHash: null, semanticHash: null })
    : Object.freeze({
        state: 'present' as const,
        shape: classification.before.shape as Exclude<typeof classification.before.shape, 'future'>,
        byteHash: classification.before.byteHash,
        semanticHash: classification.before.semanticHash,
      });

export const prepareInitOperationPlan = (input: {
  readonly request: InitRequest;
  readonly dryRun: boolean;
  readonly defaults: InitDefaults;
  readonly selection: InitArtifactSelection;
  readonly skeleton: PreparedInitPlan['skeleton'];
  readonly classification: InitManifestOperationInput;
  readonly observed: InitObservedManifest;
}): PreparedInitPlan => {
  const { classification, observed, selection } = input;
  if (classification.kind === 'noop') {
    const result: InitResult = Object.freeze({
      action: 'noop',
      operationId: null,
      before: resultBefore(classification) as Extract<InitResult['before'], { state: 'present' }>,
      after: null,
    });
    return Object.freeze({
      ...input,
      plan: createOperationPlan({
        domain: 'skillsmith.operation-plan',
        schemaVersion: 1,
        command: 'init',
        selection: { source: 'bounded-default', tools: [], scopes: [] },
        batchPolicy: 'fail-fast',
        operations: [],
        checks: [],
        diagnostics: [],
      }),
      result,
    });
  }

  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'init',
    skill: null,
    source: null,
    scope: null,
    target: selection.manifestPath,
  });
  const kind =
    classification.kind === 'migrate-project-config'
      ? ('migrate-project-config' as const)
      : ('write-manifest' as const);
  const before = beforeOperationImage(selection.manifestPath, classification, observed);
  const after = afterOperationImage(selection.manifestPath, classification);
  const conflict: BoundedConflict | null =
    classification.kind === 'replace-manifest'
      ? Object.freeze({
          class: 'destination-exists' as const,
          normal: 'refuse' as const,
          forced: 'backup-and-replace' as const,
          target: resource(selection.manifestPath),
          backup: 'required' as const,
        })
      : null;
  const identity = {
    domain: 'skillsmith.operation-identity' as const,
    schemaVersion: 1 as const,
    groupId,
    pairId: null,
    kind,
    skill: null,
    source: null,
    tool: null,
    scope: null,
  };
  const operationId = createOperationId(identity);
  const expected = initObservationFacts(observed);
  const preconditionId = createExecutionPrecondition({
    operationIds: [operationId],
    resource: resource(selection.manifestPath),
    expected,
    observe: async () => expected,
  }).preconditionId;
  const operation: ExecutableOperation = Object.freeze({
    operationId,
    groupId,
    pairId: null,
    kind,
    dependencyMetadata: Object.freeze({
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds: Object.freeze([]),
    }),
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before,
    after,
    reason: Object.freeze({
      code: `init-${classification.kind}`,
      message: `${classification.kind} is required for the selected manifest.`,
    }),
    selectionSource: 'bounded-default',
    preconditionIds: Object.freeze([preconditionId]),
    requiredCheckIds: Object.freeze([]),
    reversibility: Object.freeze({ kind: 'none' as const, retentionResourceIds: [] as const }),
    mutates: Object.freeze({ live: false, manifest: true, lock: false, ledger: false }),
    conflict,
  });
  const plan = createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'init',
    selection: { source: 'bounded-default', tools: [], scopes: [] },
    batchPolicy: 'fail-fast',
    operations: [operation],
    checks: [],
    diagnostics: [],
  });
  const result: InitResult = Object.freeze({
    action: classification.kind,
    operationId,
    before: resultBefore(classification),
    after: Object.freeze({
      state: 'canonical' as const,
      byteHash: classification.after.byteHash,
      semanticHash: classification.after.semanticHash,
    }),
  }) as InitResult;
  return Object.freeze({ ...input, plan, result });
};

export { resourceDigest as hashInitResourceBytes };
