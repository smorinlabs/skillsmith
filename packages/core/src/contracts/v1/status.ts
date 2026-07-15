import { z } from 'zod';
import {
  STATUS_FACT_AUTHORITY,
  STATUS_FACT_CODES,
  STATUS_FACT_IMPACTS,
  STATUS_FACT_SUBJECTS,
} from '../../status/types.ts';
import type {
  StatusArtifactRelationship,
  StatusDesiredState,
  StatusEntry,
  StatusFact,
  StatusJournalState,
  StatusLedgerObservation,
  StatusLedgerSummary,
  StatusLegacyExpectedNode,
  StatusLegacyObservedNode,
  StatusLegacyStructuralCheck,
  StatusLiveObservation,
  StatusLockSummary,
  StatusLockedState,
  StatusManifestSummary,
  StatusPlacement,
  StatusPortableLockFact,
  StatusRecordedContentCheck,
  StatusRecordedRevisionCheck,
  StatusReport,
  StatusRetentionRequirement,
  StatusShadow,
  StatusUnmatchedJournal,
} from '../../status/types.ts';
import { createJsonWireCodec } from '../codec.ts';

const ScopeSchema = z.enum(['system', 'user', 'project', 'managed']);
const SupportedToolSchema = z.enum(['claude-code', 'codex', 'kilo-code', 'opencode']);
const VerificationSchema = z.enum(['passed', 'warned', 'skipped', 'unrecorded']);
const SourceIdentitySchema = z
  .object({ host: z.string(), repository: z.string(), path: z.string().nullable() })
  .strict();

const SelectionSchema = z.union([
  z
    .object({
      source: z.enum(['explicit-targets', 'bounded-default']),
      targets: z.array(z.string()),
      tools: z.array(z.string()),
      toolSource: z.enum(['explicit', 'effective-config', 'unbounded-default']),
      scopes: z.array(ScopeSchema),
      scopeSource: z.enum(['explicit', 'unbounded-default']),
      outcome: z.literal('selected'),
      reason: z.null(),
    })
    .strict(),
  z
    .object({
      source: z.enum(['explicit-targets', 'bounded-default']),
      targets: z.array(z.string()),
      tools: z.array(z.string()),
      toolSource: z.enum(['explicit', 'effective-config', 'unbounded-default']),
      scopes: z.array(ScopeSchema),
      scopeSource: z.enum(['explicit', 'unbounded-default']),
      outcome: z.literal('filter-noop'),
      reason: z.literal('valid selection was reduced to zero by active filters'),
    })
    .strict(),
]);

const ContextSchema = z
  .object({
    effectiveCwd: z.string(),
    projectRoot: z.string().nullable(),
    projectIdentity: z.string().nullable(),
    projectSource: z.enum(['shared-project', 'explicit-non-git']).nullable(),
  })
  .strict();

const ManifestSummarySchema = z.union([
  z.object({ state: z.literal('absent') }).strict(),
  z
    .object({
      state: z.literal('present'),
      sourceVersion: z.literal('legacy'),
      currentVersion: z.literal(1),
      byteRevision: z.string(),
      semanticRevision: z.string(),
      canonical: z.literal(false),
      migrationPending: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal('present'),
      sourceVersion: z.literal(1),
      currentVersion: z.literal(1),
      byteRevision: z.string(),
      semanticRevision: z.string(),
      canonical: z.boolean(),
      migrationPending: z.literal(false),
    })
    .strict(),
]);

const LockSummarySchema = z.union([
  z.object({ state: z.literal('absent') }).strict(),
  z
    .object({
      state: z.literal('present'),
      sourceVersion: z.literal(1),
      currentVersion: z.literal(1),
      byteRevision: z.string(),
      semanticRevision: z.string(),
      canonical: z.literal(true),
      migrationPending: z.literal(false),
    })
    .strict(),
]);

const PortableLockFactSchema = z.union([
  z
    .object({
      reason: z.literal('missing-entry'),
      name: z.string(),
      field: z.literal('skills.name'),
    })
    .strict(),
  z
    .object({ reason: z.literal('extra-entry'), name: z.string(), field: z.literal('skills.name') })
    .strict(),
  z
    .object({ reason: z.literal('manifest-hash-mismatch'), field: z.literal('manifest_hash') })
    .strict(),
  z
    .object({ reason: z.literal('source-mismatch'), name: z.string(), field: z.literal('source') })
    .strict(),
  z
    .object({
      reason: z.literal('requested-ref-mismatch'),
      name: z.string(),
      field: z.literal('requested_ref'),
    })
    .strict(),
  z
    .object({
      reason: z.literal('source-path-mismatch'),
      name: z.string(),
      field: z.literal('source_path'),
    })
    .strict(),
]);

const ArtifactRelationshipSchema = z.union([
  z.object({ state: z.enum(['none', 'missing-lock', 'lock-only', 'current']) }).strict(),
  z
    .object({
      state: z.literal('incomplete'),
      missingNames: z.array(z.string()),
      facts: z.array(PortableLockFactSchema),
    })
    .strict()
    .refine(
      (value) =>
        value.facts.length > 0 &&
        value.facts.every(
          (fact) => fact.reason === 'missing-entry' || fact.reason === 'extra-entry',
        ),
      'incomplete relationship requires only entry facts',
    ),
  z
    .object({ state: z.literal('stale'), facts: z.array(PortableLockFactSchema) })
    .strict()
    .refine(
      (value) =>
        value.facts.length > 0 && value.facts.every((fact) => fact.reason !== 'missing-entry'),
      'stale relationship requires non-missing facts',
    ),
]);

