import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import {
  type LedgerMigrationCursor,
  type LedgerWriteReceipt,
  type LedgerWriter,
  type LedgerWriterBarrier,
  type LedgerWriterError,
  type LedgerWriterPorts,
  createTestNodeLedgerWriter,
} from '../artifacts/ledger-writer.ts';
import { type SkillSmithError, cancelledError, safeErrorCode } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type { PlacementPorts } from './types.ts';

type LedgerCancellationError = Extract<SkillSmithError, { readonly code: 'cancelled' }>;
export type LedgerPersistenceError = LedgerWriterError | LedgerCancellationError;
type CallerLedgerWriterPorts = PlacementPorts & {
  /** Explicit narrower I/O composition for callers that observe other filesystem operations. */
  readonly ledgerWriterPorts?: LedgerWriterPorts;
  /** Deterministic observation seam for the canonical writer's durable barriers. */
  readonly afterLedgerBarrier?: (value: LedgerWriterBarrier) => Promise<void>;
};

const cancellationCode = (error: unknown): string | null => {
  const code = safeErrorCode(error);
  if (code !== null) return code;
  if (error === null || typeof error !== 'object' || !('name' in error)) return null;
  return typeof error.name === 'string' ? error.name : null;
};

/** Normalize the writer's exceptional cancellation protocol at its one caller boundary. */
export const runLedgerWriterOperation = async <T>(
  operation: () => Promise<Result<T, LedgerPersistenceError>>,
): Promise<Result<T, LedgerPersistenceError>> => {
  try {
    return await operation();
  } catch (error) {
    const code = cancellationCode(error);
    if (code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError') {
      return err(cancelledError('interrupted') as LedgerCancellationError);
    }
    throw error;
  }
};

/** Open the one canonical writer with explicit caller-owned I/O and deterministic barriers. */
export const openCallerLedgerWriter = (
  env: CallerLedgerWriterPorts,
  ledgerPath: string,
  signal?: AbortSignal,
  afterCursorTransition?: (cursor: LedgerMigrationCursor) => void,
): Promise<Result<LedgerWriter, LedgerPersistenceError>> => {
  return runLedgerWriterOperation(async () =>
    ok(
      await createTestNodeLedgerWriter(ledgerPath, {
        ports: env.ledgerWriterPorts ?? env,
        ...(env.afterLedgerBarrier === undefined ? {} : { afterBarrier: env.afterLedgerBarrier }),
        ...(afterCursorTransition === undefined ? {} : { afterCursorTransition }),
        ...(signal === undefined ? {} : { signal }),
      }),
    ),
  );
};

export interface LedgerPersistenceGateway {
  persist(model: LedgerModel): Promise<LedgerPersistenceResult>;
}

export type LedgerPersistenceResult =
  | { readonly ok: true; readonly value: LedgerWriteReceipt }
  | {
      readonly ok: false;
      readonly error: LedgerPersistenceError;
      readonly acknowledgedModel: LedgerModel | null;
    };

/**
 * Canonical expected-revision gateway for every placement mutation. `finalizeHistory` first
 * publishes the supplied model, then converges bounded history with proof-checked cleanup under
 * the same writer authority. The returned receipt becomes the next exact CAS expectation.
 */
export const createLedgerPersistenceGateway = (
  env: PlacementPorts,
  ledgerPath: string,
  signal?: AbortSignal,
): LedgerPersistenceGateway => {
  let writer: LedgerWriter | null = null;
  let expectedByteRevision: ArtifactDigest | null | undefined;
  let durableModel: LedgerModel | null = null;
  return Object.freeze({
    persist: async (model: LedgerModel): Promise<LedgerPersistenceResult> => {
      const persisted = await runLedgerWriterOperation(async () => {
        if (writer === null) {
          const opened = await openCallerLedgerWriter(env, ledgerPath, signal);
          if (!opened.ok) return opened;
          writer = opened.value;
        }
        if (expectedByteRevision === undefined) {
          const current = await writer.read();
          if (!current.ok) return current;
          if (current.value.state === 'present') {
            const preflight = await writer.finalizeHistory({
              model: current.value.model,
              expectedByteRevision: current.value.byteRevision,
            });
            if (!preflight.ok) return preflight;
            expectedByteRevision = preflight.value.byteRevision;
            durableModel = preflight.value.model;
            // The caller prepared its mutation from the prior model. Never merge that stale snapshot
            // over a preflight compaction; fail closed so the command can re-read and re-plan.
            if (preflight.value.changed) {
              return err<LedgerWriterError>({ code: 'stale-state', path: ledgerPath });
            }
          } else {
            expectedByteRevision = null;
            durableModel = null;
          }
        }
        const historyChanged =
          JSON.stringify(model.history) !== JSON.stringify(durableModel?.history ?? []);
        const written = await (historyChanged ? writer.finalizeHistory : writer.replace)({
          model,
          expectedByteRevision,
        });
        if (written.ok) {
          expectedByteRevision = written.value.byteRevision;
          durableModel = written.value.model;
        }
        return written;
      });
      return persisted.ok
        ? persisted
        : Object.freeze({
            ok: false,
            error: persisted.error,
            acknowledgedModel: durableModel,
          });
    },
  });
};
