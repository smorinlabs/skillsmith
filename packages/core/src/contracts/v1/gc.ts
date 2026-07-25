import { z } from 'zod';
import { containsSensitiveMaterial } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodec } from '../types.ts';

export interface GcProjectV1Dto {
  readonly root: string;
  readonly current: boolean;
  readonly existing: boolean;
  readonly registered: boolean;
  readonly requested: boolean;
  readonly action: 'none' | 'forget-project';
  readonly outcome: 'protected' | 'planned' | 'forgotten' | 'refused';
  readonly reason: string | null;
}

export interface GcObjectV1Dto {
  readonly id: string;
  readonly kind: 'store' | 'adapted-overlay';
  readonly path: string;
  readonly contentHash: string;
  readonly modifiedAt: number;
  readonly logicalBytes: number;
  readonly protection: readonly Readonly<{
    readonly kind:
      | 'ledger'
      | 'project-registration'
      | 'live-placement'
      | 'logical-transaction'
      | 'legacy-journal'
      | 'history'
      | 'adapted-overlay';
    readonly sourceId: string;
  }>[];
  readonly ageEligible: boolean;
  readonly outcome:
    | 'protected'
    | 'age-filtered'
    | 'eligible'
    | 'reclaimed'
    | 'already-absent'
    | 'refused';
  readonly reason: string | null;
}

export interface GcActionV1Dto {
  readonly actionId: string;
  readonly kind: 'migrate-ledger' | 'forget-project' | 'reclaim-store';
  readonly target: string;
  readonly logicalBytes: number;
  readonly dependencyIds: readonly string[];
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'protected-skip';
  readonly reason: string | null;
}

export interface GcSummaryV1Dto {
  readonly observedItems: number;
  readonly protectedItems: number;
  readonly ageFilteredItems: number;
  readonly eligibleItems: number | null;
  readonly eligibleBytes: number | null;
  readonly forgottenProjects: number;
  readonly alreadyAbsentItems: number;
  readonly reclaimedItems: number;
  readonly reclaimedBytes: number;
  readonly refusedItems: number;
  readonly failedItems: number;
}

export interface GcReportV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.gc';
  readonly command: 'gc';
  readonly mode: 'dry-run' | 'execute';
  readonly state: 'planned' | 'no-op' | 'refused' | 'completed' | 'partial';
  readonly planId: string | null;
  readonly selectionSource: 'bounded-default';
  readonly project: {
    readonly effectiveCwd: string;
    readonly root: string;
    readonly identity: string;
  };
  readonly migration: {
    readonly sourceVersion: 1 | 2 | null;
    readonly action: 'none' | 'migrate-ledger';
    readonly outcome: 'not-required' | 'planned' | 'succeeded';
  };
  readonly olderThan: null | {
    readonly input: string;
    readonly milliseconds: number;
    readonly cutoff: number;
  };
  readonly approval: {
    readonly required: boolean;
    readonly outcome: 'not-required' | 'pending' | 'approved' | 'refused' | 'cancelled';
  };
  readonly recovery: {
    readonly state: 'none' | 'pending' | 'completed' | 'refused';
    readonly phase:
      | 'approved'
      | 'migration-complete'
      | 'forget-complete'
      | 'reclaiming'
      | 'complete'
      | 'initial-staging'
      | null;
  };
  readonly projects: readonly GcProjectV1Dto[];
  readonly objects: readonly GcObjectV1Dto[];
  readonly actions: readonly GcActionV1Dto[];
  readonly results: readonly GcActionV1Dto[];
  readonly checks: readonly Readonly<{
    readonly code: string;
    readonly outcome: 'passed' | 'failed';
    readonly message: string;
  }>[];
  readonly diagnostics: readonly Readonly<{
    readonly code: string;
    readonly message: string;
    readonly path: string | null;
  }>[];
  readonly summary: GcSummaryV1Dto;
}