const ArtifactsSchema = z.union([
  z.object({ state: z.literal('unselected'), reason: z.literal('live-only-scope') }).strict(),
  z
    .object({
      state: z.literal('selected'),
      source: z.enum(['explicit', 'discovered-project', 'project-default', 'user-default']),
      manifestPath: z.string(),
      lockPath: z.string(),
      lockSource: z.enum(['sibling', 'explicit']),
      manifest: ManifestSummarySchema,
      lock: LockSummarySchema,
      relationship: ArtifactRelationshipSchema,
    })
    .strict(),
]);

const LedgerSummarySchema = z.union([
  z
    .object({
      state: z.literal('absent'),
      path: z.string(),
      sourceVersion: z.null(),
      currentVersion: z.literal(2),
      migrationPending: z.literal(false),
    })
    .strict(),
  z
    .object({
      state: z.literal('present'),
      path: z.string(),
      sourceVersion: z.literal(1),
      currentVersion: z.literal(2),
      byteRevision: z.string(),
      semanticRevision: z.string(),
      migrationPending: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal('present'),
      path: z.string(),
      sourceVersion: z.literal(2),
      currentVersion: z.literal(2),
      byteRevision: z.string(),
      semanticRevision: z.string(),
      migrationPending: z.literal(false),
    })
    .strict(),
]);

const DesiredStateSchema = z
  .object({
    name: z.string(),
    source: SourceIdentitySchema,
    ref: z.string().nullable(),
    tools: z.array(SupportedToolSchema),
    scope: z.enum(['user', 'project']),
    placement: z.enum(['symlink', 'copy']),
    path: z.string().nullable(),
  })
  .strict();

const LockedStateSchema = z
  .object({
    name: z.string(),
    source: z.string(),
    requestedRef: z.string().nullable(),
    resolvedSha: z.string(),
    sourcePath: z.string(),
    contentHash: z.string(),
  })
  .strict();

const LedgerObservationSchema = z
  .object({
    placementPath: z.string(),
    mode: z.enum(['dev', 'pinned']),
    source: SourceIdentitySchema.nullable(),
    requestedRef: z.string().nullable(),
    resolvedRevision: z.string().nullable(),
    contentHash: z.string().nullable(),
    verification: VerificationSchema,
    placement: z.enum(['symlink', 'copy']).nullable(),
  })
  .strict();

const LiveObservationSchema = z
  .object({
    path: z.string(),
    realpath: z.string().nullable(),
    nodeKind: z.enum(['directory', 'symlink', 'file', 'other']),
    linkTarget: z.string().nullable(),
    skillFile: z.enum(['valid', 'missing', 'invalid']),
  })
  .strict();

const presence = <T extends z.ZodTypeAny>(value: T) =>
  z.union([
    z.object({ state: z.literal('absent') }).strict(),
    z.object({ state: z.literal('present'), value }).strict(),
  ]);

const ShadowSchema = z.union([
  z.object({ state: z.literal('none') }).strict(),
  z.object({ state: z.literal('winner'), shadows: z.array(z.string()) }).strict(),
  z.object({ state: z.literal('shadowed'), winner: z.string() }).strict(),
  z.object({ state: z.literal('duplicate'), winner: z.null() }).strict(),
]);

const RevisionValueSchema = z
  .object({ kind: z.enum(['artifact-bytes', 'resource']), digest: z.string() })
  .strict();
const RecordedRevisionSchema = z
  .union([
    z
      .object({
        state: z.enum(['satisfied', 'mismatch']),
        expected: RevisionValueSchema,
        observed: RevisionValueSchema,
      })
      .strict(),
    z
      .object({
        state: z.enum(['missing', 'unverified']),
        expected: RevisionValueSchema,
        observed: z.null(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.observed !== null && value.expected.kind !== value.observed.kind) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'revision kinds must agree' });
    }
    if (value.observed === null) return;
    const equal =
      value.expected.kind === value.observed.kind &&
      value.expected.digest === value.observed.digest;
    if ((value.state === 'satisfied') !== equal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'revision state must describe expected/observed equality',
      });
    }
  });

const RecordedContentSchema = z
  .union([
    z
      .object({
        state: z.enum(['satisfied', 'mismatch']),
        domain: z.enum(['manifest-bytes', 'lock-canonical', 'source-content', 'resource']),
        expected: z.string(),
        observed: z.string(),
      })
      .strict(),
    z
      .object({
        state: z.enum(['missing', 'unverified']),
        domain: z.enum(['manifest-bytes', 'lock-canonical', 'source-content', 'resource']),
        expected: z.string(),
        observed: z.null(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.observed === null) return;
    if ((value.state === 'satisfied') !== (value.expected === value.observed)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'content state must describe expected/observed equality',
      });
    }
  });

