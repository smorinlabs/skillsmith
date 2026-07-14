import { z } from 'zod';
import { type Result, err, ok } from '../result.ts';
import {
  type ArtifactCodec,
  type ArtifactCodecError,
  artifactCodecError,
  canonicalJsonBytes,
  decodeArtifactUtf8,
  unsignedUtf16Compare,
} from './codec.ts';
import type {
  JournalResourceActualV1Dto,
  JournalRetainedV1Dto,
  JournalV1Dto,
  LogicalJournalV1,
  LogicalJournalV1Dto,
} from './journal-types.ts';
import { ownArtifactDto, validatePlanOperationIntentV1 } from './plan-codec.ts';

type Path = readonly (string | number)[];

const STATIC_PATHS = new Set([
  'schemaVersion',
  'kind',
  'transactionId',
  'intent',
  'context',
  'parentOperationId',
  'command',
  'workflow',
  'attempt',
  'startedAt',
  'disposition',
  'phase',
  'actual',
  'before',
  'after',
  'retained',
  'resourceId',
  'role',
  'state',
  'repositoryRevision',
  'placementPath',
  'liveKind',
  'mode',
  'symlinkTarget',
  'contentHash',
  'location',
  'shape',
  'version',
  'byteHash',
  'semanticHash',
  'canonicalHash',
  'projectRoot',
  'sourceRole',
  'path',
  'retainUntil',
  'updatedAt',
  'completedAt',
  'digest',
]);

const codecError = (
  reason: ArtifactCodecError['reason'],
  path: Path = [],
  requestedVersion: number | null = 1,
): ArtifactCodecError =>
  artifactCodecError(
    'journal',
    requestedVersion,
    reason,
    path.map((segment) =>
      typeof segment === 'number' || STATIC_PATHS.has(segment) ? segment : '*',
    ),
  );

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
    .refine((value) => !hasForbiddenScalar(value));
const scalarString = ordinaryString(4096);
const id = ordinaryString(256).refine((value) => value.trim() === value && value.length > 0);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestamp = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => !hasForbiddenScalar(value))
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  });
const location = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('portable'), token: scalarString }).strict(),
  z.object({ kind: z.literal('machine-bound'), path: scalarString }).strict(),
]);
const revision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact-bytes'), digest }).strict(),
  z.object({ kind: z.literal('resource'), digest }).strict(),
]);

const liveActual = z.union([
  z
    .object({
      resourceId: id,
      role: z.literal('live'),
      state: z.literal('absent'),
      repositoryRevision: z.null(),
      placementPath: scalarString,
      liveKind: z.null(),
      mode: z.null(),
      symlinkTarget: z.null(),
      contentHash: z.null(),
    })
    .strict(),
  z
    .object({
      resourceId: id,
      role: z.literal('live'),
      state: z.literal('present'),
      repositoryRevision: revision,
      placementPath: scalarString,
      liveKind: z.enum(['symlink', 'directory', 'file', 'other']),
      mode: z.enum(['dev', 'pinned']).nullable(),
      symlinkTarget: scalarString.nullable(),
      contentHash: digest.nullable(),
    })
    .strict(),
]);
const manifestActual = z.union([
  z
    .object({
      resourceId: id,
      role: z.literal('manifest'),
      state: z.literal('absent'),
      repositoryRevision: z.null(),
      location,
      shape: z.null(),
      version: z.null(),
      byteHash: z.null(),
      semanticHash: z.null(),
    })
    .strict(),
  z
    .object({
      resourceId: id,
      role: z.literal('manifest'),
      state: z.literal('present'),
      repositoryRevision: revision,
      location,
      shape: z.literal('legacy'),
      version: z.null(),
      byteHash: digest,
      semanticHash: digest,
    })
    .strict(),
  z
    .object({
      resourceId: id,
      role: z.literal('manifest'),
      state: z.literal('present'),
      repositoryRevision: revision,
      location,
      shape: z.literal('canonical'),
      version: z.literal(1),
      byteHash: digest,
      semanticHash: digest,
    })
    .strict(),
]);
const lockActual = z.union([
  z
    .object({
      resourceId: id,
      role: z.literal('lock'),
      state: z.literal('absent'),
      repositoryRevision: z.null(),
      location,
      version: z.null(),
      canonicalHash: z.null(),
    })
    .strict(),
  z
    .object({
      resourceId: id,
      role: z.literal('lock'),
      state: z.literal('present'),
      repositoryRevision: revision,
      location,
      version: z.literal(1),
      canonicalHash: digest,
    })
    .strict(),
]);
const ledgerActual = z.union([
  z
    .object({
      resourceId: id,
      role: z.literal('ledger'),
      state: z.literal('absent'),
      repositoryRevision: z.null(),
      schemaVersion: z.null(),
      semanticHash: z.null(),
    })
    .strict(),
  z
    .object({
      resourceId: id,
      role: z.literal('ledger'),
      state: z.literal('present'),
      repositoryRevision: revision,
      schemaVersion: z.union([z.literal(1), z.literal(2)]),
      semanticHash: digest,
    })
    .strict(),
]);
const resourceActual = z.union([liveActual, manifestActual, lockActual, ledgerActual]);
const retained = z.discriminatedUnion('role', [
  z
    .object({
      resourceId: id,
      role: z.literal('backup'),
      sourceRole: z.enum(['live', 'manifest', 'lock', 'ledger']),
      path: scalarString,
      repositoryRevision: revision,
      contentHash: digest,
      retainUntil: timestamp.nullable(),
    })
    .strict(),
  z
    .object({
      resourceId: id,
      role: z.literal('store'),
      path: scalarString,
      repositoryRevision: revision,
      contentHash: digest,
      retainUntil: timestamp.nullable(),
    })
    .strict(),
]);

const JournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.transaction-journal'),
    transactionId: id,
    intent: z.unknown(),
    context: z
      .object({
        parentOperationId: id.nullable(),
        command: id,
        workflow: id,
        attempt: z.number().int().positive().safe(),
        startedAt: timestamp,
      })
      .strict(),
    disposition: z.enum(['forward', 'rollback']),
    phase: z.enum(['prepared', 'staged', 'backed-up', 'live', 'committed']),
    actual: z
      .object({
        before: z.array(resourceActual),
        after: z.array(resourceActual),
        retained: z.array(retained),
      })
      .strict(),
    updatedAt: timestamp,
    completedAt: timestamp.nullable(),
  })
  .strict();

const firstZodPath = (error: z.ZodError): Path => error.issues[0]?.path ?? [];
const resourceKey = (value: JournalResourceActualV1Dto): string =>
  `${value.resourceId}\0${value.role}`;
const retainedKey = (value: JournalRetainedV1Dto): string => `${value.resourceId}\0${value.role}`;
const uniqueKeys = <T>(values: readonly T[], key: (value: T) => string): boolean =>
  new Set(values.map(key)).size === values.length;
const sameKeySet = (
  left: readonly JournalResourceActualV1Dto[],
  right: readonly JournalResourceActualV1Dto[],
): boolean => {
  const rightKeys = new Set(right.map(resourceKey));
  return left.length === right.length && left.every((value) => rightKeys.has(resourceKey(value)));
};

const journalRelationshipsValid = (value: LogicalJournalV1Dto): boolean => {
  if (
    !uniqueKeys(value.actual.before, resourceKey) ||
    !uniqueKeys(value.actual.after, resourceKey) ||
    !uniqueKeys(value.actual.retained, retainedKey)
  ) {
    return false;
  }
  const roles = ['live', 'manifest', 'lock', 'ledger'] as const;
  for (const role of roles) {
    const count = value.actual.before.filter((resource) => resource.role === role).length;
    if (count !== (value.intent.mutates[role] ? 1 : 0)) return false;
  }
  if (
    (value.phase === 'prepared' || value.phase === 'staged' || value.phase === 'backed-up') &&
    value.actual.after.length !== 0
  ) {
    return false;
  }
  if (
    (value.phase === 'live' || value.phase === 'committed') &&
    !sameKeySet(value.actual.before, value.actual.after)
  ) {
    return false;
  }
  if ((value.phase === 'committed') !== (value.completedAt !== null)) return false;

  const retainedIds = new Set(value.actual.retained.map(({ resourceId }) => resourceId));
  if (retainedIds.size !== value.actual.retained.length) return false;
  const declaredIds = new Set(value.intent.reversibility.retentionResourceIds);
  if (value.intent.reversibility.kind === 'none') return retainedIds.size === 0;
  if ([...retainedIds].some((resourceId) => !declaredIds.has(resourceId))) return false;
  return (
    value.intent.reversibility.kind !== 'reversible' ||
    value.phase !== 'committed' ||
    retainedIds.size === declaredIds.size
  );
};

