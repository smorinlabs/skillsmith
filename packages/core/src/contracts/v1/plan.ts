import { z } from 'zod';
import { SUPPORTED_TOOLS, type SupportedTool } from '../../agents/types.ts';
import type {
  ConflictV1,
  LockSnapshotV1,
  ManifestSnapshotV1,
  MutationFlagsV1,
  PlanCheckV1,
  PlanDiagnosticV1,
  PlanDigestV1,
  PlanImageV1,
  PlanOperationV1,
  PlanSourceV1,
  ResourceIdentityV1,
  ReversibilityV1,
} from '../../artifacts/plan-types.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodec } from '../types.ts';

const IdSchema = z.string().min(1);
const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u) as unknown as z.ZodType<PlanDigestV1>;
const ToolSchema = z.enum(SUPPORTED_TOOLS);
const ScopeSchema = z.enum(['user', 'project']);
const SelectionSourceSchema = z.enum(['explicit-targets', 'explicit-all', 'bounded-default']);
const ReasonSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict();
const LocationSchema = z.union([
  z.object({ kind: z.literal('portable'), token: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('machine-bound'), path: z.string().min(1) }).strict(),
]);
const PortableSourceSchema: z.ZodType<Extract<PlanSourceV1, { kind: 'portable' }>> = z
  .object({
    kind: z.literal('portable'),
    identity: z
      .object({
        host: z.string().min(1),
        repository: z.string().min(1),
        path: z.string().nullable(),
      })
      .strict(),
    requestedRef: z.string().nullable(),
    resolvedSha: z.string().min(1),
    sourcePath: z.string().min(1),
    contentHash: DigestSchema,
  })
  .strict();
const SourceSchema: z.ZodType<PlanSourceV1> = z.union([
  PortableSourceSchema,
  z
    .object({
      kind: z.literal('local-dev'),
      path: z.string().min(1),
      contentHash: DigestSchema,
    })
    .strict(),
]);
const LiveResourceSchema = z
  .object({
    kind: z.literal('live'),
    skill: z.string().min(1),
    tool: ToolSchema,
    scope: ScopeSchema,
    projectRoot: LocationSchema.nullable(),
    location: LocationSchema,
  })
  .strict();
const ResourceSchema: z.ZodType<ResourceIdentityV1> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manifest-bytes'), location: LocationSchema }).strict(),
    z.object({ kind: z.literal('lock'), location: LocationSchema }).strict(),
    z.object({ kind: z.literal('ledger'), projectRoot: LocationSchema.nullable() }).strict(),
    z.object({ kind: z.literal('ledger-schema'), projectRoot: LocationSchema.nullable() }).strict(),
    LiveResourceSchema,
    z.object({ kind: z.literal('store'), contentHash: DigestSchema }).strict(),
    z.object({ kind: z.literal('project-context'), root: LocationSchema }).strict(),
  ]),
);
const ManifestSnapshotSchema: z.ZodType<ManifestSnapshotV1> = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        tools: z.array(ToolSchema).nullable(),
        scope: ScopeSchema.nullable(),
        path: z.string().nullable(),
      })
      .strict()
      .nullable(),
    registry: z.object({ default: z.string().nullable() }).strict().nullable(),
    skills: z.array(
      z
        .object({
          name: z.string().min(1),
          source: z
            .object({
              host: z.string().min(1),
              repository: z.string().min(1),
              path: z.string().nullable(),
            })
            .strict(),
          ref: z.string().nullable(),
          tools: z.array(ToolSchema),
          scope: ScopeSchema,
          placement: z.enum(['symlink', 'copy']),
          path: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const LockSnapshotSchema: z.ZodType<LockSnapshotV1> = z
  .object({
    version: z.literal(1),
    hashSchemaVersion: z.literal(1),
    manifestHash: DigestSchema,
    skills: z.array(
      z
        .object({
          name: z.string().min(1),
          source: z.string().min(1),
          requestedRef: z.string().nullable(),
          resolvedSha: z.string().min(1),
          sourcePath: z.string().min(1),
          contentHash: DigestSchema,
        })
        .strict(),
    ),
  })
  .strict();
const ImageSchema: z.ZodType<PlanImageV1> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('absent'), resource: ResourceSchema }).strict(),
    z
      .object({
        kind: z.literal('placement'),
        resource: LiveResourceSchema,
        classification: z.enum(['dev', 'pinned', 'store-linked', 'unmanaged']),
        representation: z.enum(['symlink', 'copy', 'other']),
        linkTarget: LocationSchema.nullable(),
        dangling: z.boolean(),
        source: SourceSchema.nullable(),
        contentHash: DigestSchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('manifest'),
        location: LocationSchema,
        shape: z.enum(['canonical', 'legacy']),
        version: z.literal(1),
        byteHash: DigestSchema,
        semanticHash: DigestSchema,
        value: ManifestSnapshotSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('lock'),
        location: LocationSchema,
        version: z.literal(1),
        canonicalHash: DigestSchema,
        value: LockSnapshotSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('ledger'),
        projectRoot: LocationSchema.nullable(),
        schemaVersion: z.union([z.literal(1), z.literal(2)]),
        byteHash: DigestSchema,
        semanticHash: DigestSchema,
      })
      .strict(),
  ]),
);
const MutationSchema: z.ZodType<MutationFlagsV1> = z
  .object({ live: z.boolean(), manifest: z.boolean(), lock: z.boolean(), ledger: z.boolean() })
  .strict();