const UnrecordedCheckSchema = z
  .object({
    state: z.literal('not-recorded'),
    domain: z.null(),
    expected: z.null(),
    observed: z.null(),
  })
  .strict();
const LegacyExpectedNodeSchema = z.union([
  z.object({ kind: z.literal('absent'), linkTarget: z.null() }).strict(),
  z.object({ kind: z.literal('directory'), linkTarget: z.null() }).strict(),
  z.object({ kind: z.literal('symlink'), linkTarget: z.string().nullable() }).strict(),
]);
const LegacyObservedNodeSchema = z.union([
  z.object({ kind: z.literal('absent'), linkTarget: z.null() }).strict(),
  z.object({ kind: z.literal('directory'), linkTarget: z.null() }).strict(),
  z.object({ kind: z.literal('symlink'), linkTarget: z.string() }).strict(),
  z.object({ kind: z.enum(['file', 'other']), linkTarget: z.null() }).strict(),
]);
const LegacyStructuralSchema = z
  .union([
    z
      .object({
        state: z.enum(['satisfied', 'mismatch']),
        expected: LegacyExpectedNodeSchema,
        observed: LegacyObservedNodeSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal('missing'),
        expected: LegacyExpectedNodeSchema,
        observed: z.object({ kind: z.literal('absent'), linkTarget: z.null() }).strict(),
      })
      .strict()
      .refine((value) => value.expected.kind !== 'absent', 'missing legacy node must be expected'),
    z
      .object({
        state: z.literal('unverified'),
        expected: LegacyExpectedNodeSchema,
        observed: z.null(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.observed === null) return;
    const equal =
      value.expected.kind === value.observed.kind &&
      !(value.expected.kind === 'symlink' && value.expected.linkTarget === null) &&
      value.expected.linkTarget === value.observed.linkTarget;
    if ((value.state === 'satisfied') !== equal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'structural state must describe expected/observed equality',
      });
    }
  });

type RetentionCheckState = 'satisfied' | 'missing' | 'mismatch' | 'unverified';

const aggregateRetentionState = (
  states: readonly (RetentionCheckState | 'not-recorded')[],
): RetentionCheckState => {
  if (states.includes('missing')) return 'missing';
  if (states.includes('mismatch')) return 'mismatch';
  if (states.includes('unverified')) return 'unverified';
  return 'satisfied';
};

const RetentionCommon = {
  path: z.string(),
  pathState: z.enum(['satisfied', 'missing', 'unverified']),
  state: z.enum(['satisfied', 'missing', 'mismatch', 'unverified']),
} as const;
const LogicalRetentionSchema = z
  .union([
    z
      .object({
        format: z.literal('logical'),
        resourceId: z.string(),
        retainUntil: z.string().nullable(),
        repositoryRevision: RecordedRevisionSchema,
        contentHash: RecordedContentSchema,
        role: z.literal('backup'),
        sourceRole: z.enum(['live', 'manifest', 'lock', 'ledger']),
        ...RetentionCommon,
      })
      .strict(),
    z
      .object({
        format: z.literal('logical'),
        resourceId: z.string(),
        retainUntil: z.string().nullable(),
        repositoryRevision: RecordedRevisionSchema,
        contentHash: RecordedContentSchema,
        role: z.literal('store'),
        sourceRole: z.null(),
        ...RetentionCommon,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const expectedDomain =
      value.role === 'store' || value.sourceRole === 'live'
        ? 'source-content'
        : value.sourceRole === 'manifest'
          ? 'manifest-bytes'
          : value.sourceRole === 'lock'
            ? 'lock-canonical'
            : 'resource';
    if (value.contentHash.domain !== expectedDomain) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'retention content domain mismatch',
      });
    }
    if (
      value.pathState === 'missing' &&
      (value.repositoryRevision.state !== 'missing' || value.contentHash.state !== 'missing')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'missing logical path requires missing checks',
      });
    }
    if (
      value.pathState === 'unverified' &&
      (value.repositoryRevision.state !== 'unverified' || value.contentHash.state !== 'unverified')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unverified logical path requires unverified checks',
      });
    }
    if (
      value.pathState === 'satisfied' &&
      (value.repositoryRevision.state === 'missing' || value.contentHash.state === 'missing')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'satisfied logical path cannot have missing checks',
      });
    }
    if (
      value.pathState !== 'satisfied' &&
      (value.repositoryRevision.observed !== null || value.contentHash.observed !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'observed logical checks require a satisfied path',
      });
    }
    const aggregate = aggregateRetentionState([
      value.pathState,
      value.repositoryRevision.state,
      value.contentHash.state,
    ]);
    if (value.state !== aggregate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'retention state must equal its aggregate check state',
      });
    }
  });
