import { dirname, join } from 'node:path';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type {
  JournalResourceActualV1Dto,
  LogicalJournalV1Dto,
} from '../artifacts/journal-types.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import { validateJournalV1DtoShape } from '../artifacts/registry.ts';
import type { PathKind } from '../env/types.ts';
import {
  type SkillSmithError,
  cancelledError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  genericError,
  permissionDeniedError,
  safeErrorCode,
} from '../errors.ts';
import type { ExecutableOperation, OperationImage } from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  deletePairAt,
  getLedgerPairAt,
  getPairAt,
  setPairAt,
  withLedgerPairAt,
  withoutLedgerPairAt,
} from './ledger.ts';
import {
  abortPendingLogicalTransaction,
  advanceLogicalTransaction,
  commitLogicalTransaction,
} from './logical-transactions.ts';
import { contentHashOf } from './store.ts';
import type {
  FlipTool,
  Journal,
  JournalOp,
  JournalPhase,
  PairRecord,
  SwapCtx,
  SwapOutcome,
  SwapPlan,
  SwapPorts,
} from './types.ts';

const pairAt = (
  ctx: SwapCtx,
  scopeKey: string | null,
  skill: string,
  tool: string,
): PairRecord | null => {
  const pair =
    'schemaVersion' in ctx.ledger
      ? getPairAt(ctx.ledger, scopeKey, skill, tool as FlipTool)
      : getLedgerPairAt(ctx.ledger, scopeKey, skill, tool);
  return pair === null ? null : (structuredClone(pair) as PairRecord);
};

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}` as ArtifactDigest;

const liveActual = (
  image: OperationImage,
  pair: PairRecord,
  fallbackState: 'absent' | 'present',
): JournalResourceActualV1Dto => {
  if (image.kind === 'absent') {
    return {
      resourceId: 'live:placement',
      role: 'live',
      state: 'absent',
      repositoryRevision: null,
      placementPath: pair.placementPath,
      liveKind: null,
      mode: null,
      symlinkTarget: null,
      contentHash: null,
    };
  }
  if (image.kind === 'placement') {
    const digest = (image.contentHash ??
      image.source?.contentHash ??
      ZERO_DIGEST) as ArtifactDigest;
    return {
      resourceId: 'live:placement',
      role: 'live',
      state: 'present',
      repositoryRevision: { kind: 'resource', digest },
      placementPath: pair.placementPath,
      liveKind: image.representation === 'symlink' ? 'symlink' : 'directory',
      mode: image.classification === 'dev' ? 'dev' : 'pinned',
      symlinkTarget: image.linkTarget?.kind === 'machine-bound' ? image.linkTarget.path : null,
      contentHash: image.contentHash as ArtifactDigest | null,
    };
  }
  return fallbackState === 'absent'
    ? {
        resourceId: 'live:placement',
        role: 'live',
        state: 'absent',
        repositoryRevision: null,
        placementPath: pair.placementPath,
        liveKind: null,
        mode: null,
        symlinkTarget: null,
        contentHash: null,
      }
    : {
        resourceId: 'live:placement',
        role: 'live',
        state: 'present',
        repositoryRevision: { kind: 'resource', digest: ZERO_DIGEST },
        placementPath: pair.placementPath,
        liveKind: 'directory',
        mode: pair.mode,
        symlinkTarget: null,
        contentHash: (pair.pinned?.contentHash ?? null) as ArtifactDigest | null,
      };
};

const logicalJournalFor = (
  operation: ExecutableOperation,
  pair: PairRecord,
  shadow: Journal,
): LogicalJournalV1Dto => {
  const visible = shadow.phase === 'live' || shadow.phase === 'committed';
  const imageSource = operation.after.kind === 'placement' ? operation.after.source : null;
  const source =
    operation.source ??
    (operation.kind === 'promote' && imageSource?.kind === 'local-dev'
      ? {
          kind: 'portable' as const,
          identity: {
            host: 'github.com',
            repository: 'local/source',
            path: operation.skill,
          },
          requestedRef: null,
          resolvedSha: '0'.repeat(40),
          sourcePath: operation.skill ?? '.',
          contentHash: imageSource.contentHash as unknown as ArtifactDigest,
        }
      : (operation.kind === 'install' ||
            operation.kind === 'update' ||
            operation.kind === 'repair') &&
          pair.origin !== undefined &&
          pair.pinned != null
        ? {
            kind: 'portable' as const,
            identity: {
              host: pair.origin.host,
              repository: pair.origin.repo,
              path: pair.origin.skillPath,
            },
            requestedRef: pair.origin.refRequested,
            resolvedSha: pair.origin.refResolved,
            sourcePath: pair.origin.skillPath,
            contentHash: pair.pinned.contentHash as ArtifactDigest,
          }
        : null);
  const afterImage = operation.after;
  const ledger = {
    resourceId: 'ledger:placements',
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'resource' as const, digest: ZERO_DIGEST },
    schemaVersion: 2 as const,
    semanticHash: ZERO_DIGEST,
  };
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId: shadow.txId,
    intent: {
      operationId: operation.operationId,
      groupId: operation.groupId,
      pairId: operation.pairId,
      kind: operation.kind,
      skill: operation.skill,
      source: source as unknown as LogicalJournalV1Dto['intent']['source'],
      tool: operation.tool,
      scope: operation.scope,
      before: operation.before as unknown as LogicalJournalV1Dto['intent']['before'],
      after: afterImage as unknown as LogicalJournalV1Dto['intent']['after'],
      mutates: operation.mutates,
      reversibility: { kind: 'none', retentionResourceIds: [] },
      conflict: null,
    },
    context: {
      parentOperationId: null,
      command: 'skillsmith-place',
      workflow: 'placement-swap',
      attempt: 1,
      startedAt: shadow.startedAt,
    },
    disposition: 'forward',
    phase: shadow.phase,
    actual: {
      before: [liveActual(operation.before, pair, 'absent'), ledger],
      after: visible ? [liveActual(afterImage as OperationImage, pair, 'present'), ledger] : [],
      retained: [],
    },
    updatedAt: shadow.completedAt ?? shadow.startedAt,
    completedAt: shadow.completedAt,
  };
};

const recordOnlyBefore = (operation: ExecutableOperation): Journal['before'] => {
  if (operation.before.kind === 'absent') return { mode: 'absent' };
  if (operation.before.kind !== 'placement') return { mode: 'absent' };
  if (operation.before.classification === 'dev') {
    const linkTarget = operation.before.linkTarget ?? operation.before.resource.location;
    return {
      mode: 'dev',
      symlinkTarget: linkTarget.kind === 'machine-bound' ? linkTarget.path : linkTarget.token,
      liveKind: operation.before.representation === 'symlink' ? 'symlink' : 'dir',
    };
  }
  return {
    mode: 'pinned',
    storePath: null,
    contentHash: operation.before.contentHash,
    liveKind: operation.before.representation === 'symlink' ? 'symlink' : 'dir',
  };
};

/**
 * One canonical finalizer for mutations whose live filesystem state is already authoritative.
 * Repair writes the terminal pair plus committed logical history directly, without inventing a
 * physical shadow. Other record-only operations advance their logical/compatibility-shadow phases
 * in memory. Both paths persist exactly one terminal ledger image; there is no recoverable
 * filesystem phase because these callers deliberately perform no live mutation.
 */
export const commitRecordOnlyLogicalTransaction = async (
  ctx: SwapCtx,
  operation: ExecutableOperation,
  pair: PairRecord,
  scopeKey: string | null = null,
): Promise<Result<void, SkillSmithError>> => {
  if ('schemaVersion' in ctx.ledger || operation.pairId === null) {
    return err(flipFailedError('record-only logical transaction requires canonical pair identity'));
  }
  const canonicalLedger = ctx.ledger as LedgerModel;
  const transactionId = ctx.newTxId();
  const startedAt = ctx.now();
  const stagedCtx: SwapCtx = {
    ...ctx,
    ledger: canonicalLedger,
    persist: async () => ok(undefined),
  };
  const journal: Journal = {
    op:
      operation.kind === 'remove' ? 'uninstall' : operation.kind === 'link-dev' ? 'dev' : 'install',
    txId: transactionId,
    phase: 'prepared',
    startedAt,
    completedAt: null,
    before: recordOnlyBefore(operation),
    stagingPath: join(
      dirname(pair.placementPath),
      `.skillsmith-staging-${operation.skill ?? 'skill'}-${transactionId}`,
    ),
    backupPath: join(
      dirname(pair.placementPath),
      `.skillsmith-backup-${operation.skill ?? 'skill'}-${transactionId}`,
    ),
  };
  if (operation.kind === 'repair') {
    if (
      canonicalLedger.transactions[transactionId] !== undefined ||
      canonicalLedger.history.some((candidate) => candidate.transactionId === transactionId)
    ) {
      return err(flipFailedError('record-only repair transaction identity already exists'));
    }
    const completedAt = ctx.now();
    const committed = logicalJournalFor(operation, pair, {
      ...journal,
      phase: 'committed',
      completedAt,
    });
    const validation = validateJournalV1DtoShape(committed);
    if (!validation.ok) {
      return err(
        flipFailedError(
          `record-only repair journal is invalid: ${JSON.stringify(validation.error)}`,
        ),
      );
    }
    const terminal = withLedgerPairAt(
      canonicalLedger,
      scopeKey,
      operation.skill ?? '',
      operation.tool ?? '',
      { ...pair, journal: null },
    );
    if (!terminal.ok) return terminal;
    ctx.ledger = {
      ...terminal.value,
      history: [...terminal.value.history, committed],
    };
    return ctx.persist();
  }
  for (const phase of ['prepared', 'staged', 'backed-up', 'live', 'committed'] as const) {
    if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
    const completedAt = phase === 'committed' ? ctx.now() : null;
    const persisted = await persistPair(
      stagedCtx,
      scopeKey,
      operation.skill ?? '',
      operation.tool ?? '',
      {
        ...pair,
        journal: { ...journal, phase, completedAt },
      },
    );
    if (!persisted.ok) return persisted;
  }
  ctx.ledger = stagedCtx.ledger;
  return ctx.persist();
};

const hydrateLogicalPendingFromShadow = (
  model: LedgerModel,
  scopeKey: string | null,
  skill: string,
  tool: string,
  journal: LogicalJournalV1Dto,
): Result<LedgerModel, SkillSmithError> => {
  if (model.transactions[journal.transactionId] !== undefined) return ok(model);
  const pair = getLedgerPairAt(model, scopeKey, skill, tool);
  const shadow = pair?.journal;
  if (
    pair === null ||
    shadow === undefined ||
    shadow === null ||
    shadow.txId !== journal.transactionId ||
    shadow.phase === 'committed'
  ) {
    return ok(model);
  }

  const phases = ['prepared', 'staged', 'backed-up', 'live'] as const;
  const shadowIndex = phases.indexOf(shadow.phase);
  if (shadowIndex < 0) return ok(model);
  const preparedPair = withLedgerPairAt(model, scopeKey, skill, tool, {
    ...pair,
    journal: { ...shadow, phase: 'prepared', completedAt: null },
  });
  if (!preparedPair.ok) return preparedPair;

  let hydrated = preparedPair.value;
  for (const phase of phases.slice(0, shadowIndex + 1)) {
    const pending = hydrated.transactions[journal.transactionId];
    const replay: LogicalJournalV1Dto =
      pending === undefined
        ? {
            ...journal,
            phase: 'prepared',
            actual: { ...journal.actual, after: [] },
            updatedAt: journal.context.startedAt,
            completedAt: null,
          }
        : {
            ...pending,
            phase,
            actual: {
              ...pending.actual,
              after: phase === 'live' ? journal.actual.after : [],
            },
            updatedAt: journal.updatedAt,
            completedAt: null,
          };
    const advanced = advanceLogicalTransaction(hydrated, replay);
    if (!advanced.ok) return err(flipFailedError(advanced.error.message));
    hydrated = advanced.value;
  }
  return ok(hydrated);
};

const persistPair = async (
  ctx: SwapCtx,
  scopeKey: string | null,
  skill: string,
  tool: string,
  pair: PairRecord,
): Promise<Result<void, SkillSmithError>> => {
  if ('schemaVersion' in ctx.ledger) {
    setPairAt(ctx.ledger, scopeKey, skill, tool as FlipTool, pair);
    return ctx.persist();
  }
  const operation = ctx.logicalOperation;
  if (operation !== undefined && pair.journal == null && operation.pairId !== null) {
    const pending = Object.values(ctx.ledger.transactions).find(
      (journal) => journal.intent.operationId === operation.operationId,
    );
    if (pending !== undefined) {
      if (pending.phase !== 'live') {
        return err(flipFailedError('logical placement terminal write requires live state'));
      }
      const completedAt = ctx.now();
      const committed = commitLogicalTransaction(ctx.ledger, {
        ...pending,
        phase: 'committed',
        updatedAt: completedAt,
        completedAt,
      });
      if (!committed.ok) return err(flipFailedError(committed.error.message));
      ctx.ledger = committed.value;
      return ctx.persist();
    }
  }
  if (operation !== undefined && pair.journal != null) {
    const freshJournal = logicalJournalFor(operation, pair, pair.journal);
    const persistedPending = ctx.ledger.transactions[freshJournal.transactionId];
    // A crash can make the freshly observed live image differ from the operation's original
    // before-image (for example, live has already moved to backup). Resume from the durable logical
    // identity and use the fresh journal only for this phase's observed after-resources/timestamps.
    const journal: LogicalJournalV1Dto =
      persistedPending === undefined
        ? freshJournal
        : {
            ...persistedPending,
            phase: freshJournal.phase,
            actual: { ...persistedPending.actual, after: freshJournal.actual.after },
            updatedAt: freshJournal.updatedAt,
            completedAt: freshJournal.completedAt,
          };
    const validation = validateJournalV1DtoShape(journal);
    if (!validation.ok) {
      return err(
        flipFailedError(
          `logical placement journal is invalid: ${JSON.stringify(validation.error)} ${JSON.stringify(journal.intent)}`,
        ),
      );
    }
    const hydrated = hydrateLogicalPendingFromShadow(ctx.ledger, scopeKey, skill, tool, journal);
    if (!hydrated.ok) return hydrated;
    ctx.ledger = hydrated.value;
    if (journal.phase === 'committed') {
      if (ctx.ledger.transactions[journal.transactionId] === undefined) {
        return err(flipFailedError('logical placement transaction is missing at commit'));
      }
      const pendingPair = getLedgerPairAt(ctx.ledger, scopeKey, skill, tool);
      const staged = withLedgerPairAt(ctx.ledger, scopeKey, skill, tool, {
        ...(pair as LedgerPairV1Dto),
        journal: pendingPair?.journal ?? null,
      });
      if (!staged.ok) return staged;
      // Canonical pair replacement validates and normalizes the complete ledger model. Build the
      // terminal record from that normalized pending record so identity comparison is exact even
      // when the codec has canonicalized resource ordering.
      const stagedPending = staged.value.transactions[journal.transactionId];
      if (stagedPending === undefined) {
        return err(flipFailedError('logical placement transaction is missing after pair staging'));
      }
      const terminalJournal: LogicalJournalV1Dto = {
        ...stagedPending,
        phase: 'committed',
        actual: { ...stagedPending.actual, after: journal.actual.after },
        updatedAt: journal.updatedAt,
        completedAt: journal.completedAt,
      };
      const committed = commitLogicalTransaction(staged.value, terminalJournal);
      if (!committed.ok) return err(flipFailedError(committed.error.message));
      ctx.ledger = committed.value;
    } else {
      const pending = ctx.ledger.transactions[journal.transactionId];
      const transitionJournal: LogicalJournalV1Dto =
        pending === undefined
          ? journal
          : {
              ...pending,
              phase: journal.phase,
              actual: { ...pending.actual, after: journal.actual.after },
              updatedAt: journal.updatedAt,
              completedAt: journal.completedAt,
            };
      const base =
        pending === undefined
          ? withLedgerPairAt(ctx.ledger, scopeKey, skill, tool, pair as LedgerPairV1Dto)
          : ok(ctx.ledger);
      if (!base.ok) return base;
      const advanced = advanceLogicalTransaction(base.value, transitionJournal);
      if (!advanced.ok) return err(flipFailedError(advanced.error.message));
      ctx.ledger = advanced.value;
    }
  } else {
    const next = withLedgerPairAt(ctx.ledger, scopeKey, skill, tool, pair as LedgerPairV1Dto);
    if (!next.ok) return next;
    ctx.ledger = next.value;
  }
  return ctx.persist();
};

const persistWithoutPair = async (
  ctx: SwapCtx,
  scopeKey: string | null,
  skill: string,
  tool: string,
): Promise<Result<void, SkillSmithError>> => {
  if ('schemaVersion' in ctx.ledger) {
    deletePairAt(ctx.ledger, scopeKey, skill, tool as FlipTool);
    return ctx.persist();
  }
  const next = withoutLedgerPairAt(ctx.ledger, scopeKey, skill, tool);
  if (!next.ok) return next;
  ctx.ledger = next.value;
  return ctx.persist();
};

const logicalRollbackError = (message: string, cancelled = false): SkillSmithError =>
  cancelled ? cancelledError(message) : flipFailedError(message);

/**
 * Switch the original interrupted transaction to rollback before changing the filesystem. The
 * durable direction change makes a crash after this boundary resume rollback instead of allowing a
 * same-operation retry to drive the interrupted forward transaction to committed.
 */
const prepareLogicalRollback = async (
  ctx: SwapCtx,
  transactionId: string,
): Promise<Result<LogicalJournalV1Dto | null, SkillSmithError>> => {
  if ('schemaVersion' in ctx.ledger) return ok(null);

  const pending = ctx.ledger.transactions[transactionId];
  // Canonical ledgers migrated from the legacy schema may still carry an unmatched compatibility
  // shadow. There is no logical transaction to abort in that representation, so retain the legacy
  // journal-clearing path. A matched logical transaction always takes the durable rollback route.
  if (pending === undefined) return ok(null);
  if (pending.disposition === 'rollback') return ok(pending);

  const aborted = abortPendingLogicalTransaction(ctx.ledger, {
    transactionId: pending.transactionId,
    pairId: pending.intent.pairId,
    command: 'skillsmith-rollback',
    workflow: 'placement-swap',
    updatedAt: ctx.now(),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (!aborted.ok) {
    return err(logicalRollbackError(aborted.error.message, aborted.error.reason === 'cancelled'));
  }
  ctx.ledger = aborted.value;
  const persisted = await ctx.persist();
  if (!persisted.ok) return persisted;

  const rollback = ctx.ledger.transactions[transactionId];
  return rollback?.disposition === 'rollback'
    ? ok(rollback)
    : err(flipFailedError('durable logical placement rollback transaction is missing'));
};

/** Finish the original transaction as rollback after its before-image is authoritative on disk. */
const commitLogicalRollback = async (
  ctx: SwapCtx,
  transactionId: string,
  scopeKey: string | null,
  skill: string,
  tool: string,
  restoredMode: PairRecord['mode'],
): Promise<Result<void, SkillSmithError>> => {
  if ('schemaVersion' in ctx.ledger) {
    return err(flipFailedError('logical placement rollback requires a canonical ledger'));
  }
  const pending = ctx.ledger.transactions[transactionId];
  if (pending === undefined || pending.disposition !== 'rollback') {
    return err(flipFailedError('logical placement rollback transaction is not pending'));
  }

  let terminalBase = ctx.ledger;
  if (pending.intent.before.kind !== 'absent') {
    const currentPair = getLedgerPairAt(terminalBase, scopeKey, skill, tool);
    if (currentPair === null) {
      return err(flipFailedError('logical placement rollback pair is missing'));
    }
    const restored = withLedgerPairAt(terminalBase, scopeKey, skill, tool, {
      ...currentPair,
      mode: restoredMode,
    });
    if (!restored.ok) return restored;
    terminalBase = restored.value;
  }

  const terminalPending = terminalBase.transactions[transactionId];
  if (terminalPending === undefined || terminalPending.disposition !== 'rollback') {
    return err(flipFailedError('logical placement rollback transaction was lost during staging'));
  }
  const completedAt = ctx.now();
  const committed = commitLogicalTransaction(terminalBase, {
    ...terminalPending,
    phase: 'committed',
    actual: { ...terminalPending.actual, after: terminalPending.actual.before },
    updatedAt: completedAt,
    completedAt,
  });
  if (!committed.ok) return err(flipFailedError(committed.error.message));
  ctx.ledger = committed.value;
  return ctx.persist();
};

const PHASE_INDEX: Record<JournalPhase, number> = {
  prepared: 0,
  staged: 1,
  'backed-up': 2,
  live: 3,
  committed: 4,
};

const isPermError = (e: unknown): boolean => {
  const code = safeErrorCode(e);
  return code === 'EACCES' || code === 'EPERM';
};

const mapFsErr = (e: unknown, context: string): SkillSmithError =>
  isPermError(e)
    ? permissionDeniedError(`${context}: ${errorMessage(e)}`)
    : flipFailedError(`${context}: ${errorMessage(e)}`);

const guardFs = async (
  fn: () => Promise<void>,
  context: string,
): Promise<Result<void, SkillSmithError>> => {
  try {
    await fn();
    return ok(undefined);
  } catch (e) {
    return err(mapFsErr(e, context));
  }
};

const stagingNameOf = (skill: string, txId: string): string =>
  `.skillsmith-staging-${skill}-${txId}`;
const backupNameOf = (skill: string, txId: string): string => `.skillsmith-backup-${skill}-${txId}`;

const kindOf = (probe: PathKind): 'symlink' | 'dir' => (probe === 'symlink' ? 'symlink' : 'dir');

// Recursively fsync every regular file under a freshly copied staging tree (durability of P2).
const fsyncTree = async (env: SwapPorts, dir: string): Promise<void> => {
  const names = await env.listDir(dir);
  for (const name of names) {
    const abs = join(dir, name);
    const kind = await env.pathKind(abs);
    if (kind === 'dir') await fsyncTree(env, abs);
    else if (kind === 'file') await env.fsyncFile(abs);
  }
};

// Test seam: hold in a crash window for 30 s (used only by the CLI E2E via SKILLSMITH_TEST_PAUSE_AT).
const pause = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, 30_000);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

// Persist a phase transition (write-ahead) then, if configured, hold in that crash window.
const advance = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  pair: PairRecord,
  j: Journal,
  phase: JournalPhase,
): Promise<Result<void, SkillSmithError>> => {
  j.phase = phase;
  const p = await persistPair(ctx, plan.scopeKey ?? null, plan.skill, plan.tool, pair);
  if (!p.ok) return p;
  if (ctx.pauseAt === phase) await pause(ctx.signal);
  return ok(undefined);
};

// P2: materialize the staging entry under its dot-name (never touches the live path).
const buildStaging = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  j: Journal,
): Promise<Result<void, SkillSmithError>> => {
  const env = ctx.env;
  try {
    if (plan.op === 'promote') {
      if (!plan.promote) return err(genericError('promote plan missing promote payload'));
      await env.copyTree(plan.promote.storePath, j.stagingPath);
      await fsyncTree(env, j.stagingPath);
      const h = await contentHashOf(env, j.stagingPath);
      if (!h.ok) return h;
      if (h.value !== plan.promote.contentHash) {
        return err(
          flipFailedError(
            `staging hash mismatch for ${plan.skill}: expected ${plan.promote.contentHash}`,
          ),
        );
      }
      return ok(undefined);
    }
    if (plan.op === 'install') {
      if (!plan.install) return err(genericError('install plan missing install payload'));
      if (plan.install.build === 'symlink') {
        await env.makeSymlink(plan.install.storePath, j.stagingPath);
        return ok(undefined);
      }
      await env.copyTree(plan.install.storePath, j.stagingPath);
      await fsyncTree(env, j.stagingPath);
      const h = await contentHashOf(env, j.stagingPath);
      if (!h.ok) return h;
      if (h.value !== plan.install.contentHash) {
        return err(
          flipFailedError(
            `staging hash mismatch for ${plan.skill}: expected ${plan.install.contentHash}`,
          ),
        );
      }
      return ok(undefined);
    }
    if (plan.op === 'uninstall') return ok(undefined); // no staging phase
    if (!plan.dev) return err(genericError('dev plan missing dev payload'));
    await env.makeSymlink(plan.dev.sourcePath, j.stagingPath);
    return ok(undefined);
  } catch (e) {
    return err(mapFsErr(e, `cannot stage ${plan.skill}`));
  }
};

/** Reclaim a backup left by a two-rename swap. Symlink backups are always removed (the store
 *  target they pointed at is never touched and remains recorded). A dir backup is removed only
 *  when its content matches a store entry recorded on the pair (reproducible); an edited copy is
 *  KEPT with a warning so an unmanaged edit is never silently destroyed. */
const reclaimBackup = async (
  env: SwapPorts,
  backupPath: string,
  acceptableHashes: readonly (string | null | undefined)[],
  label: string,
): Promise<Result<{ backupKept: string | null; warning: string | null }, SkillSmithError>> => {
  try {
    const kind = await env.pathKind(backupPath);
    if (kind === 'absent') return ok({ backupKept: null, warning: null });
    if (kind === 'symlink') {
      await env.removeTree(backupPath);
      return ok({ backupKept: null, warning: null });
    }
    const acceptable = acceptableHashes.filter(
      (h): h is string => typeof h === 'string' && h.length > 0,
    );
    const h = await contentHashOf(env, backupPath);
    if (!h.ok) return h;
    if (acceptable.includes(h.value)) {
      await env.removeTree(backupPath);
      return ok({ backupKept: null, warning: null });
    }
    return ok({
      backupKept: backupPath,
      warning: `kept backup ${backupPath}: the ${label} copy was edited in place (hash mismatch)`,
    });
  } catch (e) {
    return err(mapFsErr(e, `cannot reclaim backup ${backupPath}`));
  }
};

// P5: write-ahead commit (durable committed journal) THEN reclaim the backup. Committing first
// keeps the C5 rollback valid — the backup is the only physical copy of the old state and must
// survive until the new live entry is recorded as committed. Promote/dev leave the committed
// journal at rest; acquisition ops (install/uninstall) finish with a terminal write that nulls the
// journal (install) or deletes the pair (uninstall) so no committed acquisition journal survives.
const commit = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  pair: PairRecord,
  j: Journal,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const env = ctx.env;
  const scopeKey = plan.scopeKey ?? null;
  try {
    await env.fsyncDir(plan.skillsRoot);
  } catch (e) {
    return err(mapFsErr(e, `cannot fsync ${plan.skillsRoot}`));
  }

  if (plan.op === 'promote' || plan.op === 'dev') {
    if (plan.op === 'promote') {
      if (!plan.promote) return err(genericError('promote plan missing promote payload'));
      pair.mode = 'pinned';
      pair.pinned = plan.promote.pinned;
      pair.dev = plan.promote.devRecord;
    } else {
      if (!plan.dev) return err(genericError('dev plan missing dev payload'));
      pair.mode = 'dev';
      pair.dev = plan.dev.devRecord;
    }
    j.phase = 'committed';
    j.completedAt = ctx.now();
    const persisted = await persistPair(ctx, scopeKey, plan.skill, plan.tool, pair);
    if (!persisted.ok) return persisted;

    // Backup reclamation is authorized by the now-durable committed journal.
    let backupKept: string | null = null;
    let warning: string | null = null;
    try {
      if (plan.op === 'dev') {
        const pinnedHash = pair.pinned?.contentHash ?? null;
        if ((await env.pathKind(j.backupPath)) !== 'absent') {
          if (pinnedHash === null) {
            backupKept = j.backupPath;
            warning = `kept backup ${j.backupPath}: no pinned record to verify the demoted copy`;
          } else {
            const h = await contentHashOf(env, j.backupPath);
            if (!h.ok) return h;
            if (h.value === pinnedHash) {
              await env.removeTree(j.backupPath);
            } else {
              backupKept = j.backupPath;
              warning = `kept backup ${j.backupPath}: demoted copy was edited in place (hash mismatch)`;
            }
          }
        }
      } else if ((await env.pathKind(j.backupPath)) !== 'absent') {
        await env.removeTree(j.backupPath);
      }
      await env.fsyncDir(plan.skillsRoot);
    } catch (e) {
      return err(mapFsErr(e, `cannot reclaim backup for ${plan.skill}`));
    }
    return ok({ committed: true, backupKept, warning });
  }

  if (plan.op === 'install') {
    // The terminal records (mode 'pinned', pinned, origin, dev) were staged at P1. A fresh install
    // (before absent) has no backup: a single terminal write nulls the journal. A replace install
    // needs a write-ahead committed journal to authorize reclaiming the backup, then a terminal
    // write to null the journal.
    if (j.before.mode === 'absent') {
      pair.journal = null;
      const persisted = await persistPair(ctx, scopeKey, plan.skill, plan.tool, pair);
      if (!persisted.ok) return persisted;
      return ok({ committed: true, backupKept: null, warning: null });
    }
    j.phase = 'committed';
    j.completedAt = ctx.now();
    const committed = await persistPair(ctx, scopeKey, plan.skill, plan.tool, pair);
    if (!committed.ok) return committed;

    const oldHash = j.before.mode === 'pinned' ? j.before.contentHash : null;
    const newHash = plan.install?.contentHash ?? pair.pinned?.contentHash ?? null;
    const reclaimed = await reclaimBackup(env, j.backupPath, [newHash, oldHash], 'replaced');
    if (!reclaimed.ok) return reclaimed;
    const synced = await guardFs(
      () => env.fsyncDir(plan.skillsRoot),
      `cannot fsync ${plan.skillsRoot}`,
    );
    if (!synced.ok) return synced;

    pair.journal = null;
    const terminal = await persistPair(ctx, scopeKey, plan.skill, plan.tool, pair);
    if (!terminal.ok) return terminal;
    return ok({ committed: true, ...reclaimed.value });
  }

  // op === 'uninstall'
  j.phase = 'committed';
  j.completedAt = ctx.now();
  const committed = await persistPair(ctx, scopeKey, plan.skill, plan.tool, pair);
  if (!committed.ok) return committed;

  const reclaimed = await reclaimBackup(
    env,
    j.backupPath,
    [pair.pinned?.contentHash],
    'uninstalled',
  );
  if (!reclaimed.ok) return reclaimed;
  const synced = await guardFs(
    () => env.fsyncDir(plan.skillsRoot),
    `cannot fsync ${plan.skillsRoot}`,
  );
  if (!synced.ok) return synced;

  const terminal = await persistWithoutPair(ctx, scopeKey, plan.skill, plan.tool);
  if (!terminal.ok) return terminal;
  return ok({ committed: true, ...reclaimed.value });
};

// Drive the swap forward from the journal's current phase to committed, probing the filesystem to
// disambiguate the crash window (spec §8.4 right column). Idempotent per phase. Uninstall has no
// staging (P2) and no publish (P4) — only the P3 backup rename and the P5 commit.
const forward = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  pair: PairRecord,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const j = pair.journal;
  if (!j) return err(genericError(`no journal to drive for ${plan.skill}`));
  const env = ctx.env;
  const live = plan.placementPath;
  const idx = (): number => PHASE_INDEX[j.phase];
  const hasStaging = plan.op !== 'uninstall';

  // P2 — build staging (journal at prepared). Skipped for uninstall.
  if (hasStaging && idx() < PHASE_INDEX.staged) {
    if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
    if ((await env.pathKind(j.stagingPath)) !== 'absent') {
      const cleared = await guardFs(() => env.removeTree(j.stagingPath), 'clear staging remnant');
      if (!cleared.ok) return cleared;
    }
    const built = await buildStaging(ctx, plan, j);
    if (!built.ok) return built;
    const p = await advance(ctx, plan, pair, j, 'staged');
    if (!p.ok) return p;
  }

  // Uninstall has no physical staging artifact, but its logical transaction still traverses the
  // complete adjacent phase protocol. Persist the staged state before backing up/removing live.
  if (!hasStaging && idx() < PHASE_INDEX.staged) {
    const p = await advance(ctx, plan, pair, j, 'staged');
    if (!p.ok) return p;
  }

  // P3 — persist backed-up, then rename(live → backup) if the live path is still the old entry.
  if (idx() < PHASE_INDEX['backed-up']) {
    if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
    const p = await advance(ctx, plan, pair, j, 'backed-up');
    if (!p.ok) return p;
  }
  if (idx() <= PHASE_INDEX['backed-up']) {
    if ((await env.pathKind(live)) !== 'absent') {
      if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
      const r = await guardFs(() => env.rename(live, j.backupPath), `back up ${plan.skill}`);
      if (!r.ok) return r;
    }
  }

  // P4 — persist live, then rename(staging → live) if the live path is still absent. Skipped for
  // uninstall (nothing is published).
  if (hasStaging) {
    if (idx() < PHASE_INDEX.live) {
      const p = await advance(ctx, plan, pair, j, 'live');
      if (!p.ok) return p;
    }
    if (idx() <= PHASE_INDEX.live) {
      if ((await env.pathKind(live)) === 'absent') {
        if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
        const r = await guardFs(() => env.rename(j.stagingPath, live), `install ${plan.skill}`);
        if (!r.ok) return r;
      }
    }
  } else if (idx() < PHASE_INDEX.live) {
    // Removing the live entry is the uninstall operation's published state. Record that logical
    // visibility before committing so forward transactions obey the same live-before-commit rule.
    const p = await advance(ctx, plan, pair, j, 'live');
    if (!p.ok) return p;
  }

  // P5 — commit.
  if (ctx.signal?.aborted) return err(flipFailedError('interrupted'));
  return commit(ctx, plan, pair, j);
};

export const refusedMessage = (op: JournalOp, skill: string, source?: string): string => {
  if (op === 'install') {
    return (
      `a previous install of ${skill} was interrupted. ` +
      `Run 'skillsmith promote --rollback ${skill}' (or 'skillsmith dev --rollback ${skill}') ` +
      `to restore the previous state, or re-run 'skillsmith install ${source ?? skill}' to complete it.`
    );
  }
  if (op === 'uninstall') {
    return (
      `a previous uninstall of ${skill} was interrupted. ` +
      `Run 'skillsmith promote --rollback ${skill}' (or 'skillsmith dev --rollback ${skill}') ` +
      `to restore the previous state, or re-run 'skillsmith uninstall ${skill}' to complete it.`
    );
  }
  return (
    `a previous ${op} of ${skill} was interrupted. ` +
    `Run 'skillsmith ${op} --rollback ${skill}' to restore the previous state, ` +
    `or re-run 'skillsmith ${op} ${skill}' to complete the swap.`
  );
};

// Compute the journal `before` record (the pre-swap live state) for a fresh swap.
const computeBefore = async (
  ctx: SwapCtx,
  plan: SwapPlan,
  existing: PairRecord | null,
  liveKind: PathKind,
): Promise<Result<Journal['before'], SkillSmithError>> => {
  const readLive = async (): Promise<Result<string, SkillSmithError>> => {
    try {
      return ok(await ctx.env.readLink(plan.placementPath));
    } catch (e) {
      return err(mapFsErr(e, `cannot read live symlink for ${plan.skill}`));
    }
  };

  if (plan.op === 'promote') {
    const t = await readLive();
    if (!t.ok) return t;
    return ok({ mode: 'dev', symlinkTarget: t.value, liveKind: kindOf(liveKind) });
  }
  if (plan.op === 'dev') {
    return ok({
      mode: 'pinned',
      storePath: existing?.pinned?.storePath ?? null,
      contentHash: existing?.pinned?.contentHash ?? null,
      liveKind: kindOf(liveKind),
    });
  }
  if (plan.op === 'install') {
    if (liveKind === 'absent') {
      // Fresh install. The run layer routes any pair holding prior records through the replace
      // path, so a fresh install must land on a genuinely empty slot.
      if (existing?.pinned || existing?.dev) {
        return err(
          genericError(
            `fresh install precondition violated for ${plan.skill}: pair holds prior records`,
          ),
        );
      }
      return ok({ mode: 'absent' });
    }
    // Replace install. `rollbackSwap` decides "live is the new artifact" (P4 done): for a
    // kind-changing swap by the kind flip; for symlink→symlink by the recorded old symlink target
    // (see below + rollbackSwap). dir→dir is BOTH kind- and target-ambiguous at that window, so it
    // stays rejected — the run layer must route a copy re-install as a kind change (promote's
    // demote-first path). symlink→symlink is safe and allowed.
    const newBuildKind = plan.install?.build === 'symlink' ? 'symlink' : 'dir';
    const oldKind = kindOf(liveKind);
    if (newBuildKind === 'dir' && oldKind === 'dir') {
      return err(
        genericError(
          `same-kind replace of ${plan.skill} (dir → dir) must be routed as a kind change by the run layer`,
        ),
      );
    }
    // Record the old symlink target for ANY symlink pre-state so rollback can disambiguate a
    // symlink→symlink replace via the target. `adoptedDev` is the run layer's signal that the live
    // symlink points outside the store (governs dev-vs-pinned mode); if it forgets to set it, that
    // dev record is silently lost (recorded as pinned instead of dev).
    let symlinkTarget: string | null = null;
    if (oldKind === 'symlink') {
      const t = await readLive();
      if (!t.ok) return t;
      symlinkTarget = t.value;
    }
    if (plan.install?.adoptedDev) {
      if (symlinkTarget === null) {
        return err(
          genericError(`cannot adopt dev source for ${plan.skill}: live is not a symlink`),
        );
      }
      return ok({ mode: 'dev', symlinkTarget, liveKind: 'symlink' });
    }
    return ok({
      mode: 'pinned',
      storePath: existing?.pinned?.storePath ?? null,
      contentHash: existing?.pinned?.contentHash ?? null,
      liveKind: oldKind,
      ...(symlinkTarget !== null ? { symlinkTarget } : {}),
    });
  }
  // op === 'uninstall'
  if (!existing) return err(genericError(`cannot uninstall ${plan.skill}: no pair record`));
  if (existing.mode === 'dev') {
    const t = await readLive();
    if (!t.ok) return t;
    return ok({ mode: 'dev', symlinkTarget: t.value, liveKind: kindOf(liveKind) });
  }
  // Record the old symlink target for a store-symlink placement too, so rollback's symlink branch
  // always has it (uninstall is symlink→absent, so a live symlink at rollback is always the OLD one;
  // recording the target keeps that branch well-defined rather than tripping its fail-loud guard).
  let uninstallTarget: string | null = null;
  if (kindOf(liveKind) === 'symlink') {
    const t = await readLive();
    if (!t.ok) return t;
    uninstallTarget = t.value;
  }
  return ok({
    mode: 'pinned',
    storePath: existing.pinned?.storePath ?? null,
    contentHash: existing.pinned?.contentHash ?? null,
    liveKind: kindOf(liveKind),
    ...(uninstallTarget !== null ? { symlinkTarget: uninstallTarget } : {}),
  });
};

// Build the pair record to stage behind the uncommitted journal at P1.
const stagePair = (
  plan: SwapPlan,
  existing: PairRecord | null,
  before: Journal['before'],
  journal: Journal,
): Result<PairRecord, SkillSmithError> => {
  if (plan.op === 'install') {
    if (!plan.install) return err(genericError('install plan missing install payload'));
    return ok({
      placementPath: plan.placementPath,
      mode: 'pinned',
      dev: plan.install.adoptedDev ?? existing?.dev ?? null,
      pinned: plan.install.pinned,
      origin: plan.install.origin,
      journal,
    });
  }
  if (plan.op === 'uninstall') {
    if (!existing) return err(genericError(`cannot uninstall ${plan.skill}: no pair record`));
    return ok({ ...existing, journal });
  }
  // promote / dev — mode stays the before-mode until P5 (P12 shape, unchanged).
  const mode = before.mode === 'dev' ? 'dev' : 'pinned';
  return ok({
    placementPath: plan.placementPath,
    mode,
    dev: plan.op === 'promote' ? (plan.promote?.devRecord ?? null) : (plan.dev?.devRecord ?? null),
    pinned: plan.op === 'promote' ? (plan.promote?.pinned ?? null) : (existing?.pinned ?? null),
    ...(existing?.origin ? { origin: existing.origin } : {}),
    journal,
  });
};

/** Start a fresh journaled swap. Refuses (flip-refused) when the pair carries an uncommitted
 *  journal — the caller must rollback or resume it first (Global Constraint 6). */
export const runSwap = async (
  ctx: SwapCtx,
  plan: SwapPlan,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const scopeKey = plan.scopeKey ?? null;
  const existing = pairAt(ctx, scopeKey, plan.skill, plan.tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    return err(
      flipRefusedError(
        refusedMessage(existing.journal.op, plan.skill, plan.install?.origin.source),
      ),
    );
  }

  let liveKind: PathKind;
  try {
    liveKind = await ctx.env.pathKind(plan.placementPath);
  } catch (e) {
    return err(mapFsErr(e, `cannot probe live path for ${plan.skill}`));
  }

  const beforeRes = await computeBefore(ctx, plan, existing, liveKind);
  if (!beforeRes.ok) return beforeRes;
  const before = beforeRes.value;

  const txId = ctx.newTxId();
  const journal: Journal = {
    op: plan.op,
    txId,
    phase: 'prepared',
    startedAt: ctx.now(),
    completedAt: null,
    before,
    stagingPath: join(plan.skillsRoot, stagingNameOf(plan.skill, txId)),
    backupPath: join(plan.skillsRoot, backupNameOf(plan.skill, txId)),
  };

  const pairRes = stagePair(plan, existing, before, journal);
  if (!pairRes.ok) return pairRes;
  const pair = pairRes.value;
  const p1 = await persistPair(ctx, scopeKey, plan.skill, plan.tool, pair);
  if (!p1.ok) return p1;
  if (ctx.pauseAt === 'prepared') await pause(ctx.signal);

  return forward(ctx, plan, pair);
};

const reconstructPlan = (
  pair: PairRecord,
  j: Journal,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null,
): Result<SwapPlan, SkillSmithError> => {
  const base = {
    skill,
    tool,
    skillsRoot: dirname(pair.placementPath),
    placementPath: pair.placementPath,
    scopeKey,
  };
  if (j.op === 'promote') {
    if (!pair.pinned) return err(genericError(`cannot resume promote of ${skill}: pinned missing`));
    if (!pair.dev) return err(genericError(`cannot resume promote of ${skill}: dev missing`));
    return ok({
      ...base,
      op: 'promote',
      promote: {
        storePath: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
        pinned: pair.pinned,
        devRecord: pair.dev,
      },
    });
  }
  if (j.op === 'dev') {
    if (!pair.dev) return err(genericError(`cannot resume dev of ${skill}: dev missing`));
    return ok({
      ...base,
      op: 'dev',
      dev: { sourcePath: pair.dev.sourcePath, devRecord: pair.dev },
    });
  }
  if (j.op === 'install') {
    if (!pair.pinned) return err(genericError(`cannot resume install of ${skill}: pinned missing`));
    if (!pair.origin) return err(genericError(`cannot resume install of ${skill}: origin missing`));
    return ok({
      ...base,
      op: 'install',
      install: {
        build: pair.pinned.placement === 'symlink' ? 'symlink' : 'copy',
        storePath: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
        pinned: pair.pinned,
        origin: pair.origin,
        adoptedDev: pair.dev,
      },
    });
  }
  if (j.op === 'uninstall') {
    return ok({ ...base, op: 'uninstall' });
  }
  return err(genericError(`cannot resume journal op '${j.op}' for ${skill}`));
};

/** Same-op re-run continuation (spec §8.4 right column). Reconstructs the plan from the ledger and
 *  drives the journal forward to committed; a committed journal only reclaims residue and finishes
 *  the terminal transition.
 *  Warning: called on an already-`committed` journal, this still returns `ok({committed: true})` —
 *  that means "residue reclaimed", never "this call just performed the swap"; callers must not
 *  count it as a fresh success. */
export const resumeSwap = async (
  ctx: SwapCtx,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null = null,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pair = pairAt(ctx, scopeKey, skill, tool);
  const j = pair?.journal ?? null;
  if (!pair || !j) return err(flipRefusedError(`nothing to resume for ${skill}`));
  const plan = reconstructPlan(pair, j, skill, tool, scopeKey);
  if (!plan.ok) return plan;
  return forward(ctx, plan.value, pair);
};

/** Uncommitted-journal recovery (spec §8.4 --rollback column). Restores the before-state with at
 *  most two renames and clears the journal. A committed promote/dev/install is refused — the run
 *  layer performs the inverse via the retained records. A committed uninstall is still reversible
 *  while its backup survives (rename it back); once reclaimed it is terminal. A fresh install
 *  (before absent) rolls back to "nothing there": the new artifact and pair record are removed. */
export const rollbackSwap = async (
  ctx: SwapCtx,
  skill: string,
  tool: FlipTool,
  scopeKey: string | null = null,
): Promise<Result<SwapOutcome, SkillSmithError>> => {
  const pair = pairAt(ctx, scopeKey, skill, tool);
  const j = pair?.journal ?? null;
  if (!pair || !j) return err(flipRefusedError(`nothing to roll back for ${skill}`));

  const env = ctx.env;
  const live = pair.placementPath;
  const before = j.before;

  if (j.phase === 'committed') {
    if (j.op === 'uninstall' && (await env.pathKind(j.backupPath)) !== 'absent') {
      try {
        if ((await env.pathKind(live)) === 'absent') await env.rename(j.backupPath, live);
      } catch (e) {
        return err(mapFsErr(e, `cannot roll back ${skill}`));
      }
      pair.journal = null;
      const persisted = await persistPair(ctx, scopeKey, skill, tool, pair);
      if (!persisted.ok) return persisted;
      return ok({ committed: false, backupKept: null, warning: null });
    }
    return err(flipRefusedError(`cannot roll back a committed ${j.op} of ${skill}`));
  }

  const logicalRollback = await prepareLogicalRollback(ctx, j.txId);
  if (!logicalRollback.ok) return logicalRollback;

  // Fresh install: the only live entry that can exist is the new artifact. Restore "nothing there".
  if (before.mode === 'absent') {
    try {
      if ((await env.pathKind(live)) !== 'absent') await env.removeTree(live);
      if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
    } catch (e) {
      return err(mapFsErr(e, `cannot roll back ${skill}`));
    }
    const persisted =
      logicalRollback.value === null
        ? await persistWithoutPair(ctx, scopeKey, skill, tool)
        : await commitLogicalRollback(ctx, j.txId, scopeKey, skill, tool, pair.mode);
    if (!persisted.ok) return persisted;
    return ok({ committed: false, backupKept: null, warning: null });
  }

  const oldKind = before.liveKind ?? (before.mode === 'dev' ? 'symlink' : 'dir');
  try {
    const liveKind = await env.pathKind(live);
    if (liveKind === 'absent') {
      // P3 done, P4 not: the old entry lives at the backup — one rename restores it.
      if ((await env.pathKind(j.backupPath)) !== 'absent') {
        await env.rename(j.backupPath, live);
      }
    } else {
      // Live is present: decide whether it is the NEW artifact (P4 done) or still the OLD one. A kind
      // change tells them apart; a symlink→symlink replace can't be told apart by kind, so compare
      // the recorded old symlink target — this is what makes symlink→symlink replace safe to allow.
      let liveIsNew: boolean;
      if (oldKind === 'symlink' && liveKind === 'symlink') {
        if (before.symlinkTarget == null) {
          return err(
            genericError(`cannot roll back ${skill}: symlink before-state is missing its target`),
          );
        }
        liveIsNew = (await env.readLink(live)) !== before.symlinkTarget;
      } else {
        liveIsNew = liveKind !== oldKind;
      }
      if (liveIsNew) {
        // Move the new entry aside, restore the backup, drop the new one.
        if ((await env.pathKind(j.backupPath)) !== 'absent') {
          if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
          await env.rename(live, j.stagingPath);
          await env.rename(j.backupPath, live);
        }
      }
      // else: live is still the old entry — nothing to restore.
    }
    if ((await env.pathKind(j.stagingPath)) !== 'absent') await env.removeTree(j.stagingPath);
  } catch (e) {
    return err(mapFsErr(e, `cannot roll back ${skill}`));
  }

  // Restores the old live BYTES but keeps whatever records `stagePair` wrote at P1: for an
  // uncommitted replace-install rollback that means the NEW pinned/origin/placement records survive
  // (mirrors P12 promote-rollback — the engine never retains the old PinnedRecord/origin, so it
  // cannot restore them). The run layer (Task 7) MUST reconcile the ledger record after such a rollback.
  pair.mode = before.mode;
  if (logicalRollback.value === null) pair.journal = null;
  const persisted = await (logicalRollback.value === null
    ? persistPair(ctx, scopeKey, skill, tool, pair)
    : commitLogicalRollback(ctx, j.txId, scopeKey, skill, tool, before.mode));
  if (!persisted.ok) return persisted;
  return ok({ committed: false, backupKept: null, warning: null });
};

/** §8.5: finish any committed acquisition journal left by a crash between the committed write and
 *  the terminal write. Walks the user `skills` tree AND every `projects` subtree. Runs at the start
 *  of every locked batch (install, uninstall, promote, dev, rollback). Idempotent. */
export const sweepCommittedAcquireJournals = async (
  ctx: SwapCtx,
): Promise<Result<string[], SkillSmithError>> => {
  type Target = { scopeKey: string | null; skill: string; tool: FlipTool };
  const targets: Target[] = [];

  const collect = (tree: LedgerModel['skills'], scopeKey: string | null): void => {
    for (const skill of Object.keys(tree)) {
      const entry = tree[skill];
      if (!entry) continue;
      for (const tool of Object.keys(entry.tools) as FlipTool[]) {
        const j = entry.tools[tool]?.journal;
        if (j && j.phase === 'committed' && (j.op === 'install' || j.op === 'uninstall')) {
          targets.push({ scopeKey, skill, tool });
        }
      }
    }
  };

  collect(ctx.ledger.skills, null);
  if (ctx.ledger.projects) {
    for (const key of Object.keys(ctx.ledger.projects)) {
      const scope = ctx.ledger.projects[key];
      if (scope) collect(scope.skills, key);
    }
  }

  const notes: string[] = [];
  for (const t of targets) {
    const pair = pairAt(ctx, t.scopeKey, t.skill, t.tool);
    const j = pair?.journal ?? null;
    if (!pair || !j) continue;
    const plan = reconstructPlan(pair, j, t.skill, t.tool, t.scopeKey);
    if (!plan.ok) return plan;
    const done = await forward(ctx, plan.value, pair);
    if (!done.ok) return done;
    if (done.value.warning) notes.push(done.value.warning);
  }
  return ok(notes);
};
