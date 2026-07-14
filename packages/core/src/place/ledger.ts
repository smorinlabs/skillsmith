import { dirname } from 'node:path';
import type { ArtifactCodec } from '../artifacts/codec.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
  LedgerSkillsV1Dto,
  LedgerV1Dto,
  LedgerV2Dto,
} from '../artifacts/ledger-types.ts';
import {
  artifactContractRegistry,
  fromLedgerV1Dto,
  validateLedgerV1Dto,
} from '../artifacts/registry.ts';
import {
  type SkillSmithError,
  errorMessage,
  flipFailedError,
  ledgerError,
  permissionDeniedError,
  safeErrorCode,
} from '../errors.ts';
import type { ClockPort, FileReadPort, FileWritePort, IdPort, LockPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { FLIP_TOOLS, type FlipTool, type LedgerFile, type PairRecord } from './types.ts';

type LedgerReadPorts = Pick<FileReadPort, 'pathKind' | 'readBytes'> & Pick<ClockPort, 'wallNowIso'>;
type LedgerWritePorts = Pick<
  FileWritePort,
  'writeTextFile' | 'fsyncFile' | 'rename' | 'fsyncDir' | 'removeTree'
> &
  Pick<ClockPort, 'wallNowIso'> &
  IdPort;
type LedgerLockPorts = Pick<FileWritePort, 'makeDir'> & LockPort;

const isPermError = (e: unknown): boolean => {
  const code = safeErrorCode(e);
  return code === 'EACCES' || code === 'EPERM';
};

const decoder = new TextDecoder();
const ledgerV1Codec = artifactContractRegistry.get('ledger', 1) as ArtifactCodec<
  'ledger',
  1,
  LedgerV1Dto,
  LedgerModel
>;
const ledgerV2Codec = artifactContractRegistry.get('ledger', 2) as ArtifactCodec<
  'ledger',
  2,
  LedgerV2Dto,
  LedgerModel
>;

const CORRUPT_LEDGER_MESSAGE = 'ledger is invalid or corrupt';
const FUTURE_LEDGER_MESSAGE = 'ledger schema version requires a newer skillsmith; upgrade required';
const V2_READ_ONLY_MESSAGE =
  'ledger schema v2 is read-only until the canonical ledger writer lands';
const LEGACY_WRITE_REFUSAL_MESSAGE =
  'legacy ledger writer accepts only schema v1; refusing a lossy or downgrade write';

const corruptLedger = (ledgerPath: string): Result<never, SkillSmithError> =>
  err(ledgerError(CORRUPT_LEDGER_MESSAGE, ledgerPath));

const defineEntry = <T>(target: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const clonePairRecord = (record: LedgerPairV1Dto): PairRecord => {
  const dev =
    record.dev === null
      ? null
      : {
          sourcePath: record.dev.sourcePath,
          resolvedPath: record.dev.resolvedPath,
          repoRoot: record.dev.repoRoot,
          sourceRelPath: record.dev.sourceRelPath,
          remote: record.dev.remote,
          recordedAt: record.dev.recordedAt,
        };
  const output: PairRecord = {
    placementPath: record.placementPath,
    mode: record.mode,
    dev,
  };
  if (Object.hasOwn(record, 'pinned') && record.pinned !== undefined) {
    output.pinned =
      record.pinned === null
        ? record.pinned
        : {
            storePath: record.pinned.storePath,
            rev: record.pinned.rev,
            gitSha: record.pinned.gitSha,
            dirty: record.pinned.dirty,
            contentHash: record.pinned.contentHash,
            snapshotAt: record.pinned.snapshotAt,
            verify: record.pinned.verify,
            ...(record.pinned.placement === undefined
              ? {}
              : { placement: record.pinned.placement }),
          };
  }
  if (record.origin !== undefined) {
    output.origin = {
      source: record.origin.source,
      host: record.origin.host,
      repo: record.origin.repo,
      skillPath: record.origin.skillPath,
      refRequested: record.origin.refRequested,
      refResolved: record.origin.refResolved,
      pin: record.origin.pin,
      installedAt: record.origin.installedAt,
    };
  }
  if (Object.hasOwn(record, 'journal') && record.journal !== undefined) {
    if (record.journal === null) {
      output.journal = record.journal;
    } else {
      const before =
        record.journal.before.mode === 'absent'
          ? { mode: 'absent' as const }
          : record.journal.before.mode === 'dev'
            ? {
                mode: 'dev' as const,
                symlinkTarget: record.journal.before.symlinkTarget,
                ...(record.journal.before.liveKind === undefined
                  ? {}
                  : { liveKind: record.journal.before.liveKind }),
              }
            : {
                mode: 'pinned' as const,
                storePath: record.journal.before.storePath,
                contentHash: record.journal.before.contentHash,
                ...(record.journal.before.liveKind === undefined
                  ? {}
                  : { liveKind: record.journal.before.liveKind }),
                ...(record.journal.before.symlinkTarget === undefined
                  ? {}
                  : { symlinkTarget: record.journal.before.symlinkTarget }),
              };
      output.journal = {
        op: record.journal.op,
        txId: record.journal.txId,
        phase: record.journal.phase,
        startedAt: record.journal.startedAt,
        completedAt: record.journal.completedAt,
        before,
        stagingPath: record.journal.stagingPath,
        backupPath: record.journal.backupPath,
      };
    }
  }
  return output;
};

type LegacySkillsTree = LedgerFile['skills'];

const cloneSkillsTree = (tree: LedgerSkillsV1Dto): LegacySkillsTree => {
  const output: LegacySkillsTree = {};
  for (const [skill, entry] of Object.entries(tree)) {
    const tools: LegacySkillsTree[string]['tools'] = {};
    for (const tool of FLIP_TOOLS) {
      const record = entry.tools[tool];
      if (record !== undefined) tools[tool] = clonePairRecord(record);
    }
    defineEntry(output, skill, { tools });
  }
  return output;
};

const cloneLedgerV1 = (ledger: LedgerV1Dto): LedgerFile => {
  const output: LedgerFile = {
    schemaVersion: 1,
    kind: 'skillsmith.placements',
    updatedAt: ledger.updatedAt,
    skills: cloneSkillsTree(ledger.skills),
  };
  if (ledger.projects !== undefined) {
    const projects: NonNullable<LedgerFile['projects']> = {};
    for (const [root, project] of Object.entries(ledger.projects)) {
      defineEntry(projects, root, { skills: cloneSkillsTree(project.skills) });
    }
    output.projects = projects;
  }
  return output;
};

export const emptyLedger = (now: string): LedgerFile => ({
  schemaVersion: 1,
  kind: 'skillsmith.placements',
  updatedAt: now,
  skills: {},
});

export const readLedger = async (
  env: LedgerReadPorts,
  ledgerPath: string,
): Promise<Result<LedgerFile, SkillSmithError>> => {
  if ((await env.pathKind(ledgerPath)) === 'absent') {
    return ok(emptyLedger(env.wallNowIso()));
  }

  let bytes: Uint8Array;
  try {
    bytes = await env.readBytes(ledgerPath);
  } catch (e) {
    if (isPermError(e)) {
      return err(permissionDeniedError(`cannot read ledger: ${errorMessage(e)}`, ledgerPath));
    }
    return err(ledgerError(`cannot read ledger: ${errorMessage(e)}`, ledgerPath));
  }

  const decodedV1 = ledgerV1Codec.decode(bytes);
  if (decodedV1.ok) {
    const dto = ledgerV1Codec.toDto(decodedV1.value.model);
    return dto.ok ? ok(cloneLedgerV1(dto.value)) : corruptLedger(ledgerPath);
  }
  if (decodedV1.error.requestedVersion === 2) {
    const decodedV2 = ledgerV2Codec.decode(bytes);
    return decodedV2.ok
      ? err(ledgerError(V2_READ_ONLY_MESSAGE, ledgerPath))
      : corruptLedger(ledgerPath);
  }
  if (
    decodedV1.error.reason === 'unsupported-version' &&
    decodedV1.error.requestedVersion !== null &&
    decodedV1.error.requestedVersion > 2
  ) {
    return err(ledgerError(FUTURE_LEDGER_MESSAGE, ledgerPath));
  }
  return corruptLedger(ledgerPath);
};

export const writeLedger = async (
  env: LedgerWritePorts,
  ledgerPath: string,
  ledger: LedgerFile,
): Promise<Result<void, SkillSmithError>> => {
  const validated = validateLedgerV1Dto(ledger as unknown);
  if (!validated.ok) return err(ledgerError(LEGACY_WRITE_REFUSAL_MESSAGE, ledgerPath));
  const stamped = validateLedgerV1Dto({
    ...validated.value,
    updatedAt: env.wallNowIso(),
  });
  if (!stamped.ok) return err(ledgerError(LEGACY_WRITE_REFUSAL_MESSAGE, ledgerPath));
  const model = fromLedgerV1Dto(stamped.value);
  if (!model.ok) return err(ledgerError(LEGACY_WRITE_REFUSAL_MESSAGE, ledgerPath));
  const encoded = ledgerV1Codec.encode(model.value);
  if (!encoded.ok) return err(ledgerError(LEGACY_WRITE_REFUSAL_MESSAGE, ledgerPath));
  const serialized = decoder.decode(encoded.value);
  const tmp = `${ledgerPath}.tmp-${env.nextId('ledger-write')}`;
  try {
    await env.writeTextFile(tmp, serialized);
    await env.fsyncFile(tmp);
    await env.rename(tmp, ledgerPath);
    await env.fsyncDir(dirname(ledgerPath));
    return ok(undefined);
  } catch (e) {
    await env.removeTree(tmp).catch(() => {});
    if (isPermError(e)) {
      return err(permissionDeniedError(`cannot write ledger: ${errorMessage(e)}`, ledgerPath));
    }
    return err(ledgerError(`cannot write ledger: ${errorMessage(e)}`, ledgerPath));
  }
};

export const withLedgerLock = async <T>(
  env: LedgerLockPorts,
  ledgerPath: string,
  fn: () => Promise<T>,
): Promise<Result<T, SkillSmithError>> => {
  try {
    await env.makeDir(dirname(ledgerPath));
  } catch (e) {
    if (isPermError(e)) {
      return err(
        permissionDeniedError(`cannot create ledger directory: ${errorMessage(e)}`, ledgerPath),
      );
    }
    return err(ledgerError(`cannot create ledger directory: ${errorMessage(e)}`, ledgerPath));
  }

  // R2 / BF-7a (D2 "nothing written"): lock the ledger TARGET directly. proper-lockfile mkdir's the
  // atomic lock DIR `placements.json.lock` — with `withFileLock`'s `realpath:false`, the target need
  // NOT exist, so this both (a) restores the ORIGINAL lock-dir name for true cross-version exclusion
  // with pre-sidecar binaries (they locked the same target -> the same dir) and (b) never
  // materializes `placements.json` when a gate fails before any write. A prior fix locked a SIDECAR
  // (`placements.json.lock`) as the target, which mkdir'd `placements.json.lock.lock` — a DIFFERENT
  // dir than old binaries held, so the two never excluded each other (split-brain).
  try {
    const value = await env.withFileLock(ledgerPath, fn);
    return ok(value);
  } catch (e) {
    return err(flipFailedError(`another skillsmith operation is running: ${errorMessage(e)}`));
  }
};

// scopeKey null → the user-scope `skills` tree; a string → `projects[scopeKey].skills`.
type SkillsTree = LedgerFile['skills'];

const skillsTreeAt = (l: LedgerFile, scopeKey: string | null): SkillsTree | null => {
  if (scopeKey === null) return l.skills;
  return l.projects?.[scopeKey]?.skills ?? null;
};

export const getPairAt = (
  l: LedgerFile,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
): PairRecord | null => {
  const tree = skillsTreeAt(l, scopeKey);
  return tree?.[skill]?.tools[tool] ?? null;
};

export const setPairAt = (
  l: LedgerFile,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
  rec: PairRecord,
): void => {
  let tree: SkillsTree;
  if (scopeKey === null) {
    tree = l.skills;
  } else {
    const projects = l.projects ?? {};
    const scope = projects[scopeKey] ?? { skills: {} };
    projects[scopeKey] = scope;
    l.projects = projects;
    tree = scope.skills;
  }
  const entry = tree[skill] ?? { tools: {} };
  entry.tools[tool] = rec;
  tree[skill] = entry;
};

// Removes the pair and prunes any container it leaves empty (tools → skill → project → projects).
export const deletePairAt = (
  l: LedgerFile,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
): void => {
  const tree = skillsTreeAt(l, scopeKey);
  const entry = tree?.[skill];
  if (!tree || !entry) return;
  delete entry.tools[tool];
  if (Object.keys(entry.tools).length === 0) delete tree[skill];
  if (scopeKey !== null && l.projects) {
    const scope = l.projects[scopeKey];
    if (scope && Object.keys(scope.skills).length === 0) delete l.projects[scopeKey];
    // Drop the whole optional `projects` field when empty. `delete l.projects` trips
    // lint/noDelete and `l.projects = undefined` trips exactOptionalPropertyTypes; Reflect avoids both.
    if (Object.keys(l.projects).length === 0) Reflect.deleteProperty(l, 'projects');
  }
};

export const getPair = (l: LedgerFile, skill: string, tool: FlipTool): PairRecord | null =>
  getPairAt(l, null, skill, tool);

export const setPair = (l: LedgerFile, skill: string, tool: FlipTool, rec: PairRecord): void =>
  setPairAt(l, null, skill, tool, rec);