const LegacyRetentionSchema = z
  .union([
    z
      .object({
        format: z.literal('legacy-pair'),
        resourceId: z.null(),
        retainUntil: z.null(),
        structural: LegacyStructuralSchema,
        repositoryRevision: UnrecordedCheckSchema,
        contentHash: z.union([RecordedContentSchema, UnrecordedCheckSchema]),
        role: z.literal('backup'),
        sourceRole: z.literal('live'),
        ...RetentionCommon,
      })
      .strict(),
    z
      .object({
        format: z.literal('legacy-pair'),
        resourceId: z.null(),
        retainUntil: z.null(),
        structural: LegacyStructuralSchema,
        repositoryRevision: UnrecordedCheckSchema,
        contentHash: z.union([RecordedContentSchema, UnrecordedCheckSchema]),
        role: z.literal('store'),
        sourceRole: z.null(),
        ...RetentionCommon,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const contentRecorded = value.contentHash.state !== 'not-recorded';
    if (contentRecorded && value.structural.expected.kind !== 'directory') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recorded legacy content requires a directory expectation',
      });
    }
    const expectedPathState =
      value.structural.state === 'missing'
        ? 'missing'
        : value.structural.state === 'unverified'
          ? 'unverified'
          : 'satisfied';
    if (value.pathState !== expectedPathState) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'legacy structural state must equal path state',
      });
    }
    if (contentRecorded) {
      if (value.contentHash.domain !== 'source-content') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'legacy retention content must use the source-content domain',
        });
      }
      if (
        (value.pathState === 'missing' && value.contentHash.state !== 'missing') ||
        (value.pathState === 'unverified' && value.contentHash.state !== 'unverified') ||
        (value.pathState === 'satisfied' && value.contentHash.state === 'missing')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'legacy content state must agree with its path state',
        });
      }
      if (value.contentHash.observed !== null && value.pathState !== 'satisfied') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'observed legacy content requires a satisfied path',
        });
      }
    }
    const aggregate = aggregateRetentionState([
      value.pathState,
      value.structural.state,
      value.repositoryRevision.state,
      value.contentHash.state,
    ]);
    if (value.state !== aggregate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'retention state must equal its aggregate check state',
      });
    }
  });
const RetentionSchema = z.union([LogicalRetentionSchema, LegacyRetentionSchema]);

