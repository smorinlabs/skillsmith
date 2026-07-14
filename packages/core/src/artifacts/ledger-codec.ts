import { z } from 'zod';
import { FLIP_TOOLS } from '../agents/registry.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type ArtifactCodec,
  type ArtifactCodecError,
  artifactCodecError,
  canonicalJsonBytes,
  decodeArtifactUtf8,
  deepOwnFreeze,
  hasSensitiveArtifactContent,
  ownArtifactBytes,
  unsignedUtf16Compare,
} from './codec.ts';
import { type ArtifactDigest, hashCanonicalInput } from './hash.ts';
import type { LogicalJournalV1Dto } from './journal-types.ts';
import type {
  LedgerConsumerV2Dto,
  LedgerMigrationV1ToV2,
  LedgerModel,
  LedgerPairV1Dto,
  LedgerSkillsV1Dto,
  LedgerSkillsV2Dto,
  LedgerV1Dto,
  LedgerV1ToolId,
  LedgerV2Dto,
  PreservedLegacyJournalIdentityV1,
} from './ledger-types.ts';
import { validateJournalV1DtoShape } from './registry.ts';

type Path = readonly (string | number)[];
type JsonRecord = Record<string, unknown>;

const STATIC_PATHS = new Set(
  'schemaVersion kind updatedAt skills projects projectRegistrations transactions history tools placementPath mode dev sourcePath resolvedPath repoRoot sourceRelPath remote recordedAt pinned storePath rev gitSha dirty contentHash snapshotAt verify placement origin source host repo skillPath refRequested refResolved pin installedAt journal op txId phase startedAt completedAt before liveKind symlinkTarget stagingPath backupPath consumers skill tool store path transactionId'.split(
    ' ',
  ),
);

const codecError = (
  reason: ArtifactCodecError['reason'],
  path: Path = [],
  requestedVersion: number | null = null,
): ArtifactCodecError =>
  artifactCodecError(
    'ledger',
    requestedVersion,
    reason,
    path.map((segment) =>
      typeof segment === 'number' || STATIC_PATHS.has(segment) ? segment : '*',
    ),
  );

const string = z.string();
const nullableString = string.nullable();
const DevSchema = z
  .object({
    sourcePath: string,
    resolvedPath: string,
    repoRoot: nullableString,
    sourceRelPath: nullableString,
    remote: nullableString,
    recordedAt: string,
  })
  .strict();
const PinnedSchema = z
  .object({
    storePath: string,
    rev: string,
    gitSha: nullableString,
    dirty: z.boolean(),
    contentHash: string,
    snapshotAt: string,
    verify: z.enum(['passed', 'warned', 'skipped']),
    placement: z.enum(['symlink', 'copy']).optional(),
  })
  .strict();
const OriginSchema = z
  .object({
    source: string,
    host: string,
    repo: string,
    skillPath: string,
    refRequested: nullableString,
    refResolved: string,
    pin: z.boolean(),
    installedAt: string,
  })
  .strict();
const BeforeSchema = z.union([
  z
    .object({
      mode: z.literal('dev'),
      symlinkTarget: string,
      liveKind: z.enum(['symlink', 'dir']).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('pinned'),
      storePath: nullableString,
      contentHash: nullableString,
      liveKind: z.enum(['symlink', 'dir']).optional(),
      symlinkTarget: string.optional(),
    })
    .strict(),
  z.object({ mode: z.literal('absent') }).strict(),
]);
const LegacyJournalSchema = z
  .object({
    op: z.enum(['promote', 'dev', 'rollback', 'install', 'uninstall']),
    txId: string,
    phase: z.enum(['prepared', 'staged', 'backed-up', 'live', 'committed']),
    startedAt: string,
    completedAt: nullableString,
    before: BeforeSchema,
    stagingPath: string,
    backupPath: string,
  })
  .strict();
const PairSchema = z
  .object({
    placementPath: string,
    mode: z.enum(['dev', 'pinned']),
    dev: DevSchema.nullable(),
    pinned: PinnedSchema.nullable().optional(),
    origin: OriginSchema.optional(),
    journal: LegacyJournalSchema.nullable().optional(),
  })
  .strict();
