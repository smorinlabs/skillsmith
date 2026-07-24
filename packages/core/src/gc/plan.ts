import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import { deriveLedgerProjectRegistrations } from '../artifacts/registry.ts';
import type { GcProjectV1Dto, GcReportV1Dto } from '../contracts/v1/gc.ts';
import { type Result, err, ok } from '../result.ts';
import type {
  GcDuration,
  GcInventory,
  GcObjectClassification,
  GcPreparedAction,
  GcRequestError,
  PreparedGcPlan,
} from './types.ts';

const DURATION = /^([1-9][0-9]*)(s|m|h|d|w)$/u;
const MULTIPLIER = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const);

const requestError = (
  code: GcRequestError['code'],
  message: string,
): Result<never, GcRequestError> => err(Object.freeze({ code, message }));

export const parseGcDuration = (value: string): Result<GcDuration, GcRequestError> => {
  const parsed = DURATION.exec(value);
  const unit = parsed?.[2] as keyof typeof MULTIPLIER | undefined;
  if (parsed?.[1] === undefined || unit === undefined) {
    return requestError('invalid-duration', 'duration must match [1-9][0-9]*(s|m|h|d|w)');
  }
  const count = Number(parsed[1]);
  const milliseconds = count * MULTIPLIER[unit];
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(milliseconds)) {
    return requestError('invalid-duration', 'duration milliseconds must be a safe integer');
  }
  return ok(Object.freeze({ input: value, milliseconds }));
};

export const normalizeGcForgetRoots = (
  cwd: string,
  roots: readonly string[],
): Result<readonly string[], GcRequestError> => {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (root.length === 0 || root.includes('\0')) {
      return requestError('invalid-forget', 'forget-project path is invalid');
    }
    const selected = resolve(cwd, root);
    if (!seen.has(selected)) {
      seen.add(selected);
      normalized.push(selected);
    }
  }
  return ok(Object.freeze(normalized));
};

export const withoutLedgerProjectAt = (
  model: LedgerModel,
  roots: readonly string[],
): Result<LedgerModel, GcRequestError> => {
  const projects = { ...model.projects };
  for (const root of roots) {
    if (!Object.hasOwn(projects, root)) {
      return requestError('invalid-forget', 'forget-project root is not registered');
    }
    delete projects[root];
  }
  const frozenProjects = Object.freeze(projects);
  return ok(
    Object.freeze({
      ...model,
      projects: frozenProjects,
      projectRegistrations: deriveLedgerProjectRegistrations(frozenProjects),
    }),
  );
};

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const gcRequestDigest = (
  duration: GcDuration | null,
  normalizedForgetRoots: readonly string[],
): string =>
  digest({
    olderThanMilliseconds: duration?.milliseconds ?? null,
    forget: normalizedForgetRoots,
  });

const compare = (left: string, right: string): number =>
  Buffer.from(left).compare(Buffer.from(right));

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

export interface BuildGcPlanInput {
  readonly sourceLedger: PreparedGcPlan['sourceLedger'];
  readonly model: LedgerModel;
  readonly postForgetModel: LedgerModel;
  readonly inventory: Extract<GcInventory, { readonly state: 'ok' }>;
  readonly classifications: readonly GcObjectClassification[];
  readonly duration: GcDuration | null;
  readonly nowMilliseconds: number;
  readonly projects: readonly GcProjectV1Dto[];
  readonly dataDir: string;
  readonly storeRoot: string;
  readonly ledgerPath: string;
  readonly project: GcReportV1Dto['project'];
  readonly retryArguments: readonly string[];
  readonly normalizedForgetRoots: readonly string[];
}