const LogicalOperationSchema = z.enum([
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
const LegacyOperationSchema = z.enum(['promote', 'dev', 'rollback', 'install', 'uninstall']);
const EligibilitySchema = z.enum([
  'eligible',
  'not-reversible',
  'retention-incomplete',
  'retention-missing',
  'retention-mismatch',
  'retention-unverified',
]);
const PendingJournalBase = {
  state: z.literal('pending'),
  transactionId: z.string(),
  phase: z.enum(['prepared', 'staged', 'backed-up', 'live']),
  before: z.enum(['dev', 'pinned', 'absent', 'multi-resource']),
  retention: z.array(RetentionSchema),
  abortEligibility: EligibilitySchema,
  remediation: z
    .object({
      resume: z.literal('rerun the same operation'),
      abort: z.array(z.string()).nullable(),
    })
    .strict(),
} as const;
const CommittedJournalBase = {
  state: z.literal('committed'),
  transactionId: z.string(),
  phase: z.literal('committed'),
  before: z.enum(['dev', 'pinned', 'absent', 'multi-resource']),
  retention: z.array(RetentionSchema),
  reverseEligibility: EligibilitySchema,
  remediation: z.object({ reverse: z.array(z.string()).nullable() }).strict(),
} as const;
const JournalSchema = z
  .union([
    z.object({ state: z.literal('none') }).strict(),
    z
      .object({
        ...PendingJournalBase,
        format: z.literal('logical'),
        operation: LogicalOperationSchema,
      })
      .strict(),
    z
      .object({
        ...PendingJournalBase,
        format: z.literal('legacy-pair'),
        operation: LegacyOperationSchema,
      })
      .strict(),
    z
      .object({
        ...CommittedJournalBase,
        format: z.literal('logical'),
        operation: LogicalOperationSchema,
      })
      .strict(),
    z
      .object({
        ...CommittedJournalBase,
        format: z.literal('legacy-pair'),
        operation: LegacyOperationSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.state === 'none') return;
    if (value.retention.some((retention) => retention.format !== value.format)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'journal and retention formats must agree',
      });
    }

    const eligibility =
      value.state === 'pending' ? value.abortEligibility : value.reverseEligibility;
    const remediation =
      value.state === 'pending' ? value.remediation.abort : value.remediation.reverse;
    const aggregate = aggregateRetentionState(value.retention.map((retention) => retention.state));
    const expectedAggregate = eligibility.startsWith('retention-')
      ? eligibility.slice('retention-'.length)
      : null;
    const isLogicalPreRetentionGate =
      value.state === 'pending' &&
      value.format === 'logical' &&
      (value.before === 'absent' ||
        ((value.phase === 'prepared' || value.phase === 'staged') &&
          (value.before === 'dev' || value.before === 'pinned')));

    if (eligibility === 'eligible' && aggregate !== 'satisfied' && !isLogicalPreRetentionGate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'eligible journal requires satisfied retention',
      });
    }
    if (
      (expectedAggregate === 'missing' ||
        expectedAggregate === 'mismatch' ||
        expectedAggregate === 'unverified') &&
      aggregate !== expectedAggregate
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'retention eligibility must equal aggregate retention state',
      });
    }
    if (value.format === 'logical') {
      const resourceIds = value.retention.map((retention) => retention.resourceId);
      if (new Set(resourceIds).size !== resourceIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'logical journal retention resource IDs must be unique',
        });
      }
      if (value.before === 'multi-resource' && eligibility !== 'not-reversible') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'multi-resource logical journal must be not-reversible',
        });
      }
      if (value.state === 'pending' && value.before === 'absent' && eligibility !== 'eligible') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'absent-before pending journal must be eligible',
        });
      }
      if (
        value.state === 'pending' &&
        (value.phase === 'prepared' || value.phase === 'staged') &&
        (value.before === 'dev' || value.before === 'pinned') &&
        eligibility !== 'eligible' &&
        eligibility !== 'not-reversible'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'early pending journal must use an intent-gate eligibility',
        });
      }
    }
    if (value.format === 'legacy-pair') {
      if (value.before === 'multi-resource') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'legacy journal cannot have a multi-resource before state',
        });
      }
      if (eligibility === 'retention-incomplete') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'legacy journal cannot have incomplete retention',
        });
      }
      if (value.retention.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'legacy journal requires exactly one retention record',
        });
      }
      const retention = value.retention[0];
      if (retention?.format === 'legacy-pair') {
        const committedPinnedDev =
          value.state === 'committed' && value.operation === 'dev' && value.before === 'pinned';
        if (
          (retention.role === 'store' && !committedPinnedDev) ||
          (committedPinnedDev && retention.role === 'backup' && eligibility !== 'not-reversible')
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'legacy retention role must match the exact reversal resource',
          });
        }

        const expectedKind = retention.structural.expected.kind;
        const preBackupPhase =
          value.state === 'pending' && (value.phase === 'prepared' || value.phase === 'staged');
        const mayRetainAtLive =
          value.state === 'pending' &&
          value.phase === 'backed-up' &&
          (value.before === 'dev' || value.before === 'pinned');
        const mustExpectAbsent = value.before === 'absent' || preBackupPhase;
        if (
          (mustExpectAbsent && expectedKind !== 'absent') ||
          (!mustExpectAbsent && !mayRetainAtLive && expectedKind === 'absent') ||
          (value.before === 'dev' && expectedKind === 'directory') ||
          (retention.structural.expected.kind === 'symlink' &&
            retention.structural.expected.linkTarget === null &&
            value.before !== 'pinned') ||
          (committedPinnedDev && retention.role === 'store' && expectedKind !== 'directory')
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'legacy structural expectation must match phase and before state',
          });
        }

        const aggregateEligibility =
          aggregate === 'satisfied' ? 'eligible' : (`retention-${aggregate}` as const);
        const missingPinnedSymlinkTarget =
          value.before === 'pinned' &&
          retention.structural.expected.kind === 'symlink' &&
          retention.structural.expected.linkTarget === null;
        if (value.state === 'committed') {
          const reversibleCombination =
            (value.operation === 'uninstall' && value.before !== 'absent') ||
            (value.operation === 'promote' && value.before === 'dev') ||
            committedPinnedDev;
          const requiresMissingSourceFallback =
            (value.operation === 'uninstall' && missingPinnedSymlinkTarget) ||
            (committedPinnedDev && retention.role === 'backup');
          const expectedEligibility = requiresMissingSourceFallback
            ? 'not-reversible'
            : reversibleCombination
              ? aggregateEligibility
              : 'not-reversible';
          if (eligibility !== expectedEligibility) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'committed legacy eligibility must match operation and retained state',
            });
          }
        } else {
          const mayFailEarlyIntentGate =
            (value.phase === 'prepared' || value.phase === 'staged') &&
            (value.before === 'dev' || value.before === 'pinned');
          const requiresMissingSourceFallback =
            (value.phase === 'backed-up' || value.phase === 'live') && missingPinnedSymlinkTarget;
          if (requiresMissingSourceFallback) {
            if (eligibility !== 'not-reversible') {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'pending legacy unrecorded symlink target must be not-reversible',
              });
            }
          } else if (!(mayFailEarlyIntentGate && eligibility === 'not-reversible')) {
            if (eligibility !== aggregateEligibility) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'pending legacy eligibility must match its compatibility gate',
              });
            }
          }
        }
      }
    }
    if ((eligibility === 'eligible') !== (remediation !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'remediation argv exists if and only if the journal is eligible',
      });
    }
  });

const FactSchema = z
  .object({
    code: z.enum(STATUS_FACT_CODES),
    impact: z.enum(STATUS_FACT_IMPACTS),
    subject: z.enum(STATUS_FACT_SUBJECTS),
    expected: z.string().nullable(),
    actual: z.string().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const authority = STATUS_FACT_AUTHORITY[value.code];
    if (value.subject !== authority.subject || value.impact !== authority.impact) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'fact authority mismatch' });
    }
  });