const ToolsV1Schema = z.record(z.enum(FLIP_TOOLS), PairSchema);
const SkillsV1Schema = z.record(string, z.object({ tools: ToolsV1Schema }).strict());
const ToolsV2Schema = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/u), PairSchema);
const SkillsV2Schema = z.record(string, z.object({ tools: ToolsV2Schema }).strict());
const ConsumerSchema = z
  .object({
    skill: string,
    tool: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    placementPath: string,
    store: z.object({ path: string, contentHash: string }).strict().nullable(),
  })
  .strict();
const LedgerV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.placements'),
    updatedAt: string,
    skills: SkillsV1Schema,
    projects: z.record(string, z.object({ skills: SkillsV1Schema }).strict()).optional(),
  })
  .strict();
const LedgerV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('skillsmith.placements'),
    updatedAt: string,
    skills: SkillsV2Schema,
    projects: z.record(string, z.object({ skills: SkillsV2Schema }).strict()),
    projectRegistrations: z.record(
      string,
      z.object({ consumers: z.array(ConsumerSchema) }).strict(),
    ),
    transactions: z.record(string, z.unknown()),
    history: z.array(z.unknown()),
  })
  .strict();

const firstZodPath = (error: z.ZodError): Path => error.issues[0]?.path ?? [];
const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};
const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);
const sortedEntries = <T>(record: Readonly<Record<string, T>>): [string, T][] =>
  Object.entries(record).sort(([left], [right]) => unsignedUtf16Compare(left, right));
const sortedRecord = <T, U>(
  record: Readonly<Record<string, T>>,
  mapValue: (value: T, key: string) => U,
): Readonly<Record<string, U>> =>
  Object.fromEntries(sortedEntries(record).map(([key, value]) => [key, mapValue(value, key)]));

const canonicalDev = (value: NonNullable<LedgerPairV1Dto['dev']>) => ({
  sourcePath: value.sourcePath,
  resolvedPath: value.resolvedPath,
  repoRoot: value.repoRoot,
  sourceRelPath: value.sourceRelPath,
  remote: value.remote,
  recordedAt: value.recordedAt,
});
const canonicalPinned = (value: NonNullable<LedgerPairV1Dto['pinned']>) => ({
  storePath: value.storePath,
  rev: value.rev,
  gitSha: value.gitSha,
  dirty: value.dirty,
  contentHash: value.contentHash,
  snapshotAt: value.snapshotAt,
  verify: value.verify,
  ...(value.placement === undefined ? {} : { placement: value.placement }),
});
const canonicalOrigin = (value: NonNullable<LedgerPairV1Dto['origin']>) => ({
  source: value.source,
  host: value.host,
  repo: value.repo,
  skillPath: value.skillPath,
  refRequested: value.refRequested,
  refResolved: value.refResolved,
  pin: value.pin,
  installedAt: value.installedAt,
});
const canonicalBefore = (value: NonNullable<LedgerPairV1Dto['journal']>['before']) => {
  if (value.mode === 'absent') return { mode: value.mode };
  if (value.mode === 'dev') {
    return {
      mode: value.mode,
      symlinkTarget: value.symlinkTarget,
      ...(value.liveKind === undefined ? {} : { liveKind: value.liveKind }),
    };
  }
  return {
    mode: value.mode,
    storePath: value.storePath,
    contentHash: value.contentHash,
    ...(value.liveKind === undefined ? {} : { liveKind: value.liveKind }),
    ...(value.symlinkTarget === undefined ? {} : { symlinkTarget: value.symlinkTarget }),
  };
};
const canonicalLegacyJournal = (value: NonNullable<LedgerPairV1Dto['journal']>) => ({
  op: value.op,
  txId: value.txId,
  phase: value.phase,
  startedAt: value.startedAt,
  completedAt: value.completedAt,
  before: canonicalBefore(value.before),
  stagingPath: value.stagingPath,
  backupPath: value.backupPath,
});
const canonicalPair = (value: LedgerPairV1Dto): LedgerPairV1Dto => ({
  placementPath: value.placementPath,
  mode: value.mode,
  dev: value.dev === null ? null : canonicalDev(value.dev),
  ...(hasOwn(value, 'pinned')
    ? { pinned: value.pinned == null ? value.pinned : canonicalPinned(value.pinned) }
    : {}),
  ...(value.origin === undefined ? {} : { origin: canonicalOrigin(value.origin) }),
  ...(hasOwn(value, 'journal')
    ? { journal: value.journal == null ? value.journal : canonicalLegacyJournal(value.journal) }
    : {}),
});
const canonicalSkillsV1 = (value: LedgerSkillsV1Dto): LedgerSkillsV1Dto =>
  sortedRecord(value, (entry) => ({
    tools: sortedRecord(entry.tools as Readonly<Record<string, LedgerPairV1Dto>>, canonicalPair),
  })) as LedgerSkillsV1Dto;
