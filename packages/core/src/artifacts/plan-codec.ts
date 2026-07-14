import { types as utilTypes } from 'node:util';
import { z } from 'zod';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import {
  type ArtifactCodec,
  type ArtifactCodecError,
  artifactCodecError,
  canonicalJsonBytes,
  decodeArtifactUtf8,
} from './codec.ts';
import type {
  PlanImageV1,
  PlanOperationIntentV1,
  PlanOperationV1,
  SavedPlanV1,
  SavedPlanV1Dto,
} from './plan-types.ts';

const SECRET_CANARY = 'P17_SECRET_CANARY';
const STATIC_PATHS = new Set([
  'schemaVersion',
  'kind',
  'skillsmithVersion',
  'executorSchemaVersion',
  'hashSchemaVersion',
  'portability',
  'artifactPair',
  'manifestSemanticHash',
  'lockCanonicalHash',
  'options',
  'selection',
  'operations',
  'checks',
  'diagnostics',
  'resourcePreconditions',
  'selectionPreconditions',
  'capabilityPreconditions',
  'reasons',
  'manifest',
  'lock',
  'lockSource',
  'prune',
  'locked',
  'selectionSource',
  'skills',
  'tools',
  'scopes',
  'operationId',
  'groupId',
  'pairId',
  'dependsOn',
  'skill',
  'source',
  'tool',
  'scope',
  'before',
  'after',
  'reason',
  'preconditionIds',
  'requiredCheckIds',
  'reversibility',
  'mutates',
  'conflict',
  'resource',
  'classification',
  'representation',
  'linkTarget',
  'dangling',
  'contentHash',
  'location',
  'shape',
  'version',
  'byteHash',
  'semanticHash',
  'value',
  'projectRoot',
  'identity',
  'host',
  'repository',
  'path',
  'requestedRef',
  'resolvedSha',
  'sourcePath',
  'defaults',
  'registry',
  'default',
  'name',
  'ref',
  'placement',
  'hashSchemaVersion',
  'manifestHash',
  'expectedState',
  'expectedHash',
  'expectedRevision',
  'domain',
  'digest',
  'members',
  'resourceHash',
  'operation',
  'capabilityVersion',
  'supported',
  'live',
  'ledger',
  'retentionResourceIds',
  'code',
  'message',
  'class',
  'normal',
  'forced',
  'target',
  'backup',
  'checkId',
  'blocking',
  'operationIds',
  'capabilityPreconditionId',
  'expectedContentHash',
  'mode',
  'diagnosticId',
  'severity',
  'refusalClass',
  'affected',
  'correlation',
  'unexpected',
]);

type Path = readonly (string | number)[];
type SnapshotFailure = {
  readonly reason: 'invalid-shape' | 'sensitive-content';
  readonly path: Path;
};

const codecError = (
  artifactId: 'plan' | 'journal',
  reason: ArtifactCodecError['reason'],
  path: Path = [],
  requestedVersion: number | null = 1,
): ArtifactCodecError =>
  artifactCodecError(
    artifactId,
    requestedVersion,
    reason,
    path.map((segment) =>
      typeof segment === 'number' || STATIC_PATHS.has(segment) ? segment : '*',
    ),
  );

const isSensitive = (value: string): boolean =>
  value.includes(SECRET_CANARY) || containsSensitiveMaterial(value);

const snapshotOrdinary = (
  input: unknown,
  path: Path = [],
  active = new Set<object>(),
  budget = { nodes: 0 },
): Result<unknown, SnapshotFailure> => {
  budget.nodes += 1;
  if (budget.nodes > 20_000 || path.length > 64) {
    return err({ reason: 'invalid-shape', path });
  }
  if (typeof input === 'string') {
    return isSensitive(input) ? err({ reason: 'sensitive-content', path }) : ok(input);
  }
  if (
    input === null ||
    typeof input === 'boolean' ||
    (typeof input === 'number' && Number.isFinite(input))
  ) {
    return ok(input);
  }
  if (typeof input !== 'object' || utilTypes.isProxy(input)) {
    return err({ reason: 'invalid-shape', path });
  }
  if (active.has(input)) return err({ reason: 'invalid-shape', path });
  active.add(input);
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) {
        return err({ reason: 'invalid-shape', path });
      }
      const ownKeys = Reflect.ownKeys(input);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
        ) ||
        Object.keys(input).length !== input.length
      ) {
        return err({ reason: 'invalid-shape', path });
      }
      const values: unknown[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !('value' in descriptor)) {
          return err({ reason: 'invalid-shape', path: [...path, index] });
        }
        const child = snapshotOrdinary(descriptor.value, [...path, index], active, budget);
        if (!child.ok) return child;
        values.push(child.value);
      }
      return ok(values);
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return err({ reason: 'invalid-shape', path });
    }
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || isSensitive(key)) {
        return err({
          reason: typeof key === 'string' ? 'sensitive-content' : 'invalid-shape',
          path,
        });
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return err({ reason: 'invalid-shape', path: [...path, key] });
      }
      const child = snapshotOrdinary(descriptor.value, [...path, key], active, budget);
      if (!child.ok) return child;
      clone[key] = child.value;
    }
    return ok(clone);
  } catch {
    return err({ reason: 'invalid-shape', path });
  } finally {
    active.delete(input);
  }
};

