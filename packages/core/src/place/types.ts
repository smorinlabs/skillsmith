import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { Result } from '../result.ts';

export const FLIP_TOOLS = ['claude-code', 'codex'] as const;
export type FlipTool = (typeof FLIP_TOOLS)[number];
export type FlipOp = 'promote' | 'dev' | 'rollback';
export type AcquireOp = 'install' | 'uninstall';
export type JournalOp = FlipOp | AcquireOp; // FlipOp is NOT widened
export type { Placement, PlacementClass } from '../agents/placement-shared.ts';

export interface OriginRecord {
  source: string; // the literal user argument ('smorinlabs/smorinlabs-harness/factor-scan')
  host: string; // 'github.com'
  repo: string; // UNCLAMPED repo path (subgroups keep their '/')
  skillPath: string; // repo-relative git tree path; '' for a root skill
  refRequested: string | null; // '@ref' / --ref as given; null = HEAD default
  refResolved: string; // always the full 40-hex SHA
  pin: boolean; // --pin policy marker
  installedAt: string;
}

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
  placement?: 'symlink' | 'copy'; // absent = 'copy' (every P12-written record)
}

export interface PairRecord {
  placementPath: string;
  mode: 'dev' | 'pinned';
  dev: DevRecord | null;
  pinned: PinnedRecord | null;
  origin?: OriginRecord; // written only by install
  journal: Journal | null;
}

export type JournalPhase = 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';

export interface Journal {
  op: JournalOp;
  txId: string; // 8 lowercase hex chars
  phase: JournalPhase;
  startedAt: string;
  completedAt: string | null;
  before:
    | { mode: 'dev'; symlinkTarget: string; liveKind?: 'symlink' | 'dir' }
    | {
        mode: 'pinned';
        storePath: string | null;
        contentHash: string | null;
        liveKind?: 'symlink' | 'dir';
      }
    | { mode: 'absent' };
  stagingPath: string;
  backupPath: string;
}

export type ProjectScope = {
  skills: Record<string, { tools: Partial<Record<FlipTool, PairRecord>> }>;
};

export interface LedgerFile {
  schemaVersion: 1;
  kind: 'skillsmith.placements';
  updatedAt: string;
  skills: Record<string, { tools: Partial<Record<FlipTool, PairRecord>> }>;
  projects?: Record<string, ProjectScope>; // key = project root, REALPATH basis
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
  op: 'promote' | 'dev' | 'install' | 'uninstall';
  rollbackOf?: FlipOp; // set when this swap implements a committed-state rollback
  skill: string;
  tool: FlipTool;
  skillsRoot: string;
  placementPath: string; // join(skillsRoot, skill)
  scopeKey?: string | null; // realpath project key; null/undefined = user-scope `skills` tree
  // promote: the store entry to materialize; dev: the literal symlink target to restore
  promote?: { storePath: string; contentHash: string; pinned: PinnedRecord; devRecord: DevRecord };
  dev?: { sourcePath: string; devRecord: DevRecord };
  install?: {
    build: 'symlink' | 'copy';
    storePath: string;
    contentHash: string;
    pinned: PinnedRecord;
    origin: OriginRecord;
    adoptedDev: DevRecord | null;
  };
  // op 'uninstall' needs no payload — the engine reads the pair record.
}

export interface SwapOutcome {
  committed: boolean;
  backupKept: string | null; // path of a preserved backup (hash mismatch / no pinned record)
  warning: string | null;
}

export type FlipAction =
  | 'flipped'
  | 'updated'
  | 'noop'
  | 'skipped'
  | 'refused'
  | 'failed'
  | 'rolled-back';

export interface FlipResult {
  skill: string;
  tool: FlipTool | null; // null only for a target that matched no tool at all
  placementPath: string | null;
  action: FlipAction;
  reason: string | null; // human cause for skipped/refused/failed
  before: { mode: 'dev' | 'pinned'; symlinkTarget?: string; storePath?: string | null } | null;
  after: { mode: 'dev' | 'pinned'; symlinkTarget?: string; storePath?: string | null } | null;
  store: {
    path: string;
    rev: string;
    gitSha: string | null;
    dirty: boolean;
    reused: boolean;
  } | null;
  verify: {
    gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
    verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
  } | null; // null for dev/rollback pairs
  error?: SkillSmithError; // CORE-ONLY: drives the CLI exit code; NOT rendered in JSON
}

export interface FlipReport {
  op: FlipOp;
  dryRun: boolean;
  requested: { targets: string[]; all: boolean; tools: FlipTool[]; explicitTools: boolean };
  results: FlipResult[];
  summary: {
    flipped: number;
    updated: number;
    noop: number;
    skipped: number;
    refused: number;
    failed: number;
    rolledBack: number;
  };
}

export interface FlipOptions {
  targets: readonly string[];
  all?: boolean;
  tools?: readonly FlipTool[]; // explicit --tool list; undefined = auto
  source?: string; // dev only
  strict?: boolean; // promote only
  noVerify?: boolean; // promote only
  allowDirty?: boolean; // promote only
  rollback?: boolean;
  dryRun?: boolean;
  cwd: string;
  envVars: Record<string, string | undefined>;
  testPauseAt?: JournalPhase; // wired only by the CLI under SKILLSMITH_E2E=1
  signal?: AbortSignal;
}

export interface FlipDeps {
  verify: typeof import('../verify/run.ts').verifyPlugin; // injectable for tests
  now: () => string;
  newTxId: () => string;
}
