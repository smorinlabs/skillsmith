import {
  type SyncCliProduct,
  type SyncFleet,
  createSyncFleet,
  destroySyncFleet,
  runSyncCli,
} from '../p5-sync/fleet.ts';
import {
  type CreateUpdateFleetOptions,
  type UpdateCliProduct,
  type UpdateFleet,
  createUpdateFleet,
  destroyUpdateFleet,
  runUpdateCli,
  runUpdateCliWithSignal,
  snapshotUpdateState,
} from '../p5-update/fleet.ts';

export type BatchFleet = UpdateFleet;
export type BatchCliProduct = UpdateCliProduct;

export const createBatchFleet = (options: CreateUpdateFleetOptions = {}): Promise<BatchFleet> =>
  createUpdateFleet(options);

export const destroyBatchFleet = destroyUpdateFleet;
export const snapshotBatchState = snapshotUpdateState;

export const runBatchCli = (fleet: BatchFleet, args: readonly string[]): Promise<BatchCliProduct> =>
  runUpdateCli(fleet, args);
export const runBatchCliWithSignal = runUpdateCliWithSignal;

export type SyncBatchFleet = SyncFleet;
export type SyncBatchCliProduct = SyncCliProduct;
export const createSyncBatchFleet = createSyncFleet;
export const destroySyncBatchFleet = destroySyncFleet;
export const runSyncBatchCli = runSyncCli;

export const snapshotSyncBatchState = async (
  fleet: SyncBatchFleet,
): Promise<Readonly<Record<string, string | null>>> => {
  const snapshot = async (path: string): Promise<string | null> =>
    Bun.file(path)
      .exists()
      .then((exists) => (exists ? Bun.file(path).text() : null));
  return Object.freeze({
    ledger: await snapshot(fleet.ledger),
    lint: await snapshot(`${fleet.projects.c}/.agents/skills/lint/SKILL.md`),
    review: await snapshot(`${fleet.projects.c}/.agents/skills/review/SKILL.md`),
    claudeReview: await snapshot(`${fleet.projects.c}/.claude/skills/review/SKILL.md`),
  });
};

export const parseBatchJson = (
  product: BatchCliProduct | SyncBatchCliProduct,
  expectedExit = 0,
): Record<string, unknown> => {
  if (product.exitCode !== expectedExit) {
    throw new Error(
      `unexpected CLI exit ${product.exitCode} (expected ${expectedExit}): ${product.stderr}${product.stdout}`,
    );
  }
  if (product.stderr !== '') throw new Error(`unexpected CLI stderr: ${product.stderr}`);
  const parsed: unknown = JSON.parse(product.stdout);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('batch CLI JSON product is not an object');
  }
  return parsed as Record<string, unknown>;
};