const hasForbiddenScalar = (value: string): boolean =>
  [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0x1f || point === 0x7f || (point >= 0xd800 && point <= 0xdfff);
  });
const ordinaryString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !hasForbiddenScalar(value))
    .refine((value) => !isSensitive(value));
const scalarString = ordinaryString(4096);
const id = ordinaryString(256).refine((value) => value.trim() === value && value.length > 0);
const code = z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const tool = z.enum(['claude-code', 'codex', 'kilo-code', 'opencode']);
const scope = z.enum(['user', 'project']);
const selectionSource = z.enum(['explicit-targets', 'explicit-all', 'bounded-default']);
const unique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;
type KindUnionOption = z.ZodDiscriminatedUnionOption<'kind'>;
type ClassUnionOption = z.ZodDiscriminatedUnionOption<'class'>;
const strictSchema = (shape: z.ZodRawShape): z.AnyZodObject => z.object(shape).strict();
const kindUnion = (options: readonly z.ZodTypeAny[]): z.ZodTypeAny =>
  z.discriminatedUnion(
    'kind',
    options as unknown as [KindUnionOption, KindUnionOption, ...KindUnionOption[]],
  );
const classUnion = (options: readonly z.ZodTypeAny[]): z.ZodTypeAny =>
  z.discriminatedUnion(
    'class',
    options as unknown as [ClassUnionOption, ClassUnionOption, ...ClassUnionOption[]],
  );

const location = kindUnion([
  strictSchema({ kind: z.literal('portable'), token: scalarString }),
  strictSchema({ kind: z.literal('machine-bound'), path: scalarString }),
]);
const sourceIdentity = strictSchema({
  host: scalarString,
  repository: scalarString,
  path: scalarString.nullable(),
});
const portableSource = strictSchema({
  kind: z.literal('portable'),
  identity: sourceIdentity,
  requestedRef: scalarString.nullable(),
  resolvedSha: scalarString,
  sourcePath: scalarString,
  contentHash: digest,
});
const source = kindUnion([
  portableSource,
  strictSchema({ kind: z.literal('local-dev'), path: scalarString, contentHash: digest }),
]);
const manifestSnapshot = strictSchema({
  version: z.literal(1),
  defaults: strictSchema({
    tools: z.array(tool).refine(unique).nullable(),
    scope: scope.nullable(),
    path: scalarString.nullable(),
  }).nullable(),
  registry: strictSchema({ default: scalarString.nullable() }).nullable(),
  skills: z
    .array(
      strictSchema({
        name: scalarString,
        source: sourceIdentity,
        ref: scalarString.nullable(),
        tools: z.array(tool).min(1).refine(unique),
        scope,
        placement: z.enum(['symlink', 'copy']),
        path: scalarString.nullable(),
      }),
    )
    .refine((values) => unique(values.map(({ name }) => name))),
});
const lockSnapshot = strictSchema({
  version: z.literal(1),
  hashSchemaVersion: z.literal(1),
  manifestHash: digest,
  skills: z
    .array(
      strictSchema({
        name: scalarString,
        source: scalarString,
        requestedRef: scalarString.nullable(),
        resolvedSha: scalarString,
        sourcePath: scalarString,
        contentHash: digest,
      }),
    )
    .refine((values) => unique(values.map(({ name }) => name))),
});