const ReversibilitySchema: z.ZodType<ReversibilityV1> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), retentionResourceIds: z.tuple([]) }).strict(),
  z
    .object({
      kind: z.enum(['reversible', 'conditional']),
      retentionResourceIds: z.array(IdSchema).nonempty(),
    })
    .strict(),
]);
const ConflictSchema: z.ZodType<ConflictV1> = z
  .union([
    z
      .object({
        class: z.enum(['unmanaged-target', 'modified-managed-target', 'destination-exists']),
        normal: z.literal('refuse'),
        forced: z.literal('backup-and-replace'),
        target: ResourceSchema,
        backup: z.literal('required'),
      })
      .strict(),
    z
      .object({
        class: z.literal('source-changed'),
        normal: z.literal('refuse'),
        forced: z.literal('replace'),
        target: ResourceSchema,
        backup: z.literal('none'),
      })
      .strict(),
  ])
  .nullable();
const OperationKindSchema = z.enum([
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
const OperationSchema: z.ZodType<PlanOperationV1> = z
  .object({
    operationId: IdSchema,
    groupId: IdSchema,
    pairId: IdSchema.nullable(),
    kind: OperationKindSchema,
    dependsOn: z.array(IdSchema),
    skill: z.string().nullable(),
    source: SourceSchema.nullable(),
    tool: ToolSchema.nullable(),
    scope: ScopeSchema.nullable(),
    before: ImageSchema,
    after: ImageSchema,
    reason: ReasonSchema,
    selectionSource: SelectionSourceSchema,
    preconditionIds: z.array(IdSchema),
    requiredCheckIds: z.array(IdSchema),
    reversibility: ReversibilitySchema,
    mutates: MutationSchema,
    conflict: ConflictSchema,
  })
  .strict();
const CheckCommon = {
  checkId: IdSchema,
  blocking: z.literal(true),
  operationIds: z.array(IdSchema).nonempty(),
};
const CheckSchema: z.ZodType<PlanCheckV1> = z.discriminatedUnion('kind', [
  z
    .object({ ...CheckCommon, kind: z.literal('source-resolution'), source: PortableSourceSchema })
    .strict(),
  z
    .object({ ...CheckCommon, kind: z.literal('capability'), capabilityPreconditionId: IdSchema })
    .strict(),
  z
    .object({
      ...CheckCommon,
      kind: z.literal('content-integrity'),
      source: SourceSchema,
      expectedContentHash: DigestSchema,
    })
    .strict(),
  z
    .object({
      ...CheckCommon,
      kind: z.literal('verification'),
      tool: ToolSchema,
      mode: z.enum(['static', 'static+deep']),
      expectedContentHash: DigestSchema,
    })
    .strict(),
  z
    .object({
      ...CheckCommon,
      kind: z.literal('precondition-validation'),
      preconditionIds: z.array(IdSchema).nonempty(),
    })
    .strict(),
]);
const DiagnosticSchema: z.ZodType<PlanDiagnosticV1> = z
  .object({
    diagnosticId: IdSchema,
    kind: z.enum(['noop', 'skip', 'refuse', 'conflict', 'warning']),
    severity: z.enum(['info', 'warning', 'error']),
    refusalClass: z.enum(['usage', 'state', 'capability', 'source', 'permission']).nullable(),
    affected: z
      .object({
        skill: z.string().nullable(),
        source: SourceSchema.nullable(),
        tool: ToolSchema.nullable(),
        scope: ScopeSchema.nullable(),
        path: LocationSchema.nullable(),
      })
      .strict(),
    correlation: z
      .object({
        groupId: IdSchema.nullable(),
        pairId: IdSchema.nullable(),
        operationId: IdSchema.nullable(),
      })
      .strict(),
    reason: ReasonSchema,
    selectionSource: SelectionSourceSchema,
  })
  .strict();
const CountSchema = z.number().int().nonnegative();
const OperationKindCountsSchema = z
  .object({
    install: CountSchema,
    update: CountSchema,
    remove: CountSchema,
    'link-dev': CountSchema,
    promote: CountSchema,
    'move-scope': CountSchema,
    adapt: CountSchema,
    repair: CountSchema,
    'write-manifest': CountSchema,
    'write-lock': CountSchema,
    'migrate-project-config': CountSchema,
    'migrate-ledger': CountSchema,
  })
  .strict();
const CheckKindCountsSchema = z
  .object({
    'source-resolution': CountSchema,
    capability: CountSchema,
    'content-integrity': CountSchema,
    verification: CountSchema,
    'precondition-validation': CountSchema,
  })
  .strict();
const DiagnosticKindCountsSchema = z
  .object({
    noop: CountSchema,
    skip: CountSchema,
    refuse: CountSchema,
    conflict: CountSchema,
    warning: CountSchema,
  })
  .strict();

const PlanV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.plan-report'),
    command: z.literal('plan'),
    state: z.enum(['ready', 'refused']),
    artifactPair: z
      .object({
        manifestPath: z.string(),
        lockPath: z.string(),
        lockSource: z.enum(['explicit', 'sibling']),
        selectionSource: z.enum([
          'explicit',
          'discovered-project',
          'project-default',
          'user-default',
        ]),
      })
      .strict(),
    project: z
      .object({
        effectiveCwd: z.string(),
        root: z.string().nullable(),
        identity: z.string().nullable(),
      })
      .strict(),
    options: z.object({ locked: z.boolean(), prune: z.boolean(), check: z.boolean() }).strict(),
    selection: z
      .object({
        selectionSource: SelectionSourceSchema,
        selectionOutcome: z.enum(['selected', 'filter-noop']),
        requestedTools: z.array(ToolSchema),
        requestedScope: ScopeSchema.nullable(),
        skills: z.array(z.string()),
        tools: z.array(ToolSchema),
        scopes: z.array(ScopeSchema),
      })
      .strict(),
    operations: z.array(OperationSchema),
    checks: z.array(CheckSchema),
    diagnostics: z.array(DiagnosticSchema),
    summary: z
      .object({
        operations: z.number().int().nonnegative(),
        checks: z.number().int().nonnegative(),
        diagnostics: z.number().int().nonnegative(),
        drift: z.number().int().nonnegative(),
        refusals: z.number().int().nonnegative(),
        operationKinds: OperationKindCountsSchema,
        checkKinds: CheckKindCountsSchema,
        diagnosticKinds: DiagnosticKindCountsSchema,
      })
      .strict(),
    savedOutput: z
      .object({
        path: z.string(),
        disposition: z.enum(['created', 'replaced']),
        mode: z.literal('0600'),
        portability: z.enum(['portable', 'machine-bound']),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const total = (counts: Readonly<Record<string, number>>): number =>
      Object.values(counts).reduce((sum, count) => sum + count, 0);
    const countKinds = (rows: readonly Readonly<{ kind: string }>[]): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
      return counts;
    };
    const exactCounts = (
      expected: Readonly<Record<string, number>>,
      rows: readonly Readonly<{ kind: string }>[],
    ): boolean => {
      const actual = countKinds(rows);
      return Object.entries(expected).every(([kind, count]) => (actual[kind] ?? 0) === count);
    };
    if (
      value.summary.operations !== value.operations.length ||
      value.summary.checks !== value.checks.length ||
      value.summary.diagnostics !== value.diagnostics.length ||
      value.summary.drift !== value.operations.length ||
      value.summary.refusals !==
        value.diagnostics.filter((item) => item.kind === 'refuse').length ||
      total(value.summary.operationKinds) !== value.operations.length ||
      total(value.summary.checkKinds) !== value.checks.length ||
      total(value.summary.diagnosticKinds) !== value.diagnostics.length ||
      !exactCounts(value.summary.operationKinds, value.operations) ||
      !exactCounts(value.summary.checkKinds, value.checks) ||
      !exactCounts(value.summary.diagnosticKinds, value.diagnostics) ||
      (value.state === 'refused') !== value.summary.refusals > 0
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'plan summary is inconsistent' });
    }

    const unique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;
    const operationIndex = new Map<string, number>();
    const checkIds = new Set<string>();
    const diagnosticIds = new Set<string>();
    let referencesValid = true;
    value.operations.forEach((operation, index) => {
      if (operationIndex.has(operation.operationId)) referencesValid = false;
      else operationIndex.set(operation.operationId, index);
      if (
        !unique(operation.dependsOn) ||
        !unique(operation.preconditionIds) ||
        !unique(operation.requiredCheckIds)
      ) {
        referencesValid = false;
      }
    });
    for (const check of value.checks) {
      if (checkIds.has(check.checkId)) referencesValid = false;
      checkIds.add(check.checkId);
      if (!unique(check.operationIds)) referencesValid = false;
      if ('preconditionIds' in check && !unique(check.preconditionIds)) referencesValid = false;
    }
    for (const diagnostic of value.diagnostics) {
      if (diagnosticIds.has(diagnostic.diagnosticId)) referencesValid = false;
      diagnosticIds.add(diagnostic.diagnosticId);
    }
    value.operations.forEach((operation, index) => {
      if (
        operation.dependsOn.some((id) => {
          const dependencyIndex = operationIndex.get(id);
          return dependencyIndex === undefined || dependencyIndex >= index;
        }) ||
        operation.requiredCheckIds.some((id) => !checkIds.has(id))
      ) {
        referencesValid = false;
      }
    });
    for (const check of value.checks) {
      if (check.operationIds.some((id) => !operationIndex.has(id))) referencesValid = false;
    }
    const operationById = new Map(
      value.operations.map((operation) => [operation.operationId, operation]),
    );
    const groupIds = new Set(value.operations.map((operation) => operation.groupId));
    const pairIds = new Set(
      value.operations.flatMap((operation) =>
        operation.pairId === null ? [] : [operation.pairId],
      ),
    );
    const pairGroups = new Set(
      value.operations.flatMap((operation) =>
        operation.pairId === null ? [] : [`${operation.pairId}\0${operation.groupId}`],
      ),
    );
    for (const diagnostic of value.diagnostics) {
      const correlation = diagnostic.correlation;
      const operation =
        correlation.operationId === null ? undefined : operationById.get(correlation.operationId);
      const informational = diagnostic.kind === 'noop' || diagnostic.kind === 'skip';
      const warning = diagnostic.kind === 'warning';
      if (
        (informational && (diagnostic.severity !== 'info' || diagnostic.refusalClass !== null)) ||
        (warning && (diagnostic.severity !== 'warning' || diagnostic.refusalClass !== null)) ||
        (!informational &&
          !warning &&
          (diagnostic.severity !== 'error' || diagnostic.refusalClass === null)) ||
        (correlation.operationId !== null && operation === undefined) ||
        (correlation.groupId !== null && !groupIds.has(correlation.groupId)) ||
        (correlation.pairId !== null && !pairIds.has(correlation.pairId)) ||
        (correlation.pairId !== null &&
          (correlation.groupId === null ||
            !pairGroups.has(`${correlation.pairId}\0${correlation.groupId}`))) ||
        (operation !== undefined &&
          correlation.groupId !== null &&
          operation.groupId !== correlation.groupId) ||
        (operation !== undefined &&
          correlation.pairId !== null &&
          operation.pairId !== correlation.pairId)
      ) {
        referencesValid = false;
      }
    }
    if (!referencesValid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan identifiers or references are inconsistent',
      });
    }
  });