const PlacementSchema = z
  .object({
    identity: z
      .object({
        tool: z.string(),
        scope: ScopeSchema,
        projectIdentity: z.string().nullable(),
        path: z.string().nullable(),
      })
      .strict(),
    ledger: presence(LedgerObservationSchema),
    live: presence(LiveObservationSchema),
    classification: z.enum(['dev', 'pinned', 'store-linked', 'unmanaged', 'broken', 'absent']),
    brokenReason: z
      .enum([
        'ledger-recorded-absence',
        'dangling-link',
        'wrong-node-kind',
        'skill-file-missing',
        'skill-file-invalid',
        'ledger-mode-contradiction',
      ])
      .nullable(),
    verification: VerificationSchema,
    shadow: ShadowSchema,
    journal: JournalSchema,
    facts: z.array(FactSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.classification === 'broken') !== (value.brokenReason !== null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'broken reason/class mismatch' });
    }
    if (value.journal.state === 'none') return;

    if (value.identity.path === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'journal placement requires a canonical path',
      });
      return;
    }

    const eligibility =
      value.journal.state === 'pending'
        ? value.journal.abortEligibility
        : value.journal.reverseEligibility;
    const remediation =
      value.journal.state === 'pending'
        ? value.journal.remediation.abort
        : value.journal.remediation.reverse;
    if (eligibility === 'eligible' && remediation !== null) {
      const expected = [
        'skillsmith',
        'undo',
        value.identity.path,
        '--tool',
        value.identity.tool,
        '--scope',
        value.identity.scope,
      ];
      if (
        remediation.length !== expected.length ||
        remediation.some((argument, index) => argument !== expected[index])
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'eligible remediation argv must identify the exact placement',
        });
      }
    }

    const retentionFactRank = new Map(
      [
        'retention-missing',
        'retention-mismatch',
        'retention-unverified',
        'retention-incomplete',
      ].map((code, index) => [code, index]),
    );
    const actualRetentionFacts = value.facts
      .filter((fact) => fact.code.startsWith('retention-'))
      .map((fact) => ({ code: fact.code, expected: fact.expected, actual: fact.actual }));
    const expectedRetentionFacts = (
      eligibility === 'retention-incomplete'
        ? [{ code: 'retention-incomplete', expected: 'complete', actual: 'incomplete' }]
        : eligibility.startsWith('retention-')
          ? value.journal.retention
              .filter((requirement) => requirement.state !== 'satisfied')
              .map((requirement) => ({
                code: `retention-${requirement.state}`,
                expected: JSON.stringify([requirement.resourceId, requirement.path]),
                actual: requirement.state,
              }))
          : []
    ).sort(
      (left, right) =>
        (retentionFactRank.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
          (retentionFactRank.get(right.code) ?? Number.MAX_SAFE_INTEGER) ||
        (left.expected < right.expected ? -1 : left.expected > right.expected ? 1 : 0) ||
        (left.actual < right.actual ? -1 : left.actual > right.actual ? 1 : 0),
    );
    if (JSON.stringify(actualRetentionFacts) !== JSON.stringify(expectedRetentionFacts)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'retention facts must exactly describe every failed requirement',
      });
    }
  });

const EntrySchema = z
  .object({
    name: z.string(),
    desired: presence(DesiredStateSchema),
    locked: presence(LockedStateSchema),
    placements: z.array(PlacementSchema),
    facts: z.array(FactSchema),
    convergence: z.enum(['converged', 'drift']),
  })
  .strict();

const UnmatchedJournalSchema = z.union([
  z
    .object({
      transactionId: z.string(),
      phase: z.enum(['prepared', 'staged', 'backed-up', 'live', 'committed']),
      reason: z.enum(['superseded', 'unselected-placement', 'multi-resource']),
      format: z.literal('logical'),
      operation: LogicalOperationSchema,
    })
    .strict(),
  z
    .object({
      transactionId: z.string(),
      phase: z.enum(['prepared', 'staged', 'backed-up', 'live', 'committed']),
      reason: z.enum(['superseded', 'unselected-placement', 'multi-resource']),
      format: z.literal('legacy-pair'),
      operation: LegacyOperationSchema,
    })
    .strict(),
]);

type DeepMutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly unknown[]
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;

export interface StatusV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.status';
  selection: DeepMutable<StatusReport['selection']>;
  context: DeepMutable<StatusReport['context']>;
  artifacts: DeepMutable<StatusReport['artifacts']>;
  ledger: DeepMutable<StatusReport['ledger']>;
  journals: DeepMutable<StatusReport['journals']>;
  facts: DeepMutable<StatusReport['facts']>;
  entries: DeepMutable<StatusReport['entries']>;
  summary: DeepMutable<StatusReport['summary']>;
}

const StatusV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.status'),
    selection: SelectionSchema,
    context: ContextSchema,
    artifacts: ArtifactsSchema,
    ledger: LedgerSummarySchema,
    journals: z.array(UnmatchedJournalSchema),
    facts: z.array(FactSchema),
    entries: z.array(EntrySchema),
    summary: z
      .object({
        entries: z.number().int().nonnegative(),
        converged: z.number().int().nonnegative(),
        drifting: z.number().int().nonnegative(),
        migrationPending: z.boolean(),
      })
      .strict(),
  })
  .strict() as z.ZodType<StatusV1Dto>;

const mapSourceIdentity = (source: StatusDesiredState['source']) => ({
  host: source.host,
  repository: source.repository,
  path: source.path,
});

const mapPortableLockFact = (fact: StatusPortableLockFact) => {
  if (fact.reason === 'manifest-hash-mismatch') {
    return { reason: fact.reason, field: fact.field };
  }
  return { reason: fact.reason, name: fact.name, field: fact.field };
};