const resourceIdentity: z.ZodTypeAny = z.lazy(() =>
  kindUnion([
    strictSchema({ kind: z.literal('manifest-bytes'), location }),
    strictSchema({ kind: z.literal('lock'), location }),
    strictSchema({ kind: z.literal('ledger'), projectRoot: location.nullable() }),
    strictSchema({ kind: z.literal('ledger-schema'), projectRoot: location.nullable() }),
    strictSchema({
      kind: z.literal('live'),
      skill: scalarString,
      tool,
      scope,
      projectRoot: location.nullable(),
      location,
    }),
    strictSchema({ kind: z.literal('store'), contentHash: digest }),
    strictSchema({ kind: z.literal('project-context'), root: location }),
  ]),
);
const image: z.ZodTypeAny = z.lazy(() =>
  kindUnion([
    strictSchema({ kind: z.literal('absent'), resource: resourceIdentity }),
    strictSchema({
      kind: z.literal('placement'),
      resource: strictSchema({
        kind: z.literal('live'),
        skill: scalarString,
        tool,
        scope,
        projectRoot: location.nullable(),
        location,
      }),
      classification: z.enum(['dev', 'pinned', 'store-linked', 'unmanaged']),
      representation: z.enum(['symlink', 'copy', 'other']),
      linkTarget: location.nullable(),
      dangling: z.boolean(),
      source: source.nullable(),
      contentHash: digest.nullable(),
    }),
    strictSchema({
      kind: z.literal('manifest'),
      location,
      shape: z.enum(['canonical', 'legacy']),
      version: z.literal(1),
      byteHash: digest,
      semanticHash: digest,
      value: manifestSnapshot,
    }),
    strictSchema({
      kind: z.literal('lock'),
      location,
      version: z.literal(1),
      canonicalHash: digest,
      value: lockSnapshot,
    }),
    strictSchema({
      kind: z.literal('ledger'),
      projectRoot: location.nullable(),
      schemaVersion: z.union([z.literal(1), z.literal(2)]),
      byteHash: digest,
      semanticHash: digest,
    }),
  ]),
);
const hashFact = strictSchema({
  domain: z.enum([
    'manifest-semantic',
    'manifest-bytes',
    'lock-canonical',
    'source-content',
    'resource',
    'selection-set',
    'capability',
  ]),
  hashSchemaVersion: z.literal(1),
  digest,
});
const revision = kindUnion([
  strictSchema({ kind: z.literal('artifact-bytes'), digest }),
  strictSchema({ kind: z.literal('resource'), digest }),
]);
const mutationFlags = strictSchema({
  live: z.boolean(),
  manifest: z.boolean(),
  lock: z.boolean(),
  ledger: z.boolean(),
});
const reversibility = kindUnion([
  strictSchema({ kind: z.literal('none'), retentionResourceIds: z.tuple([]) }),
  strictSchema({
    kind: z.enum(['reversible', 'conditional']),
    retentionResourceIds: z.array(id).min(1).refine(unique),
  }),
]);
const conflict = classUnion([
  strictSchema({
    class: z.enum(['unmanaged-target', 'modified-managed-target', 'destination-exists']),
    normal: z.literal('refuse'),
    forced: z.literal('backup-and-replace'),
    target: resourceIdentity,
    backup: z.literal('required'),
  }),
  strictSchema({
    class: z.literal('source-changed'),
    normal: z.literal('refuse'),
    forced: z.literal('replace'),
    target: resourceIdentity,
    backup: z.literal('none'),
  }),
]).nullable();
const operationKind = z.enum([
  'install',
  'update',
  'remove',
  'link-dev',
  'promote',
  'move-scope',
  'adapt',
  'repair',
  'write-manifest',
  'write-lock',
  'migrate-project-config',
  'migrate-ledger',
]);

const operation = strictSchema({
  operationId: id,
  groupId: id,
  pairId: id.nullable(),
  kind: operationKind,
  dependsOn: z.array(id).refine(unique),
  skill: scalarString.nullable(),
  source: source.nullable(),
  tool: tool.nullable(),
  scope: scope.nullable(),
  before: image,
  after: image,
  reason: strictSchema({ code, message: scalarString }),
  selectionSource,
  preconditionIds: z.array(id).refine(unique),
  requiredCheckIds: z.array(id).refine(unique),
  reversibility,
  mutates: mutationFlags,
  conflict,
});
const operationIntent = operation.omit({
  dependsOn: true,
  reason: true,
  selectionSource: true,
  preconditionIds: true,
  requiredCheckIds: true,
});