const canonicalSkillsV2 = (value: LedgerSkillsV2Dto): LedgerSkillsV2Dto =>
  sortedRecord(value, (entry) => ({ tools: sortedRecord(entry.tools, canonicalPair) }));
const canonicalProjectsV2 = (value: LedgerV2Dto['projects']): LedgerV2Dto['projects'] =>
  sortedRecord(value, (entry) => ({ skills: canonicalSkillsV2(entry.skills) }));

const consumerCompare = (left: LedgerConsumerV2Dto, right: LedgerConsumerV2Dto): number =>
  unsignedUtf16Compare(left.skill, right.skill) ||
  unsignedUtf16Compare(left.tool, right.tool) ||
  unsignedUtf16Compare(left.placementPath, right.placementPath);
const canonicalConsumer = (value: LedgerConsumerV2Dto): LedgerConsumerV2Dto => ({
  skill: value.skill,
  tool: value.tool,
  placementPath: value.placementPath,
  store:
    value.store === null ? null : { path: value.store.path, contentHash: value.store.contentHash },
});
const deriveRegistrations = (
  projects: LedgerV2Dto['projects'],
): LedgerV2Dto['projectRegistrations'] =>
  sortedRecord(projects, (project) => {
    const consumers: LedgerConsumerV2Dto[] = [];
    for (const [skill, entry] of sortedEntries(project.skills)) {
      for (const [tool, pair] of sortedEntries(entry.tools)) {
        consumers.push({
          skill,
          tool,
          placementPath: pair.placementPath,
          store:
            pair.pinned == null
              ? null
              : { path: pair.pinned.storePath, contentHash: pair.pinned.contentHash },
        });
      }
    }
    return { consumers: consumers.sort(consumerCompare) };
  });
const canonicalRegistrations = (
  value: LedgerV2Dto['projectRegistrations'],
): LedgerV2Dto['projectRegistrations'] =>
  sortedRecord(value, (registration) => ({
    consumers: registration.consumers.map(canonicalConsumer).sort(consumerCompare),
  }));

const ownAndParse = <T>(
  input: unknown,
  schema: z.ZodType<T>,
  requestedVersion: 1 | 2,
): Result<T, ArtifactCodecError> => {
  const owned = deepOwnFreeze<unknown>('ledger', input, requestedVersion);
  if (!owned.ok) return owned;
  const parsed = schema.safeParse(owned.value);
  return parsed.success
    ? ok(parsed.data)
    : err(codecError('invalid-shape', firstZodPath(parsed.error), requestedVersion));
};

export const validateLedgerV1Dto = (input: unknown): Result<LedgerV1Dto, ArtifactCodecError> => {
  const parsed = ownAndParse(input, LedgerV1Schema, 1);
  if (!parsed.ok) return parsed;
  const value = parsed.value as LedgerV1Dto;
  const canonical: LedgerV1Dto = {
    schemaVersion: 1,
    kind: 'skillsmith.placements',
    updatedAt: value.updatedAt,
    skills: canonicalSkillsV1(value.skills),
    ...(value.projects === undefined
      ? {}
      : {
          projects: sortedRecord(value.projects, (project) => ({
            skills: canonicalSkillsV1(project.skills),
          })),
        }),
  };
  if (hasSensitiveArtifactContent(value)) {
    return err(codecError('sensitive-content', [], 1));
  }
  return ok(deepFreeze(canonical));
};

