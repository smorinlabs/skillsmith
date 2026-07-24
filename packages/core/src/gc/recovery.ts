import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { gcV1Codec } from '../contracts/v1/gc.ts';
import type {
  EffectiveUserPort,
  ExclusiveCreatePort,
  FileMetadataReadPort,
  FileReadPort,
  FileWritePort,
  IdPort,
} from '../ports/types.ts';
import { gcRequestDigest } from './plan.ts';
import type { GcRecoveryObservation, GcRecoveryPhase, GcRecoveryRecordV1 } from './types.ts';

type RecoveryPorts = EffectiveUserPort &
  ExclusiveCreatePort &
  FileMetadataReadPort &
  Pick<FileReadPort, 'listDir' | 'pathKind' | 'readText' | 'realpath'> &
  Pick<FileWritePort, 'fsyncDir' | 'fsyncFile' | 'removeTree' | 'rename'> &
  IdPort;

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX16 = /^[0-9a-f]{16}$/u;
const IdSchema = z.string().regex(HEX64);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const EntrySchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['file', 'symlink']),
    identity: z.string().min(1),
    linkCount: z.literal(1),
    logicalBytes: z.number().int().nonnegative(),
    executable: z.boolean().nullable(),
    target: z.string().nullable(),
  })
  .strict();
const ObjectSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['store', 'adapted-overlay']),
    path: z.string().min(1),
    relativePath: z.string().min(1),
    namespace: z.string().min(1),
    repository: z.string().min(1),
    revision: z.string().min(1),
    skill: z.string().min(1),
    contentHash: DigestSchema,
    modifiedAt: z.number().finite(),
    logicalBytes: z.number().int().nonnegative(),
    rootIdentity: z.string().min(1),
    namespaceIdentity: z.string().min(1),
    repositoryIdentity: z.string().min(1),
    directoryIdentity: z.string().min(1),
    directoryLinkCount: z.number().int().nonnegative(),
    entries: z.array(EntrySchema),
  })
  .strict();
const ActionSchema = z
  .object({
    actionId: IdSchema,
    kind: z.literal('reclaim-store'),
    path: z.string().min(1),
    contentHash: DigestSchema,
    modifiedAt: z.number().finite(),
    logicalBytes: z.number().int().nonnegative(),
    object: ObjectSchema,
    ownershipToken: IdSchema,
    containerPath: z.string().min(1),
    payloadPath: z.string().min(1),
    containerIdentity: z.string().min(1).nullable(),
    payloadIdentity: z.string().min(1).nullable(),
    outcome: z.enum(['pending', 'prepared', 'detached', 'cleaned', 'protected-skip']),
  })
  .strict();
const SourceLedgerSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('absent'),
      sourceVersion: z.null(),
      byteRevision: z.null(),
      semanticRevision: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal('present'),
      sourceVersion: z.union([z.literal(1), z.literal(2)]),
      byteRevision: DigestSchema,
      semanticRevision: DigestSchema,
    })
    .strict(),
]);
const RecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.gc-recovery'),
    planId: IdSchema,
    requestDigest: IdSchema,
    revision: IdSchema,
    phase: z.enum(['approved', 'migration-complete', 'forget-complete', 'reclaiming', 'complete']),
    dataDir: z.string().min(1),
    storeRoot: z.string().min(1),
    ledgerPath: z.string().min(1),
    retryArguments: z.array(z.string()),
    sourceLedger: SourceLedgerSchema,
    normalizedForgetRoots: z.array(z.string().min(1)),
    migrationUpdatedAt: z.string().datetime().nullable(),
    expectedMigrationSemanticRevision: DigestSchema.nullable(),
    forgetUpdatedAt: z.string().datetime().nullable(),
    expectedPostForgetSemanticRevision: DigestSchema.nullable(),
    nowMilliseconds: z.number().int().safe(),
    olderThanMilliseconds: z.number().int().positive().safe().nullable(),
    approvedReport: z.unknown(),
    actions: z.array(ActionSchema),
  })
  .strict();