const checkCommon = {
  checkId: id,
  blocking: z.literal(true),
  operationIds: z.array(id).min(1).refine(unique),
};
const check = kindUnion([
  strictSchema({ ...checkCommon, kind: z.literal('source-resolution'), source: portableSource }),
  strictSchema({ ...checkCommon, kind: z.literal('capability'), capabilityPreconditionId: id }),
  strictSchema({
    ...checkCommon,
    kind: z.literal('content-integrity'),
    source,
    expectedContentHash: digest,
  }),
  strictSchema({
    ...checkCommon,
    kind: z.literal('verification'),
    tool,
    mode: z.enum(['static', 'static+deep']),
    expectedContentHash: digest,
  }),
  strictSchema({
    ...checkCommon,
    kind: z.literal('precondition-validation'),
    preconditionIds: z.array(id).min(1).refine(unique),
  }),
]);
const reason = strictSchema({ code, message: scalarString });
const diagnostic = strictSchema({
  diagnosticId: id,
  kind: z.enum(['noop', 'skip', 'refuse', 'conflict', 'warning']),
  severity: z.enum(['info', 'warning', 'error']),
  refusalClass: z.enum(['usage', 'state', 'capability', 'source', 'permission']).nullable(),
  affected: strictSchema({
    skill: scalarString.nullable(),
    source: source.nullable(),
    tool: tool.nullable(),
    scope: scope.nullable(),
    path: location.nullable(),
  }),
  correlation: strictSchema({
    groupId: id.nullable(),
    pairId: id.nullable(),
    operationId: id.nullable(),
  }),
  reason,
  selectionSource,
});
const resourcePrecondition = strictSchema({
  preconditionId: id,
  resource: resourceIdentity,
  expectedState: z.enum(['absent', 'present']),
  expectedHash: hashFact,
  expectedRevision: revision.nullable(),
});
const selectionPrecondition = strictSchema({
  preconditionId: id,
  domain: z.literal('selection-set'),
  hashSchemaVersion: z.literal(1),
  expectedHash: digest,
  selectionSource,
  skills: z.array(scalarString).refine(unique),
  tools: z.array(tool).refine(unique),
  scopes: z.array(scope).refine(unique),
  members: z
    .array(strictSchema({ resource: resourceIdentity, resourceHash: hashFact }))
    .refine((values) => unique(values.map((value) => JSON.stringify(value.resource)))),
});
const capabilityPrecondition = strictSchema({
  preconditionId: id,
  domain: z.literal('capability'),
  hashSchemaVersion: z.literal(1),
  expectedHash: digest,
  tool,
  operation: z.enum([
    'detect',
    'inventory-skills',
    'inventory-commands',
    'diagnostics',
    'install',
    'uninstall',
    'dev',
    'promote',
    'undo',
    'verify-static',
    'verify-deep',
    'plan',
    'apply',
    'sync',
    'update',
    'adapt',
  ]),
  capabilityVersion: z.number().int().positive().safe(),
  supported: z.literal(true),
  scopes: z
    .array(z.enum(['user', 'project', 'system', 'managed', 'custom', 'artifact']))
    .refine(unique),
});
const machineReason = strictSchema({
  code: z.enum([
    'absolute-artifact-selector',
    'local-project-root',
    'local-dev-source',
    'absolute-live-placement',
    'custom-absolute-target',
  ]),
  message: scalarString,
  path: scalarString,
  preconditionIds: z.array(id).min(1).refine(unique),
});
const portability = z.union([
  strictSchema({ kind: z.literal('portable'), reasons: z.tuple([]) }),
  strictSchema({ kind: z.literal('machine-bound'), reasons: z.array(machineReason).min(1) }).refine(
    (value) =>
      unique(
        value.reasons.map(
          ({ code, path }: { readonly code: string; readonly path: string }) => `${code}\0${path}`,
        ),
      ),
  ),
]);