const validateLogicalJournals = (
  transactions: Readonly<Record<string, unknown>>,
  history: readonly unknown[],
): Result<
  Readonly<{
    transactions: Readonly<Record<string, LogicalJournalV1Dto>>;
    history: readonly LogicalJournalV1Dto[];
  }>,
  ArtifactCodecError
> => {
  const transactionEntries: [string, LogicalJournalV1Dto][] = [];
  for (const [key, input] of sortedEntries(transactions)) {
    const journal = validateJournalV1DtoShape(input);
    if (!journal.ok) {
      return err(codecError('invalid-shape', ['transactions', key], 2));
    }
    if (journal.value.transactionId !== key || journal.value.phase === 'committed') {
      return err(codecError('invalid-shape', ['transactions', key], 2));
    }
    transactionEntries.push([key, journal.value]);
  }
  const canonicalHistory: LogicalJournalV1Dto[] = [];
  for (const [index, input] of history.entries()) {
    const journal = validateJournalV1DtoShape(input);
    if (!journal.ok) {
      return err(codecError('invalid-shape', ['history', index], 2));
    }
    if (journal.value.phase !== 'committed') {
      return err(codecError('invalid-shape', ['history', index], 2));
    }
    canonicalHistory.push(journal.value);
  }
  return ok({ transactions: Object.fromEntries(transactionEntries), history: canonicalHistory });
};

const validateLedgerV2DtoShape = (input: unknown): Result<LedgerV2Dto, ArtifactCodecError> => {
  const parsed = ownAndParse(input, LedgerV2Schema, 2);
  if (!parsed.ok) return parsed;
  const value = parsed.value as unknown as LedgerV2Dto;
  const projects = canonicalProjectsV2(value.projects);
  const registrations = canonicalRegistrations(value.projectRegistrations);
  if (JSON.stringify(Object.keys(projects)) !== JSON.stringify(Object.keys(registrations))) {
    return err(codecError('invalid-shape', ['projectRegistrations'], 2));
  }
  const expected = deriveRegistrations(projects);
  if (JSON.stringify(registrations) !== JSON.stringify(expected)) {
    return err(codecError('invalid-shape', ['projectRegistrations'], 2));
  }
  const journals = validateLogicalJournals(value.transactions, value.history);
  if (!journals.ok) return journals;
  return ok(
    deepFreeze({
      schemaVersion: 2 as const,
      kind: 'skillsmith.placements' as const,
      updatedAt: value.updatedAt,
      skills: canonicalSkillsV2(value.skills),
      projects,
      projectRegistrations: registrations,
      transactions: journals.value.transactions,
      history: journals.value.history,
    }),
  );
};

export const validateLedgerV2Dto = (input: unknown): Result<LedgerV2Dto, ArtifactCodecError> => {
  const shaped = validateLedgerV2DtoShape(input);
  if (!shaped.ok) return shaped;
  return hasSensitiveArtifactContent(shaped.value)
    ? err(codecError('sensitive-content', [], 2))
    : shaped;
};

export const migrateLedgerV1DtoToV2Dto = (
  dto: LedgerV1Dto,
): Result<LedgerV2Dto, ArtifactCodecError> => {
  const source = validateLedgerV1Dto(dto);
  if (!source.ok) return source;
  const projects = canonicalProjectsV2((source.value.projects ?? {}) as LedgerV2Dto['projects']);
  return validateLedgerV2Dto({
    schemaVersion: 2,
    kind: 'skillsmith.placements',
    updatedAt: source.value.updatedAt,
    skills: source.value.skills,
    projects,
    projectRegistrations: deriveRegistrations(projects),
    transactions: {},
    history: [],
  });
};

const modelFromV2 = (value: LedgerV2Dto): LedgerModel =>
  deepFreeze({
    updatedAt: value.updatedAt,
    skills: value.skills,
    projects: value.projects,
    projectRegistrations: value.projectRegistrations,
    transactions: value.transactions,
    history: value.history,
  });

