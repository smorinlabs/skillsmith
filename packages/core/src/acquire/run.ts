import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { installHint as claudeCodeInstallHint } from '../agents/claude-code/install-hint.ts';
import { getSkillRoots as claudeCodeSkillRoots } from '../agents/claude-code/skill-roots.ts';
import { installHint as codexInstallHint } from '../agents/codex/install-hint.ts';
import { getSkillRoots as codexSkillRoots } from '../agents/codex/skill-roots.ts';
import { type Placement, classifyPlacement } from '../agents/placement-shared.ts';
import { execGit } from '../env/git.ts';
import type { ScanEnv } from '../env/types.ts';
import {
  type SkillSmithError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  genericError,
  toolUnavailableError,
} from '../errors.ts';
import {
  deletePairAt,
  getPairAt,
  readLedger,
  setPairAt,
  withLedgerLock,
  writeLedger,
} from '../place/ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import { LEGACY_ROOT_NOTICE } from '../place/plan.ts';
import {
  type SnapshotResult,
  clampStoreNs,
  contentHashOf,
  snapshotToStore,
  sweepStaging,
} from '../place/store.ts';
import {
  refusedMessage,
  resumeSwap,
  runSwap,
  sweepCommittedAcquireJournals,
} from '../place/swap.ts';
import {
  FLIP_TOOLS,
  type FlipTool,
  type LedgerFile,
  type OriginRecord,
  type PairRecord,
  type PinnedRecord,
  type Provenance,
  type SwapCtx,
  type SwapPlan,
} from '../place/types.ts';
import { type Result, err, ok } from '../result.ts';
import { detectTool } from '../scan/index.ts';
import { verifyPlugin } from '../verify/run.ts';
import type { ToolVerdict } from '../verify/types.ts';
import {
  fetchRepo,
  lsTreeSkills,
  resolveRefViaLsRemote,
  sparseCheckoutSkill,
  sweepFetchOrphans,
} from './fetch.ts';
import { matchCandidates, selectSkill } from './resolve.ts';
import { parseSource } from './source.ts';
import type {
  CandidateSkill,
  InstallAction,
  InstallDeps,
  InstallOptions,
  InstallReport,
  InstallResult,
  InstallScope,
  SourceSpec,
  UninstallAction,
  UninstallDeps,
  UninstallOptions,
  UninstallReport,
  UninstallResult,
} from './types.ts';

export const defaultInstallDeps: Omit<InstallDeps, 'pick'> = {
  verify: verifyPlugin,
  detect: (env, tool, signal) => detectTool(env, tool, signal),
  now: () => new Date().toISOString(),
  newTxId: () => randomBytes(4).toString('hex'),
};

const SKILL_ROOTS: Record<FlipTool, typeof claudeCodeSkillRoots> = {
  'claude-code': claudeCodeSkillRoots,
  codex: codexSkillRoots,
};

const INSTALL_HINTS: Record<FlipTool, string> = {
  'claude-code': claudeCodeInstallHint,
  codex: codexInstallHint,
};

const PLUMBING_TIMEOUT_MS = 10_000;

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const lastSegment = (repoPath: string): string =>
  repoPath
    .split('/')
    .filter((s) => s.length > 0)
    .pop() ?? repoPath;

const selectorLabel = (spec: SourceSpec): string => {
  if (spec.selector.kind === 'path') return spec.selector.path;
  if (spec.selector.kind === 'name') return spec.selector.name;
  return spec.repoPath;
};

const resolveSymlinkAbsolute = (placementPath: string, literalTarget: string): string =>
  isAbsolute(literalTarget) ? literalTarget : join(dirname(placementPath), literalTarget);

// ---------------------------------------------------------------------------------------------
// result builders
// ---------------------------------------------------------------------------------------------

const emptyResult = (
  source: string,
  scope: InstallScope,
  action: InstallAction,
): InstallResult => ({
  source,
  skill: null,
  tool: null,
  scope,
  placementPath: null,
  action,
  reason: null,
  placement: null,
  store: null,
  origin: null,
  verify: null,
  candidates: null,
});

// ---------------------------------------------------------------------------------------------
// verify gate (D11 mirror; install-specific --deep wiring)
// ---------------------------------------------------------------------------------------------

interface Gate {
  blocked: SkillSmithError | null;
  gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
  verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
  mode: 'static' | 'static+deep' | null;
  notice: string | null;
}

const summarizeFindings = (tv: ToolVerdict | undefined): string => {
  if (!tv) return 'no verdict produced';
  const findings = tv.modes
    .flatMap((m) => m.findings)
    .filter((fnd) => fnd.normalizedSeverity !== 'info');
  if (findings.length === 0) return `verdict ${tv.verdict}`;
  return findings.map((fnd) => `${fnd.checkId}: ${fnd.message}`).join('; ');
};

