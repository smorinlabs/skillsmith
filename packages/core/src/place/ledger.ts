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
  placement: z.enum(['symlink', 'copy']).optional(),
});

const OriginRecordSchema = z.object({
  source: z.string(),
  host: z.string(),
  repo: z.string(),
  skillPath: z.string(),
  refRequested: z.string().nullable(),
  refResolved: z.string(),
  pin: z.boolean(),
  installedAt: z.string(),
});

const JournalSchema = z.object({
  op: z.enum(['promote', 'dev', 'rollback', 'install', 'uninstall']),
  txId: z.string(),
  phase: z.enum(['prepared', 'staged', 'backed-up', 'live', 'committed']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  before: z.union([
    z.object({
      mode: z.literal('dev'),
      symlinkTarget: z.string(),
      liveKind: z.enum(['symlink', 'dir']).optional(),
    }),
    z.object({
      mode: z.literal('pinned'),
      storePath: z.string().nullable(),
      contentHash: z.string().nullable(),
      liveKind: z.enum(['symlink', 'dir']).optional(),
    }),
    z.object({ mode: z.literal('absent') }),
  ]),
  stagingPath: z.string(),
  backupPath: z.string(),
});

const PairRecordSchema = z.object({
  placementPath: z.string(),
  mode: z.enum(['dev', 'pinned']),
  dev: DevRecordSchema.nullable(),
  pinned: PinnedRecordSchema.nullable(),
  origin: OriginRecordSchema.optional(),
  journal: JournalSchema.nullable(),
});

const SkillsTreeSchema = z.record(
  z.string(),
  z.object({ tools: z.record(z.enum(FLIP_TOOLS), PairRecordSchema) }),
);

const LedgerSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('skillsmith.placements'),
  updatedAt: z.string(),
  skills: SkillsTreeSchema,
  projects: z.record(z.string(), z.object({ skills: SkillsTreeSchema })).optional(),
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