const canonical = (record: GcRecoveryRecordV1): string =>
  `${JSON.stringify(
    {
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      planId: record.planId,
      requestDigest: record.requestDigest,
      revision: record.revision,
      phase: record.phase,
      dataDir: record.dataDir,
      storeRoot: record.storeRoot,
      ledgerPath: record.ledgerPath,
      retryArguments: [...record.retryArguments],
      sourceLedger: record.sourceLedger,
      normalizedForgetRoots: [...record.normalizedForgetRoots],
      migrationUpdatedAt: record.migrationUpdatedAt,
      expectedMigrationSemanticRevision: record.expectedMigrationSemanticRevision,
      forgetUpdatedAt: record.forgetUpdatedAt,
      expectedPostForgetSemanticRevision: record.expectedPostForgetSemanticRevision,
      nowMilliseconds: record.nowMilliseconds,
      olderThanMilliseconds: record.olderThanMilliseconds,
      approvedReport: record.approvedReport,
      actions: record.actions.map((action) => ({
        actionId: action.actionId,
        kind: action.kind,
        path: action.path,
        contentHash: action.contentHash,
        modifiedAt: action.modifiedAt,
        logicalBytes: action.logicalBytes,
        object: action.object,
        ownershipToken: action.ownershipToken,
        containerPath: action.containerPath,
        payloadPath: action.payloadPath,
        containerIdentity: action.containerIdentity,
        payloadIdentity: action.payloadIdentity,
        outcome: action.outcome,
      })),
    },
    null,
    2,
  )}\n`;

const recoveryRootOf = (dataDir: string): string => join(dataDir, '.gc-recovery', 'v1');

const hash64 = (value: string): string => createHash('sha256').update(value).digest('hex');

const casId = (ports: Pick<RecoveryPorts, 'nextId'>): string =>
  hash64(ports.nextId('gc-recovery-cas')).slice(0, 16);

const secureDirectory = async (
  ports: RecoveryPorts,
  path: string,
  expectedMode: number,
): Promise<boolean> => {
  const metadata = await ports.readFileMetadata(path).catch(() => null);
  const effective = ports.effectiveUserIdentity();
  return (
    metadata?.kind === 'dir' &&
    metadata.identity !== null &&
    metadata.mode === expectedMode &&
    effective.uid !== null &&
    metadata.uid === effective.uid &&
    (effective.gid === null || metadata.gid === effective.gid)
  );
};

const secureFile = async (ports: RecoveryPorts, path: string): Promise<boolean> => {
  const metadata = await ports.readFileMetadata(path).catch(() => null);
  const effective = ports.effectiveUserIdentity();
  return (
    metadata?.kind === 'file' &&
    metadata.identity !== null &&
    metadata.mode === 0o600 &&
    metadata.linkCount === 1 &&
    effective.uid !== null &&
    metadata.uid === effective.uid &&
    (effective.gid === null || metadata.gid === effective.gid)
  );
};