export const fromLedgerV1Dto = (dto: LedgerV1Dto): Result<LedgerModel, ArtifactCodecError> => {
  const migrated = migrateLedgerV1DtoToV2Dto(dto);
  return migrated.ok ? ok(modelFromV2(migrated.value)) : migrated;
};

export const fromLedgerV2Dto = (dto: LedgerV2Dto): Result<LedgerModel, ArtifactCodecError> => {
  const validated = validateLedgerV2Dto(dto);
  return validated.ok ? ok(modelFromV2(validated.value)) : validated;
};

export const toLedgerV2Dto = (model: LedgerModel): Result<LedgerV2Dto, ArtifactCodecError> =>
  validateLedgerV2Dto({
    schemaVersion: 2,
    kind: 'skillsmith.placements',
    updatedAt: model.updatedAt,
    skills: model.skills,
    projects: model.projects,
    projectRegistrations: model.projectRegistrations,
    transactions: model.transactions,
    history: model.history,
  });

const LEGACY_TOOLS = new Set<string>(FLIP_TOOLS);
const v1ToolsOnly = (skills: LedgerSkillsV2Dto): boolean =>
  Object.values(skills).every((entry) =>
    Object.keys(entry.tools).every((tool) => LEGACY_TOOLS.has(tool)),
  );

export const toLedgerV1Dto = (model: LedgerModel): Result<LedgerV1Dto, ArtifactCodecError> => {
  const v2 = toLedgerV2Dto(model);
  if (!v2.ok) return v2;
  if (
    Object.keys(v2.value.transactions).length !== 0 ||
    v2.value.history.length !== 0 ||
    !v1ToolsOnly(v2.value.skills) ||
    !Object.values(v2.value.projects).every((project) => v1ToolsOnly(project.skills)) ||
    JSON.stringify(v2.value.projectRegistrations) !==
      JSON.stringify(deriveRegistrations(v2.value.projects))
  ) {
    return err(codecError('invalid-shape', [], 1));
  }
  return validateLedgerV1Dto({
    schemaVersion: 1,
    kind: 'skillsmith.placements',
    updatedAt: v2.value.updatedAt,
    skills: v2.value.skills as LedgerSkillsV1Dto,
    ...(Object.keys(v2.value.projects).length === 0
      ? {}
      : { projects: v2.value.projects as LedgerV1Dto['projects'] }),
  });
};

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
const parseJsonBytes = (
  bytes: Uint8Array,
  requestedVersion: 1 | 2,
): Result<Readonly<{ bytes: Uint8Array; input: JsonRecord }>, ArtifactCodecError> => {
  const decoded = decodeArtifactUtf8('ledger', bytes, requestedVersion);
  if (!decoded.ok) return decoded;
  if (decoded.value.source.trim().length === 0)
    return err(codecError('malformed', [], requestedVersion));
  let input: unknown;
  try {
    if (duplicateJsonMember(decoded.value.source))
      return err(codecError('malformed', [], requestedVersion));
    input = JSON.parse(decoded.value.source);
  } catch {
    return err(codecError('malformed', [], requestedVersion));
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return err(codecError('invalid-shape', [], requestedVersion));
  }
  const record = input as JsonRecord;
  if (record.kind !== 'skillsmith.placements') {
    return err(codecError('invalid-shape', ['kind'], requestedVersion));
  }
  const version = record.schemaVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
    return err(codecError('invalid-shape', ['schemaVersion'], null));
  }
  return ok({ bytes: decoded.value.bytes, input: record });
};