const runInstallVerifyGate = async (
  env: ScanEnv,
  deps: InstallDeps,
  tool: FlipTool,
  path: string,
  opts: InstallOptions,
): Promise<Gate> => {
  if (opts.noVerify) {
    return { blocked: null, gate: 'skipped', verdict: null, mode: null, notice: null };
  }
  const deep = tool === 'codex' && opts.deep === true;
  const mode: 'static' | 'static+deep' = deep ? 'static+deep' : 'static';
  const vr = await deps.verify(env, {
    path,
    tools: [tool],
    deep,
    strict: opts.strict ?? false,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!vr.ok) return { blocked: vr.error, gate: 'failed', verdict: 'fail', mode, notice: null };

  const tv = vr.value.tools.find((t) => t.tool === tool);
  const verdict = tv?.verdict ?? vr.value.summary.verdict;

  if (verdict === 'fail') {
    const reason = `installation blocked: '${path}' failed verification for ${tool}: ${summarizeFindings(tv)}`;
    return {
      blocked: flipFailedError(reason),
      gate: 'failed',
      verdict: 'fail',
      mode,
      notice: null,
    };
  }
  if (verdict === 'warn') {
    if (opts.strict) {
      return {
        blocked: flipFailedError(`verify warnings blocked under --strict for ${tool}`),
        gate: 'failed',
        verdict: 'warn',
        mode,
        notice: null,
      };
    }
    return { blocked: null, gate: 'warned', verdict: 'warn', mode, notice: null };
  }
  if (verdict === 'inconclusive') {
    if (opts.strict) {
      return {
        blocked: flipFailedError(`verify gate inconclusive under --strict for ${tool}`),
        gate: 'failed',
        verdict: 'inconclusive',
        mode,
        notice: null,
      };
    }
    return {
      blocked: null,
      gate: 'inconclusive',
      verdict: 'inconclusive',
      mode,
      notice: `verify gate was inconclusive for ${tool}; proceeding unverified`,
    };
  }
  return { blocked: null, gate: 'passed', verdict: 'pass', mode, notice: null };
};

const ledgerVerifyOf = (gate: Gate['gate']): 'passed' | 'warned' | 'skipped' =>
  gate === 'passed' ? 'passed' : gate === 'warned' ? 'warned' : 'skipped';

// ---------------------------------------------------------------------------------------------
// resolve + fetch (once per source)
// ---------------------------------------------------------------------------------------------

interface Resolved {
  sha: string;
  skillName: string;
  skillPath: string; // repo-relative git tree path ('' for a root skill)
  materializedDir: string; // fetched skill dir OR store entry (verify + snapshot source)
  fetchDir: string | null; // for cleanup (null when elided)
}

type ResolveOutcome =
  | { kind: 'resolved'; r: Resolved }
  | { kind: 'result'; result: InstallResult; fetchDir: string | null };

// Elision (F-fetch): a full-SHA-resolvable ref whose skill path is known without a tree scan and
// whose store entry already exists — skip the clone entirely (restricted to //path or a
// ledger-recorded origin so R2's never-guess is not bypassed).
const tryElide = async (
  env: ScanEnv,
  spec: SourceSpec,
  storeRoot: string,
  ledger: LedgerFile,
  scopeKey: string | null,
  signal: AbortSignal | undefined,
): Promise<Resolved | null> => {
  const probe = await resolveRefViaLsRemote(env, spec.cloneUrl, spec.ref, signal);
  if (!probe.ok || !probe.value) return null;
  const sha = probe.value;

  let name: string | null = null;
  let path: string | null = null;
  if (spec.selector.kind === 'path') {
    path = spec.selector.path;
    name = basename(spec.selector.path);
  } else {
    // a ledger origin matching (repo, refResolved=SHA) that pins skillPath + skill name
    const tree = scopeKey === null ? ledger.skills : (ledger.projects?.[scopeKey]?.skills ?? {});
    const matches: { name: string; path: string }[] = [];
    for (const skill of Object.keys(tree)) {
      const tools = tree[skill]?.tools ?? {};
      for (const tool of Object.keys(tools) as FlipTool[]) {
        const origin = tools[tool]?.origin;
        if (origin && origin.repo === spec.repoPath && origin.refResolved === sha) {
          if (spec.selector.kind === 'name' && skill !== spec.selector.name) continue;
          matches.push({ name: skill, path: origin.skillPath });
        }
      }
    }
    const unique = matches.filter(
      (m, i) => matches.findIndex((x) => x.name === m.name && x.path === m.path) === i,
    );
    if (unique.length === 1 && unique[0]) {
      name = unique[0].name;
      path = unique[0].path;
    }
  }
  if (name === null || path === null) return null;

  const { ns, name: nsName } = clampStoreNs(spec.repoPath);
  const storeEntry = join(storeRoot, ns, `${nsName}@${sha.slice(0, 12)}`, name);
  if ((await env.pathKind(storeEntry)) === 'absent') return null;

  return { sha, skillName: name, skillPath: path, materializedDir: storeEntry, fetchDir: null };
};

const resolveSource = async (
  env: ScanEnv,
  deps: InstallDeps,
  spec: SourceSpec,
  scope: InstallScope,
  scopeKey: string | null,
  storeRoot: string,
  dataDir: string,
  ledger: LedgerFile,
  opts: InstallOptions,
): Promise<ResolveOutcome> => {
  const elided = await tryElide(env, spec, storeRoot, ledger, scopeKey, opts.signal);
  if (elided) return { kind: 'resolved', r: elided };

  const fetchDir = join(dataDir, '.fetch', deps.newTxId());
  const fr = await fetchRepo(env, {
    cloneUrl: spec.cloneUrl,
    ref: spec.ref,
    fetchDir,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!fr.ok) {
    const result = {
      ...emptyResult(spec.raw, scope, 'failed'),
      reason: msg(fr.error),
      error: fr.error,
    };
    return { kind: 'result', result, fetchDir };
  }
  const sha = fr.value.sha;

  const lst = await lsTreeSkills(env, fetchDir, opts.signal);
  if (!lst.ok) {
    const result = {
      ...emptyResult(spec.raw, scope, 'failed'),
      reason: msg(lst.error),
      error: lst.error,
    };
    return { kind: 'result', result, fetchDir };
  }
  const candidates: CandidateSkill[] = lst.value.candidates.map((c) => ({
    path: c.path,
    name: c.path === '' ? lastSegment(spec.repoPath) : c.name,
  }));
  const matches = matchCandidates(candidates, spec.selector);
  const selection = await selectSkill(matches, lst.value.scanned, deps.pick);

  if (selection.kind === 'none') {
    const e = {
      code: 'source-unresolvable' as const,
      message: `'${selectorLabel(spec)}' matched no skills in ${spec.repoPath} @ ${sha.slice(0, 12)}: searched ${selection.searched} SKILL.md directories`,
    };
    return {
      kind: 'result',
      result: { ...emptyResult(spec.raw, scope, 'failed'), reason: e.message, error: e },
      fetchDir,
    };
  }
  if (selection.kind === 'ambiguous') {
    const cands = selection.candidates.map((m) => `${spec.repoPath}//${m.path}`);
    const reason = `'${selectorLabel(spec)}' matches ${selection.candidates.length} skills — re-run with one of the exact paths above`;
    return {
      kind: 'result',
      result: {
        ...emptyResult(spec.raw, scope, 'refused'),
        reason,
        candidates: cands,
        error: flipRefusedError(reason),
      },
      fetchDir,
    };
  }

  const skillPath = selection.skill.path;
  const skillName = skillPath === '' ? lastSegment(spec.repoPath) : selection.skill.name;
  const co = await sparseCheckoutSkill(env, fetchDir, skillPath, opts.signal);
  if (!co.ok) {
    const result = {
      ...emptyResult(spec.raw, scope, 'failed'),
      reason: msg(co.error),
      error: co.error,
    };
    return { kind: 'result', result, fetchDir };
  }

  return {
    kind: 'resolved',
    r: { sha, skillName, skillPath, materializedDir: co.value, fetchDir },
  };
};

// ---------------------------------------------------------------------------------------------
// pinned / origin builders
// ---------------------------------------------------------------------------------------------

const buildPinned = (
  snap: SnapshotResult,
  sha: string,
  build: 'symlink' | 'copy',
  gate: Gate,
  now: string,
): PinnedRecord => ({
  storePath: snap.storePath,
  rev: sha.slice(0, 12),
  gitSha: sha,
  dirty: false,
  contentHash: snap.contentHash,
  snapshotAt: now,
  verify: ledgerVerifyOf(gate.gate),
  placement: build,
});

const buildOrigin = (
  spec: SourceSpec,
  sha: string,
  skillPath: string,
  opts: InstallOptions,
  now: string,
): OriginRecord => ({
  source: spec.raw,
  host: spec.host,
  repo: spec.repoPath,
  skillPath,
  refRequested: spec.ref,
  refResolved: sha,
  pin: opts.pin ?? false,
  installedAt: now,
});

// ---------------------------------------------------------------------------------------------
// placement (per tool, scope)
// ---------------------------------------------------------------------------------------------

interface PlaceCtx {
  env: ScanEnv;
  deps: InstallDeps;
  opts: InstallOptions;
  ledger: LedgerFile;
  ledgerPath: string;
  storeRoot: string;
  scope: InstallScope;
  scopeKey: string | null;
  projectRoot: string | null;
}

const makeSwapCtx = (p: PlaceCtx): SwapCtx => ({
  env: p.env,
  ledgerPath: p.ledgerPath,
  ledger: p.ledger,
  persist: () => writeLedger(p.env, p.ledgerPath, p.ledger),
  now: p.deps.now,
  newTxId: p.deps.newTxId,
  pauseAt: p.opts.testPauseAt,
  signal: p.opts.signal,
});

// dir→dir routing: the swap engine rejects a same-kind copy-over-copy replace, so a copy re-install
// over a real dir is routed as two kind changes (dir→store-symlink, then store-symlink→dir). Every
// other transition (symlink→symlink re-pin, dir→symlink, symlink→dir) is a single swap the engine
// handles directly.
const replaceSwap = async (
  p: PlaceCtx,
  plan: SwapPlan,
  build: 'symlink' | 'copy',
  live: Placement,
  snap: SnapshotResult,
  sha: string,
  gate: Gate,
): Promise<Result<void, SkillSmithError>> => {
  const ctx = makeSwapCtx(p);
  const inst = plan.install;
  if (!inst) return err(genericError('install plan missing install payload'));
  if (build === 'copy' && live.class === 'pinned') {
    const symPinned = buildPinned(snap, sha, 'symlink', gate, p.deps.now());
    const intermediate: SwapPlan = {
      ...plan,
      install: { ...inst, build: 'symlink', pinned: symPinned, adoptedDev: null },
    };
    const r1 = await runSwap(ctx, intermediate);
    if (!r1.ok) return r1;
    const r2 = await runSwap(ctx, plan);
    if (!r2.ok) return r2;
    return ok(undefined);
  }
  const r = await runSwap(ctx, plan);
  if (!r.ok) return r;
  return ok(undefined);
};

const placePair = async (
  p: PlaceCtx,
  spec: SourceSpec,
  resolved: Resolved,
  tool: FlipTool,
  snap: SnapshotResult,
  gate: Gate,
  storeReused: boolean,
): Promise<InstallResult> => {
  const { env, opts } = p;
  const skill = resolved.skillName;
  const sha = resolved.sha;
  const build: 'symlink' | 'copy' = opts.direct ? 'copy' : 'symlink';
  const rootsCtx = {
    cwd: p.scope === 'project' ? (p.scopeKey as string) : opts.cwd,
    envVars: opts.envVars,
  };
  const installRoot = SKILL_ROOTS[tool](env, p.scope, rootsCtx)[0] as string;
  const placementPath = join(installRoot, skill);
  const resultVerify =
    gate.gate === 'skipped' ? null : { gate: gate.gate, verdict: gate.verdict, mode: gate.mode };
  const originOut = {
    host: spec.host,
    repo: spec.repoPath,
    skillPath: resolved.skillPath,
    refRequested: spec.ref,
    refResolved: sha,
    pin: opts.pin ?? false,
  };
  const storeOut = {
    path: snap.storePath,
    rev: sha.slice(0, 12),
    gitSha: sha,
    reused: storeReused,
  };

  const base: InstallResult = {
    source: spec.raw,
    skill,
    tool,
    scope: p.scope,
    placementPath,
    action: 'installed',
    reason: null,
    placement: build,
    store: storeOut,
    origin: originOut,
    verify: resultVerify,
    candidates: null,
  };
  const refuse = (reason: string): InstallResult => ({
    ...base,
    action: 'refused',
    reason,
    placement: null,
    store: null,
    origin: null,
    error: flipRefusedError(reason),
  });
  const fail = (e: SkillSmithError): InstallResult => ({
    ...base,
    action: 'failed',
    reason: msg(e),
    placement: null,
    store: null,
    origin: null,
    error: e,
  });

  try {
    await env.makeDir(installRoot);
  } catch (e) {
    return fail(genericError(`cannot create skills root ${installRoot}: ${errorMessage(e)}`));
  }

  // D15: codex legacy-root conflict (read-only detection; --force does NOT override).
  if (tool === 'codex' && p.scope === 'user') {
    const legacyRoot = SKILL_ROOTS.codex(env, 'user', rootsCtx)[1];
    if (legacyRoot) {
      const lp = await classifyPlacement(env, legacyRoot, skill, p.storeRoot);
      if (lp.class !== 'absent') {
        return refuse(
          `'${skill}' already exists in the legacy codex root ${legacyRoot}. Remove it first: skillsmith uninstall ${skill} --tool codex`,
        );
      }
    }
  }

  // F5: cross-scope shadowing (project shadows user for this repo).
  let shadowWarning: string | null = null;
  const otherScope: InstallScope = p.scope === 'project' ? 'user' : 'project';
  const otherKey = otherScope === 'project' ? p.projectRoot : null;
  if (!(otherScope === 'project' && otherKey === null)) {
    const otherCtx = {
      cwd: otherScope === 'project' ? (otherKey as string) : opts.cwd,
      envVars: opts.envVars,
    };
    const otherRoot = SKILL_ROOTS[tool](env, otherScope, otherCtx)[0] as string;
    const op = await classifyPlacement(env, otherRoot, skill, p.storeRoot);
    const hasPair = getPairAt(p.ledger, otherKey, skill, tool) !== null;
    if (op.class !== 'absent' || hasPair) {
      const reason = `project-scope skills shadow user-scope skills of the same name for this repo: ${placementPath} vs ${join(otherRoot, skill)}`;
      if (!opts.force) return refuse(reason);
      shadowWarning = `proceeding despite shadow (--force): ${reason}`;
    }
  }

  const existing = getPairAt(p.ledger, p.scopeKey, skill, tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    // Global Constraint #6: an unresolved journal refuses every operation EXCEPT a same-op re-run
    // (which RESUMES it to completion) and --rollback. A same-op install re-run drives the recorded
    // swap forward via the generic resumeSwap; a DIFFERENT interrupted op still refuses, naming that
    // journal's op for the same-op-re-run / --rollback recovery.
    if (existing.journal.op === 'install') {
      const wasFresh = existing.journal.before.mode === 'absent';
      const ctx = makeSwapCtx(p);
      const resumed = await resumeSwap(ctx, skill, tool, p.scopeKey);
      if (!resumed.ok) {
        return fail(
          resumed.error.code === 'ledger-error'
            ? flipFailedError(msg(resumed.error))
            : resumed.error,
        );
      }
      const after = getPairAt(p.ledger, p.scopeKey, skill, tool);
      return {
        ...base,
        action: wasFresh ? 'installed' : 'updated',
        reason: resumed.value.warning ?? shadowWarning ?? gate.notice,
        placement: after?.pinned?.placement ?? base.placement,
        store: after?.pinned
          ? {
              path: after.pinned.storePath,
              rev: after.pinned.rev,
              gitSha: after.pinned.gitSha ?? sha,
              reused: true,
            }
          : base.store,
      };
    }
    return refuse(refusedMessage(existing.journal.op, skill, spec.raw));
  }

  const live = await classifyPlacement(env, installRoot, skill, p.storeRoot);

  // Does the live placement already materialize THIS resolved store entry?
  let liveKind: 'symlink' | 'copy' | null = null;
  if (live.class === 'store-linked' && live.symlinkTarget === snap.storePath) {
    liveKind = 'symlink';
  } else if (live.class === 'pinned') {
    const h = await contentHashOf(env, live.path);
    if (h.ok && h.value === snap.contentHash) liveKind = 'copy';
  }

  const finalize = (action: InstallAction): InstallResult => ({
    ...base,
    action,
    reason: shadowWarning ?? gate.notice,
  });

  // Idempotence / repair (F7 / D14) — only when not forcing.
  if (liveKind !== null && !opts.force) {
    const recordMatches =
      existing?.origin?.refResolved === sha &&
      existing.pinned?.storePath === snap.storePath &&
      (existing.pinned?.placement ?? 'copy') === liveKind;
    if (recordMatches) {
      return { ...finalize('noop'), reason: `already installed at ${sha.slice(0, 12)}` };
    }
    // Placement intact + matching the resolved store entry but the record is missing/stale →
    // rewrite the pair record only (no filesystem change).
    const pinned = buildPinned(snap, sha, liveKind, gate, p.deps.now());
    const origin = buildOrigin(spec, sha, resolved.skillPath, opts, p.deps.now());
    setPairAt(p.ledger, p.scopeKey, skill, tool, {
      placementPath,
      mode: 'pinned',
      dev: existing?.dev ?? null,
      pinned,
      origin,
      journal: null,
    });
    const persisted = await writeLedger(env, p.ledgerPath, p.ledger);
    if (!persisted.ok) return fail(persisted.error);
    return { ...finalize('repaired'), placement: liveKind };
  }

  const pinned = buildPinned(snap, sha, build, gate, p.deps.now());
  const origin = buildOrigin(spec, sha, resolved.skillPath, opts, p.deps.now());
  // Adopt a genuine dev symlink (points outside the store) so nothing is lost on rollback.
  const adoptedDev =
    live.class === 'dev' && live.symlinkTarget !== null
      ? {
          sourcePath: live.symlinkTarget,
          resolvedPath: resolveSymlinkAbsolute(placementPath, live.symlinkTarget),
          repoRoot: null,
          sourceRelPath: null,
          remote: null,
          recordedAt: p.deps.now(),
        }
      : null;
  const plan: SwapPlan = {
    op: 'install',
    skill,
    tool,
    skillsRoot: installRoot,
    placementPath,
    scopeKey: p.scopeKey,
    install: {
      build,
      storePath: snap.storePath,
      contentHash: snap.contentHash,
      pinned,
      origin,
      adoptedDev,
    },
  };

  // Fresh install: the slot is empty. Clear any stale records so the engine lands on an empty slot.
  if (live.class === 'absent') {
    if (existing && (existing.pinned || existing.dev)) {
      deletePairAt(p.ledger, p.scopeKey, skill, tool);
    }
    const ctx = makeSwapCtx(p);
    const r = await runSwap(ctx, plan);
    if (!r.ok)
      return fail(r.error.code === 'ledger-error' ? flipFailedError(msg(r.error)) : r.error);
    if (r.value.warning)
      shadowWarning = shadowWarning ? `${shadowWarning}; ${r.value.warning}` : r.value.warning;
    return { ...finalize('installed'), store: { ...storeOut, reused: storeReused } };
  }

  // Replace. A managed pair for this same repo may update freely; anything else needs --force.
  const managed = existing?.origin?.repo === spec.repoPath;
  if (!managed && !opts.force) {
    const recorded = existing?.origin ? existing.origin.repo : 'unmanaged';
    return refuse(
      `'${skill}' (${tool}) already exists at ${placementPath} (recorded origin: ${recorded}); re-run with --force to overwrite`,
    );
  }

  const swapRes = await replaceSwap(p, plan, build, live, snap, sha, gate);
  if (!swapRes.ok) {
    return fail(
      swapRes.error.code === 'ledger-error' ? flipFailedError(msg(swapRes.error)) : swapRes.error,
    );
  }
  return { ...finalize('updated'), store: { ...storeOut, reused: storeReused } };
};

// ---------------------------------------------------------------------------------------------
// dry-run prediction (read-only)
// ---------------------------------------------------------------------------------------------

const predictPair = async (
  p: PlaceCtx,
  spec: SourceSpec,
  resolved: Resolved,
  tool: FlipTool,
): Promise<InstallResult> => {
  const { env, opts } = p;
  const skill = resolved.skillName;
  const sha = resolved.sha;
  const build: 'symlink' | 'copy' = opts.direct ? 'copy' : 'symlink';
  const rootsCtx = {
    cwd: p.scope === 'project' ? (p.scopeKey as string) : opts.cwd,
    envVars: opts.envVars,
  };
  const installRoot = SKILL_ROOTS[tool](env, p.scope, rootsCtx)[0] as string;
  const placementPath = join(installRoot, skill);
  const { ns, name } = clampStoreNs(spec.repoPath);
  const expectedStorePath = join(p.storeRoot, ns, `${name}@${sha.slice(0, 12)}`, skill);

  const base: InstallResult = {
    source: spec.raw,
    skill,
    tool,
    scope: p.scope,
    placementPath,
    action: 'installed',
    reason: null,
    placement: build,
    store: { path: expectedStorePath, rev: sha.slice(0, 12), gitSha: sha, reused: false },
    origin: {
      host: spec.host,
      repo: spec.repoPath,
      skillPath: resolved.skillPath,
      refRequested: spec.ref,
      refResolved: sha,
      pin: opts.pin ?? false,
    },
    verify: null,
    candidates: null,
  };
  const refuse = (reason: string): InstallResult => ({
    ...base,
    action: 'refused',
    reason,
    placement: null,
    store: null,
    origin: null,
    error: flipRefusedError(reason),
  });

  if (tool === 'codex' && p.scope === 'user') {
    const legacyRoot = SKILL_ROOTS.codex(env, 'user', rootsCtx)[1];
    if (
      legacyRoot &&
      (await classifyPlacement(env, legacyRoot, skill, p.storeRoot)).class !== 'absent'
    ) {
      return refuse(
        `'${skill}' already exists in the legacy codex root ${legacyRoot}. Remove it first: skillsmith uninstall ${skill} --tool codex`,
      );
    }
  }

  const otherScope: InstallScope = p.scope === 'project' ? 'user' : 'project';
  const otherKey = otherScope === 'project' ? p.projectRoot : null;
  if (!(otherScope === 'project' && otherKey === null)) {
    const otherCtx = {
      cwd: otherScope === 'project' ? (otherKey as string) : opts.cwd,
      envVars: opts.envVars,
    };
    const otherRoot = SKILL_ROOTS[tool](env, otherScope, otherCtx)[0] as string;
    const shadowed =
      (await classifyPlacement(env, otherRoot, skill, p.storeRoot)).class !== 'absent' ||
      getPairAt(p.ledger, otherKey, skill, tool) !== null;
    if (shadowed && !opts.force) {
      return refuse(
        `project-scope skills shadow user-scope skills of the same name for this repo: ${placementPath} vs ${join(otherRoot, skill)}`,
      );
    }
  }

  const existing = getPairAt(p.ledger, p.scopeKey, skill, tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    // A same-op install re-run would RESUME to completion (#6); a different op still refuses.
    if (existing.journal.op === 'install') {
      return {
        ...base,
        action: existing.journal.before.mode === 'absent' ? 'installed' : 'updated',
      };
    }
    return refuse(refusedMessage(existing.journal.op, skill, spec.raw));
  }

  const live = await classifyPlacement(env, installRoot, skill, p.storeRoot);
  if (live.class === 'absent') return { ...base, action: 'installed' };

  const matchesResolved =
    (live.class === 'store-linked' && live.symlinkTarget === expectedStorePath) ||
    live.class === 'pinned';
  if (matchesResolved && !opts.force) {
    if (existing?.origin?.refResolved === sha) {
      return { ...base, action: 'noop', reason: `already installed at ${sha.slice(0, 12)}` };
    }
    return { ...base, action: 'repaired', placement: null };
  }
  const managed = existing?.origin?.repo === spec.repoPath;
  if (!managed && !opts.force) {
    const recorded = existing?.origin ? existing.origin.repo : 'unmanaged';
    return refuse(
      `'${skill}' (${tool}) already exists at ${placementPath} (recorded origin: ${recorded}); re-run with --force to overwrite`,
    );
  }
  return { ...base, action: 'updated' };
};

// ---------------------------------------------------------------------------------------------
// project root + scope
// ---------------------------------------------------------------------------------------------

const gitToplevel = async (env: ScanEnv, cwd: string): Promise<string | null> => {
  const r = await execGit(env, ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    timeoutMs: PLUMBING_TIMEOUT_MS,
  });
  if (r.code !== 0) return null;
  const top = r.stdout.trim();
  if (top.length === 0) return null;
  try {
    return await env.realpath(top);
  } catch {
    return top;
  }
};

// ---------------------------------------------------------------------------------------------
// report assembly
// ---------------------------------------------------------------------------------------------

const buildReport = (
  dryRun: boolean,
  requested: InstallReport['requested'],
  results: InstallResult[],
): InstallReport => {
  const summary = {
    installed: 0,
    updated: 0,
    repaired: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
  };
  for (const r of results) summary[r.action]++;
  return { dryRun, requested, results, summary };
};

// ---------------------------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------------------------

export const runInstall = async (
  env: ScanEnv,
  opts: InstallOptions,
  deps: InstallDeps = { ...defaultInstallDeps },
): Promise<Result<InstallReport, SkillSmithError>> => {
  const dataDir = resolveDataDir(env, opts.envVars);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const explicitTools = opts.tools !== undefined && opts.tools.length > 0;

  // ---- Phase 0: pure pre-flight (no I/O) ----
  const parsed = opts.sources.map((source) => ({ source, res: parseSource(source) }));
  const fallbackScope: InstallScope = opts.scope ?? 'user';
  const requestedBase = {
    sources: [...opts.sources],
    explicitTools,
    ref: opts.ref ?? null,
    pin: opts.pin ?? false,
    direct: opts.direct ?? false,
    force: opts.force ?? false,
    verify: (opts.noVerify ? 'skipped' : 'static') as 'static' | 'skipped',
    deep: Boolean(opts.deep),
  };

  const anyParseFail = parsed.some((x) => !x.res.ok);
  if (anyParseFail) {
    // Resolution 3: whole invocation refuses before any I/O.
    const results: InstallResult[] = parsed.map(({ source, res }) => {
      if (!res.ok) {
        return {
          ...emptyResult(source, fallbackScope, 'refused'),
          reason: msg(res.error),
          error: res.error,
        };
      }
      return { ...emptyResult(source, fallbackScope, 'skipped'), reason: 'fail-fast' };
    });
    return ok(
      buildReport(
        false,
        {
          ...requestedBase,
          tools: [],
          scope: fallbackScope,
          explicitScope: opts.scope !== undefined,
        },
        results,
      ),
    );
  }

  // --ref rules.
  if (opts.ref !== undefined && opts.sources.length > 1) {
    const results = parsed.map(({ source }) => ({
      ...emptyResult(source, fallbackScope, 'refused'),
      reason: '--ref is only valid with exactly one <source>',
      error: flipRefusedError('--ref is only valid with exactly one <source>'),
    }));
    return ok(
      buildReport(
        false,
        {
          ...requestedBase,
          tools: [],
          scope: fallbackScope,
          explicitScope: opts.scope !== undefined,
        },
        results,
      ),
    );
  }

  const specs: { source: string; spec: SourceSpec; refConflict: boolean }[] = parsed.map(
    ({ source, res }) => {
      const spec = (res as { ok: true; value: SourceSpec }).value;
      if (opts.ref !== undefined && spec.ref !== null) {
        return { source, spec, refConflict: true };
      }
      const effective: SourceSpec =
        opts.ref !== undefined && spec.ref === null ? { ...spec, ref: opts.ref } : spec;
      return { source, spec: effective, refConflict: false };
    },
  );

  // ---- Phase 1: target planning (local I/O only) ----
  const projectRoot = await gitToplevel(env, opts.cwd);
  const scope: InstallScope = opts.scope ?? (projectRoot ? 'project' : 'user');
  const scopeKey = scope === 'project' ? (projectRoot ?? (await env.realpath(opts.cwd))) : null;
  const explicitScope = opts.scope !== undefined;

  const candidateTools = explicitTools ? [...(opts.tools as readonly FlipTool[])] : [...FLIP_TOOLS];
  const detectedTools: FlipTool[] = [];
  const undetectedExplicit: FlipTool[] = [];
  for (const tool of candidateTools) {
    const d = await deps.detect(env, tool, opts.signal);
    if (!d.ok) return d;
    if (d.value.length > 0) detectedTools.push(tool);
    else if (explicitTools) undetectedExplicit.push(tool);
  }

  const requested: InstallReport['requested'] = {
    ...requestedBase,
    tools: detectedTools,
    scope,
    explicitScope,
  };

  // Planning refusals: explicitly named but undetected tools → exit-4 per source.
  const planningRefusals: InstallResult[] = [];
  for (const tool of undetectedExplicit) {
    const e = toolUnavailableError(
      `${tool} is not detected; install it first: ${INSTALL_HINTS[tool]}`,
    );
    for (const { source } of specs) {
      planningRefusals.push({
        ...emptyResult(source, scope, 'refused'),
        tool,
        reason: msg(e),
        error: e,
      });
    }
  }

  if (detectedTools.length === 0) {
    if (!explicitTools) {
      const e = toolUnavailableError('no supported tool detected (claude-code, codex)');
      const results = specs.map(({ source }) => ({
        ...emptyResult(source, scope, 'refused'),
        reason: msg(e),
        error: e,
      }));
      return ok(buildReport(false, requested, results));
    }
    return ok(buildReport(false, requested, planningRefusals));
  }

  // ---- per-source processing (shared by locked + dry-run) ----
  const processAll = async (ledger: LedgerFile, dryRun: boolean): Promise<InstallResult[]> => {
    const results: InstallResult[] = [...planningRefusals];
    const placeCtx: PlaceCtx = {
      env,
      deps,
      opts,
      ledger,
      ledgerPath,
      storeRoot,
      scope,
      scopeKey,
      projectRoot,
    };
    let failFast = false;

    for (const { source, spec, refConflict } of specs) {
      if (opts.signal?.aborted) {
        results.push({ ...emptyResult(source, scope, 'skipped'), reason: 'interrupted' });
        continue;
      }
      if (failFast) {
        results.push({ ...emptyResult(source, scope, 'skipped'), reason: 'fail-fast' });
        continue;
      }
      if (refConflict) {
        const reason = `--ref conflicts with the '@ref' already in '${source}'`;
        results.push({
          ...emptyResult(source, scope, 'refused'),
          reason,
          error: flipRefusedError(reason),
        });
        if (!opts.continueOnError) failFast = true;
        continue;
      }

      const resolved = await resolveSource(
        env,
        deps,
        spec,
        scope,
        scopeKey,
        storeRoot,
        dataDir,
        ledger,
        opts,
      );
      const cleanup = async (dir: string | null): Promise<void> => {
        if (dir) await env.removeTree(dir).catch(() => {});
      };

      if (resolved.kind === 'result') {
        results.push(resolved.result);
        await cleanup(resolved.fetchDir);
        if (resolved.result.error && !opts.continueOnError) failFast = true;
        continue;
      }

      const r = resolved.r;
      const sourceResults: InstallResult[] = [];
      let snap: SnapshotResult | null = null;
      let snapErr: SkillSmithError | null = null;
      let snapConsumed = false;

      for (const tool of detectedTools) {
        if (opts.signal?.aborted) {
          sourceResults.push({
            ...emptyResult(source, scope, 'skipped'),
            skill: r.skillName,
            tool,
            reason: 'interrupted',
          });
          continue;
        }

        const gate = await runInstallVerifyGate(env, deps, tool, r.materializedDir, opts);
        if (gate.blocked) {
          const rootsCtx = {
            cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
            envVars: opts.envVars,
          };
          const installRoot = SKILL_ROOTS[tool](env, scope, rootsCtx)[0] as string;
          sourceResults.push({
            ...emptyResult(source, scope, 'failed'),
            skill: r.skillName,
            tool,
            placementPath: join(installRoot, r.skillName),
            reason: msg(gate.blocked),
            verify: { gate: gate.gate, verdict: gate.verdict, mode: gate.mode },
            error: gate.blocked,
          });
          continue;
        }

        if (dryRun) {
          sourceResults.push(await predictPair(placeCtx, spec, r, tool));
          continue;
        }

        if (snap === null && snapErr === null) {
          const { ns, name } = clampStoreNs(spec.repoPath);
          const provenance: Provenance = {
            kind: 'git-clean',
            gitSha: r.sha,
            ns,
            name,
            repoRoot: null,
            sourceRelPath: null,
            remote: spec.repoPath,
            dirtySummary: null,
          };
          const s = await snapshotToStore(env, {
            sourceDir: r.materializedDir,
            skill: r.skillName,
            storeRoot,
            provenance,
            txId: deps.newTxId(),
          });
          if (!s.ok) snapErr = s.error;
          else snap = s.value;
        }
        if (snapErr) {
          sourceResults.push({
            ...emptyResult(source, scope, 'failed'),
            skill: r.skillName,
            tool,
            reason: msg(snapErr),
            error: snapErr,
          });
          continue;
        }

        const storeReused = snapConsumed ? true : (snap as SnapshotResult).reused;
        const placed = await placePair(
          placeCtx,
          spec,
          r,
          tool,
          snap as SnapshotResult,
          gate,
          storeReused,
        );
        snapConsumed = true;
        sourceResults.push(placed);
      }

      results.push(...sourceResults);
      await cleanup(r.fetchDir);
      if (!opts.continueOnError && sourceResults.some((x) => x.error)) failFast = true;
    }

    return results;
  };

  // ---- dry-run: no lock, no writes ----
  if (opts.dryRun) {
    const ledgerRes = await readLedger(env, ledgerPath);
    if (!ledgerRes.ok) return ledgerRes;
    const results = await processAll(ledgerRes.value, true);
    return ok(buildReport(true, requested, results));
  }

  // ---- Phase 2: the locked batch (ONE lock across fetch + verify + placement) ----
  const locked = await withLedgerLock(
    env,
    ledgerPath,
    async (): Promise<Result<InstallReport, SkillSmithError>> => {
      await sweepStaging(env, storeRoot);
      await sweepFetchOrphans(env, dataDir);
      const ledgerRes = await readLedger(env, ledgerPath);
      if (!ledgerRes.ok) return ledgerRes;
      const ledger = ledgerRes.value;

      const swept = await sweepCommittedAcquireJournals(
        makeSwapCtx({
          env,
          deps,
          opts,
          ledger,
          ledgerPath,
          storeRoot,
          scope,
          scopeKey,
          projectRoot,
        }),
      );
      if (!swept.ok) {
        return err(
          swept.error.code === 'ledger-error' ? flipFailedError(msg(swept.error)) : swept.error,
        );
      }

      const results = await processAll(ledger, false);
      return ok(buildReport(false, requested, results));
    },
  );

  if (!locked.ok) return locked;
  return locked.value;
};

// ---------------------------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------------------------

export const defaultUninstallDeps: UninstallDeps = {
  now: () => new Date().toISOString(),
  newTxId: () => randomBytes(4).toString('hex'),
};

// A resolved (skill, tool, scope) candidate for removal. 'stale' = ledger pair with no live
// placement anywhere; 'duplicate' = codex current+legacy both non-absent (unresolvable without
// disambiguation, mirrors place/plan.ts's resolveCodex).
interface UMatch {
  scope: InstallScope;
  scopeKey: string | null;
  tool: FlipTool;
  kind: 'live' | 'stale' | 'duplicate';
  placement: Placement | null; // null for 'stale'
  existing: PairRecord | null;
  notice: string | null; // legacy-root notice
  duplicatePaths?: string[];
}

const matchPathOf = (m: UMatch): string | null => {
  if (m.kind === 'duplicate') return m.duplicatePaths?.[0] ?? null;
  if (m.kind === 'stale') return m.existing?.placementPath ?? null;
  return m.placement?.path ?? null;
};

const emptyUninstallResult = (
  skill: string,
  tool: FlipTool | null,
  scope: InstallScope | null,
  action: UninstallAction,
): UninstallResult => ({
  skill,
  tool,
  scope,
  placementPath: null,
  action,
  reason: null,
  before: null,
  storeRetained: null,
  backupKept: null,
});

const notInstalledResult = (skill: string): UninstallResult => ({
  ...emptyUninstallResult(skill, null, null, 'noop'),
  reason: `'${skill}' is not installed anywhere skillsmith manages`,
});

// D12: before.placement/storePath come straight off the ledger record; symlinkTarget is populated
// only for dev (the recorded dev source) or a store-linked pinned record (a plain 'copy' placement
// has no symlink to report) — per the brief, "symlinkTarget for dev/store-linked".
const uninstallBeforeFromRecord = (
  mode: 'dev' | 'pinned',
  pinned: PinnedRecord | null | undefined,
  dev: PairRecord['dev'],
): UninstallResult['before'] => ({
  mode,
  placement: pinned?.placement ?? null,
  storePath: pinned?.storePath ?? null,
  symlinkTarget:
    mode === 'dev'
      ? (dev?.sourcePath ?? null)
      : pinned && pinned.placement === 'symlink'
        ? pinned.storePath
        : null,
});

// Search-set resolution for a NAME target (U2): every (scope, tool) in the requested search set,
// each classified against every root that tool owns at that scope (codex/user owns two: current +
// legacy). "Found" = a non-absent placement OR a ledger pair (spec's convergent definition).
const collectUninstallMatches = async (
  env: ScanEnv,
  opts: UninstallOptions,
  ledger: LedgerFile,
  storeRoot: string,
  name: string,
  scopesToSearch: readonly InstallScope[],
  toolsToSearch: readonly FlipTool[],
  scopeKeyFor: (scope: InstallScope) => Promise<string | null>,
): Promise<UMatch[]> => {
  const matches: UMatch[] = [];
  for (const scope of scopesToSearch) {
    const scopeKey = await scopeKeyFor(scope);
    for (const tool of toolsToSearch) {
      const ctx = {
        cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
        envVars: opts.envVars,
      };
      const roots = SKILL_ROOTS[tool](env, scope, ctx).filter((r): r is string => r !== undefined);
      const existing = getPairAt(ledger, scopeKey, name, tool);
      const placements = await Promise.all(
        roots.map((root) => classifyPlacement(env, root, name, storeRoot)),
      );
      const nonAbsent = placements.filter((p) => p.class !== 'absent');
      if (nonAbsent.length > 1) {
        matches.push({
          scope,
          scopeKey,
          tool,
          kind: 'duplicate',
          placement: nonAbsent[0] ?? null,
          existing,
          notice: null,
          duplicatePaths: nonAbsent.map((p) => p.path),
        });
        continue;
      }
      const placement = nonAbsent[0] ?? null;
      if (placement) {
        const notice =
          tool === 'codex' && roots.length > 1 && placement.root === roots[1]
            ? LEGACY_ROOT_NOTICE
            : null;
        matches.push({ scope, scopeKey, tool, kind: 'live', placement, existing, notice });
        continue;
      }
      // BF-1(d): a custom-location placement (a `dev --source --dest` create) lives outside every
      // standard root, so the scan above finds nothing — but the ledger records exactly where it is.
      // Classify at the recorded placementPath so uninstall REMOVES the live symlink, not just the
      // record (a 'stale' match would orphan the symlink).
      if (existing?.placementPath) {
        const recordedRoot = dirname(existing.placementPath);
        if (!roots.includes(recordedRoot)) {
          const custom = await classifyPlacement(env, recordedRoot, name, storeRoot);
          if (custom.class !== 'absent') {
            matches.push({
              scope,
              scopeKey,
              tool,
              kind: 'live',
              placement: custom,
              existing,
              notice: null,
            });
            continue;
          }
        }
      }
      if (existing) {
        matches.push({
          scope,
          scopeKey,
          tool,
          kind: 'stale',
          placement: null,
          existing,
          notice: null,
        });
      }
    }
  }
  return matches;
};

interface PathTargetMatch {
  name: string;
  scope: InstallScope;
  scopeKey: string | null;
  tool: FlipTool;
  root: string;
  notice: string | null;
}

// A path target (contains '/', or absolute) resolves to exactly one (tool, scope, root) by
// dirname match — claude-code user/project, codex current user/project, codex legacy. No
// ambiguity concept applies (one path, one owning root); outside every root is a hard refusal.
const resolveUninstallPathTarget = (
  env: ScanEnv,
  opts: UninstallOptions,
  target: string,
  projectRoot: string | null,
  toolsToSearch: readonly FlipTool[],
  explicitTools: boolean,
): Result<PathTargetMatch, SkillSmithError> => {
  const resolved = resolve(opts.cwd, target);
  const parent = dirname(resolved);
  const name = basename(resolved);

  const ctxUser = { cwd: opts.cwd, envVars: opts.envVars };
  const claudeUserRoot = SKILL_ROOTS['claude-code'](env, 'user', ctxUser)[0];
  const codexUserRoots = SKILL_ROOTS.codex(env, 'user', ctxUser);
  const codexCurrent = codexUserRoots[0];
  const codexLegacy = codexUserRoots[1];

  const candidates: Omit<PathTargetMatch, 'name'>[] = [];
  if (claudeUserRoot !== undefined) {
    candidates.push({
      scope: 'user',
      scopeKey: null,
      tool: 'claude-code',
      root: claudeUserRoot,
      notice: null,
    });
  }
  if (codexCurrent !== undefined) {
    candidates.push({
      scope: 'user',
      scopeKey: null,
      tool: 'codex',
      root: codexCurrent,
      notice: null,
    });
  }
  if (codexLegacy !== undefined) {
    candidates.push({
      scope: 'user',
      scopeKey: null,
      tool: 'codex',
      root: codexLegacy,
      notice: LEGACY_ROOT_NOTICE,
    });
  }
  if (projectRoot !== null) {
    const ctxProj = { cwd: projectRoot, envVars: opts.envVars };
    const claudeProjRoot = SKILL_ROOTS['claude-code'](env, 'project', ctxProj)[0];
    const codexProjRoot = SKILL_ROOTS.codex(env, 'project', ctxProj)[0];
    if (claudeProjRoot !== undefined) {
      candidates.push({
        scope: 'project',
        scopeKey: projectRoot,
        tool: 'claude-code',
        root: claudeProjRoot,
        notice: null,
      });
    }
    if (codexProjRoot !== undefined) {
      candidates.push({
        scope: 'project',
        scopeKey: projectRoot,
        tool: 'codex',
        root: codexProjRoot,
        notice: null,
      });
    }
  }

  const match = candidates.find((c) => c.root === parent);
  if (!match) {
    const roots = candidates.map((c) => c.root).join(', ');
    return err(flipRefusedError(`'${target}' is outside every known skills root (${roots})`));
  }
  if (opts.scope !== undefined && opts.scope !== match.scope) {
    return err(
      flipRefusedError(
        `'${target}' resolves to ${match.scope} scope, which is not the requested --scope`,
      ),
    );
  }
  if (explicitTools && !toolsToSearch.includes(match.tool)) {
    return err(
      flipRefusedError(
        `'${target}' resolves to ${match.tool}, which is not in the requested --tool set`,
      ),
    );
  }
  return ok({ name, ...match });
};

// Decide + (unless dry-run) execute the removal for one resolved (skill, tool, scope) match.
// Refusals happen before any journal write; a managed removal drives the already-recorded pair
// through the engine's 'uninstall' swap directly, an unmanaged --force removal first synthesizes
// a minimal PairRecord so the SAME engine path (backup rename, hash-guarded reclaim, terminal
// pair deletion) applies uniformly — the engine never deletes a store entry either way.
const processUninstallMatch = async (
  env: ScanEnv,
  ledger: LedgerFile,
  ledgerPath: string,
  opts: UninstallOptions,
  deps: UninstallDeps,
  name: string,
  match: UMatch,
  dryRun: boolean,
): Promise<UninstallResult> => {
  const { scope, scopeKey, tool, existing, notice } = match;

  const swapCtx: SwapCtx = {
    env,
    ledgerPath,
    ledger,
    persist: () => writeLedger(env, ledgerPath, ledger),
    now: deps.now,
    newTxId: deps.newTxId,
    pauseAt: opts.testPauseAt,
    signal: opts.signal,
  };
  const midSwap = (e: SkillSmithError): SkillSmithError =>
    e.code === 'ledger-error' ? flipFailedError(msg(e)) : e;
  const failed = (e: SkillSmithError, placementPath: string | null): UninstallResult => ({
    skill: name,
    tool,
    scope,
    placementPath,
    action: 'failed',
    reason: msg(e),
    before: null,
    storeRetained: null,
    backupKept: null,
    error: e,
  });

  // Constraint #6: an uncommitted journal on the pair refuses every op except a same-op re-run
  // (which resumes it to completion) — checked first, ahead of the stale-pair shortcut and the
  // dev/unmanaged gates below, since a crash window can leave the live placement absent or in an
  // unexpected class regardless of what this match's own classification found.
  if (existing?.journal && existing.journal.phase !== 'committed') {
    const placementPath = existing.placementPath;
    const before = uninstallBeforeFromRecord(existing.mode, existing.pinned, existing.dev);
    const storeRetained = existing.pinned?.storePath ?? null;
    if (existing.journal.op === 'uninstall') {
      if (dryRun) {
        return {
          skill: name,
          tool,
          scope,
          placementPath,
          action: 'removed',
          reason: notice,
          before,
          storeRetained,
          backupKept: null,
        };
      }
      const resumed = await resumeSwap(swapCtx, name, tool, scopeKey);
      if (!resumed.ok) return failed(midSwap(resumed.error), placementPath);
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason: resumed.value.warning ?? notice,
        before,
        storeRetained,
        backupKept: resumed.value.backupKept,
      };
    }
    const reason = refusedMessage(existing.journal.op, name);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }

  if (match.kind === 'duplicate') {
    const paths = match.duplicatePaths ?? [];
    const reason = `found in both ${paths.join(' and ')}; resolve the duplicate first`;
    return {
      skill: name,
      tool,
      scope,
      placementPath: paths[0] ?? null,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }

  if (match.kind === 'stale') {
    const ex = existing as PairRecord;
    const placementPath = ex.placementPath;
    const before = uninstallBeforeFromRecord(ex.mode, ex.pinned, ex.dev);
    const storeRetained = ex.pinned?.storePath ?? null;
    const reason = 'placement was already gone';
    if (dryRun) {
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason,
        before,
        storeRetained,
        backupKept: null,
      };
    }
    deletePairAt(ledger, scopeKey, name, tool);
    const persisted = await writeLedger(env, ledgerPath, ledger);
    if (!persisted.ok) return failed(persisted.error, placementPath);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason,
      before,
      storeRetained,
      backupKept: null,
    };
  }

  // match.kind === 'live'
  const placement = match.placement as Placement;
  const placementPath = placement.path;

  if (existing) {
    // P13: a dev-mode pair with a RETAINED pin (installed/promoted then demoted) still refuses
    // without --force — the pin is precious and promote/dev --rollback can restore it. A dev-CREATED
    // pair (`dev --source`, no pinned record) has nothing to restore, so uninstall removes just the
    // symlink + ledger record (the checkout is never touched).
    // BF-2: `!= null` (not `!== null`) so a RAW dev-only record whose `pinned` key is OMITTED
    // (undefined, not explicit null) is not mistaken for a retained pin and made to demand --force.
    if (existing.mode === 'dev' && existing.pinned != null && !opts.force) {
      const reason = `'${name}' (${tool}) is in dev mode — a live symlink into a working checkout. Run 'skillsmith promote ${name}' to pin it first, or 'skillsmith dev --rollback ${name}' to restore the pinned copy, or pass --force to remove the symlink — the checkout itself is never touched.`;
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'refused',
        reason,
        before: null,
        storeRetained: null,
        backupKept: null,
        error: flipRefusedError(reason),
      };
    }
    const before = uninstallBeforeFromRecord(existing.mode, existing.pinned, existing.dev);
    const storeRetained = existing.pinned?.storePath ?? null;
    if (dryRun) {
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason: notice,
        before,
        storeRetained,
        backupKept: null,
      };
    }
    const plan: SwapPlan = {
      op: 'uninstall',
      skill: name,
      tool,
      skillsRoot: dirname(placement.path),
      placementPath: placement.path,
      scopeKey,
    };
    const swapRes = await runSwap(swapCtx, plan);
    if (!swapRes.ok) return failed(midSwap(swapRes.error), placementPath);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason: swapRes.value.warning ?? notice,
      before,
      storeRetained,
      backupKept: swapRes.value.backupKept,
    };
  }

  // unmanaged (no ledger pair)
  if (!opts.force) {
    const reason = `'${name}' (${tool}) has no skillsmith record; pass --force to remove it anyway`;
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }
  const mode: 'dev' | 'pinned' = placement.class === 'dev' ? 'dev' : 'pinned';
  const before: UninstallResult['before'] = {
    mode,
    placement: null,
    storePath: null,
    symlinkTarget: placement.symlinkTarget ?? null,
  };
  if (dryRun) {
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason: notice,
      before,
      storeRetained: null,
      backupKept: null,
    };
  }
  const synth: PairRecord = {
    placementPath: placement.path,
    mode,
    dev: null,
    pinned: null,
    journal: null,
  };
  setPairAt(ledger, scopeKey, name, tool, synth);
  const plan: SwapPlan = {
    op: 'uninstall',
    skill: name,
    tool,
    skillsRoot: dirname(placement.path),
    placementPath: placement.path,
    scopeKey,
  };
  const swapRes = await runSwap(swapCtx, plan);
  if (!swapRes.ok) return failed(midSwap(swapRes.error), placementPath);
  return {
    skill: name,
    tool,
    scope,
    placementPath,
    action: 'removed',
    reason: swapRes.value.warning ?? notice,
    before,
    storeRetained: null,
    backupKept: swapRes.value.backupKept,
  };
};

