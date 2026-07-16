import { createHash, randomBytes } from 'node:crypto';
// eslint-disable-next-line skillsmith/capability-ownership -- Focused private durable ledger adapter.
import { constants } from 'node:fs';
// eslint-disable-next-line skillsmith/capability-ownership -- Focused private durable ledger adapter.
import { copyFile, lstat, mkdir, open, rename, rm, rmdir, unlink } from 'node:fs/promises';
// eslint-disable-next-line skillsmith/capability-ownership -- Account identity is owned by this focused adapter.
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  FileMetadata,
  FileMetadataReadPort,
  FileModeWritePort,
  FileReadPort,
  FileWritePort,
} from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { ArtifactDigest } from './hash.ts';
import type { LogicalJournalV1Dto } from './journal-types.ts';
import { cleanupHistoryVictim, selectBoundedHistory } from './ledger-history.ts';
import type {
  LedgerMigrationJournalSequence,
  LedgerModel,
  LedgerReadState,
} from './ledger-types.ts';
import {
  fromLedgerV2Dto,
  ledgerByteRevision,
  ledgerSemanticRevision,
  resolveLedgerArtifactCodec,
  toLedgerV2Dto,
} from './registry.ts';

const ledgerV2Codec = resolveLedgerArtifactCodec(2);

export type LedgerMigrationCursor =
  | 'prepared'
  | 'staged'
  | 'backed-up'
  | 'replaced'
  | 'handed-off'
  | 'committed'
  | 'cleanup';

export type LedgerWriterBarrierKind =
  | 'recovery-pointer-prepared-write'
  | 'recovery-pointer-prepared-fsync'
  | 'migration-stage-write'
  | 'migration-stage-fsync'
  | 'migration-backup-copy'
  | 'migration-backup-fsync'
  | 'migration-backed-up-replace'
  | 'migration-backed-up-fsync'
  | 'migration-live-replace'
  | 'migration-live-parent-fsync'
  | 'migration-handoff-write'
  | 'migration-handoff-fsync'
  | 'migration-commit-write'
  | 'migration-commit-fsync'
  | 'migration-backup-cleanup'
  | 'migration-stage-cleanup'
  | 'migration-directory-cleanup'
  | 'migration-pointer-cleanup'
  | 'history-backup-cleanup'
  | 'writer-stage-write'
  | 'writer-stage-fsync'
  | 'writer-live-replace'
  | 'writer-live-parent-fsync';

export interface LedgerWriterBarrier {
  readonly kind: LedgerWriterBarrierKind;
}

export interface LedgerWriterError {
  readonly code: 'invalid-state' | 'stale-state' | 'permission-denied' | 'filesystem-failure';
  readonly path: string;
}

export interface LedgerWriteReceipt {
  readonly model: LedgerModel;
  readonly byteRevision: ArtifactDigest;
  readonly semanticRevision: ArtifactDigest;
  readonly changed: boolean;
}

export interface LedgerReplaceRequest {
  readonly model: LedgerModel;
  readonly expectedByteRevision: ArtifactDigest | null;
}

export interface LedgerMigrationRequest {
  readonly expectedSourceByteRevision: ArtifactDigest;
  readonly expectedSourceSemanticRevision: ArtifactDigest;
  readonly journals: LedgerMigrationJournalSequence;
}

export interface LedgerMigrationReceipt extends LedgerWriteReceipt {
  readonly transactionId: string;
  readonly resumed: boolean;
}

export interface LedgerWriterOptions {
  readonly nextId?: (purpose: 'stage' | 'cas' | 'owner') => string;
  readonly afterBarrier?: (barrier: LedgerWriterBarrier) => Promise<void>;
  readonly ports?: LedgerWriterPorts;
  readonly signal?: AbortSignal;
}

export type LedgerWriterPorts = Pick<FileReadPort, 'pathKind' | 'readBytes'> &
  FileMetadataReadPort &
  Pick<
    FileWritePort,
    'makeDir' | 'writeTextFile' | 'rename' | 'copyTree' | 'removeTree' | 'fsyncFile' | 'fsyncDir'
  > &
  FileModeWritePort;

export interface LedgerWriter {
  readonly ledgerPath: string;
  readonly recoveryPointerPath: string;
  read(): Promise<Result<LedgerReadState, LedgerWriterError>>;
  replace(request: LedgerReplaceRequest): Promise<Result<LedgerWriteReceipt, LedgerWriterError>>;
  finalizeHistory(
    request: LedgerReplaceRequest,
  ): Promise<Result<LedgerWriteReceipt, LedgerWriterError>>;
  recoverMigration(): Promise<Result<LedgerMigrationReceipt | null, LedgerWriterError>>;
  migrateV1ToV2(
    request: LedgerMigrationRequest,
  ): Promise<Result<LedgerMigrationReceipt, LedgerWriterError>>;
}

interface MigrationRevisions {
  readonly pure: ArtifactDigest;
  readonly staged: ArtifactDigest;
  readonly backedUp: ArtifactDigest;
  readonly live: ArtifactDigest;
  readonly committed: ArtifactDigest;
}

interface LedgerMigrationRecoveryRecord {
  readonly kind: 'skillsmith-ledger-migration-recovery';
  readonly schemaVersion: 1;
  readonly key: string;
  readonly ownerToken: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly ledgerPath: string;
  readonly ledgerParent: string;
  readonly sourceByteRevision: ArtifactDigest;
  readonly sourceSemanticRevision: ArtifactDigest;
  readonly targetSemanticRevision: ArtifactDigest;
  readonly revisions: MigrationRevisions;
  readonly journals: LedgerMigrationJournalSequence;
  readonly transactionDirectoryBasename: string;
  readonly transactionDirectoryIdentity: string | null;
  readonly stageBasename: 'ledger.stage';
  readonly stageFileIdentity: string | null;
  readonly backupBasename: 'ledger.v1.backup';
  readonly backupFileIdentity: string | null;
  readonly cursor: LedgerMigrationCursor;
}

interface PointerEnvelope {
  readonly record: LedgerMigrationRecoveryRecord;
  readonly revision: ArtifactDigest;
}

const CURSORS: ReadonlySet<string> = new Set([
  'prepared',
  'staged',
  'backed-up',
  'replaced',
  'handed-off',
  'committed',
  'cleanup',
]);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const KEY = /^v1-[0-9a-f]{64}$/u;
const TX_DIRECTORY = /^v1-[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

const failure = (code: LedgerWriterError['code'], path: string): LedgerWriterError => ({
  code,
  path,
});
const nodeCode = (value: unknown): string | null =>
  typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code
    : null;
const mapNodeError = (value: unknown, path: string): LedgerWriterError => {
  const code = nodeCode(value);
  if (code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError') throw value;
  if (
    code === 'invalid-state' ||
    code === 'stale-state' ||
    code === 'permission-denied' ||
    code === 'filesystem-failure'
  ) {
    return value as LedgerWriterError;
  }
  return code === 'EACCES' || code === 'EPERM'
    ? failure('permission-denied', path)
    : failure('filesystem-failure', path);
};
const digestBytes = (bytes: Uint8Array): ArtifactDigest => ledgerByteRevision(bytes);
const rawDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

export const ledgerRecoveryKey = (ledgerPath: string): string =>
  `v1-${rawDigest(resolve(ledgerPath))}`;

const exactKeys = (value: object, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validJournalSequence = (value: unknown): value is LedgerMigrationJournalSequence => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['prepared', 'staged', 'backedUp', 'live', 'committed'])
  ) {
    return false;
  }
  const journals = [value.prepared, value.staged, value.backedUp, value.live, value.committed];
  if (!journals.every(isRecord)) return false;
  const typed = journals as unknown as LogicalJournalV1Dto[];
  const phases = ['prepared', 'staged', 'backed-up', 'live', 'committed'];
  const seed = typed[0];
  return (
    seed !== undefined &&
    typed.every(
      (journal, index) =>
        journal.kind === 'skillsmith.transaction-journal' &&
        journal.schemaVersion === 1 &&
        journal.phase === phases[index] &&
        journal.transactionId === seed.transactionId &&
        journal.intent.operationId === seed.intent.operationId &&
        journal.intent.kind === 'migrate-ledger' &&
        journal.intent.pairId === null &&
        journal.intent.skill === null &&
        journal.intent.source === null &&
        journal.intent.tool === null &&
        journal.intent.scope === null &&
        journal.context.startedAt === seed.context.startedAt &&
        journal.actual.retained.length === 0 &&
        journal.intent.reversibility.kind === 'none',
    )
  );
};