const parseRecord = (source: string): GcRecoveryRecordV1 | null => {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(source));
    if (!parsed.success) return null;
    const report = gcV1Codec.decode(`${JSON.stringify(parsed.data.approvedReport, null, 2)}\n`);
    const { revision, ...seed } = parsed.data;
    const actionIds = new Set(parsed.data.actions.map(({ actionId }) => actionId));
    const reportActions = new Map(
      report.ok
        ? report.value.actions
            .filter(({ kind }) => kind === 'reclaim-store')
            .map((action) => [action.actionId, action])
        : [],
    );
    const outcomesValid = parsed.data.actions.every((action) => {
      const publicAction = reportActions.get(action.actionId);
      const identityValid =
        action.outcome === 'pending' || action.outcome === 'protected-skip'
          ? action.containerIdentity === null && action.payloadIdentity === null
          : action.outcome === 'prepared'
            ? action.containerIdentity !== null && action.payloadIdentity === null
            : action.containerIdentity !== null && action.payloadIdentity !== null;
      return (
        identityValid &&
        action.path === action.object.path &&
        action.contentHash === action.object.contentHash &&
        action.modifiedAt === action.object.modifiedAt &&
        action.logicalBytes === action.object.logicalBytes &&
        action.containerPath ===
          join(
            parsed.data.storeRoot,
            '.gc-tombstones',
            'v1',
            parsed.data.planId,
            action.actionId,
          ) &&
        action.payloadPath === join(action.containerPath, 'payload') &&
        !relative(parsed.data.storeRoot, action.path).startsWith('..') &&
        relative(parsed.data.storeRoot, action.path) !== '' &&
        publicAction?.target === action.path &&
        publicAction.logicalBytes === action.logicalBytes
      );
    });
    const phaseValid =
      parsed.data.phase === 'complete'
        ? parsed.data.actions.every(
            ({ outcome }) => outcome === 'cleaned' || outcome === 'protected-skip',
          )
        : parsed.data.phase === 'approved' || parsed.data.phase === 'migration-complete'
          ? parsed.data.actions.every(({ outcome }) => outcome === 'pending')
          : true;
    const retryArguments = [
      'gc',
      ...(report.ok && report.value.olderThan !== null
        ? ['--older-than', report.value.olderThan.input]
        : []),
      ...parsed.data.normalizedForgetRoots.flatMap((root) => ['--forget-project', root]),
      '--yes',
    ];
    const reportForgetRoots = report.ok
      ? report.value.projects
          .filter(({ action }) => action === 'forget-project')
          .map(({ root }) => root)
      : [];
    const duration =
      report.ok && report.value.olderThan !== null
        ? {
            input: report.value.olderThan.input,
            milliseconds: report.value.olderThan.milliseconds,
          }
        : null;
    return report.ok &&
      report.value.planId === parsed.data.planId &&
      report.value.migration.sourceVersion === parsed.data.sourceLedger.sourceVersion &&
      parsed.data.requestDigest === gcRequestDigest(duration, parsed.data.normalizedForgetRoots) &&
      JSON.stringify(parsed.data.retryArguments) === JSON.stringify(retryArguments) &&
      JSON.stringify(reportForgetRoots) === JSON.stringify(parsed.data.normalizedForgetRoots) &&
      actionIds.size === parsed.data.actions.length &&
      reportActions.size === parsed.data.actions.length &&
      outcomesValid &&
      phaseValid &&
      [parsed.data.dataDir, parsed.data.storeRoot, parsed.data.ledgerPath].every(isAbsolute) &&
      new Set(parsed.data.normalizedForgetRoots).size ===
        parsed.data.normalizedForgetRoots.length &&
      parsed.data.normalizedForgetRoots.every(isAbsolute) &&
      revision === gcRecoveryRevision(seed)
      ? (parsed.data as unknown as GcRecoveryRecordV1)
      : null;
  } catch {
    return null;
  }
};

export const observeGcRecovery = async (
  ports: RecoveryPorts,
  dataDir: string,
): Promise<GcRecoveryObservation> => {
  const root = recoveryRootOf(dataDir);
  if ((await ports.pathKind(root)) === 'absent') {
    return Object.freeze({ state: 'none', record: null, path: root });
  }
  if (!(await secureDirectory(ports, root, 0o700))) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path: root,
      reason: 'GC recovery directory ownership or mode is unsafe',
    });
  }
  const names = [...(await ports.listDir(root))].sort();
  if (names.length === 0) return Object.freeze({ state: 'none', record: null, path: root });
  if (names.length !== 1 || !/^([0-9a-f]{64})\.json$/u.test(names[0] ?? '')) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path: root,
      reason: 'GC recovery namespace contains unexpected or competing state',
    });
  }
  const path = join(root, names[0] as string);
  if (!(await secureFile(ports, path))) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path,
      reason: 'GC recovery record ownership, mode, or identity is unsafe',
    });
  }
  const source = await ports.readText(path).catch(() => '');
  const record = parseRecord(source);
  if (record === null || names[0] !== `${record.planId}.json` || canonical(record) !== source) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path,
      reason: 'GC recovery record is malformed or noncanonical',
    });
  }
  return Object.freeze({ state: 'pending', record: Object.freeze(record), path });
};