type PlanLocationV1Dto =
  | { kind: 'portable'; token: string }
  | { kind: 'machine-bound'; path: string };
type PlanSourceV1Dto =
  | {
      kind: 'portable';
      identity: { host: string; repository: string; path: string | null };
      requestedRef: string | null;
      resolvedSha: string;
      sourcePath: string;
      contentHash: string;
    }
  | { kind: 'local-dev'; path: string; contentHash: string };
type PlanLiveResourceV1Dto = {
  kind: 'live';
  skill: string;
  tool: SupportedTool;
  scope: 'user' | 'project';
  projectRoot: PlanLocationV1Dto | null;
  location: PlanLocationV1Dto;
};
type PlanResourceV1Dto =
  | { kind: 'manifest-bytes'; location: PlanLocationV1Dto }
  | { kind: 'lock'; location: PlanLocationV1Dto }
  | { kind: 'ledger'; projectRoot: PlanLocationV1Dto | null }
  | { kind: 'ledger-schema'; projectRoot: PlanLocationV1Dto | null }
  | PlanLiveResourceV1Dto
  | { kind: 'store'; contentHash: string }
  | { kind: 'project-context'; root: PlanLocationV1Dto };
type PlanImageV1Dto =
  | { kind: 'absent'; resource: PlanResourceV1Dto }
  | {
      kind: 'placement';
      resource: PlanLiveResourceV1Dto;
      classification: 'dev' | 'pinned' | 'store-linked' | 'unmanaged';
      representation: 'symlink' | 'copy' | 'other';
      linkTarget: PlanLocationV1Dto | null;
      dangling: boolean;
      source: PlanSourceV1Dto | null;
      contentHash: string | null;
    }
  | {
      kind: 'manifest';
      location: PlanLocationV1Dto;
      shape: 'canonical' | 'legacy';
      version: 1;
      byteHash: string;
      semanticHash: string;
      value: {
        version: 1;
        defaults: {
          tools: SupportedTool[] | null;
          scope: 'user' | 'project' | null;
          path: string | null;
        } | null;
        registry: { default: string | null } | null;
        skills: Array<{
          name: string;
          source: { host: string; repository: string; path: string | null };
          ref: string | null;
          tools: SupportedTool[];
          scope: 'user' | 'project';
          placement: 'symlink' | 'copy';
          path: string | null;
        }>;
      };
    }
  | {
      kind: 'lock';
      location: PlanLocationV1Dto;
      version: 1;
      canonicalHash: string;
      value: {
        version: 1;
        hashSchemaVersion: 1;
        manifestHash: string;
        skills: Array<{
          name: string;
          source: string;
          requestedRef: string | null;
          resolvedSha: string;
          sourcePath: string;
          contentHash: string;
        }>;
      };
    }
  | {
      kind: 'ledger';
      projectRoot: PlanLocationV1Dto | null;
      schemaVersion: 1 | 2;
      byteHash: string;
      semanticHash: string;
    };

