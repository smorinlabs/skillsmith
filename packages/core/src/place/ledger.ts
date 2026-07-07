import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ScanEnv } from '../env/types.ts';
import {
  type SkillSmithError,
  errorMessage,
  flipFailedError,
  ledgerError,
  permissionDeniedError,
} from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { FLIP_TOOLS, type FlipTool, type LedgerFile, type PairRecord } from './types.ts';

const isPermError = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  'code' in e &&
  ((e as { code: unknown }).code === 'EACCES' || (e as { code: unknown }).code === 'EPERM');

const DevRecordSchema = z.object({
  sourcePath: z.string(),
  resolvedPath: z.string(),
  repoRoot: z.string().nullable(),
  sourceRelPath: z.string().nullable(),
  remote: z.string().nullable(),
  recordedAt: z.string(),
});

const PinnedRecordSchema = z.object({
  storePath: z.string(),
  rev: z.string(),
  gitSha: z.string().nullable(),
  dirty: z.boolean(),
  contentHash: z.string(),
  snapshotAt: z.string(),
  verify: z.enum(['passed', 'warned', 'skipped']),
});

const JournalSchema = z.object({
  op: z.enum(['promote', 'dev', 'rollback']),
  txId: z.string(),
  phase: z.enum(['prepared', 'staged', 'backed-up', 'live', 'committed']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  before: z.union([
    z.object({ mode: z.literal('dev'), symlinkTarget: z.string() }),
    z.object({
      mode: z.literal('pinned'),
      storePath: z.string().nullable(),
      contentHash: z.string().nullable(),
    }),
  ]),
  stagingPath: z.string(),
  backupPath: z.string(),
});

const PairRecordSchema = z.object({
  placementPath: z.string(),
  mode: z.enum(['dev', 'pinned']),
  dev: DevRecordSchema.nullable(),
  pinned: PinnedRecordSchema.nullable(),
  journal: JournalSchema.nullable(),
});

const LedgerSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('skillsmith.placements'),
  updatedAt: z.string(),
  skills: z.record(z.string(), z.object({ tools: z.record(z.enum(FLIP_TOOLS), PairRecordSchema) })),
});

export const emptyLedger = (now: string): LedgerFile => ({
  schemaVersion: 1,
  kind: 'skillsmith.placements',
  updatedAt: now,
  skills: {},
});

export const readLedger = async (
  env: ScanEnv,
  ledgerPath: string,
): Promise<Result<LedgerFile, SkillSmithError>> => {
  if ((await env.pathKind(ledgerPath)) === 'absent') {
    return ok(emptyLedger(new Date().toISOString()));
  }

  let text: string;
  try {
    text = await env.readText(ledgerPath);
  } catch (e) {
    if (isPermError(e)) {
      return err(permissionDeniedError(`cannot read ledger: ${errorMessage(e)}`, ledgerPath));
    }
    return err(ledgerError(`cannot read ledger: ${errorMessage(e)}`, ledgerPath));
  }

  if (text.trim().length === 0) return ok(emptyLedger(new Date().toISOString()));

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return err(ledgerError(`ledger is not valid JSON: ${errorMessage(e)}`, ledgerPath));
  }

  const parsed = LedgerSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') || '<root>';
    return err(ledgerError(`ledger schema: ${path}: ${first?.message ?? 'invalid'}`, ledgerPath));
  }
  return ok(parsed.data as LedgerFile);
};

export const writeLedger = async (
  env: ScanEnv,
  ledgerPath: string,
  ledger: LedgerFile,
): Promise<Result<void, SkillSmithError>> => {
  const serialized = JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${ledgerPath}.tmp-${randomBytes(4).toString('hex')}`;
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
  env: ScanEnv,
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

  // proper-lockfile needs the target to exist; create it empty on first use (`writeFile ax`
  // semantics — never clobber existing content). Precedent: config/save.ts.
  if ((await env.pathKind(ledgerPath)) === 'absent') {
    await env.writeTextFile(ledgerPath, '').catch(() => {});
  }

  try {
    const value = await env.withFileLock(ledgerPath, fn);
    return ok(value);
  } catch (e) {
    return err(flipFailedError(`another skillsmith operation is running: ${errorMessage(e)}`));
  }
};

export const getPair = (l: LedgerFile, skill: string, tool: FlipTool): PairRecord | null => {
  const entry = l.skills[skill];
  if (!entry) return null;
  return entry.tools[tool] ?? null;
};

export const setPair = (l: LedgerFile, skill: string, tool: FlipTool, rec: PairRecord): void => {
  const entry = l.skills[skill] ?? { tools: {} };
  entry.tools[tool] = rec;
  l.skills[skill] = entry;
};