const mapArtifactRelationship = (relationship: StatusArtifactRelationship) => {
  if (
    relationship.state === 'none' ||
    relationship.state === 'missing-lock' ||
    relationship.state === 'lock-only' ||
    relationship.state === 'current'
  ) {
    return { state: relationship.state };
  }
  if (relationship.state === 'incomplete') {
    return {
      state: relationship.state,
      missingNames: [...relationship.missingNames],
      facts: relationship.facts.map(mapPortableLockFact),
    };
  }
  return { state: relationship.state, facts: relationship.facts.map(mapPortableLockFact) };
};

const mapManifestSummary = (manifest: StatusManifestSummary) => {
  if (manifest.state === 'absent') return { state: manifest.state };
  return {
    state: manifest.state,
    sourceVersion: manifest.sourceVersion,
    currentVersion: manifest.currentVersion,
    byteRevision: manifest.byteRevision,
    semanticRevision: manifest.semanticRevision,
    canonical: manifest.canonical,
    migrationPending: manifest.migrationPending,
  };
};

const mapLockSummary = (lock: StatusLockSummary) => {
  if (lock.state === 'absent') return { state: lock.state };
  return {
    state: lock.state,
    sourceVersion: lock.sourceVersion,
    currentVersion: lock.currentVersion,
    byteRevision: lock.byteRevision,
    semanticRevision: lock.semanticRevision,
    canonical: lock.canonical,
    migrationPending: lock.migrationPending,
  };
};

const mapLedgerSummary = (ledger: StatusLedgerSummary) => {
  if (ledger.state === 'absent') {
    return {
      state: ledger.state,
      path: ledger.path,
      sourceVersion: ledger.sourceVersion,
      currentVersion: ledger.currentVersion,
      migrationPending: ledger.migrationPending,
    };
  }
  return {
    state: ledger.state,
    path: ledger.path,
    sourceVersion: ledger.sourceVersion,
    currentVersion: ledger.currentVersion,
    byteRevision: ledger.byteRevision,
    semanticRevision: ledger.semanticRevision,
    migrationPending: ledger.migrationPending,
  };
};

const mapDesiredState = (desired: StatusDesiredState) => ({
  name: desired.name,
  source: mapSourceIdentity(desired.source),
  ref: desired.ref,
  tools: [...desired.tools],
  scope: desired.scope,
  placement: desired.placement,
  path: desired.path,
});

const mapLockedState = (locked: StatusLockedState) => ({
  name: locked.name,
  source: locked.source,
  requestedRef: locked.requestedRef,
  resolvedSha: locked.resolvedSha,
  sourcePath: locked.sourcePath,
  contentHash: locked.contentHash,
});

const mapLedgerObservation = (ledger: StatusLedgerObservation) => ({
  placementPath: ledger.placementPath,
  mode: ledger.mode,
  source: ledger.source === null ? null : mapSourceIdentity(ledger.source),
  requestedRef: ledger.requestedRef,
  resolvedRevision: ledger.resolvedRevision,
  contentHash: ledger.contentHash,
  verification: ledger.verification,
  placement: ledger.placement,
});

const mapLiveObservation = (live: StatusLiveObservation) => ({
  path: live.path,
  realpath: live.realpath,
  nodeKind: live.nodeKind,
  linkTarget: live.linkTarget,
  skillFile: live.skillFile,
});

const mapPresence = <T>(
  value:
    | Readonly<{ readonly state: 'absent' }>
    | Readonly<{ readonly state: 'present'; readonly value: T }>,
  mapper: (present: T) => unknown,
) =>
  value.state === 'absent'
    ? { state: value.state }
    : { state: value.state, value: mapper(value.value) };

const mapShadow = (shadow: StatusShadow) => {
  if (shadow.state === 'none') return { state: shadow.state };
  if (shadow.state === 'winner') return { state: shadow.state, shadows: [...shadow.shadows] };
  if (shadow.state === 'shadowed') return { state: shadow.state, winner: shadow.winner };
  return { state: shadow.state, winner: shadow.winner };
};

const mapRevisionValue = (value: StatusRecordedRevisionCheck['expected']) => ({
  kind: value.kind,
  digest: value.digest,
});

const mapRecordedRevision = (revision: StatusRecordedRevisionCheck) => ({
  state: revision.state,
  expected: mapRevisionValue(revision.expected),
  observed: revision.observed === null ? null : mapRevisionValue(revision.observed),
});

const mapRecordedContent = (content: StatusRecordedContentCheck) => ({
  state: content.state,
  domain: content.domain,
  expected: content.expected,
  observed: content.observed,
});

const mapLegacyNode = (node: StatusLegacyExpectedNode | StatusLegacyObservedNode) => ({
  kind: node.kind,
  linkTarget: node.linkTarget,
});

const mapLegacyStructural = (structural: StatusLegacyStructuralCheck) => ({
  state: structural.state,
  expected: mapLegacyNode(structural.expected),
  observed: structural.observed === null ? null : mapLegacyNode(structural.observed),
});