const compareKey = (left: string, right: string): number => {
  const splitLeft = left.split('\0');
  const splitRight = right.split('\0');
  return (
    unsignedUtf16Compare(splitLeft[0] ?? '', splitRight[0] ?? '') ||
    unsignedUtf16Compare(splitLeft[1] ?? '', splitRight[1] ?? '')
  );
};
const canonicalizeJournal = (value: LogicalJournalV1Dto): LogicalJournalV1Dto => ({
  schemaVersion: value.schemaVersion,
  kind: value.kind,
  transactionId: value.transactionId,
  intent: value.intent,
  context: value.context,
  disposition: value.disposition,
  phase: value.phase,
  actual: {
    before: [...value.actual.before].sort((left, right) =>
      compareKey(resourceKey(left), resourceKey(right)),
    ),
    after: [...value.actual.after].sort((left, right) =>
      compareKey(resourceKey(left), resourceKey(right)),
    ),
    retained: [...value.actual.retained].sort((left, right) =>
      compareKey(retainedKey(left), retainedKey(right)),
    ),
  },
  updatedAt: value.updatedAt,
  completedAt: value.completedAt,
});

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

export const validateJournalV1Dto = (input: unknown): Result<JournalV1Dto, ArtifactCodecError> => {
  const owned = ownArtifactDto('journal', input);
  if (!owned.ok) return owned;
  const parsed = JournalSchema.safeParse(owned.value);
  if (!parsed.success) {
    return err(codecError('invalid-shape', firstZodPath(parsed.error)));
  }
  const data = parsed.data as unknown as Omit<LogicalJournalV1Dto, 'intent'> & {
    readonly intent: unknown;
  };
  const intent = validatePlanOperationIntentV1(data.intent);
  if (!intent.ok) return intent;
  const value: LogicalJournalV1Dto = {
    schemaVersion: data.schemaVersion,
    kind: data.kind,
    transactionId: data.transactionId,
    intent: intent.value,
    context: data.context,
    disposition: data.disposition,
    phase: data.phase,
    actual: data.actual,
    updatedAt: data.updatedAt,
    completedAt: data.completedAt,
  };
  if (!journalRelationshipsValid(value)) return err(codecError('invalid-shape'));
  return ok(deepFreeze(canonicalizeJournal(value)));
};

export const fromJournalV1Dto = (dto: JournalV1Dto): Result<LogicalJournalV1, ArtifactCodecError> =>
  validateJournalV1Dto(dto);

export const toJournalV1Dto = (model: LogicalJournalV1): Result<JournalV1Dto, ArtifactCodecError> =>
  validateJournalV1Dto(model);

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
      if (character === '\\') cursor += 2;
      else if (character === '"') {
        cursor += 1;
        return JSON.parse(sourceText.slice(start, cursor)) as string;
      } else cursor += 1;
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
  id: 'journal' as const,
  version: 1 as const,
  syntax: 'json' as const,
  discriminator: { kind: 'field' as const, field: 'schemaVersion' as const },
  wireKind: 'skillsmith.transaction-journal',
  presentation: { decode: 'canonical' as const, encode: 'canonical' as const },
  terminalLf: true,
  unknownFields: 'reject-recursive' as const,
  migrations: [] as const,
  compatibility: 'conservative' as const,
});

export const journalV1Codec: ArtifactCodec<'journal', 1, JournalV1Dto, LogicalJournalV1> =
  Object.freeze({
    descriptor,
    validate: validateJournalV1Dto,
    fromDto: fromJournalV1Dto,
    toDto: toJournalV1Dto,
    decode(bytes: Uint8Array) {
      const decoded = decodeArtifactUtf8('journal', bytes, 1);
      if (!decoded.ok) return decoded;
      if (decoded.value.source.trim().length === 0) return err(codecError('malformed'));
      let input: unknown;
      try {
        if (duplicateJsonMember(decoded.value.source)) return err(codecError('malformed'));
        input = JSON.parse(decoded.value.source);
      } catch {
        return err(codecError('malformed'));
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return err(codecError('invalid-shape'));
      }
      const record = input as Record<string, unknown>;
      if (record.kind !== 'skillsmith.transaction-journal') {
        return err(codecError('invalid-shape', ['kind']));
      }
      const version = record.schemaVersion;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
        return err(codecError('invalid-shape', ['schemaVersion'], null));
      }
      if (version !== 1) {
        return err(codecError('unsupported-version', ['schemaVersion'], version));
      }
      const model = fromJournalV1Dto(input as JournalV1Dto);
      if (!model.ok) return model;
      const canonical = journalV1Codec.encode(model.value);
      if (!canonical.ok) return canonical;
      if (!bytesEqual(decoded.value.bytes, canonical.value)) {
        return err(codecError('noncanonical'));
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
    encode(model: LogicalJournalV1) {
      const dto = toJournalV1Dto(model);
      return dto.ok ? canonicalJsonBytes('journal', dto.value, 1, true) : dto;
    },
  });