const ledgerV1Descriptor = deepFreeze({
  id: 'ledger' as const,
  version: 1 as const,
  syntax: 'json' as const,
  discriminator: { kind: 'field' as const, field: 'schemaVersion' as const },
  wireKind: 'skillsmith.placements',
  presentation: { decode: 'human' as const, encode: 'compatibility' as const },
  terminalLf: false,
  unknownFields: 'reject-recursive' as const,
  migrations: [] as const,
  compatibility: 'conservative' as const,
});
const ledgerV2Descriptor = deepFreeze({
  id: 'ledger' as const,
  version: 2 as const,
  syntax: 'json' as const,
  discriminator: { kind: 'field' as const, field: 'schemaVersion' as const },
  wireKind: 'skillsmith.placements',
  presentation: { decode: 'canonical' as const, encode: 'canonical' as const },
  terminalLf: true,
  unknownFields: 'reject-recursive' as const,
  migrations: [
    {
      source: { kind: 'version' as const, version: 1 },
      targetVersion: 2,
      mapperId: 'ledger-v1-to-v2' as const,
    },
  ] as const,
  compatibility: 'conservative' as const,
});

export const ledgerV1Codec: ArtifactCodec<'ledger', 1, LedgerV1Dto, LedgerModel> = Object.freeze({
  descriptor: ledgerV1Descriptor,
  validate: validateLedgerV1Dto,
  fromDto: fromLedgerV1Dto,
  toDto: toLedgerV1Dto,
  decode(bytes: Uint8Array) {
    const parsed = parseJsonBytes(bytes, 1);
    if (!parsed.ok) return parsed;
    const version = parsed.value.input.schemaVersion as number;
    if (version !== 1) {
      return err(codecError('unsupported-version', ['schemaVersion'], version));
    }
    const model = fromLedgerV1Dto(parsed.value.input as unknown as LedgerV1Dto);
    if (!model.ok) return model;
    const canonical = ledgerV1Codec.encode(model.value);
    if (!canonical.ok) return canonical;
    return ok(
      deepFreeze({
        source: { kind: 'version' as const, version: 1 },
        model: model.value,
        canonical: bytesEqual(parsed.value.bytes, canonical.value),
        migration: null,
      }),
    );
  },
  encode(model: LedgerModel) {
    const dto = toLedgerV1Dto(model);
    return dto.ok ? canonicalJsonBytes('ledger', dto.value, 1, false) : dto;
  },
});

export const ledgerV2Codec: ArtifactCodec<'ledger', 2, LedgerV2Dto, LedgerModel> = Object.freeze({
  descriptor: ledgerV2Descriptor,
  validate: validateLedgerV2Dto,
  fromDto: fromLedgerV2Dto,
  toDto: toLedgerV2Dto,
  decode(bytes: Uint8Array) {
    const parsed = parseJsonBytes(bytes, 2);
    if (!parsed.ok) return parsed;
    const version = parsed.value.input.schemaVersion as number;
    if (version !== 1 && version !== 2) {
      return err(codecError('unsupported-version', ['schemaVersion'], version));
    }
    if (version === 1) {
      const model = fromLedgerV1Dto(parsed.value.input as unknown as LedgerV1Dto);
      if (!model.ok) return model;
      const compatibilityBytes = ledgerV1Codec.encode(model.value);
      if (!compatibilityBytes.ok) return compatibilityBytes;
      return ok(
        deepFreeze({
          source: { kind: 'version' as const, version: 1 },
          model: model.value,
          canonical: bytesEqual(parsed.value.bytes, compatibilityBytes.value),
          migration: { mapperId: 'ledger-v1-to-v2' as const, targetVersion: 2 },
        }),
      );
    }
    const dto = validateLedgerV2DtoShape(parsed.value.input);
    if (!dto.ok) return dto;
    const canonical = new TextEncoder().encode(`${JSON.stringify(dto.value, null, 2)}\n`);
    if (!bytesEqual(parsed.value.bytes, canonical)) {
      return err(codecError('noncanonical', [], 2));
    }
    if (hasSensitiveArtifactContent(dto.value)) {
      return err(codecError('sensitive-content', [], 2));
    }
    const model = modelFromV2(dto.value);
    return ok(
      deepFreeze({
        source: { kind: 'version' as const, version: 2 },
        model,
        canonical: true,
        migration: null,
      }),
    );
  },
  encode(model: LedgerModel) {
    const dto = toLedgerV2Dto(model);
    return dto.ok ? canonicalJsonBytes('ledger', dto.value, 2, true) : dto;
  },
});