export type PlanOperationV1Dto = {
  operationId: string;
  groupId: string;
  pairId: string | null;
  kind:
    | 'install'
    | 'update'
    | 'remove'
    | 'link-dev'
    | 'promote'
    | 'move-scope'
    | 'adapt'
    | 'repair'
    | 'write-manifest'
    | 'write-lock'
    | 'migrate-project-config'
    | 'migrate-ledger';
  dependsOn: string[];
  skill: string | null;
  source: PlanSourceV1Dto | null;
  tool: SupportedTool | null;
  scope: 'user' | 'project' | null;
  before: PlanImageV1Dto;
  after: PlanImageV1Dto;
  reason: { code: string; message: string };
  selectionSource: 'explicit-targets' | 'explicit-all' | 'bounded-default';
  preconditionIds: string[];
  requiredCheckIds: string[];
  reversibility:
    | { kind: 'none'; retentionResourceIds: [] }
    | {
        kind: 'reversible' | 'conditional';
        retentionResourceIds: [string, ...string[]];
      };
  mutates: { live: boolean; manifest: boolean; lock: boolean; ledger: boolean };
  conflict:
    | null
    | {
        class: 'unmanaged-target' | 'modified-managed-target' | 'destination-exists';
        normal: 'refuse';
        forced: 'backup-and-replace';
        target: PlanResourceV1Dto;
        backup: 'required';
      }
    | {
        class: 'source-changed';
        normal: 'refuse';
        forced: 'replace';
        target: PlanResourceV1Dto;
        backup: 'none';
      };
};
export type PlanCheckV1Dto =
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'source-resolution';
      source: Extract<PlanSourceV1Dto, { kind: 'portable' }>;
    }
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'capability';
      capabilityPreconditionId: string;
    }
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'content-integrity';
      source: PlanSourceV1Dto;
      expectedContentHash: string;
    }
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'verification';
      tool: SupportedTool;
      mode: 'static' | 'static+deep';
      expectedContentHash: string;
    }
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'precondition-validation';
      preconditionIds: [string, ...string[]];
    };