const SavedPlanSchema = strictSchema({
  schemaVersion: z.literal(1),
  kind: z.literal('skillsmith.plan'),
  skillsmithVersion: scalarString,
  executorSchemaVersion: z.literal(1),
  hashSchemaVersion: z.literal(1),
  portability,
  artifactPair: strictSchema({
    manifest: location,
    lock: location,
    lockSource: z.enum(['explicit', 'sibling']),
  }),
  manifestSemanticHash: digest,
  lockCanonicalHash: digest.nullable(),
  options: strictSchema({ prune: z.boolean(), locked: z.boolean() }),
  selection: strictSchema({
    selectionSource,
    skills: z.array(scalarString).refine(unique),
    tools: z.array(tool).refine(unique),
    scopes: z.array(scope).refine(unique),
  }),
  operations: z.array(operation),
  checks: z.array(check),
  diagnostics: z.array(diagnostic),
  resourcePreconditions: z.array(resourcePrecondition),
  selectionPreconditions: z.array(selectionPrecondition),
  capabilityPreconditions: z.array(capabilityPrecondition),
}).superRefine((untypedValue, context) => {
  const value = untypedValue as unknown as SavedPlanV1Dto;
  const add = (path: Path): void =>
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'invalid plan relationship',
      path: [...path],
    });
  const operationIds = value.operations.map(({ operationId }) => operationId);
  const checkIds = value.checks.map(({ checkId }) => checkId);
  const preconditionIds = [
    ...value.resourcePreconditions,
    ...value.selectionPreconditions,
    ...value.capabilityPreconditions,
  ].map(({ preconditionId }) => preconditionId);
  if (!unique(operationIds)) add(['operations']);
  if (!unique(checkIds)) add(['checks']);
  if (!unique(preconditionIds)) add(['resourcePreconditions']);
  const operationSet = new Set(operationIds);
  const checkSet = new Set(checkIds);
  const preconditionSet = new Set(preconditionIds);
  for (const [index, item] of value.operations.entries()) {
    const earlier = new Set(operationIds.slice(0, index));
    if (item.dependsOn.some((candidate) => !earlier.has(candidate))) {
      add(['operations', index, 'dependsOn']);
    }
    if (item.requiredCheckIds.some((candidate) => !checkSet.has(candidate))) {
      add(['operations', index, 'requiredCheckIds']);
    }
    if (item.preconditionIds.some((candidate) => !preconditionSet.has(candidate))) {
      add(['operations', index, 'preconditionIds']);
    }
    if (!operationMatchesMatrix(item as PlanOperationV1)) add(['operations', index]);
  }
  for (const [index, item] of value.checks.entries()) {
    if (item.operationIds.some((candidate) => !operationSet.has(candidate))) {
      add(['checks', index, 'operationIds']);
    }
    if (item.kind === 'capability' && !preconditionSet.has(item.capabilityPreconditionId)) {
      add(['checks', index, 'capabilityPreconditionId']);
    }
    if (
      item.kind === 'precondition-validation' &&
      item.preconditionIds.some((candidate) => !preconditionSet.has(candidate))
    ) {
      add(['checks', index, 'preconditionIds']);
    }
  }
  for (const [index, item] of value.diagnostics.entries()) {
    const informational = item.kind === 'noop' || item.kind === 'skip';
    const warning = item.kind === 'warning';
    if (
      (informational && (item.severity !== 'info' || item.refusalClass !== null)) ||
      (warning && (item.severity !== 'warning' || item.refusalClass !== null)) ||
      (!informational && !warning && (item.severity !== 'error' || item.refusalClass === null))
    ) {
      add(['diagnostics', index]);
    }
    if (item.correlation.operationId !== null && !operationSet.has(item.correlation.operationId)) {
      add(['diagnostics', index, 'correlation', 'operationId']);
    }
    if (item.correlation.pairId !== null && item.correlation.groupId === null) {
      add(['diagnostics', index, 'correlation']);
    }
  }
  for (const [index, item] of value.resourcePreconditions.entries()) {
    if (
      (item.expectedState === 'absent' && item.expectedRevision !== null) ||
      (item.expectedState === 'present' && item.expectedRevision === null) ||
      !resourceHashPairMatches(item.resource.kind, item.expectedHash.domain)
    ) {
      add(['resourcePreconditions', index]);
    }
  }
  if (value.portability.kind === 'portable' && containsMachineBinding(value)) {
    add(['portability']);
  }
});

const resourceHashPairMatches = (kind: string, domain: string): boolean => {
  if (kind === 'manifest-bytes') {
    return domain === 'manifest-semantic' || domain === 'manifest-bytes';
  }
  if (kind === 'lock') return domain === 'lock-canonical';
  if (kind === 'store') return domain === 'source-content';
  return domain === 'resource';
};

const containsMachineBinding = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsMachineBinding);
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'machine-bound' || record.kind === 'local-dev') return true;
  return Object.values(record).some(containsMachineBinding);
};

const flagsEqual = (
  flags: PlanOperationV1['mutates'],
  expected: readonly [boolean, boolean, boolean, boolean],
): boolean =>
  flags.live === expected[0] &&
  flags.manifest === expected[1] &&
  flags.lock === expected[2] &&
  flags.ledger === expected[3];

const hasPlacementIdentity = (item: PlanOperationV1): boolean =>
  item.skill !== null && item.tool !== null && item.scope !== null && item.pairId !== null;

const imageScopeMatches = (imageValue: PlanImageV1, item: PlanOperationV1): boolean => {
  const resource =
    imageValue.kind === 'placement'
      ? imageValue.resource
      : imageValue.kind === 'absent' && imageValue.resource.kind === 'live'
        ? imageValue.resource
        : null;
  return (
    resource !== null &&
    resource.skill === item.skill &&
    resource.tool === item.tool &&
    resource.scope === item.scope
  );
};