const Count = z.number().int().nonnegative();
const Id = z.string().min(1);
const HexId = z.string().regex(/^[0-9a-f]{64}$/u);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const ProtectionKind = z.enum([
  'ledger',
  'project-registration',
  'live-placement',
  'logical-transaction',
  'legacy-journal',
  'history',
  'adapted-overlay',
]);
const ProjectSchema = z
  .object({
    root: Id,
    current: z.boolean(),
    existing: z.boolean(),
    registered: z.boolean(),
    requested: z.boolean(),
    action: z.enum(['none', 'forget-project']),
    outcome: z.enum(['protected', 'planned', 'forgotten', 'refused']),
    reason: z.string().nullable(),
  })
  .strict();
const ObjectSchema = z
  .object({
    id: HexId,
    kind: z.enum(['store', 'adapted-overlay']),
    path: Id,
    contentHash: Digest,
    modifiedAt: z.number().finite(),
    logicalBytes: Count,
    protection: z.array(z.object({ kind: ProtectionKind, sourceId: Id }).strict()),
    ageEligible: z.boolean(),
    outcome: z.enum([
      'protected',
      'age-filtered',
      'eligible',
      'reclaimed',
      'already-absent',
      'refused',
    ]),
    reason: z.string().nullable(),
  })
  .strict();
const ActionSchema = z
  .object({
    actionId: HexId,
    kind: z.enum(['migrate-ledger', 'forget-project', 'reclaim-store']),
    target: Id,
    logicalBytes: Count,
    dependencyIds: z.array(Id),
    outcome: z.enum(['planned', 'succeeded', 'failed', 'protected-skip']),
    reason: z.string().nullable(),
  })
  .strict();
const SummarySchema = z
  .object({
    observedItems: Count,
    protectedItems: Count,
    ageFilteredItems: Count,
    eligibleItems: Count.nullable(),
    eligibleBytes: Count.nullable(),
    forgottenProjects: Count,
    alreadyAbsentItems: Count,
    reclaimedItems: Count,
    reclaimedBytes: Count,
    refusedItems: Count,
    failedItems: Count,
  })
  .strict();
const containsForbiddenOutput = (input: unknown): boolean => {
  if (typeof input === 'string') {
    return containsSensitiveMaterial(input) || /(?:https?|ssh):\/\//iu.test(input);
  }
  if (Array.isArray(input)) return input.some(containsForbiddenOutput);
  if (input === null || typeof input !== 'object') return false;
  return Object.values(input).some(containsForbiddenOutput);
};
const GcReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.gc'),
    command: z.literal('gc'),
    mode: z.enum(['dry-run', 'execute']),
    state: z.enum(['planned', 'no-op', 'refused', 'completed', 'partial']),
    planId: HexId.nullable(),
    selectionSource: z.literal('bounded-default'),
    project: z.object({ effectiveCwd: Id, root: Id, identity: Id }).strict(),
    migration: z
      .object({
        sourceVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
        action: z.enum(['none', 'migrate-ledger']),
        outcome: z.enum(['not-required', 'planned', 'succeeded']),
      })
      .strict(),
    olderThan: z
      .object({ input: Id, milliseconds: Count, cutoff: z.number().finite() })
      .strict()
      .nullable(),
    approval: z
      .object({
        required: z.boolean(),
        outcome: z.enum(['not-required', 'pending', 'approved', 'refused', 'cancelled']),
      })
      .strict(),
    recovery: z
      .object({
        state: z.enum(['none', 'pending', 'completed', 'refused']),
        phase: z
          .enum([
            'approved',
            'migration-complete',
            'forget-complete',
            'reclaiming',
            'complete',
            'initial-staging',
          ])
          .nullable(),
      })
      .strict(),
    projects: z.array(ProjectSchema),
    objects: z.array(ObjectSchema),
    actions: z.array(ActionSchema),
    results: z.array(ActionSchema),
    checks: z.array(
      z.object({ code: Id, outcome: z.enum(['passed', 'failed']), message: z.string() }).strict(),
    ),
    diagnostics: z.array(
      z.object({ code: Id, message: z.string(), path: z.string().nullable() }).strict(),
    ),
    summary: SummarySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (containsForbiddenOutput(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'gc reports cannot contain source URLs or credential material',
      });
    }
  });

export const gcV1Codec = createJsonWireCodec(
  {
    id: 'gc',
    version: 1,
    wireKind: 'skillsmith.gc',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  GcReportSchema,
) as unknown as WireCodec<'gc', 1, GcReportV1Dto>;