export const ownLedgerMigrationRecoveryRecord = (
  value: unknown,
): Result<LedgerMigrationRecoveryRecord, LedgerWriterError> => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'kind',
      'schemaVersion',
      'key',
      'ownerToken',
      'transactionId',
      'operationId',
      'ledgerPath',
      'ledgerParent',
      'sourceByteRevision',
      'sourceSemanticRevision',
      'targetSemanticRevision',
      'revisions',
      'journals',
      'transactionDirectoryBasename',
      'transactionDirectoryIdentity',
      'stageBasename',
      'stageFileIdentity',
      'backupBasename',
      'backupFileIdentity',
      'cursor',
    ]) ||
    value.kind !== 'skillsmith-ledger-migration-recovery' ||
    value.schemaVersion !== 1 ||
    typeof value.key !== 'string' ||
    !KEY.test(value.key) ||
    typeof value.ownerToken !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.ownerToken) ||
    typeof value.transactionId !== 'string' ||
    value.transactionId.length === 0 ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    typeof value.ledgerPath !== 'string' ||
    typeof value.ledgerParent !== 'string' ||
    typeof value.sourceByteRevision !== 'string' ||
    !DIGEST.test(value.sourceByteRevision) ||
    typeof value.sourceSemanticRevision !== 'string' ||
    !DIGEST.test(value.sourceSemanticRevision) ||
    typeof value.targetSemanticRevision !== 'string' ||
    !DIGEST.test(value.targetSemanticRevision) ||
    !isRecord(value.revisions) ||
    !exactKeys(value.revisions, ['pure', 'staged', 'backedUp', 'live', 'committed']) ||
    !Object.values(value.revisions).every((revision) =>
      typeof revision === 'string' ? DIGEST.test(revision) : false,
    ) ||
    !validJournalSequence(value.journals) ||
    typeof value.transactionDirectoryBasename !== 'string' ||
    !TX_DIRECTORY.test(value.transactionDirectoryBasename) ||
    !(
      value.transactionDirectoryIdentity === null ||
      (typeof value.transactionDirectoryIdentity === 'string' &&
        /^[0-9]+:[0-9]+$/u.test(value.transactionDirectoryIdentity))
    ) ||
    value.stageBasename !== 'ledger.stage' ||
    !(
      value.stageFileIdentity === null ||
      (typeof value.stageFileIdentity === 'string' &&
        /^[0-9]+:[0-9]+$/u.test(value.stageFileIdentity))
    ) ||
    value.backupBasename !== 'ledger.v1.backup' ||
    !(
      value.backupFileIdentity === null ||
      (typeof value.backupFileIdentity === 'string' &&
        /^[0-9]+:[0-9]+$/u.test(value.backupFileIdentity))
    ) ||
    typeof value.cursor !== 'string' ||
    !CURSORS.has(value.cursor)
  ) {
    return err(failure('invalid-state', 'ledger-recovery-record'));
  }
  return ok(Object.freeze(value as unknown as LedgerMigrationRecoveryRecord));
};

const syncPath = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const safeRead = async (path: string): Promise<Uint8Array | null> => {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw failure('invalid-state', path);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw failure('invalid-state', path);
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) {
      throw failure('invalid-state', path);
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

const decodeLedgerState = (
  bytes: Uint8Array | null,
): Result<LedgerReadState, LedgerWriterError> => {
  if (bytes === null) {
    return ok({
      state: 'absent',
      sourceVersion: null,
      bytes: null,
      byteRevision: null,
      semanticRevision: null,
      model: null,
    });
  }
  const decoded = ledgerV2Codec.decode(bytes);
  if (!decoded.ok) return err(failure('invalid-state', 'ledger'));
  if (decoded.value.source.kind !== 'version') return err(failure('invalid-state', 'ledger'));
  const sourceVersion = decoded.value.source.version;
  if (sourceVersion !== 1 && sourceVersion !== 2) {
    return err(failure('invalid-state', 'ledger'));
  }
  const semantic = ledgerSemanticRevision(decoded.value.model);
  if (!semantic.ok) return err(failure('invalid-state', 'ledger'));
  return ok({
    state: 'present',
    sourceVersion,
    bytes: new Uint8Array(bytes),
    byteRevision: digestBytes(bytes),
    semanticRevision: semantic.value,
    model: decoded.value.model,
  });
};

const encodedModel = (
  model: LedgerModel,
): Result<Readonly<{ model: LedgerModel; bytes: Uint8Array }>, LedgerWriterError> => {
  const dto = toLedgerV2Dto(model);
  if (!dto.ok) return err(failure('invalid-state', 'ledger'));
  const owned = fromLedgerV2Dto(dto.value);
  if (!owned.ok) return err(failure('invalid-state', 'ledger'));
  const bytes = ledgerV2Codec.encode(owned.value);
  return bytes.ok
    ? ok({ model: owned.value, bytes: bytes.value })
    : err(failure('invalid-state', 'ledger'));
};

const withPending = (
  base: LedgerModel,
  journal: LogicalJournalV1Dto,
): Result<LedgerModel, LedgerWriterError> => {
  const dto = toLedgerV2Dto(base);
  if (!dto.ok) return err(failure('invalid-state', 'ledger'));
  const value = fromLedgerV2Dto({
    ...dto.value,
    transactions: { ...dto.value.transactions, [journal.transactionId]: journal },
  });
  return value.ok ? ok(value.value) : err(failure('invalid-state', 'ledger'));
};

const withCommitted = (
  base: LedgerModel,
  journal: LogicalJournalV1Dto,
): Result<LedgerModel, LedgerWriterError> => {
  const dto = toLedgerV2Dto(base);
  if (!dto.ok) return err(failure('invalid-state', 'ledger'));
  const transactions = { ...dto.value.transactions };
  Reflect.deleteProperty(transactions, journal.transactionId);
  const existing = dto.value.history.find(
    (candidate) => candidate.transactionId === journal.transactionId,
  );
  const history = existing === undefined ? [...dto.value.history, journal] : dto.value.history;
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(journal)) {
    return err(failure('invalid-state', 'ledger'));
  }
  const value = fromLedgerV2Dto({ ...dto.value, transactions, history });
  return value.ok ? ok(value.value) : err(failure('invalid-state', 'ledger'));
};

const pointerBytes = (record: LedgerMigrationRecoveryRecord): Uint8Array =>
  encoder.encode(`${JSON.stringify(record, null, 2)}\n`);

const parsePointer = (
  bytes: Uint8Array,
): Result<LedgerMigrationRecoveryRecord, LedgerWriterError> => {
  try {
    return ownLedgerMigrationRecoveryRecord(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    return err(failure('invalid-state', 'ledger-recovery-record'));
  }
};

const directoryIdentity = async (path: string): Promise<string> => {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw failure('invalid-state', path);
  return `${value.dev}:${value.ino}`;
};

const regularFileIdentity = async (path: string): Promise<string> => {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) {
    throw failure('invalid-state', path);
  }
  return `${value.dev}:${value.ino}`;
};