export const operationMatchesMatrix = (item: PlanOperationV1): boolean => {
  const placementIdentity = hasPlacementIdentity(item);
  const noPlacementIdentity =
    item.skill === null &&
    item.source === null &&
    item.tool === null &&
    item.scope === null &&
    item.pairId === null;
  switch (item.kind) {
    case 'install':
      return (
        placementIdentity &&
        item.source?.kind === 'portable' &&
        item.before.kind === 'absent' &&
        item.before.resource.kind === 'live' &&
        item.after.kind === 'placement' &&
        item.after.classification === 'pinned' &&
        flagsEqual(item.mutates, [true, false, false, true]) &&
        imageScopeMatches(item.before, item) &&
        imageScopeMatches(item.after, item)
      );
    case 'update':
    case 'promote':
      return (
        placementIdentity &&
        item.source?.kind === 'portable' &&
        item.before.kind === 'placement' &&
        item.after.kind === 'placement' &&
        item.after.classification === 'pinned' &&
        (item.kind !== 'promote' || item.before.classification === 'dev') &&
        flagsEqual(item.mutates, [true, false, false, true]) &&
        imageScopeMatches(item.before, item) &&
        imageScopeMatches(item.after, item)
      );
    case 'remove':
      return (
        placementIdentity &&
        item.before.kind === 'placement' &&
        item.after.kind === 'absent' &&
        item.after.resource.kind === 'live' &&
        flagsEqual(item.mutates, [true, false, false, true]) &&
        imageScopeMatches(item.before, item) &&
        imageScopeMatches(item.after, item)
      );
    case 'link-dev':
      return (
        placementIdentity &&
        item.source?.kind === 'local-dev' &&
        (item.before.kind === 'absent' || item.before.kind === 'placement') &&
        item.after.kind === 'placement' &&
        item.after.classification === 'dev' &&
        flagsEqual(item.mutates, [true, false, false, true]) &&
        imageScopeMatches(item.before, item) &&
        imageScopeMatches(item.after, item)
      );
    case 'move-scope':
      return (
        placementIdentity &&
        item.before.kind === 'placement' &&
        item.after.kind === 'placement' &&
        flagsEqual(item.mutates, [true, false, false, true]) &&
        item.before.resource.skill === item.skill &&
        item.before.resource.tool === item.tool &&
        imageScopeMatches(item.after, item) &&
        (item.before.resource.scope !== item.after.resource.scope ||
          JSON.stringify(item.before.resource.location) !==
            JSON.stringify(item.after.resource.location))
      );
    case 'adapt':
    case 'repair':
      return (
        placementIdentity &&
        item.source !== null &&
        item.before.kind === 'placement' &&
        item.after.kind === 'placement' &&
        flagsEqual(item.mutates, [true, false, false, true]) &&
        imageScopeMatches(item.before, item) &&
        imageScopeMatches(item.after, item)
      );
    case 'write-manifest':
      return (
        noPlacementIdentity &&
        (item.before.kind === 'absent' ||
          (item.before.kind === 'manifest' && item.before.shape === 'canonical')) &&
        item.after.kind === 'manifest' &&
        item.after.shape === 'canonical' &&
        flagsEqual(item.mutates, [false, true, false, false])
      );
    case 'write-lock':
      return (
        noPlacementIdentity &&
        (item.before.kind === 'absent' || item.before.kind === 'lock') &&
        item.after.kind === 'lock' &&
        flagsEqual(item.mutates, [false, false, true, false])
      );
    case 'migrate-project-config':
      return (
        noPlacementIdentity &&
        item.before.kind === 'manifest' &&
        item.before.shape === 'legacy' &&
        item.after.kind === 'manifest' &&
        item.after.shape === 'canonical' &&
        flagsEqual(item.mutates, [false, true, false, false])
      );
    case 'migrate-ledger':
      return (
        noPlacementIdentity &&
        item.before.kind === 'ledger' &&
        item.before.schemaVersion === 1 &&
        item.after.kind === 'ledger' &&
        item.after.schemaVersion === 2 &&
        flagsEqual(item.mutates, [false, false, false, true])
      );
  }
};

export const validatePlanOperationIntentV1 = (
  input: unknown,
): Result<PlanOperationIntentV1, ArtifactCodecError> => {
  const snapshot = ownArtifactDto('journal', input);
  if (!snapshot.ok) return snapshot;
  const parsed = operationIntent.safeParse(snapshot.value);
  if (!parsed.success) {
    return err(codecError('journal', 'invalid-shape', firstZodPath(parsed.error)));
  }
  const full: PlanOperationV1 = {
    ...(parsed.data as PlanOperationIntentV1),
    dependsOn: [],
    reason: { code: 'journal-intent', message: 'journal intent' },
    selectionSource: 'explicit-targets',
    preconditionIds: [],
    requiredCheckIds: [],
  };
  if (!operationMatchesMatrix(full)) return err(codecError('journal', 'invalid-shape'));
  const value = parsed.data as PlanOperationIntentV1;
  const canonical: PlanOperationIntentV1 = {
    operationId: value.operationId,
    groupId: value.groupId,
    pairId: value.pairId,
    kind: value.kind,
    skill: value.skill,
    source: value.source,
    tool: value.tool,
    scope: value.scope,
    before: canonicalizeImage(value.before),
    after: canonicalizeImage(value.after),
    mutates: value.mutates,
    reversibility: {
      ...value.reversibility,
      retentionResourceIds: sortStrings(value.reversibility.retentionResourceIds),
    } as PlanOperationV1['reversibility'],
    conflict: value.conflict,
  };
  return ok(deepFreeze(canonical));
};

const firstZodPath = (error: z.ZodError): Path => {
  const issue = error.issues[0];
  if (issue?.code === 'unrecognized_keys' && issue.keys[0] !== undefined) {
    return [...issue.path, issue.keys[0]];
  }
  return issue?.path ?? [];
};

