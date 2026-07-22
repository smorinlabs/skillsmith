import { dirname, join } from 'node:path';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type { LedgerModel, LedgerPairV1Dto, LedgerReadState } from '../artifacts/ledger-types.ts';
import {
  deriveLedgerProjectRegistrations,
  fromLedgerV2Dto,
  ledgerByteRevision,
  ledgerSemanticRevision,
  legacyJournalOperationMatchesLogicalShadow,
  logicalJournalPairIdentity,
  resolveLedgerArtifactCodec,
  toLedgerV2Dto,
} from '../artifacts/registry.ts';
import {
  type SkillSmithError,
  cancelledError,
  errorMessage,
  flipFailedError,
  ledgerError,
  permissionDeniedError,
  safeErrorCode,
} from '../errors.ts';
import type { ClockPort, FileReadPort, FileWritePort, IdPort, LockPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { FlipTool, Journal, LedgerFile, PairRecord } from './types.ts';

const ledgerV1Codec = resolveLedgerArtifactCodec(1);
const ledgerV2Codec = resolveLedgerArtifactCodec(2);

type LedgerStateReadPorts = Pick<FileReadPort, 'pathKind' | 'readBytes'>;
type LedgerReadPorts = LedgerStateReadPorts & Pick<ClockPort, 'wallNowIso'>;
type LedgerWritePorts = Pick<
  FileWritePort,
  'writeTextFile' | 'fsyncFile' | 'rename' | 'fsyncDir' | 'removeTree'
> &
  Pick<ClockPort, 'wallNowIso'> &
  IdPort & {
    readonly afterLedgerBarrier?: (
      barrier: Readonly<{
        kind:
          | 'writer-stage-write'
          | 'writer-stage-fsync'
          | 'writer-live-replace'
          | 'writer-live-parent-fsync';
      }>,
    ) => Promise<void>;
  };
type LedgerLockPorts = Pick<FileWritePort, 'makeDir'> & LockPort;

const isPermError = (e: unknown): boolean => {
  const code = safeErrorCode(e);
  return code === 'EACCES' || code === 'EPERM';
};

const decoder = new TextDecoder();

const CORRUPT_LEDGER_MESSAGE = 'ledger is invalid or corrupt';
const FUTURE_LEDGER_MESSAGE = 'ledger schema version requires a newer skillsmith; upgrade required';
const CANONICAL_WRITE_REFUSAL_MESSAGE =
  'canonical ledger writer accepts only a complete schema-v2 ledger model';

const corruptLedger = (ledgerPath: string): Result<never, SkillSmithError> =>
  err(ledgerError(CORRUPT_LEDGER_MESSAGE, ledgerPath));

export const emptyLedger = (now: string): LedgerFile => ({
  schemaVersion: 1,
  kind: 'skillsmith.placements',
  updatedAt: now,
  skills: {},
});

export const emptyLedgerModel = (now: string): LedgerModel => {
  const model = fromLedgerV2Dto({
    schemaVersion: 2,
    kind: 'skillsmith.placements',
    updatedAt: now,
    skills: {},
    projects: {},
    projectRegistrations: {},
    transactions: {},
    history: [],
  });
  if (!model.ok) throw new Error('empty ledger model invariant failed');
  return model.value;
};

/** Canonical read boundary. Absence never consults the clock or fabricates a model. */
export const readLedgerState = async (
  env: LedgerStateReadPorts,
  ledgerPath: string,
): Promise<Result<LedgerReadState, SkillSmithError>> => {
  if ((await env.pathKind(ledgerPath)) === 'absent') {
    return ok(
      Object.freeze({
        state: 'absent',
        sourceVersion: null,
        bytes: null,
        byteRevision: null,
        semanticRevision: null,
        model: null,
      }),
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await env.readBytes(ledgerPath));
  } catch (e) {
    if (isPermError(e)) {
      return err(permissionDeniedError(`cannot read ledger: ${errorMessage(e)}`, ledgerPath));
    }
    return err(ledgerError(`cannot read ledger: ${errorMessage(e)}`, ledgerPath));
  }
  const decoded = ledgerV2Codec.decode(bytes);
  if (!decoded.ok) {
    if (
      decoded.error.reason === 'unsupported-version' &&
      decoded.error.requestedVersion !== null &&
      decoded.error.requestedVersion > 2
    ) {
      return err(ledgerError(FUTURE_LEDGER_MESSAGE, ledgerPath));
    }
    return corruptLedger(ledgerPath);
  }
  const semanticRevision = ledgerSemanticRevision(decoded.value.model);
  if (!semanticRevision.ok) return corruptLedger(ledgerPath);
  if (decoded.value.source.kind !== 'version') return corruptLedger(ledgerPath);
  const sourceVersion = decoded.value.source.version;
  if (sourceVersion !== 1 && sourceVersion !== 2) return corruptLedger(ledgerPath);
  return ok(
    Object.freeze({
      state: 'present',
      sourceVersion,
      bytes: new Uint8Array(bytes),
      byteRevision: ledgerByteRevision(bytes),
      semanticRevision: semanticRevision.value,
      model: decoded.value.model,
    }),
  );
};

export const ledgerModelForMutation = (state: LedgerReadState, now: string): LedgerModel =>
  state.state === 'present' ? state.model : emptyLedgerModel(now);

const legacyJournalBefore = (journal: LogicalJournalV1Dto, pair: PairRecord): Journal['before'] => {
  const before = journal.intent.before;
  if (before.kind === 'absent') return { mode: 'absent' };
  if (before.kind !== 'placement') return { mode: 'absent' };
  if (before.classification === 'dev') {
    return {
      mode: 'dev',
      symlinkTarget:
        before.linkTarget?.kind === 'machine-bound'
          ? before.linkTarget.path
          : (pair.dev?.sourcePath ?? pair.placementPath),
      liveKind: before.representation === 'symlink' ? 'symlink' : 'dir',
    };
  }
  const retainedStore = journal.actual.retained.find((resource) => resource.role === 'store');
  return {
    mode: 'pinned',
    storePath: retainedStore?.path ?? pair.pinned?.storePath ?? null,
    contentHash: before.contentHash,
    liveKind: before.representation === 'symlink' ? 'symlink' : 'dir',
  };
};

const legacyJournalView = (
  journal: LogicalJournalV1Dto,
  pair: PairRecord,
  skill: string,
): Journal => {
  const skillsRoot = dirname(pair.placementPath);
  const op: Journal['op'] =
    journal.disposition === 'rollback'
      ? 'rollback'
      : journal.intent.kind === 'remove'
        ? 'uninstall'
        : journal.intent.kind === 'link-dev'
          ? 'dev'
          : journal.intent.kind === 'promote'
            ? 'promote'
            : 'install';
  return {
    op,
    txId: journal.transactionId,
    phase: journal.phase,
    startedAt: journal.context.startedAt,
    completedAt: journal.completedAt,
    before: legacyJournalBefore(journal, pair),
    stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-${journal.transactionId}`),
    backupPath: join(skillsRoot, `.skillsmith-backup-${skill}-${journal.transactionId}`),
  };
};

export const legacyLedgerView = (model: LedgerModel): LedgerFile => {
  const view: LedgerFile = {
    schemaVersion: 1,
    kind: 'skillsmith.placements',
    updatedAt: model.updatedAt,
    skills: structuredClone(model.skills) as LedgerFile['skills'],
    ...(Object.keys(model.projects).length === 0
      ? {}
      : {
          projects: structuredClone(model.projects) as NonNullable<LedgerFile['projects']>,
        }),
  };
  const terminalPairIdentities = new Map<string | null, Map<string, Set<string>>>();
  const claimTerminalPairIdentity = (
    projectRoot: string | null,
    skill: string,
    tool: string,
  ): boolean => {
    const skills = terminalPairIdentities.get(projectRoot) ?? new Map<string, Set<string>>();
    terminalPairIdentities.set(projectRoot, skills);
    const tools = skills.get(skill) ?? new Set<string>();
    skills.set(skill, tools);
    if (tools.has(tool)) return false;
    tools.add(tool);
    return true;
  };
  for (let index = model.history.length - 1; index >= 0; index -= 1) {
    const journal = model.history[index];
    if (journal === undefined) continue;
    const identity = logicalJournalPairIdentity(journal);
    if (identity === null) continue;
    const skills =
      identity.projectRoot === null ? view.skills : view.projects?.[identity.projectRoot]?.skills;
    const pair = skills?.[identity.skill]?.tools[identity.tool as FlipTool];
    if (pair === undefined) continue;
    if (!claimTerminalPairIdentity(identity.projectRoot, identity.skill, identity.tool)) continue;
    if (pair.journal != null || journal.disposition === 'rollback') continue;
    // Record-only repair has no compatibility shadow to project. Claiming its terminal identity
    // above still makes it a tombstone for older supported history at this pair.
    if (journal.intent.kind === 'repair') continue;
    const candidate = legacyJournalView(journal, pair, identity.skill);
    if (!legacyJournalOperationMatchesLogicalShadow(journal, candidate.op)) continue;
    pair.journal = candidate;
  }
  return view;
};

export const readLedger = async (
  env: LedgerReadPorts,
  ledgerPath: string,
): Promise<Result<LedgerFile, SkillSmithError>> => {
  const state = await readLedgerState(env, ledgerPath);
  if (!state.ok) return state;
  if (state.value.state === 'absent') return ok(emptyLedger(env.wallNowIso()));
  if (state.value.sourceVersion === 2) return ok(legacyLedgerView(state.value.model));
  const dto = ledgerV1Codec.toDto(state.value.model);
  return dto.ok
    ? ok(structuredClone(dto.value) as LedgerFile)
    : err(ledgerError(CORRUPT_LEDGER_MESSAGE, ledgerPath));
};

export const writeLedger = async (
  env: LedgerWritePorts,
  ledgerPath: string,
  ledger: LedgerModel | LedgerFile,
): Promise<Result<void, SkillSmithError>> => {
  if (ledger === null || typeof ledger !== 'object') {
    return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE, ledgerPath));
  }
  let validated: ReturnType<typeof toLedgerV2Dto>;
  try {
    validated = toLedgerV2Dto(ledger as LedgerModel);
  } catch {
    return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE, ledgerPath));
  }
  if (!validated.ok) return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE, ledgerPath));
  const model = toLedgerV2Dto({ ...ledger, updatedAt: env.wallNowIso() } as LedgerModel);
  if (!model.ok) return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE, ledgerPath));
  const normalized = fromLedgerV2Dto(model.value);
  if (!normalized.ok) return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE, ledgerPath));
  const encoded = ledgerV2Codec.encode(normalized.value);
  if (!encoded.ok) return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE, ledgerPath));
  const serialized = decoder.decode(encoded.value);
  const tmp = `${ledgerPath}.tmp-${env.nextId('ledger-write')}`;
  try {
    await env.writeTextFile(tmp, serialized);
    await env.afterLedgerBarrier?.({ kind: 'writer-stage-write' });
    await env.fsyncFile(tmp);
    await env.afterLedgerBarrier?.({ kind: 'writer-stage-fsync' });
    await env.rename(tmp, ledgerPath);
    await env.afterLedgerBarrier?.({ kind: 'writer-live-replace' });
    await env.fsyncDir(dirname(ledgerPath));
    await env.afterLedgerBarrier?.({ kind: 'writer-live-parent-fsync' });
    return ok(undefined);
  } catch (e) {
    await env.removeTree(tmp).catch(() => {});
    const code = safeErrorCode(e);
    if (code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError') throw e;
    if (isPermError(e)) {
      return err(permissionDeniedError(`cannot write ledger: ${errorMessage(e)}`, ledgerPath));
    }
    return err(ledgerError(`cannot write ledger: ${errorMessage(e)}`, ledgerPath));
  }
};

export const getLedgerPairAt = (
  model: LedgerModel,
  projectRoot: string | null,
  skill: string,
  tool: string,
): LedgerPairV1Dto | null => {
  const tree = projectRoot === null ? model.skills : model.projects[projectRoot]?.skills;
  return tree?.[skill]?.tools[tool] ?? null;
};

export const withLedgerPairAt = (
  model: LedgerModel,
  projectRoot: string | null,
  skill: string,
  tool: string,
  pair: LedgerPairV1Dto,
): Result<LedgerModel, SkillSmithError> => {
  let dto: ReturnType<typeof toLedgerV2Dto>;
  try {
    dto = toLedgerV2Dto({
      ...model,
      projectRegistrations: deriveLedgerProjectRegistrations(model.projects),
    });
  } catch {
    return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE));
  }
  if (!dto.ok) return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE));
  const skills = structuredClone(dto.value.skills) as Record<
    string,
    { tools: Record<string, LedgerPairV1Dto> }
  >;
  const projects = structuredClone(dto.value.projects) as Record<
    string,
    { skills: Record<string, { tools: Record<string, LedgerPairV1Dto> }> }
  >;
  let tree: Record<string, { tools: Record<string, LedgerPairV1Dto> }>;
  if (projectRoot === null) {
    tree = skills;
  } else {
    const project = projects[projectRoot] ?? { skills: {} };
    projects[projectRoot] = project;
    tree = project.skills;
  }
  const entry = tree[skill] ?? { tools: {} };
  tree[skill] = entry;
  entry.tools[tool] = structuredClone(pair);
  const next = fromLedgerV2Dto({
    ...dto.value,
    skills,
    projects,
    projectRegistrations: deriveLedgerProjectRegistrations(projects),
  });
  return next.ok ? ok(next.value) : err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE));
};

export const withoutLedgerPairAt = (
  model: LedgerModel,
  projectRoot: string | null,
  skill: string,
  tool: string,
): Result<LedgerModel, SkillSmithError> => {
  let dto: ReturnType<typeof toLedgerV2Dto>;
  try {
    dto = toLedgerV2Dto({
      ...model,
      projectRegistrations: deriveLedgerProjectRegistrations(model.projects),
    });
  } catch {
    return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE));
  }
  if (!dto.ok) return err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE));
  const skills = structuredClone(dto.value.skills) as Record<
    string,
    { tools: Record<string, LedgerPairV1Dto> }
  >;
  const projects = structuredClone(dto.value.projects) as Record<
    string,
    { skills: Record<string, { tools: Record<string, LedgerPairV1Dto> }> }
  >;
  const tree = projectRoot === null ? skills : projects[projectRoot]?.skills;
  const entry = tree?.[skill];
  if (entry !== undefined) {
    Reflect.deleteProperty(entry.tools, tool);
    if (Object.keys(entry.tools).length === 0 && tree !== undefined) {
      Reflect.deleteProperty(tree, skill);
    }
  }
  if (
    projectRoot !== null &&
    projects[projectRoot] !== undefined &&
    Object.keys(projects[projectRoot].skills).length === 0
  ) {
    Reflect.deleteProperty(projects, projectRoot);
  }
  const next = fromLedgerV2Dto({
    ...dto.value,
    skills,
    projects,
    projectRegistrations: deriveLedgerProjectRegistrations(projects),
  });
  return next.ok ? ok(next.value) : err(ledgerError(CANONICAL_WRITE_REFUSAL_MESSAGE));
};

export const withLedgerLock = async <T>(
  env: LedgerLockPorts,
  ledgerPath: string,
  fn: () => Promise<T>,
  options?: Readonly<{ signal?: AbortSignal }>,
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
    const value = await env.withFileLock(ledgerPath, fn, options);
    return ok(value);
  } catch (e) {
    const code = safeErrorCode(e);
    if (code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError') {
      return err(cancelledError('ledger lock wait cancelled'));
    }
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

const setLegacyPairAt = (
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

export function setPairAt(
  ledger: LedgerFile,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
  record: PairRecord,
): void;
export function setPairAt(
  ledger: LedgerModel,
  scopeKey: string | null,
  skill: string,
  tool: string,
  record: LedgerPairV1Dto,
): Result<LedgerModel, SkillSmithError>;
export function setPairAt(
  ledger: LedgerFile | LedgerModel,
  scopeKey: string | null,
  skill: string,
  tool: string,
  record: PairRecord | LedgerPairV1Dto,
): undefined | Result<LedgerModel, SkillSmithError> {
  if ('schemaVersion' in ledger) {
    setLegacyPairAt(ledger, scopeKey, skill, tool as FlipTool, record as PairRecord);
    return;
  }
  return withLedgerPairAt(ledger, scopeKey, skill, tool, record as LedgerPairV1Dto);
}

// Removes the pair and prunes any container it leaves empty (tools → skill → project → projects).
const deleteLegacyPairAt = (
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

export function deletePairAt(
  ledger: LedgerFile,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
): void;
export function deletePairAt(
  ledger: LedgerModel,
  scopeKey: string | null,
  skill: string,
  tool: string,
): Result<LedgerModel, SkillSmithError>;
export function deletePairAt(
  ledger: LedgerFile | LedgerModel,
  scopeKey: string | null,
  skill: string,
  tool: string,
): undefined | Result<LedgerModel, SkillSmithError> {
  if ('schemaVersion' in ledger) {
    deleteLegacyPairAt(ledger, scopeKey, skill, tool as FlipTool);
    return;
  }
  return withoutLedgerPairAt(ledger, scopeKey, skill, tool);
}

export const getPair = (l: LedgerFile, skill: string, tool: FlipTool): PairRecord | null =>
  getPairAt(l, null, skill, tool);

export const setPair = (l: LedgerFile, skill: string, tool: FlipTool, rec: PairRecord): void =>
  setPairAt(l, null, skill, tool, rec);