const ensureNodePrivateDirectory = async (path: string): Promise<void> => {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (nodeCode(error) !== 'EEXIST') throw error;
  }
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw failure('invalid-state', path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isDirectory()) {
      throw failure('invalid-state', path);
    }
    const accountUid = userInfo().uid;
    if (accountUid >= 0 && opened.uid !== accountUid) {
      throw failure('invalid-state', path);
    }
    if (created || (opened.mode & 0o777) !== 0o700) await handle.chmod(0o700);
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !after.isDirectory() ||
      (after.mode & 0o777) !== 0o700
    ) {
      throw failure('invalid-state', path);
    }
  } finally {
    await handle.close();
  }
};

interface LedgerWriterOpenFile {
  readonly write: (bytes: Uint8Array) => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface LedgerWriterIo {
  readonly readRegular: (path: string) => Promise<Uint8Array | null>;
  readonly readFileMetadata: (path: string) => Promise<FileMetadata>;
  readonly makePrivateDirectory: (path: string) => Promise<void>;
  readonly directoryIdentity: (path: string) => Promise<string | null>;
  readonly regularFileIdentity: (path: string) => Promise<string | null>;
  readonly openExclusive: (path: string, mode: number) => Promise<LedgerWriterOpenFile>;
  readonly copyExclusive: (from: string, to: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly removeDirectory: (path: string) => Promise<void>;
  readonly removeIfPresent: (path: string) => Promise<void>;
  readonly syncFile: (path: string) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<void>;
}

const nodeLedgerWriterIo = (): LedgerWriterIo => ({
  readRegular: safeRead,
  readFileMetadata: async (path) => {
    try {
      const value = await lstat(path);
      return {
        kind: value.isSymbolicLink()
          ? 'symlink'
          : value.isDirectory()
            ? 'dir'
            : value.isFile()
              ? 'file'
              : 'other',
        mode: value.mode & 0o7777,
        identity: `${value.dev}:${value.ino}`,
        linkCount: value.nlink,
      };
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') {
        return { kind: 'absent', mode: null, identity: null, linkCount: 0 };
      }
      throw error;
    }
  },
  makePrivateDirectory: ensureNodePrivateDirectory,
  directoryIdentity: async (path) => {
    try {
      return await directoryIdentity(path);
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
  regularFileIdentity: async (path) => {
    try {
      return await regularFileIdentity(path);
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
  openExclusive: async (path, mode) => {
    const handle = await open(path, 'wx', mode);
    return {
      write: async (bytes) => handle.writeFile(bytes),
      sync: async () => handle.sync(),
      close: async () => handle.close(),
    };
  },
  copyExclusive: async (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
  rename,
  removeFile: unlink,
  removeDirectory: rmdir,
  removeIfPresent: async (path) => rm(path, { force: true }),
  syncFile: syncPath,
  syncDirectory: syncPath,
});

const portLedgerWriterIo = (ports: LedgerWriterPorts, assertActive: () => void): LedgerWriterIo => {
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => operation();
  return {
    readRegular: async (path) => {
      assertActive();
      const kind = await ports.pathKind(path);
      if (kind === 'absent') return null;
      if (kind !== 'file') throw failure('invalid-state', path);
      const before = await ports.readFileMetadata(path);
      if (before.kind !== 'file' || before.identity === null) throw failure('invalid-state', path);
      const bytes = new Uint8Array(await ports.readBytes(path));
      const after = await ports.readFileMetadata(path);
      if (after.kind !== 'file' || after.identity !== before.identity) {
        throw failure('stale-state', path);
      }
      assertActive();
      return bytes;
    },
    readFileMetadata: async (path) => {
      assertActive();
      const metadata = await ports.readFileMetadata(path);
      assertActive();
      return metadata;
    },
    makePrivateDirectory: async (path) => {
      const before = await ports.readFileMetadata(path);
      const created = before.kind === 'absent';
      if (!created && before.kind !== 'dir') throw failure('invalid-state', path);
      if (created) await mutate(() => ports.makeDir(path));
      const opened = await ports.readFileMetadata(path);
      if (opened.kind !== 'dir' || opened.identity === null) throw failure('invalid-state', path);
      if (!created && before.identity !== opened.identity) throw failure('stale-state', path);
      if (created || opened.mode !== 0o700) await mutate(() => ports.setFileMode(path, 0o700));
      const after = await ports.readFileMetadata(path);
      if (after.kind !== 'dir' || after.identity !== opened.identity || after.mode !== 0o700) {
        throw failure('stale-state', path);
      }
    },
    directoryIdentity: async (path) => {
      assertActive();
      const metadata = await ports.readFileMetadata(path);
      if (metadata.kind === 'absent') return null;
      if (metadata.kind !== 'dir' || metadata.identity === null) {
        throw failure('invalid-state', path);
      }
      return metadata.identity;
    },
    regularFileIdentity: async (path) => {
      assertActive();
      const metadata = await ports.readFileMetadata(path);
      if (metadata.kind === 'absent') return null;
      if (metadata.kind !== 'file' || metadata.identity === null) {
        throw failure('invalid-state', path);
      }
      return metadata.identity;
    },
    openExclusive: async (path, _mode) => {
      assertActive();
      if ((await ports.pathKind(path)) !== 'absent') {
        throw Object.assign(new Error('exclusive ledger stage already exists'), { code: 'EEXIST' });
      }
      return {
        write: (bytes) =>
          mutate(() =>
            ports.writeTextFile(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          ),
        sync: () => mutate(() => ports.fsyncFile(path)),
        close: async () => {},
      };
    },
    copyExclusive: async (from, to) => {
      assertActive();
      if ((await ports.pathKind(to)) !== 'absent') {
        throw Object.assign(new Error('exclusive ledger backup already exists'), {
          code: 'EEXIST',
        });
      }
      await mutate(() => ports.copyTree(from, to));
    },
    rename: (from, to) => mutate(() => ports.rename(from, to)),
    removeFile: (path) => mutate(() => ports.removeTree(path)),
    removeDirectory: (path) => mutate(() => ports.removeTree(path)),
    removeIfPresent: async (path) => {
      assertActive();
      if ((await ports.pathKind(path)) !== 'absent') await mutate(() => ports.removeTree(path));
    },
    syncFile: (path) => mutate(() => ports.fsyncFile(path)),
    syncDirectory: (path) => mutate(() => ports.fsyncDir(path)),
  };
};

export interface LedgerMigrationRecoveryDecision {
  readonly action:
    | 'resume-stage'
    | 'promote-staged'
    | 'resume-backup'
    | 'promote-backed-up'
    | 'resume-replace'
    | 'promote-replaced'
    | 'resume-handoff'
    | 'promote-handoff'
    | 'resume-commit'
    | 'promote-committed'
    | 'resume-cleanup'
    | 'finish-cleanup';
  readonly authority: 'old-v1' | 'new-v2';
  readonly authoritativeByteRevision: string;
  readonly authoritativeSemanticRevision: string;
  readonly authoritativeBytes: string;
}

interface LedgerMigrationMatrixState {
  readonly cursor: LedgerMigrationCursor;
  readonly livePhase: null | 'backed-up' | 'live' | 'committed';
  readonly stagePhase: 'absent' | 'staged' | 'backed-up';
  readonly backupPresent: boolean;
  readonly directoryPresent: boolean;
}

const decideLedgerMigrationAction = (
  state: LedgerMigrationMatrixState,
): LedgerMigrationRecoveryDecision['action'] | null => {
  const { cursor, livePhase, stagePhase, backupPresent, directoryPresent } = state;
  if (cursor === 'prepared' && livePhase === null && !backupPresent) {
    return stagePhase === 'absent'
      ? 'resume-stage'
      : stagePhase === 'staged' && directoryPresent
        ? 'promote-staged'
        : null;
  }
  if (cursor === 'staged' && livePhase === null && directoryPresent) {
    return !backupPresent
      ? stagePhase === 'staged'
        ? 'resume-backup'
        : null
      : stagePhase === 'staged' || stagePhase === 'backed-up'
        ? 'promote-backed-up'
        : null;
  }
  if (cursor === 'backed-up' && backupPresent && directoryPresent) {
    return livePhase === null
      ? stagePhase === 'backed-up'
        ? 'resume-replace'
        : null
      : livePhase === 'backed-up' && stagePhase === 'absent'
        ? 'promote-replaced'
        : null;
  }
  if (cursor === 'replaced' && backupPresent && directoryPresent && stagePhase === 'absent') {
    return livePhase === 'backed-up'
      ? 'resume-handoff'
      : livePhase === 'live'
        ? 'promote-handoff'
        : null;
  }
  if (cursor === 'handed-off' && backupPresent && directoryPresent && stagePhase === 'absent') {
    return livePhase === 'live'
      ? 'resume-commit'
      : livePhase === 'committed'
        ? 'promote-committed'
        : null;
  }
  if (
    cursor === 'committed' &&
    livePhase === 'committed' &&
    directoryPresent &&
    stagePhase === 'absent'
  ) {
    return 'resume-cleanup';
  }
  return cursor === 'cleanup' &&
    livePhase === 'committed' &&
    !backupPresent &&
    stagePhase === 'absent'
    ? 'finish-cleanup'
    : null;
};

/** Pure closed-matrix authority used by fixtures and by adapters before any recovery mutation. */
export const recoverLedgerMigrationState = (
  input: unknown,
  options: Readonly<{ readonly decideOnly?: boolean }> = {},
): Result<LedgerMigrationRecoveryDecision, LedgerWriterError> => {
  if (!isRecord(input) || !isRecord(input.pointer)) {
    return err(failure('invalid-state', 'ledger-recovery-record'));
  }
  const pointer = input.pointer;
  const live = input.live;
  const stage = input.stage;
  const backup = input.backup;
  const directory = input.privateDirectory;
  if (
    typeof input.operationId !== 'string' ||
    typeof input.transactionId !== 'string' ||
    typeof input.ownerToken !== 'string' ||
    typeof input.targetPath !== 'string' ||
    typeof input.sourceRevision !== 'string' ||
    pointer.state !== 'present' ||
    pointer.kind !== 'regular' ||
    pointer.linkCount !== 1 ||
    pointer.ownerToken !== input.ownerToken ||
    pointer.targetPath !== input.targetPath ||
    pointer.byteRevision !== input.actualPointerRevision ||
    pointer.sourceSemanticRevision !== input.sourceRevision ||
    pointer.transactionDirectoryBasename !== `v1-${rawDigest(input.transactionId)}` ||
    pointer.stageBasename !== 'ledger.stage' ||
    pointer.backupBasename !== 'ledger.v1.backup' ||
    !CURSORS.has(String(pointer.cursor)) ||
    !isRecord(pointer.expectedImages) ||
    !isRecord(live) ||
    !isRecord(stage) ||
    !isRecord(backup) ||
    !isRecord(directory) ||
    !Array.isArray(input.residue)
  ) {
    return err(failure('invalid-state', String(input.targetPath ?? 'ledger')));
  }
  const directoryPresent = directory.state === 'present';
  if (
    (pointer.transactionDirectoryIdentity === null
      ? directory.state !== 'absent' && !directoryPresent
      : !directoryPresent || directory.identity !== pointer.transactionDirectoryIdentity) ||
    (directoryPresent &&
      (directory.kind !== 'directory' ||
        directory.basename !== pointer.transactionDirectoryBasename ||
        typeof directory.identity !== 'string' ||
        directory.ownerToken !== input.ownerToken ||
        directory.mode !== 0o700))
  ) {
    return err(failure('invalid-state', String(input.targetPath)));
  }
  const images = pointer.expectedImages as Record<string, unknown>;
  const expectedFor = (phase: unknown): Record<string, unknown> | null => {
    if (typeof phase !== 'string') return null;
    const key =
      phase === 'staged'
        ? 'staged-v2'
        : phase === 'backed-up'
          ? 'backed-up-v2'
          : phase === 'live'
            ? 'live-v2'
            : phase === 'committed'
              ? 'committed-v2'
              : phase;
    const value = images[key];
    return isRecord(value) ? value : null;
  };
  const validateObserved = (
    value: Record<string, unknown>,
    role: 'live' | 'stage' | 'backup',
  ): boolean => {
    if (value.state === 'absent') {
      return value.kind === null && value.linkCount === 0 && value.identity === null;
    }
    if (
      typeof value.state !== 'string' ||
      value.kind !== 'regular' ||
      value.linkCount !== 1 ||
      typeof value.byteRevision !== 'string' ||
      typeof value.semanticRevision !== 'string' ||
      typeof value.bytes !== 'string' ||
      typeof value.identity !== 'string'
    ) {
      return false;
    }
    if (
      role === 'stage' &&
      pointer.stageFileIdentity !== null &&
      value.identity !== pointer.stageFileIdentity
    )
      return false;
    if (
      role === 'backup' &&
      pointer.backupFileIdentity !== null &&
      value.identity !== pointer.backupFileIdentity
    )
      return false;
    if (role === 'stage' && value.basename !== pointer.stageBasename) return false;
    if (role === 'backup' && value.basename !== pointer.backupBasename) return false;
    if (value.phase === null) {
      return (
        value.state === 'v1-source' &&
        (role === 'backup' || role === 'live') &&
        value.byteRevision === pointer.sourceByteRevision &&
        value.semanticRevision === pointer.sourceSemanticRevision
      );
    }
    const expected = expectedFor(value.phase);
    return (
      expected !== null &&
      value.state === `${String(value.phase)}-v2` &&
      value.byteRevision === expected.byteRevision &&
      value.semanticRevision === expected.semanticRevision &&
      value.bytes === expected.bytes
    );
  };
  if (!validateObserved(live, 'live')) {
    return err(failure('invalid-state', String(input.targetPath)));
  }
  if (!validateObserved(stage, 'stage')) {
    return err(failure('invalid-state', String(input.targetPath)));
  }
  if (!validateObserved(backup, 'backup')) {
    return err(failure('invalid-state', String(input.targetPath)));
  }
  const permitted = new Map<string, string | null>();
  if (directory.state === 'present')
    permitted.set('transaction-directory', String(directory.identity));
  if (stage.state !== 'absent') permitted.set('stage', String(stage.identity));
  if (backup.state !== 'absent') permitted.set('backup', String(backup.identity));
  const residue = input.residue as unknown[];
  if (residue.length !== permitted.size) {
    return err(failure('invalid-state', String(input.targetPath)));
  }
  for (const item of residue) {
    if (!isRecord(item) || typeof item.role !== 'string' || !permitted.has(item.role)) {
      return err(failure('invalid-state', String(input.targetPath)));
    }
    if (item.identity !== permitted.get(item.role)) {
      return err(failure('invalid-state', String(input.targetPath)));
    }
  }
  const livePhase = live.phase;
  const action = decideLedgerMigrationAction({
    cursor: pointer.cursor as LedgerMigrationCursor,
    livePhase: livePhase as LedgerMigrationMatrixState['livePhase'],
    stagePhase:
      stage.state === 'absent'
        ? 'absent'
        : (stage.phase as LedgerMigrationMatrixState['stagePhase']),
    backupPresent: backup.state !== 'absent',
    directoryPresent,
  });
  if (action === null) return err(failure('invalid-state', String(input.targetPath)));
  if (options.decideOnly !== true && isRecord(input.mutations)) {
    // The durable adapter owns execution; this pure function intentionally only selects authority.
  }
  return ok({
    action,
    authority: livePhase === null ? 'old-v1' : 'new-v2',
    authoritativeByteRevision: String(live.byteRevision),
    authoritativeSemanticRevision: String(live.semanticRevision),
    authoritativeBytes: String(live.bytes),
  });
};

const makeWriter = async (
  inputPath: string,
  options: LedgerWriterOptions,
): Promise<LedgerWriter> => {
  const assertActive = (): void => {
    if (options.signal?.aborted) {
      throw Object.assign(new Error('ledger writer cancelled'), { code: 'cancelled' });
    }
  };
  const io = options.ports ? portLedgerWriterIo(options.ports, assertActive) : nodeLedgerWriterIo();
  assertActive();
  const ledgerPath = resolve(inputPath);
  const ledgerParent = dirname(ledgerPath);
  const key = ledgerRecoveryKey(ledgerPath);
  const recoveryParent = join(ledgerParent, 'recovery');
  const recoveryRoot = join(recoveryParent, 'ledger');
  const transactionRoot = join(recoveryRoot, 'transactions');
  const pointerPath = join(recoveryRoot, `${key}.json`);
  await io.makePrivateDirectory(recoveryParent);
  await io.makePrivateDirectory(recoveryRoot);
  await io.makePrivateDirectory(transactionRoot);
  const after = async (kind: LedgerWriterBarrierKind): Promise<void> => {
    await options.afterBarrier?.(Object.freeze({ kind }));
    if (kind.includes('fsync') || kind.includes('cleanup')) assertActive();
  };
  const next = (purpose: 'stage' | 'cas' | 'owner'): string => {
    const value =
      options.nextId?.(purpose) ?? randomBytes(purpose === 'owner' ? 32 : 8).toString('hex');
    if (!/^[0-9a-f]{16,64}$/u.test(value)) throw failure('invalid-state', ledgerPath);
    return value;
  };
  const read = async (): Promise<Result<LedgerReadState, LedgerWriterError>> => {
    try {
      return decodeLedgerState(await io.readRegular(ledgerPath));
    } catch (error) {
      return err(mapNodeError(error, ledgerPath));
    }
  };
  const readPointer = async (): Promise<Result<PointerEnvelope | null, LedgerWriterError>> => {
    try {
      const bytes = await io.readRegular(pointerPath);
      if (bytes === null) return ok(null);
      const record = parsePointer(bytes);
      if (!record.ok) return record;
      if (
        record.value.key !== key ||
        record.value.ledgerPath !== ledgerPath ||
        record.value.ledgerParent !== ledgerParent
      ) {
        return err(failure('invalid-state', pointerPath));
      }
      return ok({ record: record.value, revision: digestBytes(bytes) });
    } catch (error) {
      return err(mapNodeError(error, pointerPath));
    }
  };
  const createPointer = async (
    record: LedgerMigrationRecoveryRecord,
  ): Promise<Result<PointerEnvelope, LedgerWriterError>> => {
    try {
      const bytes = pointerBytes(record);
      const handle = await io.openExclusive(pointerPath, 0o600);
      try {
        await handle.write(bytes);
        await after('recovery-pointer-prepared-write');
        await handle.sync();
        await after('recovery-pointer-prepared-fsync');
      } finally {
        await handle.close();
      }
      await io.syncDirectory(recoveryRoot);
      return ok({ record, revision: digestBytes(bytes) });
    } catch (error) {
      return err(mapNodeError(error, pointerPath));
    }
  };
  const replacePointer = async (
    envelope: PointerEnvelope,
    record: LedgerMigrationRecoveryRecord,
  ): Promise<Result<PointerEnvelope, LedgerWriterError>> => {
    const temp = join(recoveryRoot, `.${key}.cas-${next('cas')}.tmp`);
    try {
      const current = await io.readRegular(pointerPath);
      if (current === null || digestBytes(current) !== envelope.revision) {
        return err(failure('stale-state', pointerPath));
      }
      const bytes = pointerBytes(record);
      const handle = await io.openExclusive(temp, 0o600);
      try {
        await handle.write(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const latest = await io.readRegular(pointerPath);
      if (latest === null || digestBytes(latest) !== envelope.revision) {
        return err(failure('stale-state', pointerPath));
      }
      await io.rename(temp, pointerPath);
      await io.syncDirectory(recoveryRoot);
      return ok({ record, revision: digestBytes(bytes) });
    } catch (error) {
      await io.removeIfPresent(temp).catch(() => {});
      return err(mapNodeError(error, pointerPath));
    }
  };
  const replaceBytes = async (
    bytes: Uint8Array,
    expected: ArtifactDigest | null,
    barrierPrefix: 'writer' | 'migration-live' | 'migration-handoff' | 'migration-commit',
  ): Promise<Result<void, LedgerWriterError>> => {
    const stage = join(ledgerParent, `.placements.stage-${next('stage')}`);
    try {
      const current = await io.readRegular(ledgerPath);
      if ((current === null ? null : digestBytes(current)) !== expected) {
        return err(failure('stale-state', ledgerPath));
      }
      const handle = await io.openExclusive(stage, 0o600);
      try {
        await handle.write(bytes);
        if (barrierPrefix !== 'migration-commit') {
          await after(
            barrierPrefix === 'writer'
              ? 'writer-stage-write'
              : barrierPrefix === 'migration-live'
                ? 'migration-live-replace'
                : 'migration-handoff-write',
          );
        }
        await handle.sync();
        if (barrierPrefix !== 'migration-commit') {
          await after(
            barrierPrefix === 'writer'
              ? 'writer-stage-fsync'
              : barrierPrefix === 'migration-handoff'
                ? 'migration-handoff-fsync'
                : 'migration-live-parent-fsync',
          );
        }
      } finally {
        await handle.close();
      }
      const latest = await io.readRegular(ledgerPath);
      if ((latest === null ? null : digestBytes(latest)) !== expected) {
        return err(failure('stale-state', ledgerPath));
      }
      await io.rename(stage, ledgerPath);
      await after(
        barrierPrefix === 'writer'
          ? 'writer-live-replace'
          : barrierPrefix === 'migration-commit'
            ? 'migration-commit-write'
            : 'migration-live-replace',
      );
      await io.syncDirectory(ledgerParent);
      await after(
        barrierPrefix === 'writer'
          ? 'writer-live-parent-fsync'
          : barrierPrefix === 'migration-commit'
            ? 'migration-commit-fsync'
            : 'migration-live-parent-fsync',
      );
      return ok(undefined);
    } catch (error) {
      await io.removeIfPresent(stage).catch(() => {});
      return err(mapNodeError(error, ledgerPath));
    }
  };
  const replaceModel = async (
    request: LedgerReplaceRequest,
  ): Promise<Result<LedgerWriteReceipt, LedgerWriterError>> => {
    const recovered = await recoverMigration();
    if (!recovered.ok) return recovered;
    const encoded = encodedModel(request.model);
    if (!encoded.ok) return encoded;
    const before = await read();
    if (!before.ok) return before;
    const observed = before.value.state === 'absent' ? null : before.value.byteRevision;
    if (observed !== request.expectedByteRevision) return err(failure('stale-state', ledgerPath));
    if (before.value.state === 'present' && observed === digestBytes(encoded.value.bytes)) {
      const semantic = ledgerSemanticRevision(encoded.value.model);
      if (!semantic.ok) return err(failure('invalid-state', ledgerPath));
      return ok({
        model: encoded.value.model,
        byteRevision: observed,
        semanticRevision: semantic.value,
        changed: false,
      });
    }
    const written = await replaceBytes(encoded.value.bytes, observed, 'writer');
    if (!written.ok) return written;
    const semantic = ledgerSemanticRevision(encoded.value.model);
    if (!semantic.ok) return err(failure('invalid-state', ledgerPath));
    return ok({
      model: encoded.value.model,
      byteRevision: digestBytes(encoded.value.bytes),
      semanticRevision: semantic.value,
      changed: true,
    });
  };

  const historyVictimPath = (model: LedgerModel, transactionId: string | null): string => {
    if (transactionId === null) return ledgerPath;
    const journal = model.history.find((candidate) => candidate.transactionId === transactionId);
    return (
      journal?.actual.retained.find((resource) => resource.role === 'backup')?.path ?? ledgerPath
    );
  };

  const finalizeHistory = async (
    request: LedgerReplaceRequest,
  ): Promise<Result<LedgerWriteReceipt, LedgerWriterError>> => {
    const recovered = await recoverMigration();
    if (!recovered.ok) return recovered;
    const requested = encodedModel(request.model);
    if (!requested.ok) return requested;
    const durable = await read();
    if (!durable.ok) return durable;
    const durableRevision = durable.value.state === 'present' ? durable.value.byteRevision : null;
    if (durableRevision !== request.expectedByteRevision) {
      return err(failure('stale-state', ledgerPath));
    }
    if (durable.value.state === 'present') {
      const currentSelection = selectBoundedHistory(durable.value.model);
      if (!currentSelection.ok) {
        return err(
          failure(
            'invalid-state',
            historyVictimPath(durable.value.model, currentSelection.error.transactionId),
          ),
        );
      }
      if (
        currentSelection.value.cleanupVictim !== null &&
        digestBytes(requested.value.bytes) !== durable.value.byteRevision
      ) {
        return err(
          failure(
            'invalid-state',
            historyVictimPath(
              durable.value.model,
              currentSelection.value.cleanupVictim?.transactionId ?? null,
            ),
          ),
        );
      }
    }

    const persisted = await replaceModel(request);
    if (!persisted.ok) return persisted;
    let current = persisted.value;
    let changed = current.changed;
    for (;;) {
      const selection = selectBoundedHistory(current.model);
      if (!selection.ok) {
        return err(
          failure('invalid-state', historyVictimPath(current.model, selection.error.transactionId)),
        );
      }
      const victim = selection.value.cleanupVictim;
      if (victim === null) {
        const bounded = encodedModel(selection.value);
        if (!bounded.ok) return bounded;
        if (digestBytes(bounded.value.bytes) === current.byteRevision) {
          return ok({ ...current, changed });
        }
        const rewritten = await replaceModel({
          model: selection.value,
          expectedByteRevision: current.byteRevision,
        });
        if (!rewritten.ok) return rewritten;
        current = rewritten.value;
        changed ||= current.changed;
        continue;
      }

      const victimPath = historyVictimPath(current.model, victim.transactionId);
      let cleaned: Awaited<ReturnType<typeof cleanupHistoryVictim>>;
      try {
        cleaned = await cleanupHistoryVictim(
          {
            readFileMetadata: io.readFileMetadata,
            readBytes: async (path) => {
              const bytes = await io.readRegular(path);
              if (bytes === null) throw failure('stale-state', path);
              return bytes;
            },
            removeTree: io.removeFile,
            fsyncDir: io.syncDirectory,
          },
          current.model,
          {
            transactionId: victim.transactionId,
            ledgerRevision: current.byteRevision,
            expectedLedgerRevision: current.byteRevision,
          },
        );
      } catch (error) {
        return err(mapNodeError(error, victimPath));
      }
      if (!cleaned.ok) return err(failure('invalid-state', victimPath));
      await after('history-backup-cleanup');
      const rewritten = await replaceModel({
        model: cleaned.value,
        expectedByteRevision: current.byteRevision,
      });
      if (!rewritten.ok) return rewritten;
      current = rewritten.value;
      changed = true;
    }
  };

  const sequenceModels = (
    base: LedgerModel,
    sequence: LedgerMigrationJournalSequence,
  ): Result<
    Readonly<Record<'staged' | 'backedUp' | 'live' | 'committed', LedgerModel>>,
    LedgerWriterError
  > => {
    const staged = withPending(base, sequence.staged);
    if (!staged.ok) return staged;
    const backedUp = withPending(base, sequence.backedUp);
    if (!backedUp.ok) return backedUp;
    const live = withPending(base, sequence.live);
    if (!live.ok) return live;
    const committed = withCommitted(base, sequence.committed);
    if (!committed.ok) return committed;
    return ok({
      staged: staged.value,
      backedUp: backedUp.value,
      live: live.value,
      committed: committed.value,
    });
  };
  const sequenceBytes = (
    base: LedgerModel,
    sequence: LedgerMigrationJournalSequence,
  ): Result<
    Readonly<Record<'pure' | 'staged' | 'backedUp' | 'live' | 'committed', Uint8Array>>,
    LedgerWriterError
  > => {
    const models = sequenceModels(base, sequence);
    if (!models.ok) return models;
    const pure = encodedModel(base);
    const staged = encodedModel(models.value.staged);
    const backedUp = encodedModel(models.value.backedUp);
    const live = encodedModel(models.value.live);
    const committed = encodedModel(models.value.committed);
    if (!pure.ok) return pure;
    if (!staged.ok) return staged;
    if (!backedUp.ok) return backedUp;
    if (!live.ok) return live;
    if (!committed.ok) return committed;
    return ok({
      pure: pure.value.bytes,
      staged: staged.value.bytes,
      backedUp: backedUp.value.bytes,
      live: live.value.bytes,
      committed: committed.value.bytes,
    });
  };
  const recoverBase = async (
    record: LedgerMigrationRecoveryRecord,
  ): Promise<Result<LedgerModel, LedgerWriterError>> => {
    const transactionDirectory = join(transactionRoot, record.transactionDirectoryBasename);
    const backup = join(transactionDirectory, record.backupBasename);
    for (const path of [ledgerPath, backup]) {
      try {
        const bytes = await io.readRegular(path);
        if (bytes === null) continue;
        const decoded = ledgerV2Codec.decode(bytes);
        if (
          decoded.ok &&
          decoded.value.source.kind === 'version' &&
          decoded.value.source.version === 1
        ) {
          return ok(decoded.value.model);
        }
      } catch (error) {
        return err(mapNodeError(error, path));
      }
    }
    const current = await read();
    if (!current.ok || current.value.state === 'absent') {
      return err(failure('invalid-state', ledgerPath));
    }
    const dto = toLedgerV2Dto(current.value.model);
    if (!dto.ok) return err(failure('invalid-state', ledgerPath));
    const transactions = { ...dto.value.transactions };
    Reflect.deleteProperty(transactions, record.transactionId);
    const base = fromLedgerV2Dto({
      ...dto.value,
      transactions,
      history: dto.value.history.filter(
        (journal) => journal.transactionId !== record.transactionId,
      ),
    });
    return base.ok ? ok(base.value) : err(failure('invalid-state', ledgerPath));
  };
  const resume = async (
    initial: PointerEnvelope,
    resumed: boolean,
  ): Promise<Result<LedgerMigrationReceipt, LedgerWriterError>> => {
    let envelope = initial;
    const record = initial.record;
    const transactionDirectory = join(transactionRoot, record.transactionDirectoryBasename);
    const stage = join(transactionDirectory, record.stageBasename);
    const backup = join(transactionDirectory, record.backupBasename);
    const base = await recoverBase(record);
    if (!base.ok) return base;
    const bytes = sequenceBytes(base.value, record.journals);
    if (!bytes.ok) return bytes;
    const expected: MigrationRevisions = {
      pure: digestBytes(bytes.value.pure),
      staged: digestBytes(bytes.value.staged),
      backedUp: digestBytes(bytes.value.backedUp),
      live: digestBytes(bytes.value.live),
      committed: digestBytes(bytes.value.committed),
    };
    if (JSON.stringify(expected) !== JSON.stringify(record.revisions)) {
      return err(failure('invalid-state', pointerPath));
    }
    const transition = async (
      cursor: LedgerMigrationCursor,
      amendment: Partial<LedgerMigrationRecoveryRecord> = {},
    ): Promise<Result<void, LedgerWriterError>> => {
      const nextRecord = Object.freeze({ ...envelope.record, ...amendment, cursor });
      const nextEnvelope = await replacePointer(envelope, nextRecord);
      if (!nextEnvelope.ok) return nextEnvelope;
      envelope = nextEnvelope.value;
      return ok(undefined);
    };
    const observeAction = async (): Promise<
      Result<LedgerMigrationRecoveryDecision['action'], LedgerWriterError>
    > => {
      try {
        const live = await io.readRegular(ledgerPath);
        const staged = await io.readRegular(stage);
        const backedUp = await io.readRegular(backup);
        const directoryIdentity = await io.directoryIdentity(transactionDirectory);
        if (live === null) return err(failure('invalid-state', ledgerPath));
        const liveRevision = digestBytes(live);
        const livePhase: LedgerMigrationMatrixState['livePhase'] =
          liveRevision === record.sourceByteRevision
            ? null
            : liveRevision === expected.backedUp
              ? 'backed-up'
              : liveRevision === expected.live
                ? 'live'
                : liveRevision === expected.committed
                  ? 'committed'
                  : (() => {
                      throw failure('invalid-state', ledgerPath);
                    })();
        const stagePhase: LedgerMigrationMatrixState['stagePhase'] =
          staged === null
            ? 'absent'
            : digestBytes(staged) === expected.staged
              ? 'staged'
              : digestBytes(staged) === expected.backedUp
                ? 'backed-up'
                : (() => {
                    throw failure('invalid-state', stage);
                  })();
        if (backedUp !== null && digestBytes(backedUp) !== record.sourceByteRevision) {
          return err(failure('invalid-state', backup));
        }
        const action = decideLedgerMigrationAction({
          cursor: envelope.record.cursor,
          livePhase,
          stagePhase,
          backupPresent: backedUp !== null,
          directoryPresent: directoryIdentity !== null,
        });
        return action === null ? err(failure('invalid-state', pointerPath)) : ok(action);
      } catch (error) {
        return err(mapNodeError(error, pointerPath));
      }
    };
    while (true) {
      const observedAction = await observeAction();
      if (!observedAction.ok) return observedAction;
      const action = observedAction.value;
      if (action === 'resume-stage' || action === 'promote-staged') {
        let identity: string;
        let stageIdentity: string;
        try {
          let existingIdentity = await io.directoryIdentity(transactionDirectory);
          if (existingIdentity === null) {
            await io.makePrivateDirectory(transactionDirectory);
            existingIdentity = await io.directoryIdentity(transactionDirectory);
          }
          if (existingIdentity === null) throw failure('invalid-state', transactionDirectory);
          identity = existingIdentity;
          if (
            envelope.record.transactionDirectoryIdentity !== null &&
            envelope.record.transactionDirectoryIdentity !== identity
          ) {
            return err(failure('invalid-state', transactionDirectory));
          }
          if (envelope.record.transactionDirectoryIdentity === null) {
            const anchored = await transition('prepared', {
              transactionDirectoryIdentity: identity,
            });
            if (!anchored.ok) return err(anchored.error);
          }
          if ((await io.readRegular(backup)) !== null) {
            return err(failure('invalid-state', backup));
          }
          const existingStage = await io.readRegular(stage);
          if (existingStage === null) {
            const handle = await io.openExclusive(stage, 0o600);
            try {
              await handle.write(bytes.value.staged);
              await after('migration-stage-write');
              await handle.sync();
              await after('migration-stage-fsync');
            } finally {
              await handle.close();
            }
            await io.syncDirectory(transactionDirectory);
          } else if (digestBytes(existingStage) !== expected.staged) {
            return err(failure('invalid-state', stage));
          }
          const observedStageIdentity = await io.regularFileIdentity(stage);
          if (observedStageIdentity === null) throw failure('invalid-state', stage);
          if (
            envelope.record.stageFileIdentity !== null &&
            envelope.record.stageFileIdentity !== observedStageIdentity
          ) {
            return err(failure('invalid-state', stage));
          }
          stageIdentity = observedStageIdentity;
        } catch (error) {
          return err(mapNodeError(error, transactionDirectory));
        }
        const moved = await transition('staged', {
          transactionDirectoryIdentity: identity,
          stageFileIdentity: stageIdentity,
        });
        if (!moved.ok) return moved;
        continue;
      }
      if (action === 'resume-backup' || action === 'promote-backed-up') {
        let stageIdentity: string;
        let backupIdentity: string;
        try {
          const directoryIdentity = await io.directoryIdentity(transactionDirectory);
          if (
            directoryIdentity === null ||
            directoryIdentity !== envelope.record.transactionDirectoryIdentity
          ) {
            return err(failure('invalid-state', transactionDirectory));
          }
          const backupBytes = await io.readRegular(backup);
          if (backupBytes === null) {
            await io.copyExclusive(ledgerPath, backup);
            await after('migration-backup-copy');
            await io.syncFile(backup);
            await after('migration-backup-fsync');
            await io.syncDirectory(transactionDirectory);
          } else if (digestBytes(backupBytes) !== record.sourceByteRevision) {
            return err(failure('invalid-state', backup));
          }
          const observedBackupIdentity = await io.regularFileIdentity(backup);
          if (observedBackupIdentity === null) throw failure('invalid-state', backup);
          if (
            envelope.record.backupFileIdentity !== null &&
            envelope.record.backupFileIdentity !== observedBackupIdentity
          ) {
            return err(failure('invalid-state', backup));
          }
          backupIdentity = observedBackupIdentity;
          const staged = await io.readRegular(stage);
          if (staged === null) return err(failure('invalid-state', stage));
          const stagedIdentityBefore = await io.regularFileIdentity(stage);
          if (stagedIdentityBefore === null) throw failure('invalid-state', stage);
          if (digestBytes(staged) === expected.staged) {
            if (
              envelope.record.stageFileIdentity !== null &&
              envelope.record.stageFileIdentity !== stagedIdentityBefore
            ) {
              return err(failure('invalid-state', stage));
            }
            const temp = join(transactionDirectory, `.ledger.stage-${next('cas')}`);
            const handle = await io.openExclusive(temp, 0o600);
            try {
              await handle.write(bytes.value.backedUp);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await io.rename(temp, stage);
            await after('migration-backed-up-replace');
            await io.syncDirectory(transactionDirectory);
            await after('migration-backed-up-fsync');
          } else if (digestBytes(staged) !== expected.backedUp) {
            return err(failure('invalid-state', stage));
          }
          const observedStageIdentity = await io.regularFileIdentity(stage);
          if (observedStageIdentity === null) throw failure('invalid-state', stage);
          stageIdentity = observedStageIdentity;
        } catch (error) {
          return err(mapNodeError(error, backup));
        }
        const moved = await transition('backed-up', {
          stageFileIdentity: stageIdentity,
          backupFileIdentity: backupIdentity,
        });
        if (!moved.ok) return moved;
        continue;
      }
      if (action === 'resume-replace' || action === 'promote-replaced') {
        const directoryIdentity = await io.directoryIdentity(transactionDirectory);
        if (
          directoryIdentity === null ||
          directoryIdentity !== envelope.record.transactionDirectoryIdentity ||
          (await io.regularFileIdentity(backup)) !== envelope.record.backupFileIdentity
        ) {
          return err(failure('invalid-state', transactionDirectory));
        }
        const live = await io.readRegular(ledgerPath).catch(() => null);
        if (live === null) return err(failure('invalid-state', ledgerPath));
        if (digestBytes(live) === record.sourceByteRevision) {
          await io.rename(stage, ledgerPath);
          await after('migration-live-replace');
          await io.syncDirectory(ledgerParent);
          await after('migration-live-parent-fsync');
        } else if (digestBytes(live) !== expected.backedUp) {
          return err(failure('invalid-state', ledgerPath));
        }
        const moved = await transition('replaced');
        if (!moved.ok) return moved;
        continue;
      }
      if (action === 'resume-handoff' || action === 'promote-handoff') {
        if ((await io.regularFileIdentity(backup)) !== envelope.record.backupFileIdentity) {
          return err(failure('invalid-state', backup));
        }
        const live = await io.readRegular(ledgerPath);
        if (live === null) return err(failure('invalid-state', ledgerPath));
        if (digestBytes(live) === expected.backedUp) {
          const replaced = await replaceBytes(
            bytes.value.live,
            expected.backedUp,
            'migration-handoff',
          );
          if (!replaced.ok) return replaced;
        } else if (digestBytes(live) !== expected.live) {
          return err(failure('invalid-state', ledgerPath));
        }
        const moved = await transition('handed-off');
        if (!moved.ok) return moved;
        continue;
      }
      if (action === 'resume-commit' || action === 'promote-committed') {
        if ((await io.regularFileIdentity(backup)) !== envelope.record.backupFileIdentity) {
          return err(failure('invalid-state', backup));
        }
        const live = await io.readRegular(ledgerPath);
        if (live === null) return err(failure('invalid-state', ledgerPath));
        if (digestBytes(live) === expected.live) {
          const replaced = await replaceBytes(
            bytes.value.committed,
            expected.live,
            'migration-commit',
          );
          if (!replaced.ok) return replaced;
        } else if (digestBytes(live) !== expected.committed) {
          return err(failure('invalid-state', ledgerPath));
        }
        const moved = await transition('committed');
        if (!moved.ok) return moved;
        continue;
      }
      if (action === 'resume-cleanup') {
        try {
          const backupBytes = await io.readRegular(backup);
          if (backupBytes !== null && digestBytes(backupBytes) !== record.sourceByteRevision) {
            return err(failure('invalid-state', backup));
          }
          if (
            backupBytes !== null &&
            (await io.regularFileIdentity(backup)) !== envelope.record.backupFileIdentity
          ) {
            return err(failure('invalid-state', backup));
          }
          if (backupBytes !== null) await io.removeFile(backup);
          await io.syncDirectory(transactionDirectory);
          await after('migration-backup-cleanup');
        } catch (error) {
          return err(mapNodeError(error, backup));
        }
        const moved = await transition('cleanup');
        if (!moved.ok) return moved;
        continue;
      }
      try {
        const directoryIdentity = await io.directoryIdentity(transactionDirectory);
        if (
          directoryIdentity !== null &&
          directoryIdentity !== envelope.record.transactionDirectoryIdentity
        ) {
          return err(failure('invalid-state', transactionDirectory));
        }
        const residue = await io.readRegular(stage);
        if (residue !== null && digestBytes(residue) !== expected.backedUp) {
          return err(failure('invalid-state', stage));
        }
        if (
          residue !== null &&
          (await io.regularFileIdentity(stage)) !== envelope.record.stageFileIdentity
        ) {
          return err(failure('invalid-state', stage));
        }
        if (residue !== null) await io.removeFile(stage);
        await after('migration-stage-cleanup');
        if (directoryIdentity !== null) await io.removeDirectory(transactionDirectory);
        await io.syncDirectory(transactionRoot);
        await after('migration-directory-cleanup');
        const live = await io.readRegular(ledgerPath);
        if (live === null || digestBytes(live) !== expected.committed) {
          return err(failure('invalid-state', ledgerPath));
        }
        const currentPointer = await io.readRegular(pointerPath);
        if (currentPointer === null || digestBytes(currentPointer) !== envelope.revision) {
          return err(failure('stale-state', pointerPath));
        }
        await io.removeFile(pointerPath);
        await io.syncDirectory(recoveryRoot);
        await after('migration-pointer-cleanup');
      } catch (error) {
        return err(mapNodeError(error, pointerPath));
      }
      const committedModel = sequenceModels(base.value, record.journals);
      if (!committedModel.ok) return committedModel;
      const semantic = ledgerSemanticRevision(committedModel.value.committed);
      if (!semantic.ok) return err(failure('invalid-state', ledgerPath));
      return ok({
        model: committedModel.value.committed,
        byteRevision: expected.committed,
        semanticRevision: semantic.value,
        changed: true,
        transactionId: record.transactionId,
        resumed,
      });
    }
  };
  const recoverMigration = async (): Promise<
    Result<LedgerMigrationReceipt | null, LedgerWriterError>
  > => {
    const pointer = await readPointer();
    if (!pointer.ok) return err(pointer.error);
    if (pointer.value === null) return ok(null);
    return resume(pointer.value, true);
  };
  const migrateV1ToV2 = async (
    request: LedgerMigrationRequest,
  ): Promise<Result<LedgerMigrationReceipt, LedgerWriterError>> => {
    const existing = await readPointer();
    if (!existing.ok) return existing;
    if (existing.value !== null) return resume(existing.value, true);
    if (!validJournalSequence(request.journals)) {
      return err(failure('invalid-state', pointerPath));
    }
    const source = await read();
    if (!source.ok) return source;
    if (
      source.value.state !== 'present' ||
      source.value.sourceVersion !== 1 ||
      source.value.byteRevision !== request.expectedSourceByteRevision ||
      source.value.semanticRevision !== request.expectedSourceSemanticRevision
    ) {
      return err(failure('stale-state', ledgerPath));
    }
    const semantic = ledgerSemanticRevision(source.value.model);
    if (!semantic.ok) return err(failure('invalid-state', ledgerPath));
    const bytes = sequenceBytes(source.value.model, request.journals);
    if (!bytes.ok) return bytes;
    const transactionId = request.journals.prepared.transactionId;
    const record: LedgerMigrationRecoveryRecord = Object.freeze({
      kind: 'skillsmith-ledger-migration-recovery',
      schemaVersion: 1,
      key,
      ownerToken: next('owner').padEnd(64, '0'),
      transactionId,
      operationId: request.journals.prepared.intent.operationId,
      ledgerPath,
      ledgerParent,
      sourceByteRevision: source.value.byteRevision,
      sourceSemanticRevision: source.value.semanticRevision,
      targetSemanticRevision: semantic.value,
      revisions: Object.freeze({
        pure: digestBytes(bytes.value.pure),
        staged: digestBytes(bytes.value.staged),
        backedUp: digestBytes(bytes.value.backedUp),
        live: digestBytes(bytes.value.live),
        committed: digestBytes(bytes.value.committed),
      }),
      journals: request.journals,
      transactionDirectoryBasename: `v1-${rawDigest(transactionId)}`,
      transactionDirectoryIdentity: null,
      stageBasename: 'ledger.stage',
      stageFileIdentity: null,
      backupBasename: 'ledger.v1.backup',
      backupFileIdentity: null,
      cursor: 'prepared',
    });
    const created = await createPointer(record);
    return created.ok ? resume(created.value, false) : created;
  };
  return Object.freeze({
    ledgerPath,
    recoveryPointerPath: pointerPath,
    read,
    replace: replaceModel,
    finalizeHistory,
    recoverMigration,
    migrateV1ToV2,
  });
};

export const createNodeLedgerWriter = (ledgerPath: string): Promise<LedgerWriter> =>
  makeWriter(ledgerPath, {});

export const createTestNodeLedgerWriter = (
  ledgerPath: string,
  options: LedgerWriterOptions,
): Promise<LedgerWriter> => makeWriter(ledgerPath, options);