const ensureDirectory = async (
  ports: RecoveryPorts,
  path: string,
  mode: number,
): Promise<boolean> => {
  if ((await ports.pathKind(path)) === 'absent') {
    await ports.makeDirExclusive(path, mode).catch(() => {});
  }
  return secureDirectory(ports, path, mode);
};

export const createGcRecoveryRecord = async (
  ports: RecoveryPorts,
  dataDir: string,
  record: GcRecoveryRecordV1,
): Promise<GcRecoveryObservation> => {
  if (parseRecord(canonical(record)) === null) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path: recoveryRootOf(dataDir),
      reason: 'GC recovery record request is invalid',
    });
  }
  const dataMetadata = await ports.readFileMetadata(dataDir).catch(() => null);
  const effective = ports.effectiveUserIdentity();
  if (
    dataMetadata?.kind !== 'dir' ||
    dataMetadata.identity === null ||
    dataMetadata.mode === null ||
    (dataMetadata.mode & 0o022) !== 0 ||
    effective.uid === null ||
    dataMetadata.uid !== effective.uid
  ) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path: recoveryRootOf(dataDir),
      reason: 'GC data directory ownership or mode is unsafe',
    });
  }
  if ((await ports.realpath(dataDir).catch(() => '')) !== dataDir) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path: recoveryRootOf(dataDir),
      reason: 'GC data directory must be a stable canonical real directory',
    });
  }
  const parent = join(dataDir, '.gc-recovery');
  const root = recoveryRootOf(dataDir);
  if (
    !(await ensureDirectory(ports, parent, 0o700)) ||
    !(await ensureDirectory(ports, root, 0o700))
  ) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path: root,
      reason: 'GC recovery directory could not be established securely',
    });
  }
  const live = join(root, `${record.planId}.json`);
  if ((await ports.pathKind(live)) !== 'absent') {
    return Object.freeze({
      state: 'refused',
      record: null,
      path: live,
      reason: 'GC recovery record already exists',
    });
  }
  const cas = casId(ports);
  if (!HEX16.test(cas)) throw new TypeError('GC CAS ID invariant failed');
  const temp = join(root, `.${record.planId}.create-${record.revision}-${cas}.tmp`);
  const source = canonical(record);
  try {
    await ports.writeTextFileExclusive(temp, source, 0o600);
    await ports.fsyncFile(temp);
    if (!(await secureFile(ports, temp)) || (await ports.readText(temp)) !== source)
      throw new Error();
    await ports.fsyncDir(root);
    if ((await ports.pathKind(live)) !== 'absent') throw new Error();
    await ports.rename(temp, live);
    await ports.fsyncDir(root);
  } catch {
    await ports.removeTree(temp).catch(() => {});
    return Object.freeze({
      state: 'refused',
      record: null,
      path: live,
      reason: 'GC recovery record publication failed',
    });
  }
  return Object.freeze({ state: 'pending', record: Object.freeze(record), path: live });
};

const actionStatic = ({
  outcome: _outcome,
  containerIdentity: _containerIdentity,
  payloadIdentity: _payloadIdentity,
  ...value
}: GcRecoveryRecordV1['actions'][number]) => value;

const recordStatic = ({
  revision: _revision,
  phase: _phase,
  actions,
  ...value
}: GcRecoveryRecordV1) => ({ ...value, actions: actions.map(actionStatic) });

const phaseTransition = (current: GcRecoveryPhase, next: GcRecoveryPhase): boolean =>
  current === next ||
  (current === 'approved' && (next === 'migration-complete' || next === 'forget-complete')) ||
  (current === 'migration-complete' && next === 'forget-complete') ||
  (current === 'forget-complete' && (next === 'reclaiming' || next === 'complete')) ||
  (current === 'reclaiming' && next === 'complete');