const hashResource = (input: string | Uint8Array): ArtifactDigest => {
  const hashed = hashCanonicalInput('resource', 1, input);
  if (!hashed.ok) throw new Error('ledger resource hash invariant failed');
  return hashed.value;
};

export const ledgerByteRevision = (bytes: Uint8Array): ArtifactDigest =>
  hashResource(new Uint8Array(bytes));

export const ledgerSemanticRevision = (
  model: LedgerModel,
): Result<ArtifactDigest, ArtifactCodecError> => {
  const dto = toLedgerV2Dto(model);
  if (!dto.ok) return dto;
  const projection = {
    updatedAt: dto.value.updatedAt,
    skills: dto.value.skills,
    projects: dto.value.projects,
    projectRegistrations: dto.value.projectRegistrations,
    transactions: dto.value.transactions,
    history: dto.value.history,
  };
  if (hasSensitiveArtifactContent(projection)) {
    return err(codecError('sensitive-content', [], 2));
  }
  return ok(hashResource(`ledger-semantic-v1\0${JSON.stringify(projection, null, 2)}`));
};

const legacyJournalIdentities = (
  source: LedgerV1Dto,
): readonly PreservedLegacyJournalIdentityV1[] => {
  const identities: PreservedLegacyJournalIdentityV1[] = [];
  const visit = (
    skills: LedgerSkillsV1Dto,
    scope: PreservedLegacyJournalIdentityV1['scope'],
  ): void => {
    for (const [skill, entry] of sortedEntries(skills)) {
      for (const [tool, pair] of sortedEntries(
        entry.tools as Readonly<Record<string, LedgerPairV1Dto>>,
      )) {
        if (pair.journal !== undefined && pair.journal !== null) {
          identities.push({
            scope,
            skill,
            tool: tool as LedgerV1ToolId,
            txId: pair.journal.txId,
          });
        }
      }
    }
  };
  visit(source.skills, { kind: 'user' });
  for (const [root, project] of sortedEntries(source.projects ?? {})) {
    visit(project.skills, { kind: 'project', root });
  }
  return identities.sort((left, right) => {
    const leftRoot = left.scope.kind === 'project' ? left.scope.root : '';
    const rightRoot = right.scope.kind === 'project' ? right.scope.root : '';
    return (
      unsignedUtf16Compare(left.scope.kind, right.scope.kind) ||
      unsignedUtf16Compare(leftRoot, rightRoot) ||
      unsignedUtf16Compare(left.skill, right.skill) ||
      unsignedUtf16Compare(left.tool, right.tool) ||
      unsignedUtf16Compare(left.txId, right.txId)
    );
  });
};

export const describeLedgerV1Migration = (
  sourceBytes: Uint8Array,
  dto: LedgerV1Dto,
): Result<LedgerMigrationV1ToV2, ArtifactCodecError> => {
  const owned = ownArtifactBytes('ledger', sourceBytes, 1);
  if (!owned.ok) return owned;
  const source = validateLedgerV1Dto(dto);
  if (!source.ok) return source;
  const migrated = migrateLedgerV1DtoToV2Dto(source.value);
  if (!migrated.ok) return migrated;
  const model = fromLedgerV2Dto(migrated.value);
  if (!model.ok) return model;
  const targetBytes = ledgerV2Codec.encode(model.value);
  if (!targetBytes.ok) return targetBytes;
  const semantic = ledgerSemanticRevision(model.value);
  if (!semantic.ok) return semantic;
  return ok(
    deepFreeze({
      kind: 'ledger-v1-to-v2' as const,
      fromSchemaVersion: 1 as const,
      toSchemaVersion: 2 as const,
      sourceByteRevision: ledgerByteRevision(owned.value),
      sourceSemanticRevision: semantic.value,
      targetSemanticRevision: semantic.value,
      targetByteRevision: ledgerByteRevision(targetBytes.value),
      targetCanonicalSource: new TextDecoder().decode(targetBytes.value),
      preservedLegacyJournals: legacyJournalIdentities(source.value),
    }),
  );
};