export const ownArtifactDto = (
  artifactId: 'plan' | 'journal',
  input: unknown,
): Result<unknown, ArtifactCodecError> => {
  const snapshot = snapshotOrdinary(input);
  return snapshot.ok
    ? snapshot
    : err(codecError(artifactId, snapshot.error.reason, snapshot.error.path));
};

const parsePlan = (input: unknown): Result<SavedPlanV1Dto, ArtifactCodecError> => {
  const snapshot = ownArtifactDto('plan', input);
  if (!snapshot.ok) return snapshot;
  const parsed = SavedPlanSchema.safeParse(snapshot.value);
  return parsed.success
    ? ok(parsed.data as SavedPlanV1Dto)
    : err(codecError('plan', 'invalid-shape', firstZodPath(parsed.error)));
};

const sortStrings = <T extends string>(values: readonly T[]): T[] => [...values].sort();
const sortByJson = <T>(values: readonly T[]): T[] =>
  [...values].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });

const canonicalizePlan = (input: SavedPlanV1Dto): SavedPlanV1Dto => {
  const value = structuredClone(input);
  value.selection.skills = sortStrings(value.selection.skills);
  value.selection.tools = sortStrings(value.selection.tools);
  value.selection.scopes = sortStrings(value.selection.scopes);
  value.operations = value.operations.map((item) => ({
    ...item,
    dependsOn: sortStrings(item.dependsOn),
    preconditionIds: sortStrings(item.preconditionIds),
    requiredCheckIds: sortStrings(item.requiredCheckIds),
    reversibility: {
      ...item.reversibility,
      retentionResourceIds: sortStrings(item.reversibility.retentionResourceIds),
    } as PlanOperationV1['reversibility'],
    before: canonicalizeImage(item.before),
    after: canonicalizeImage(item.after),
  }));
  value.checks = value.checks.map((item) => ({
    ...item,
    operationIds: sortStrings(item.operationIds) as [string, ...string[]],
    ...(item.kind === 'precondition-validation'
      ? { preconditionIds: sortStrings(item.preconditionIds) as [string, ...string[]] }
      : {}),
  })) as SavedPlanV1Dto['checks'];
  value.resourcePreconditions.sort((left, right) =>
    left.preconditionId < right.preconditionId
      ? -1
      : left.preconditionId > right.preconditionId
        ? 1
        : 0,
  );
  value.selectionPreconditions = value.selectionPreconditions
    .map((item) => ({
      ...item,
      skills: sortStrings(item.skills),
      tools: sortStrings(item.tools),
      scopes: sortStrings(item.scopes),
      members: sortByJson(item.members),
    }))
    .sort((left, right) =>
      left.preconditionId < right.preconditionId
        ? -1
        : left.preconditionId > right.preconditionId
          ? 1
          : 0,
    );
  value.capabilityPreconditions = value.capabilityPreconditions
    .map((item) => ({ ...item, scopes: sortStrings(item.scopes) }))
    .sort((left, right) =>
      left.preconditionId < right.preconditionId
        ? -1
        : left.preconditionId > right.preconditionId
          ? 1
          : 0,
    );
  if (value.portability.kind === 'machine-bound') {
    value.portability.reasons = value.portability.reasons
      .map((item) => ({
        ...item,
        preconditionIds: sortStrings(item.preconditionIds) as [string, ...string[]],
      }))
      .sort((left, right) => {
        const a = `${left.code}\0${left.path}`;
        const b = `${right.code}\0${right.path}`;
        return a < b ? -1 : a > b ? 1 : 0;
      }) as typeof value.portability.reasons;
  }
  return value;
};

const canonicalizeImage = (value: PlanImageV1): PlanImageV1 => {
  if (value.kind === 'manifest') {
    return {
      ...value,
      value: {
        ...value.value,
        ...(value.value.defaults === null || value.value.defaults.tools === null
          ? {}
          : {
              defaults: {
                ...value.value.defaults,
                tools: sortStrings(value.value.defaults.tools),
              },
            }),
        skills: [...value.value.skills]
          .map((item) => ({ ...item, tools: sortStrings(item.tools) }))
          .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
      },
    };
  }
  if (value.kind === 'lock') {
    return {
      ...value,
      value: {
        ...value.value,
        skills: [...value.value.skills].sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        ),
      },
    };
  }
  return value;
};

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

export const validateSavedPlanV1Dto = (
  input: unknown,
): Result<SavedPlanV1Dto, ArtifactCodecError> => {
  const parsed = parsePlan(input);
  return parsed.ok ? ok(deepFreeze(canonicalizePlan(parsed.value))) : parsed;
};

export const fromSavedPlanV1Dto = (dto: SavedPlanV1Dto): Result<SavedPlanV1, ArtifactCodecError> =>
  validateSavedPlanV1Dto(dto);