export interface PlanDiagnosticV1Dto {
  diagnosticId: string;
  kind: 'noop' | 'skip' | 'refuse' | 'conflict' | 'warning';
  severity: 'info' | 'warning' | 'error';
  refusalClass: 'usage' | 'state' | 'capability' | 'source' | 'permission' | null;
  affected: {
    skill: string | null;
    source:
      | {
          kind: 'portable';
          identity: { host: string; repository: string; path: string | null };
          requestedRef: string | null;
          resolvedSha: string;
          sourcePath: string;
          contentHash: string;
        }
      | { kind: 'local-dev'; path: string; contentHash: string }
      | null;
    tool: SupportedTool | null;
    scope: 'user' | 'project' | null;
    path: { kind: 'portable'; token: string } | { kind: 'machine-bound'; path: string } | null;
  };
  correlation: { groupId: string | null; pairId: string | null; operationId: string | null };
  reason: { code: string; message: string };
  selectionSource: 'explicit-targets' | 'explicit-all' | 'bounded-default';
}
export interface PlanV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.plan-report';
  command: 'plan';
  state: 'ready' | 'refused';
  artifactPair: {
    manifestPath: string;
    lockPath: string;
    lockSource: 'explicit' | 'sibling';
    selectionSource: 'explicit' | 'discovered-project' | 'project-default' | 'user-default';
  };
  project: { effectiveCwd: string; root: string | null; identity: string | null };
  options: { locked: boolean; prune: boolean; check: boolean };
  selection: {
    selectionSource: 'explicit-targets' | 'explicit-all' | 'bounded-default';
    selectionOutcome: 'selected' | 'filter-noop';
    requestedTools: SupportedTool[];
    requestedScope: 'user' | 'project' | null;
    skills: string[];
    tools: SupportedTool[];
    scopes: ('user' | 'project')[];
  };
  operations: PlanOperationV1Dto[];
  checks: PlanCheckV1Dto[];
  diagnostics: PlanDiagnosticV1Dto[];
  summary: {
    operations: number;
    checks: number;
    diagnostics: number;
    drift: number;
    refusals: number;
    operationKinds: Record<
      | 'install'
      | 'update'
      | 'remove'
      | 'link-dev'
      | 'promote'
      | 'move-scope'
      | 'adapt'
      | 'repair'
      | 'write-manifest'
      | 'write-lock'
      | 'migrate-project-config'
      | 'migrate-ledger',
      number
    >;
    checkKinds: Record<
      | 'source-resolution'
      | 'capability'
      | 'content-integrity'
      | 'verification'
      | 'precondition-validation',
      number
    >;
    diagnosticKinds: Record<'noop' | 'skip' | 'refuse' | 'conflict' | 'warning', number>;
  };
  savedOutput: {
    path: string;
    disposition: 'created' | 'replaced';
    mode: '0600';
    portability: 'portable' | 'machine-bound';
  } | null;
}

export const planV1Codec = createJsonWireCodec(
  {
    id: 'plan-report',
    version: 1,
    wireKind: 'skillsmith.plan-report',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  PlanV1Schema,
) as unknown as WireCodec<'plan-report', 1, PlanV1Dto>;