const isUninstallPathTarget = (target: string): boolean =>
  target.includes('/') || isAbsolute(target);

// Resolve one CLI target (name or path) to zero or more UninstallResults. A name target searches
// the whole (scope x tool) search set and applies U2 ambiguity; a path target pins exactly one
// (scope, tool) by dirname match and skips the ambiguity question entirely.
const processUninstallTarget = async (
  env: ScanEnv,
  ledger: LedgerFile,
  ledgerPath: string,
  storeRoot: string,
  opts: UninstallOptions,
  deps: UninstallDeps,
  target: string,
  projectRoot: string | null,
  scopesToSearch: readonly InstallScope[],
  toolsToSearch: readonly FlipTool[],
  explicitTools: boolean,
  scopeKeyFor: (scope: InstallScope) => Promise<string | null>,
  dryRun: boolean,
): Promise<UninstallResult[]> => {
  if (isUninstallPathTarget(target)) {
    const resolved = resolveUninstallPathTarget(
      env,
      opts,
      target,
      projectRoot,
      toolsToSearch,
      explicitTools,
    );
    if (!resolved.ok) {
      const name = basename(resolve(opts.cwd, target));
      return [
        {
          ...emptyUninstallResult(name, null, null, 'refused'),
          reason: msg(resolved.error),
          error: resolved.error,
        },
      ];
    }
    const { name, scope, scopeKey, tool, root, notice } = resolved.value;
    const existing = getPairAt(ledger, scopeKey, name, tool);
    const placement = await classifyPlacement(env, root, name, storeRoot);
    let match: UMatch;
    if (placement.class !== 'absent') {
      match = { scope, scopeKey, tool, kind: 'live', placement, existing, notice };
    } else if (existing) {
      match = { scope, scopeKey, tool, kind: 'stale', placement: null, existing, notice: null };
    } else {
      return [notInstalledResult(name)];
    }
    return [await processUninstallMatch(env, ledger, ledgerPath, opts, deps, name, match, dryRun)];
  }

  const matches = await collectUninstallMatches(
    env,
    opts,
    ledger,
    storeRoot,
    target,
    scopesToSearch,
    toolsToSearch,
    scopeKeyFor,
  );
  if (matches.length === 0) return [notInstalledResult(target)];

  const distinctScopes = new Set(matches.map((m) => m.scope));
  if (distinctScopes.size > 1 && opts.scope === undefined && !opts.allScopes) {
    const list = matches
      .map((m) => `${m.scope} (${m.tool} at ${matchPathOf(m) ?? '<unknown>'})`)
      .join(', ');
    const reason = `'${target}' is installed in multiple scopes: ${list}; disambiguate with --scope, --tool, or --all-scopes`;
    return [
      {
        ...emptyUninstallResult(target, null, null, 'refused'),
        reason,
        error: flipRefusedError(reason),
      },
    ];
  }

  const results: UninstallResult[] = [];
  for (const match of matches) {
    results.push(
      await processUninstallMatch(env, ledger, ledgerPath, opts, deps, target, match, dryRun),
    );
  }
  return results;
};