const actionTransition = (
  current: GcRecoveryRecordV1['actions'][number],
  next: GcRecoveryRecordV1['actions'][number],
): boolean => {
  if (JSON.stringify(actionStatic(current)) !== JSON.stringify(actionStatic(next))) return false;
  if (
    current.outcome === next.outcome &&
    current.containerIdentity === next.containerIdentity &&
    current.payloadIdentity === next.payloadIdentity
  ) {
    return true;
  }
  if (current.outcome === 'pending') {
    return next.outcome === 'protected-skip'
      ? next.containerIdentity === null && next.payloadIdentity === null
      : next.outcome === 'prepared' &&
          next.containerIdentity !== null &&
          next.payloadIdentity === null;
  }
  if (current.outcome === 'prepared') {
    return (
      next.outcome === 'detached' &&
      next.containerIdentity === current.containerIdentity &&
      next.payloadIdentity !== null
    );
  }
  return (
    current.outcome === 'detached' &&
    next.outcome === 'cleaned' &&
    next.containerIdentity === current.containerIdentity &&
    next.payloadIdentity === current.payloadIdentity
  );
};

const validTransition = (current: GcRecoveryRecordV1, next: GcRecoveryRecordV1): boolean => {
  if (
    JSON.stringify(recordStatic(current)) !== JSON.stringify(recordStatic(next)) ||
    !phaseTransition(current.phase, next.phase) ||
    current.actions.length !== next.actions.length
  ) {
    return false;
  }
  let changes = 0;
  for (let index = 0; index < current.actions.length; index += 1) {
    const before = current.actions[index];
    const after = next.actions[index];
    if (before === undefined || after === undefined || !actionTransition(before, after))
      return false;
    if (
      before.outcome !== after.outcome ||
      before.containerIdentity !== after.containerIdentity ||
      before.payloadIdentity !== after.payloadIdentity
    ) {
      changes += 1;
    }
  }
  return changes <= 1 && (changes === 0 || next.phase === 'reclaiming');
};

export const replaceGcRecoveryRecord = async (
  ports: RecoveryPorts,
  observation: Extract<GcRecoveryObservation, { readonly state: 'pending' }>,
  next: GcRecoveryRecordV1,
): Promise<GcRecoveryObservation> => {
  const current = observation.record;
  if (
    next.planId !== current.planId ||
    next.requestDigest !== current.requestDigest ||
    next.revision === current.revision ||
    !validTransition(current, next) ||
    parseRecord(canonical(next)) === null
  ) {
    return Object.freeze({
      state: 'refused',
      record: null,
      path: observation.path,
      reason: 'GC recovery replacement is not a valid monotonic CAS transition',
    });
  }
  const root = dirname(observation.path);
  const cas = casId(ports);
  const temp = join(root, `.${next.planId}.cas-${current.revision}-${next.revision}-${cas}.tmp`);
  const source = canonical(next);
  try {
    if ((await ports.readText(observation.path)) !== canonical(current)) throw new Error();
    await ports.writeTextFileExclusive(temp, source, 0o600);
    await ports.fsyncFile(temp);
    if (!(await secureFile(ports, temp)) || (await ports.readText(temp)) !== source)
      throw new Error();
    await ports.fsyncDir(root);
    if ((await ports.readText(observation.path)) !== canonical(current)) throw new Error();
    await ports.rename(temp, observation.path);
    await ports.fsyncDir(root);
  } catch {
    await ports.removeTree(temp).catch(() => {});
    return Object.freeze({
      state: 'refused',
      record: null,
      path: observation.path,
      reason: 'GC recovery CAS replacement failed',
    });
  }
  return Object.freeze({ state: 'pending', record: Object.freeze(next), path: observation.path });
};

export const removeGcRecoveryRecord = async (
  ports: RecoveryPorts,
  observation: Extract<GcRecoveryObservation, { readonly state: 'pending' }>,
): Promise<boolean> => {
  if ((await ports.readText(observation.path).catch(() => '')) !== canonical(observation.record)) {
    return false;
  }
  await ports.removeTree(observation.path);
  await ports.fsyncDir(dirname(observation.path));
  return (await ports.pathKind(observation.path)) === 'absent';
};

export const gcRecoveryRevision = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