export const buildGcPlan = (input: BuildGcPlanInput): PreparedGcPlan => {
  const migrationSeed =
    input.sourceLedger.state === 'present' && input.sourceLedger.sourceVersion === 1
      ? { kind: 'migrate-ledger' as const, target: input.ledgerPath }
      : null;
  const forgetSeeds = input.projects
    .filter(({ action, outcome }) => action === 'forget-project' && outcome === 'planned')
    .map(({ root }) => ({ kind: 'forget-project' as const, target: root }))
    .sort((left, right) => compare(left.target, right.target));
  const reclaimSeeds = input.classifications
    .filter(({ outcome }) => outcome === 'eligible')
    .map(({ object }) => ({ kind: 'reclaim-store' as const, target: object.path, object }))
    .sort((left, right) => compare(left.target, right.target));
  const requestDigest = gcRequestDigest(input.duration, input.normalizedForgetRoots);
  const planId = digest({
    requestDigest,
    ledger:
      input.sourceLedger.state === 'present'
        ? [input.sourceLedger.byteRevision, input.sourceLedger.semanticRevision]
        : ['absent'],
    inventory: input.inventory.objects.map(({ id, modifiedAt, logicalBytes }) => [
      id,
      modifiedAt,
      logicalBytes,
    ]),
    outcomes: input.classifications.map(({ object, outcome }) => [object.id, outcome]),
  });
  const migrationId = migrationSeed === null ? null : digest({ planId, ...migrationSeed });
  const forgetActions = forgetSeeds.map((seed) =>
    Object.freeze({
      ...seed,
      actionId: digest({ planId, ...seed }),
      dependencyIds: migrationId === null ? [] : [migrationId],
    }),
  );
  const forgetIds = forgetActions.map(({ actionId }) => actionId);
  const actions: GcPreparedAction[] = [
    ...(migrationSeed === null
      ? []
      : [
          Object.freeze({
            ...migrationSeed,
            actionId: migrationId as string,
            dependencyIds: Object.freeze([] as string[]),
          }),
        ]),
    ...forgetActions,
    ...reclaimSeeds.map((seed) => {
      const actionId = digest({ planId, kind: seed.kind, target: seed.target, id: seed.object.id });
      return Object.freeze({
        ...seed,
        actionId,
        ownershipToken: digest({ planId, actionId, owner: 'gc-tombstone' }),
        dependencyIds: Object.freeze([
          ...(migrationId === null ? [] : [migrationId]),
          ...forgetIds,
        ]),
      });
    }),
  ];
  const objectRows = input.classifications.map(({ object, protection, ageEligible, outcome }) => ({
    id: object.id,
    kind: object.kind,
    path: object.path,
    contentHash: object.contentHash,
    modifiedAt: object.modifiedAt,
    logicalBytes: object.logicalBytes,
    protection: protection.map(({ kind, sourceId }) => ({ kind, sourceId })),
    ageEligible,
    outcome,
    reason:
      outcome === 'protected'
        ? 'reachable or retained'
        : outcome === 'age-filtered'
          ? 'newer than or equal to the strict cutoff'
          : null,
  }));
  const actionRows = actions.map((action) => ({
    actionId: action.actionId,
    kind: action.kind,
    target: action.target,
    logicalBytes: action.kind === 'reclaim-store' ? action.object.logicalBytes : 0,
    dependencyIds: [...action.dependencyIds],
    outcome: 'planned' as const,
    reason: null,
  }));
  const eligible = input.classifications.filter(({ outcome }) => outcome === 'eligible');
  const changing = actions.length > 0;
  const report: GcReportV1Dto = {
    schemaVersion: 1,
    kind: 'skillsmith.gc',
    command: 'gc',
    mode: 'dry-run',
    state: changing ? 'planned' : 'no-op',
    planId,
    selectionSource: 'bounded-default',
    project: input.project,
    migration: {
      sourceVersion:
        input.sourceLedger.state === 'present' ? input.sourceLedger.sourceVersion : null,
      action: migrationSeed === null ? 'none' : 'migrate-ledger',
      outcome: migrationSeed === null ? 'not-required' : 'planned',
    },
    olderThan:
      input.duration === null
        ? null
        : {
            ...input.duration,
            cutoff: input.nowMilliseconds - input.duration.milliseconds,
          },
    approval: {
      required: changing,
      outcome: changing ? 'pending' : 'not-required',
    },
    recovery: { state: 'none', phase: null },
    projects: [...input.projects],
    objects: objectRows,
    actions: actionRows,
    results: [],
    checks: [
      { code: 'inventory-safe', outcome: 'passed', message: 'configured store inventory is safe' },
      { code: 'ledger-readable', outcome: 'passed', message: 'placement ledger is readable' },
    ],
    diagnostics: [],
    summary: {
      observedItems: input.classifications.length,
      protectedItems: input.classifications.filter(({ outcome }) => outcome === 'protected').length,
      ageFilteredItems: input.classifications.filter(({ outcome }) => outcome === 'age-filtered')
        .length,
      eligibleItems: eligible.length,
      eligibleBytes: eligible.reduce((sum, { object }) => sum + object.logicalBytes, 0),
      forgottenProjects: 0,
      alreadyAbsentItems: 0,
      reclaimedItems: 0,
      reclaimedBytes: 0,
      refusedItems: 0,
      failedItems: 0,
    },
  };
  return Object.freeze({
    planId,
    requestDigest,
    sourceLedger: input.sourceLedger,
    model: input.model,
    postForgetModel: input.postForgetModel,
    actions: Object.freeze(actions),
    report: deepFreeze(report),
    dataDir: input.dataDir,
    storeRoot: input.storeRoot,
    ledgerPath: input.ledgerPath,
    retryArguments: Object.freeze([...input.retryArguments]),
    normalizedForgetRoots: Object.freeze([...input.normalizedForgetRoots]),
    nowMilliseconds: input.nowMilliseconds,
    olderThanMilliseconds: input.duration?.milliseconds ?? null,
  });
};