const mapRetention = (retention: StatusRetentionRequirement) => {
  if (retention.format === 'logical') {
    return {
      format: retention.format,
      resourceId: retention.resourceId,
      retainUntil: retention.retainUntil,
      repositoryRevision: mapRecordedRevision(retention.repositoryRevision),
      contentHash: mapRecordedContent(retention.contentHash),
      role: retention.role,
      sourceRole: retention.sourceRole,
      path: retention.path,
      pathState: retention.pathState,
      state: retention.state,
    };
  }
  return {
    format: retention.format,
    resourceId: retention.resourceId,
    retainUntil: retention.retainUntil,
    structural: mapLegacyStructural(retention.structural),
    repositoryRevision: {
      state: retention.repositoryRevision.state,
      domain: retention.repositoryRevision.domain,
      expected: retention.repositoryRevision.expected,
      observed: retention.repositoryRevision.observed,
    },
    contentHash:
      retention.contentHash.state === 'not-recorded'
        ? {
            state: retention.contentHash.state,
            domain: retention.contentHash.domain,
            expected: retention.contentHash.expected,
            observed: retention.contentHash.observed,
          }
        : mapRecordedContent(retention.contentHash),
    role: retention.role,
    sourceRole: retention.sourceRole,
    path: retention.path,
    pathState: retention.pathState,
    state: retention.state,
  };
};

const mapJournal = (journal: StatusJournalState) => {
  if (journal.state === 'none') return { state: journal.state };
  if (journal.state === 'pending') {
    return {
      state: journal.state,
      transactionId: journal.transactionId,
      phase: journal.phase,
      before: journal.before,
      retention: journal.retention.map(mapRetention),
      abortEligibility: journal.abortEligibility,
      remediation: {
        resume: journal.remediation.resume,
        abort: journal.remediation.abort === null ? null : [...journal.remediation.abort],
      },
      format: journal.format,
      operation: journal.operation,
    };
  }
  return {
    state: journal.state,
    transactionId: journal.transactionId,
    phase: journal.phase,
    before: journal.before,
    retention: journal.retention.map(mapRetention),
    reverseEligibility: journal.reverseEligibility,
    remediation: {
      reverse: journal.remediation.reverse === null ? null : [...journal.remediation.reverse],
    },
    format: journal.format,
    operation: journal.operation,
  };
};

const mapFact = (fact: StatusFact) => ({
  code: fact.code,
  impact: fact.impact,
  subject: fact.subject,
  expected: fact.expected,
  actual: fact.actual,
});

const mapPlacement = (placement: StatusPlacement) => ({
  identity: {
    tool: placement.identity.tool,
    scope: placement.identity.scope,
    projectIdentity: placement.identity.projectIdentity,
    path: placement.identity.path,
  },
  ledger: mapPresence(placement.ledger, mapLedgerObservation),
  live: mapPresence(placement.live, mapLiveObservation),
  classification: placement.classification,
  brokenReason: placement.brokenReason,
  verification: placement.verification,
  shadow: mapShadow(placement.shadow),
  journal: mapJournal(placement.journal),
  facts: placement.facts.map(mapFact),
});

const mapEntry = (entry: StatusEntry) => ({
  name: entry.name,
  desired: mapPresence(entry.desired, mapDesiredState),
  locked: mapPresence(entry.locked, mapLockedState),
  placements: entry.placements.map(mapPlacement),
  facts: entry.facts.map(mapFact),
  convergence: entry.convergence,
});

const mapUnmatchedJournal = (journal: StatusUnmatchedJournal) => ({
  transactionId: journal.transactionId,
  phase: journal.phase,
  reason: journal.reason,
  format: journal.format,
  operation: journal.operation,
});

/** Project the closed domain report through the strict schema into newly owned JSON data. */
export const toStatusV1Dto = (report: StatusReport): StatusV1Dto =>
  StatusV1Schema.parse({
    schemaVersion: 1,
    kind: 'skillsmith.status',
    selection: {
      source: report.selection.source,
      targets: [...report.selection.targets],
      tools: [...report.selection.tools],
      toolSource: report.selection.toolSource,
      scopes: [...report.selection.scopes],
      scopeSource: report.selection.scopeSource,
      outcome: report.selection.outcome,
      reason: report.selection.reason,
    },
    context: {
      effectiveCwd: report.context.effectiveCwd,
      projectRoot: report.context.projectRoot,
      projectIdentity: report.context.projectIdentity,
      projectSource: report.context.projectSource,
    },
    artifacts:
      report.artifacts.state === 'unselected'
        ? { state: report.artifacts.state, reason: report.artifacts.reason }
        : {
            state: report.artifacts.state,
            source: report.artifacts.source,
            manifestPath: report.artifacts.manifestPath,
            lockPath: report.artifacts.lockPath,
            lockSource: report.artifacts.lockSource,
            manifest: mapManifestSummary(report.artifacts.manifest),
            lock: mapLockSummary(report.artifacts.lock),
            relationship: mapArtifactRelationship(report.artifacts.relationship),
          },
    ledger: mapLedgerSummary(report.ledger),
    journals: report.journals.map(mapUnmatchedJournal),
    facts: report.facts.map(mapFact),
    entries: report.entries.map(mapEntry),
    summary: {
      entries: report.summary.entries,
      converged: report.summary.converged,
      drifting: report.summary.drifting,
      migrationPending: report.summary.migrationPending,
    },
  });

export const statusV1Codec = createJsonWireCodec(
  {
    id: 'status',
    version: 1,
    wireKind: 'skillsmith.status',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  StatusV1Schema,
);
