import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { Result } from '../result.ts';

export const FLIP_TOOLS = ['claude-code', 'codex'] as const;
export type FlipTool = (typeof FLIP_TOOLS)[number];
export type FlipOp = 'promote' | 'dev' | 'rollback';
export type { Placement, PlacementClass } from '../agents/placement-shared.ts';

export interface DevRecord {
  sourcePath: string;
  resolvedPath: string;
  repoRoot: string | null;
  sourceRelPath: string | null;
  remote: string | null;
  recordedAt: string;
}

export interface PinnedRecord {
  storePath: string;
  rev: string;
  gitSha: string | null;
  dirty: boolean;
  contentHash: string; // 'sha256:<64hex>'
  snapshotAt: string;
  verify: 'passed' | 'warned' | 'skipped';
}

export interface PairRecord {
  placementPath: string;
  mode: 'dev' | 'pinned';
  dev: DevRecord | null;
  pinned: PinnedRecord | null;
  journal: Journal | null;
}

export type JournalPhase = 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';

export interface Journal {
  op: FlipOp;
  txId: string; // 8 lowercase hex chars
  phase: JournalPhase;
  startedAt: string;
  completedAt: string | null;
  before:
    | { mode: 'dev'; symlinkTarget: string }
    | { mode: 'pinned'; storePath: string | null; contentHash: string | null };
  stagingPath: string;
  backupPath: string;
}

export interface LedgerFile {
  schemaVersion: 1;
  kind: 'skillsmith.placements';
  updatedAt: string;
  skills: Record<string, { tools: Partial<Record<FlipTool, PairRecord>> }>;
}

export interface Provenance {
  kind: 'git-clean' | 'git-dirty' | 'non-git';
  repoRoot: string | null;
  sourceRelPath: string | null;
  remote: string | null; // 'owner/repo' or null
  gitSha: string | null; // full 40-hex
  ns: string; // '<owner>' | 'local'
  name: string; // '<repo>' | '<dirname>'
  dirtySummary: string | null; // trimmed `git status --porcelain` output when dirty
}

export interface SwapCtx {
  env: ScanEnv;
  ledgerPath: string;
  ledger: LedgerFile; // mutated in place by the engine
  persist: () => Promise<Result<void, SkillSmithError>>; // writeLedger(env, ledgerPath, ledger)
  now: () => string; // injectable clock (ISO string)
  newTxId: () => string; // injectable 8-hex generator
  pauseAt?: JournalPhase | undefined; // test seam, see swap.ts
  signal?: AbortSignal | undefined;
}

export interface SwapPlan {
  op: 'promote' | 'dev';
  rollbackOf?: FlipOp; // set when this swap implements a committed-state rollback
  skill: string;
  tool: FlipTool;
  skillsRoot: string;
  placementPath: string; // join(skillsRoot, skill)
  // promote: the store entry to materialize; dev: the literal symlink target to restore
  promote?: { storePath: string; contentHash: string; pinned: PinnedRecord; devRecord: DevRecord };
  dev?: { sourcePath: string; devRecord: DevRecord };
}

export interface SwapOutcome {
  committed: boolean;
  backupKept: string | null; // path of a preserved backup (hash mismatch / no pinned record)
  warning: string | null;
}