const buildUninstallReport = (
  dryRun: boolean,
  requested: UninstallReport['requested'],
  results: UninstallResult[],
): UninstallReport => {
  const summary = { removed: 0, noop: 0, refused: 0, failed: 0 };
  for (const r of results) summary[r.action]++;
  return { dryRun, requested, results, summary };
};

export const runUninstall = async (
  env: ScanEnv,
  opts: UninstallOptions,
  deps: UninstallDeps = { ...defaultUninstallDeps },
): Promise<Result<UninstallReport, SkillSmithError>> => {
  const dataDir = resolveDataDir(env, opts.envVars);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
  const toolsToSearch: FlipTool[] = explicitTools
    ? [...(opts.tools as FlipTool[])]
    : [...FLIP_TOOLS];

  const requested: UninstallReport['requested'] = {
    targets: [...opts.targets],
    tools: toolsToSearch,
    explicitTools,
    scope: opts.scope ?? null,
    allScopes: Boolean(opts.allScopes),
    force: Boolean(opts.force),
  };

  // U2 search set: user scope + the current project's scope (Task 7 phase-1 rule) unless --scope
  // restricts to one. --all-scopes doesn't change the search set (both are already searched) — it
  // only changes the ambiguity POLICY below (act on every match instead of refusing).
  const projectRoot = await gitToplevel(env, opts.cwd);
  const scopesToSearch: InstallScope[] =
    opts.scope !== undefined ? [opts.scope] : projectRoot !== null ? ['user', 'project'] : ['user'];
  const scopeKeyFor = async (scope: InstallScope): Promise<string | null> =>
    scope === 'project' ? (projectRoot ?? (await env.realpath(opts.cwd))) : null;

  const processAll = async (ledger: LedgerFile, dryRun: boolean): Promise<UninstallResult[]> => {
    const results: UninstallResult[] = [];
    for (const target of opts.targets) {
      results.push(
        ...(await processUninstallTarget(
          env,
          ledger,
          ledgerPath,
          storeRoot,
          opts,
          deps,
          target,
          projectRoot,
          scopesToSearch,
          toolsToSearch,
          explicitTools,
          scopeKeyFor,
          dryRun,
        )),
      );
    }
    return results;
  };

  // Uninstall needs no binary detection and no fetch/verify — dry-run only needs a ledger read.
  if (opts.dryRun) {
    const ledgerRes = await readLedger(env, ledgerPath);
    if (!ledgerRes.ok) return ledgerRes;
    const results = await processAll(ledgerRes.value, true);
    return ok(buildUninstallReport(true, requested, results));
  }

  const locked = await withLedgerLock(
    env,
    ledgerPath,
    async (): Promise<Result<UninstallReport, SkillSmithError>> => {
      await sweepStaging(env, storeRoot);
      await sweepFetchOrphans(env, dataDir);
      const ledgerRes = await readLedger(env, ledgerPath);
      if (!ledgerRes.ok) return ledgerRes;
      const ledger = ledgerRes.value;

      const swept = await sweepCommittedAcquireJournals({
        env,
        ledgerPath,
        ledger,
        persist: () => writeLedger(env, ledgerPath, ledger),
        now: deps.now,
        newTxId: deps.newTxId,
        pauseAt: opts.testPauseAt,
        signal: opts.signal,
      });
      if (!swept.ok) {
        return err(
          swept.error.code === 'ledger-error' ? flipFailedError(msg(swept.error)) : swept.error,
        );
      }

      const results = await processAll(ledger, false);
      return ok(buildUninstallReport(false, requested, results));
    },
  );

  if (!locked.ok) return locked;
  return locked.value;
};
