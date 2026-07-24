import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  EffectiveUserPort,
  ExclusiveCreatePort,
  FileMetadataReadPort,
  FileReadPort,
  FileWritePort,
  IdPort,
} from '../ports/types.ts';
import type { GcRecoveryObservation, GcRecoveryPhase, GcRecoveryRecordV1 } from './types.ts';

type RecoveryPorts = EffectiveUserPort &
  ExclusiveCreatePort &
  FileMetadataReadPort &
  Pick<FileReadPort, 'listDir' | 'pathKind' | 'readText'> &
  Pick<FileWritePort, 'fsyncDir' | 'fsyncFile' | 'removeTree' | 'rename'> &
  IdPort;

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX16 = /^[0-9a-f]{16}$/u;
const IdSchema = z.string().regex(HEX64);
const ActionSchema = z
  .object({
    actionId: IdSchema,
    kind: z.literal('reclaim-store'),
    path: z.string().min(1),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    modifiedAt: z.number().finite(),
    logicalBytes: z.number().int().nonnegative(),
    ownershipToken: IdSchema,
    containerPath: z.string().min(1),
    payloadPath: z.string().min(1),
    outcome: z.enum(['pending', 'detached', 'cleaned', 'protected-skip']),
  })
  .strict();
const RecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.gc-recovery'),
    planId: IdSchema,
    requestDigest: IdSchema,
    revision: IdSchema,
    phase: z.enum(['approved', 'forget-complete', 'reclaiming', 'complete']),
    retryArguments: z.array(z.string()),
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
      retryArguments: [...record.retryArguments],
      actions: record.actions.map((action) => ({
        actionId: action.actionId,
        kind: action.kind,
        path: action.path,
        contentHash: action.contentHash,
        modifiedAt: action.modifiedAt,
        logicalBytes: action.logicalBytes,
        ownershipToken: action.ownershipToken,
        containerPath: action.containerPath,
        payloadPath: action.payloadPath,
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
    return parsed.success ? (parsed.data as GcRecoveryRecordV1) : null;
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
  if (!RecordSchema.safeParse(record).success) {
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

const nextPhase = (current: GcRecoveryPhase, next: GcRecoveryPhase): boolean => {
  const order: readonly GcRecoveryPhase[] = [
    'approved',
    'forget-complete',
    'reclaiming',
    'complete',
  ];
  return order.indexOf(next) >= order.indexOf(current);
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
    !nextPhase(current.phase, next.phase) ||
    !RecordSchema.safeParse(next).success
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