export const toSavedPlanV1Dto = (model: SavedPlanV1): Result<SavedPlanV1Dto, ArtifactCodecError> =>
  validateSavedPlanV1Dto(model);

const duplicateJsonMember = (sourceText: string): boolean => {
  let cursor = 0;
  let duplicate = false;
  const whitespace = (): void => {
    while (/\s/u.test(sourceText[cursor] ?? '')) cursor += 1;
  };
  const stringToken = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < sourceText.length) {
      const character = sourceText[cursor];
      if (character === '\\') {
        cursor += 2;
      } else if (character === '"') {
        cursor += 1;
        return JSON.parse(sourceText.slice(start, cursor)) as string;
      } else {
        cursor += 1;
      }
    }
    throw new Error('unterminated string');
  };
  const value = (): void => {
    whitespace();
    const character = sourceText[cursor];
    if (character === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (sourceText[cursor] === '}') {
        cursor += 1;
        return;
      }
      while (cursor < sourceText.length) {
        whitespace();
        if (sourceText[cursor] !== '"') throw new Error('invalid object key');
        const key = stringToken();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        whitespace();
        if (sourceText[cursor] !== ':') throw new Error('missing colon');
        cursor += 1;
        value();
        whitespace();
        if (sourceText[cursor] === '}') {
          cursor += 1;
          return;
        }
        if (sourceText[cursor] !== ',') throw new Error('missing comma');
        cursor += 1;
      }
      throw new Error('unterminated object');
    }
    if (character === '[') {
      cursor += 1;
      whitespace();
      if (sourceText[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (cursor < sourceText.length) {
        value();
        whitespace();
        if (sourceText[cursor] === ']') {
          cursor += 1;
          return;
        }
        if (sourceText[cursor] !== ',') throw new Error('missing comma');
        cursor += 1;
      }
      throw new Error('unterminated array');
    }
    if (character === '"') {
      stringToken();
      return;
    }
    const start = cursor;
    while (cursor < sourceText.length && !/[\s,}\]]/u.test(sourceText[cursor] ?? '')) cursor += 1;
    if (start === cursor) throw new Error('missing value');
  };
  value();
  whitespace();
  if (cursor !== sourceText.length) throw new Error('trailing input');
  return duplicate;
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const descriptor = deepFreeze({
  id: 'plan' as const,
  version: 1 as const,
  syntax: 'json' as const,
  discriminator: { kind: 'field' as const, field: 'schemaVersion' as const },
  wireKind: 'skillsmith.plan',
  presentation: { decode: 'canonical' as const, encode: 'canonical' as const },
  terminalLf: true,
  unknownFields: 'reject-recursive' as const,
  migrations: [] as const,
  compatibility: 'conservative' as const,
});

export const savedPlanV1Codec: ArtifactCodec<'plan', 1, SavedPlanV1Dto, SavedPlanV1> =
  Object.freeze({
    descriptor,
    validate: validateSavedPlanV1Dto,
    fromDto: fromSavedPlanV1Dto,
    toDto: toSavedPlanV1Dto,
    decode(bytes: Uint8Array) {
      const decoded = decodeArtifactUtf8('plan', bytes, 1);
      if (!decoded.ok) return decoded;
      if (decoded.value.source.trim().length === 0) {
        return err(codecError('plan', 'malformed'));
      }
      let input: unknown;
      try {
        if (duplicateJsonMember(decoded.value.source)) {
          return err(codecError('plan', 'malformed'));
        }
        input = JSON.parse(decoded.value.source);
      } catch {
        return err(codecError('plan', 'malformed'));
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return err(codecError('plan', 'invalid-shape'));
      }
      const record = input as Record<string, unknown>;
      if (record.kind !== 'skillsmith.plan') {
        return err(codecError('plan', 'invalid-shape', ['kind']));
      }
      const version = record.schemaVersion;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
        return err(codecError('plan', 'invalid-shape', ['schemaVersion'], null));
      }
      if (version !== 1) {
        return err(codecError('plan', 'unsupported-version', ['schemaVersion'], version));
      }
      const model = fromSavedPlanV1Dto(input as SavedPlanV1Dto);
      if (!model.ok) return model;
      const canonical = savedPlanV1Codec.encode(model.value);
      if (!canonical.ok) return canonical;
      if (!bytesEqual(decoded.value.bytes, canonical.value)) {
        return err(codecError('plan', 'noncanonical'));
      }
      return ok(
        deepFreeze({
          source: { kind: 'version' as const, version: 1 },
          model: model.value,
          canonical: true,
          migration: null,
        }),
      );
    },
    encode(model: SavedPlanV1) {
      const dto = toSavedPlanV1Dto(model);
      return dto.ok ? canonicalJsonBytes('plan', dto.value, 1, true) : dto;
    },
  });
