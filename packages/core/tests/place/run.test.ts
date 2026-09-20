import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readlink, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createToolRegistry, toolRegistry } from '../../src/agents/registry.ts';
import { fromLedgerV1Dto } from '../../src/artifacts/registry.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  emptyLedger,
  getLedgerPairAt,
  getPair,
  readLedger,
  readLedgerState,
  setPair,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import {
  prepareDev,
  prepareDevWithRegistry,
  preparePromote,
  runDev,
  runPromote,
  runRollback,
} from '../../src/place/run.ts';
import { contentHashOf } from '../../src/place/store.ts';
import type {
  DevRecord,
  FlipDeps,
  FlipOptions,
  FlipReport,
  Journal,
  OriginRecord,
  PairRecord,
  PinnedRecord,
} from '../../src/place/types.ts';
import type { OperationImage } from '../../src/planning/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import type { Result } from '../../src/result.ts';
import { ok } from '../../src/result.ts';
import type { VerifyOptions } from '../../src/verify/run.ts';
import type {
  ModeResult,
  ToolVerdict,
  VerifyOutcome,
  VerifyReport,
  VerifyTool,
} from '../../src/verify/types.ts';
import { hermeticGitEnv } from '../fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// This file's tests each build a fixture fleet (real `git init`) and often run 2-3 full flips
// (each resolving provenance via real `git` subprocess calls) — the 5s bun:test default can be
// tight when the whole suite runs under load.
setDefaultTimeout(20_000);

const NOW = '2026-07-07T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const userLiveResource = (skill: string, path: string) => ({
  kind: 'live' as const,
  skill,
  tool: 'claude-code' as const,
  scope: 'user' as const,
  projectRoot: null,
  location: { kind: 'machine-bound' as const, path },
});

const pinnedImage = (
  skill: string,
  path: string,
  contentHash: `sha256:${string}` | null,
  sourcePath: string | null = null,
): OperationImage => ({
  kind: 'placement',
  resource: userLiveResource(skill, path),
  classification: 'pinned',
  representation: 'copy',
  linkTarget: null,
  dangling: false,
  source:
    contentHash === null || sourcePath === null
      ? null
      : { kind: 'local-dev', path: sourcePath, contentHash },
  contentHash: sourcePath === null ? null : contentHash,
});

const devImage = (
  skill: string,
  path: string,
  target: string,
  contentHash: `sha256:${string}` | null = null,
): OperationImage => ({
  kind: 'placement',
  resource: userLiveResource(skill, path),
  classification: 'dev',
  representation: 'symlink',
  linkTarget: { kind: 'machine-bound', path: target },
  dangling: false,
  source: contentHash === null ? null : { kind: 'local-dev', path: target, contentHash },
  contentHash,
});

const absentImage = (skill: string, path: string): OperationImage => ({
  kind: 'absent',
  resource: userLiveResource(skill, path),
});

const expectRolledBackExecution = (
  report: FlipReport,
  actualBefore: OperationImage,
  actualAfter: OperationImage,
): void => {
  const operation = report.plan.operations[0];
  if (operation === undefined) throw new Error('rollback operation is missing');
  expect(operation.before).toEqual(actualBefore);
  expect(operation.after).toEqual(actualAfter);
  expect(report.executionResults).toEqual([
    {
      operationId: operation.operationId,
      outcome: 'rolled-back',
      actualBefore,
      actualAfter,
      force: null,
      error: null,
    },
  ]);
};

const runGit = (checkout: string, args: string[]): void => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: checkout,
    env: hermeticGitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
};

const commitChange = (checkout: string, relPath: string, content: string): void => {
  Bun.write(join(checkout, relPath), content);
};

const commitAll = (checkout: string, message: string): void => {
  runGit(checkout, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(checkout, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  ]);
};

// -------------------------------------------------------------------------------------------
// canned verify checker fixtures
// -------------------------------------------------------------------------------------------

const makeVerifyReport = (
  tool: VerifyTool,
  verdict: VerifyOutcome | 'inconclusive',
): VerifyReport => {
  const mode: ModeResult =
    verdict === 'inconclusive'
      ? {
          mode: 'static',
          status: 'error',
          skipReason: 'exec-error',
          coverage: { manifest: false, skills: false },
          verdict: null,
          command: 'fake',
          findings: [],
        }
      : {
          mode: 'static',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict,
          command: 'fake',
          findings:
            verdict === 'fail'
              ? [
                  {
                    checkId: 'fake.check',
                    toolSeverity: 'error',
                    normalizedSeverity: 'error' as const,
                    message: 'boom',
                    file: null,
                    subject: 'skill' as const,
                  },
                ]
              : [],
        };
  const toolVerdict: ToolVerdict = {
    tool,
    available: true,
    toolVersion: '1.0.0',
    versionDrift: false,
    skipReason: verdict === 'inconclusive' ? 'exec-error' : null,
    verdict,
    modes: [mode],
  };
  return {
    schemaVersion: 1,
    target: { path: '/fake', kind: 'skill' },
    requested: { tools: [tool], modes: ['static'], strict: false, explicitTools: true },
    verifiedAgainst: { 'claude-code': '1.0.0', codex: '1.0.0', muse: '1.0.0' },
    summary: {
      verdict,
      verified: verdict === 'pass' || verdict === 'warn' ? [tool] : [],
      failed: verdict === 'fail' ? [tool] : [],
      skipped: verdict === 'inconclusive' ? [tool] : [],
      counts: { error: verdict === 'fail' ? 1 : 0, warning: 0, info: 0 },
    },
    tools: [toolVerdict],
  };
};

// Each call needs a distinct txId — a constant one collides staging/backup names across
// multiple sequential flips of the same (skill, tool) pair within one test (a kept backup
// from an earlier flip would otherwise already occupy the next flip's backup path).
let txCounter = 0;
const nextTxId = (): string => (++txCounter).toString(16).padStart(8, '0');

const cannedDeps = (
  verdict: VerifyOutcome | 'inconclusive',
  calls: VerifyOptions[] = [],
): FlipDeps => ({
  now: () => NOW,
  newTxId: nextTxId,
  verify: async (_env, opts: VerifyOptions) => {
    calls.push(opts);
    const tool = opts.tools?.[0] ?? 'claude-code';
    return ok(makeVerifyReport(tool, verdict)) as Result<VerifyReport, SkillSmithError>;
  },
});

const passDeps = (calls: VerifyOptions[] = []): FlipDeps => cannedDeps('pass', calls);

const opts = (f: FixtureFleet, o: Partial<FlipOptions> = {}): FlipOptions => ({
  targets: [],
  cwd: f.home,
  configuration: f.configuration,
  ...o,
});

const readLedgerOf = async (f: FixtureFleet) => readLedger(f.env, ledgerPathOf(f.data));

const trackExecutionWrites = (f: FixtureFleet) => {
  const writes: string[] = [];
  let active = false;
  const env: typeof f.env = {
    ...f.env,
    writeTextFile: async (path, text) => {
      if (active) writes.push(`write:${path}`);
      await f.env.writeTextFile(path, text);
    },
    makeSymlink: async (target, linkPath) => {
      if (active) writes.push(`symlink:${linkPath}`);
      await f.env.makeSymlink(target, linkPath);
    },
    rename: async (from, to) => {
      if (active) writes.push(`rename:${from}->${to}`);
      await f.env.rename(from, to);
    },
    copyTree: async (from, to) => {
      if (active) writes.push(`copy:${from}->${to}`);
      await f.env.copyTree(from, to);
    },
    removeTree: async (path) => {
      if (active) writes.push(`remove:${path}`);
      await f.env.removeTree(path);
    },
  };
  return {
    env,
    writes,
    start: () => {
      active = true;
    },
  };
};

describe('runPromote / runDev — verify gate matrix', () => {
  const VERDICTS: (VerifyOutcome | 'inconclusive')[] = ['pass', 'warn', 'fail', 'inconclusive'];
  const MODES: { label: string; flags: Partial<FlipOptions> }[] = [
    { label: 'default', flags: {} },
    { label: '--strict', flags: { strict: true } },
    { label: '--no-verify', flags: { noVerify: true } },
  ];

  for (const verdict of VERDICTS) {
    for (const mode of MODES) {
      test(`verdict=${verdict} mode=${mode.label}`, async () => {
        const f = await buildFixtureFleet();
        try {
          const calls: VerifyOptions[] = [];
          const deps = mode.flags.noVerify ? passDeps(calls) : cannedDeps(verdict, calls);
          const r = await runPromote(f.env, opts(f, { targets: ['alpha'], ...mode.flags }), deps);
          if (!r.ok) throw new Error(msg(r.error));
          const result = r.value.results[0];
          if (!result) throw new Error('no result');

          if (mode.flags.noVerify) {
            expect(calls).toHaveLength(0);
            expect(result.action).toBe('flipped');
            expect(result.verify?.gate).toBe('skipped');
            return;
          }

          expect(calls).toHaveLength(1);
          if (verdict === 'fail') {
            expect(result.action).toBe('failed');
            expect(result.error).toBeDefined();
          } else if (verdict === 'warn') {
            if (mode.flags.strict) {
              expect(result.action).toBe('failed');
            } else {
              expect(result.action).toBe('flipped');
              expect(result.verify?.gate).toBe('warned');
            }
          } else if (verdict === 'inconclusive') {
            if (mode.flags.strict) {
              expect(result.action).toBe('failed');
            } else {
              expect(result.action).toBe('flipped');
              expect(result.verify?.gate).toBe('inconclusive');
            }
          } else {
            expect(result.action).toBe('flipped');
            expect(result.verify?.gate).toBe('passed');
          }
        } finally {
          await destroyFixtureFleet(f);
        }
      });
    }
  }

  test('codex gate is called with deep:true; claude-code gate is called without deep', async () => {
    const f = await buildFixtureFleet();
    try {
      const calls: VerifyOptions[] = [];
      const r = await runPromote(f.env, opts(f, { targets: ['alpha', 'beta'] }), passDeps(calls));
      if (!r.ok) throw new Error(msg(r.error));
      const claudeCall = calls.find((c) => c.tools?.[0] === 'claude-code');
      const codexCall = calls.find((c) => c.tools?.[0] === 'codex');
      expect(claudeCall?.deep).toBeFalsy();
      expect(codexCall?.deep).toBe(true);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('default verification dispatch uses the injected lifecycle registry adapter', async () => {
    const f = await buildFixtureFleet();
    try {
      const verifierCalls: string[] = [];
      const registry = createToolRegistry(
        toolRegistry.adapters.map((adapter) =>
          adapter.descriptor.id === 'claude-code' && adapter.verification
            ? {
                ...adapter,
                verification: {
                  ...adapter.verification,
                  verify: async (_env, verifyOpts) => {
                    verifierCalls.push(verifyOpts.path);
                    const verdict = makeVerifyReport('claude-code', 'pass').tools[0];
                    if (verdict === undefined) throw new Error('fixture verdict is missing');
                    return ok(verdict);
                  },
                },
              }
            : adapter,
        ),
      );
      const prepared = await prepareDevWithRegistry(
        registry,
        f.env,
        opts(f, {
          targets: ['beta'],
          tools: ['claude-code'],
          source: resolve(f.betaSrc),
        }),
      );
      if (!prepared.ok) throw new Error(msg(prepared.error));

      const executed = await prepared.value.execute();

      if (!executed.ok) throw new Error(msg(executed.error));
      expect(executed.value.results[0]).toMatchObject({
        action: 'created',
        verify: { gate: 'passed', verdict: 'pass' },
      });
      expect(verifierCalls).toHaveLength(1);
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});

describe('runPromote — happy paths and convergence', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('promote alpha: flipped, ledger mode pinned, dev retained, verify passed', async () => {
    const r = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.verify?.gate).toBe('passed');

    const ledgerRes = await readLedgerOf(f);
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    const pair = getPair(ledgerRes.value, 'alpha', 'claude-code');
    if (!pair) throw new Error('promoted pair is missing');
    expect(pair?.mode).toBe('pinned');
    expect(pair?.dev).not.toBeNull();
    expect(pair?.pinned?.verify).toBe('passed');
    const journal = pair.journal;
    if (!journal) throw new Error('promoted pair compatibility journal is missing');
    expect(journal).toMatchObject({ op: 'promote', phase: 'committed' });
    expect(journal.stagingPath).toBe(
      join(dirname(pair.placementPath), `.skillsmith-staging-alpha-${journal.txId}`),
    );
    expect(journal.backupPath).toBe(
      join(dirname(pair.placementPath), `.skillsmith-backup-alpha-${journal.txId}`),
    );
    const canonical = await readLedgerState(f.env, ledgerPathOf(f.data));
    if (!canonical.ok || canonical.value.state !== 'present') {
      throw new Error('canonical promoted ledger is missing');
    }
    expect(
      getLedgerPairAt(canonical.value.model, null, 'alpha', 'claude-code')?.journal ?? null,
    ).toBeNull();
    const operation = r.value.plan.operations[0];
    const logicalJournal = canonical.value.model.history.at(-1);
    if (operation?.source?.kind !== 'local-dev' || logicalJournal === undefined) {
      throw new Error('prepared promotion journal identity is missing');
    }
    const journalSource = logicalJournal.intent.source;
    if (journalSource?.kind !== 'portable') {
      throw new Error('prepared promotion journal source is not codec-portable');
    }
    expect(journalSource.identity).toEqual({
      host: 'local.skillsmith.invalid',
      repository: 'content/placement',
      path: 'alpha',
    });
    expect(journalSource.requestedRef).toBeNull();
    expect(journalSource.resolvedSha).toBe(
      operation.source.contentHash.slice('sha256:'.length).slice(0, 40),
    );
    expect(journalSource.sourcePath).toBe('alpha');
    expect(String(journalSource.contentHash)).toBe(operation.source.contentHash);
  });

  test('ledger persistence cancellation remains a cancelled placement result', async () => {
    const controller = new AbortController();
    const executionEnv = {
      ...f.env,
      afterLedgerBarrier: async (barrier: Readonly<{ kind: string }>) => {
        if (barrier.kind === 'writer-stage-write') controller.abort();
      },
    } as RuntimePorts;

    const result = await runPromote(
      executionEnv,
      opts(f, { targets: ['alpha'], signal: controller.signal }),
      passDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.results[0]).toMatchObject({
      action: 'failed',
      reason: 'interrupted',
      error: { code: 'cancelled' },
    });
    expect(result.value.executionResults[0]).toMatchObject({
      outcome: 'cancelled',
      actualAfter: result.value.plan.operations[0]?.before,
      error: null,
    });
  });

  test('preparation binds one fresh project context including an explicit config path', async () => {
    const projectSkills = join(f.project, '.claude', 'skills');
    await f.env.makeDir(projectSkills);
    await f.env.makeSymlink(resolve(f.alphaSrc), join(projectSkills, 'alpha'));
    const explicitConfigPath = join(f.project, 'placement-config.toml');

    const prepared = await preparePromote(
      f.env,
      opts(f, {
        cwd: f.project,
        scope: 'project',
        projectRoot: join(f.base, 'stale-project-root'),
        targets: ['alpha'],
        tools: ['claude-code'],
        dryRun: true,
        configuration: { ...f.configuration, explicitConfigPath },
      }),
      passDeps(),
    );
    if (!prepared.ok) throw new Error(msg(prepared.error));
    const operation = prepared.value.plan.operations[0];
    if (operation?.before.kind !== 'placement') {
      throw new Error('project placement operation is missing');
    }

    expect(operation.scope).toBe('project');
    expect(operation.before.resource.projectRoot).toEqual({
      kind: 'machine-bound',
      path: f.projectReal,
    });
    expect(operation.before.resource.location).toEqual({
      kind: 'machine-bound',
      path: join(f.projectReal, '.claude', 'skills', 'alpha'),
    });
  });

  test('preparation refuses when the project context changes during snapshot observation', async () => {
    const projectSkills = join(f.project, '.claude', 'skills');
    await f.env.makeDir(projectSkills);
    await f.env.makeSymlink(resolve(f.alphaSrc), join(projectSkills, 'alpha'));
    const explicitConfigPath = join(f.project, 'placement-config.toml');
    let projectContextReads = 0;
    const driftingEnv: RuntimePorts = {
      ...f.env,
      git: {
        ...f.env.git,
        findRepositoryRoot: async (options) => {
          if (resolve(options.cwd) === resolve(f.project)) {
            projectContextReads++;
            return projectContextReads === 1 ? f.project : f.checkout;
          }
          return f.env.git.findRepositoryRoot(options);
        },
      },
    };

    const prepared = await preparePromote(
      driftingEnv,
      opts(f, {
        cwd: f.project,
        scope: 'project',
        projectRoot: join(f.base, 'stale-project-root'),
        targets: ['alpha'],
        tools: ['claude-code'],
        dryRun: true,
        configuration: { ...f.configuration, explicitConfigPath },
      }),
      passDeps(),
    );

    expect(projectContextReads).toBe(3);
    expect(prepared.ok).toBeFalse();
    if (prepared.ok) throw new Error('expected changed project context refusal');
    expect(prepared.error).toEqual({
      code: 'flip-refused',
      message: 'project context changed while preparing the operation; retry',
    });
  });

  test('re-pin after source moves: action updated, new rev', async () => {
    const first = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!first.ok) throw new Error(msg(first.error));
    const firstRev = first.value.results[0]?.store?.rev;

    commitChange(
      f.checkout,
      'plugins/fh/skills/alpha/SKILL.md',
      '---\nname: alpha\ndescription: v2.\n---\n',
    );
    commitAll(f.checkout, 'fixture: alpha v2');

    const second = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!second.ok) throw new Error(msg(second.error));
    const result = second.value.results[0];
    expect(result?.action).toBe('updated');
    expect(result?.store?.rev).not.toBe(firstRev);
  });

  test('noop when unchanged', async () => {
    const first = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!first.ok) throw new Error(msg(first.error));
    const second = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!second.ok) throw new Error(msg(second.error));
    expect(second.value.results[0]?.action).toBe('noop');
  });

  test('dirty tree refused without --allow-dirty; --allow-dirty snapshots dirty-<hash12>', async () => {
    await f.makeCheckoutDirty();
    const refused = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!refused.ok) throw new Error(msg(refused.error));
    expect(refused.value.results[0]?.action).toBe('refused');

    const allowed = await runPromote(
      f.env,
      opts(f, { targets: ['alpha'], allowDirty: true }),
      passDeps(),
    );
    if (!allowed.ok) throw new Error(msg(allowed.error));
    const result = allowed.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.store?.rev).toMatch(/^dirty-[0-9a-f]{12}$/);
    expect(result?.store?.gitSha).not.toBeNull();
    expect(result?.store?.dirty).toBe(true);
  });

  test('non-git gamma promote: local/gamma@content-<hash12>', async () => {
    const r = await runPromote(
      f.env,
      opts(f, { targets: ['gamma'], tools: ['codex'] }),
      passDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.store?.rev).toMatch(/^content-[0-9a-f]{12}$/);
    expect(result?.store?.path).toContain(join('local', `gamma@${result?.store?.rev}`));
  });

  test('G3B-02: a changed dev target after preview refuses with zero execution writes', async () => {
    const tracked = trackExecutionWrites(f);
    const prepared = await preparePromote(tracked.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!prepared.ok) throw new Error(msg(prepared.error));
    const preparedPlan = prepared.value.plan;
    const preparedResultOrder = prepared.value.preview.results.map((result) => [
      result.skill,
      result.tool,
      result.placementPath,
    ]);
    const livePath = join(f.home, '.claude', 'skills', 'alpha');
    await f.env.removeTree(livePath);
    await f.env.makeSymlink(resolve(f.betaSrc), livePath);
    tracked.start();

    const executed = await prepared.value.execute();
    if (!executed.ok) throw new Error(msg(executed.error));
    expect(executed.value.plan).toBe(preparedPlan);
    expect(
      executed.value.results.map((result) => [result.skill, result.tool, result.placementPath]),
    ).toEqual(preparedResultOrder);
    expect(
      executed.value.results.map(({ action, reason, error }) => ({
        action,
        reason,
        error: error?.code ?? null,
      })),
    ).toEqual([
      {
        action: 'refused',
        reason: 'prepared placement state changed before execution',
        error: 'flip-refused',
      },
    ]);
    expect(executed.value.executionResults).toEqual(
      preparedPlan.operations.map((operation) => ({
        operationId: operation.operationId,
        outcome: 'failed',
        actualBefore: operation.before,
        actualAfter: operation.before,
        force: null,
        error: {
          code: 'flip-refused',
          message: 'prepared placement state changed before execution',
          remediation: 'Re-run the command to prepare and approve the current state.',
        },
      })),
    );
    expect(tracked.writes).toEqual([]);
    expect(await f.env.pathKind(livePath)).toBe('symlink');
    expect(await f.env.readLink(livePath)).toBe(resolve(f.betaSrc));
    const ledger = await readLedgerOf(f);
    if (!ledger.ok) throw new Error(msg(ledger.error));
    expect(getPair(ledger.value, 'alpha', 'claude-code')).toBeNull();
  });

  test('G3B-02: source drift after preview is refused before verify or execution writes', async () => {
    const tracked = trackExecutionWrites(f);
    const verifyCalls: VerifyOptions[] = [];
    const prepared = await preparePromote(
      tracked.env,
      opts(f, { targets: ['alpha'] }),
      passDeps(verifyCalls),
    );
    if (!prepared.ok) throw new Error(msg(prepared.error));
    const preparedPlan = prepared.value.plan;
    const preparedResultOrder = prepared.value.preview.results.map((result) => [
      result.skill,
      result.tool,
      result.placementPath,
    ]);
    const operation = prepared.value.plan.operations[0];
    expect(operation?.preconditionIds.length).toBeGreaterThan(1);
    expect(
      operation?.preconditionIds.every((id) => /^precondition:v1:[0-9a-f]{64}$/u.test(id)),
    ).toBeTrue();

    await f.env.writeTextFile(
      join(f.alphaSrc, 'SKILL.md'),
      '---\nname: alpha\ndescription: changed after preview.\n---\n',
    );
    tracked.start();
    const executed = await prepared.value.execute();

    if (!executed.ok) throw new Error(msg(executed.error));
    expect(executed.value.plan).toBe(preparedPlan);
    expect(
      executed.value.results.map((result) => [result.skill, result.tool, result.placementPath]),
    ).toEqual(preparedResultOrder);
    expect(executed.value.results[0]).toMatchObject({
      action: 'refused',
      reason: 'prepared placement state changed before execution',
      error: { code: 'flip-refused' },
    });
    expect(executed.value.executionResults.map(({ operationId }) => operationId)).toEqual(
      preparedPlan.operations.map(({ operationId }) => operationId),
    );
    expect(executed.value.executionResults.map(({ outcome }) => outcome)).toEqual(['failed']);
    expect(executed.value.executionResults.map(({ actualBefore }) => actualBefore)).toEqual(
      preparedPlan.operations.map(({ before }) => before),
    );
    expect(executed.value.executionResults.map(({ actualAfter }) => actualAfter)).toEqual(
      preparedPlan.operations.map(({ before }) => before),
    );
    expect(verifyCalls).toEqual([]);
    expect(tracked.writes).toEqual([]);
  });
});

describe('runDev — happy paths, --source adoption, missing source', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('dev happy path: literal symlink restored, pinned retained', async () => {
    const up = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!up.ok) throw new Error(msg(up.error));

    const down = await runDev(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!down.ok) throw new Error(msg(down.error));
    const result = down.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.after).toEqual({ mode: 'dev', symlinkTarget: resolve(f.alphaSrc) });

    const ledgerRes = await readLedgerOf(f);
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    const pair = getPair(ledgerRes.value, 'alpha', 'claude-code');
    expect(pair?.mode).toBe('dev');
    expect(pair?.pinned).not.toBeNull();
  });

  test('fresh and adopted dev records commit exact logical history', async () => {
    const betaLive = join(f.home, '.claude', 'skills', 'beta');
    const created = await runDev(
      f.env,
      opts(f, { targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passDeps(),
    );
    if (!created.ok) throw new Error(msg(created.error));
    expect(created.value.results[0]?.action).toBe('created');

    const afterCreate = await readLedgerState(f.env, ledgerPathOf(f.data));
    if (!afterCreate.ok || afterCreate.value.state !== 'present') {
      throw new Error('created dev placement did not persist a ledger');
    }
    expect(afterCreate.value.model.history).toHaveLength(1);
    expect(afterCreate.value.model.history[0]).toMatchObject({
      intent: { kind: 'link-dev', skill: 'beta', tool: 'claude-code' },
      phase: 'committed',
    });
    expect(Object.keys(afterCreate.value.model.transactions)).toEqual([]);

    await rm(betaLive, { force: true });
    const withoutPair = { ...afterCreate.value.model, skills: {} };
    const reset = await writeLedger(f.env, ledgerPathOf(f.data), withoutPair);
    if (!reset.ok) throw new Error(msg(reset.error));
    await symlink(resolve(f.betaSrc), betaLive);
    const beforeTarget = await readlink(betaLive);

    const adopted = await runDev(
      f.env,
      opts(f, { targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passDeps(),
    );
    if (!adopted.ok) throw new Error(msg(adopted.error));
    expect(adopted.value.results[0]?.action).toBe('adopted');
    expect(await readlink(betaLive)).toBe(beforeTarget);

    const afterAdopt = await readLedgerState(f.env, ledgerPathOf(f.data));
    if (!afterAdopt.ok || afterAdopt.value.state !== 'present') {
      throw new Error('adopted dev placement did not persist a ledger');
    }
    expect(afterAdopt.value.model.history).toHaveLength(2);
    expect(afterAdopt.value.model.history.at(-1)).toMatchObject({
      intent: { kind: 'link-dev', skill: 'beta', tool: 'claude-code' },
      phase: 'committed',
    });
    expect(Object.keys(afterAdopt.value.model.transactions)).toEqual([]);
  });

  test('a failed mandatory post-operation ledger reread aborts the remaining tools in its group', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    const firstLive = join(f.home, '.claude', 'skills', 'boundary-fail');
    const secondLive = join(f.home, '.agents', 'skills', 'boundary-fail');
    const thirdLive = join(f.env.xdg.config, 'muse', 'skills', 'boundary-fail');
    const verifyCalls: VerifyOptions[] = [];
    let crossedDurableBoundary = 0;
    let failedMandatoryReads = 0;
    let failLedgerReads = false;
    const executionEnv: RuntimePorts & {
      readonly afterLedgerBarrier: (barrier: Readonly<{ readonly kind: string }>) => Promise<void>;
    } = {
      ...f.env,
      readBytes: async (path) => {
        if (path === ledgerPath && failLedgerReads) {
          failedMandatoryReads += 1;
          const error = new Error('injected mandatory post-operation ledger reread failure');
          Object.assign(error, { code: 'EIO' });
          throw error;
        }
        return f.env.readBytes(path);
      },
      afterLedgerBarrier: async (barrier) => {
        if (barrier.kind !== 'writer-live-parent-fsync' || crossedDurableBoundary > 0) return;
        crossedDurableBoundary += 1;
        failLedgerReads = true;
        const error = new Error('injected failure after durable ledger publication');
        Object.assign(error, { code: 'EIO' });
        throw error;
      },
    };
    const prepared = await prepareDev(
      executionEnv,
      opts(f, { targets: ['boundary-fail'], source: resolve(f.betaSrc) }),
      passDeps(verifyCalls),
    );
    if (!prepared.ok) throw new Error(msg(prepared.error));
    expect(prepared.value.plan.operations).toHaveLength(3);
    expect(new Set(prepared.value.plan.operations.map(({ groupId }) => groupId)).size).toBe(1);

    const executed = await prepared.value.execute();

    expect(executed.ok).toBeFalse();
    if (executed.ok) throw new Error('mandatory ledger reread failure was ignored');
    expect(executed.error.code).toBe('ledger-error');
    expect(crossedDurableBoundary).toBe(1);
    expect(failedMandatoryReads).toBe(1);
    expect(verifyCalls.map(({ tools }) => tools?.[0])).toEqual(['claude-code']);
    expect(await f.env.pathKind(firstLive)).toBe('symlink');
    expect(await f.env.pathKind(secondLive)).toBe('absent');
    expect(await f.env.pathKind(thirdLive)).toBe('absent');

    const canonical = await readLedgerState(f.env, ledgerPath);
    if (!canonical.ok || canonical.value.state !== 'present') {
      throw new Error('durably published first-tool ledger is missing');
    }
    expect(
      getLedgerPairAt(canonical.value.model, null, 'boundary-fail', 'claude-code'),
    ).not.toBeNull();
    expect(getLedgerPairAt(canonical.value.model, null, 'boundary-fail', 'codex')).toBeNull();
    expect(getLedgerPairAt(canonical.value.model, null, 'boundary-fail', 'muse')).toBeNull();
  });

  test('G3B-02: selected store drift after preview is refused with zero execution writes', async () => {
    const promoted = await runPromote(
      f.env,
      opts(f, { targets: ['alpha'], noVerify: true }),
      passDeps(),
    );
    if (!promoted.ok) throw new Error(msg(promoted.error));
    const ledger = await readLedgerOf(f);
    if (!ledger.ok) throw new Error(msg(ledger.error));
    const storePath = getPair(ledger.value, 'alpha', 'claude-code')?.pinned?.storePath;
    if (!storePath) throw new Error('promoted store path is missing');

    const tracked = trackExecutionWrites(f);
    const prepared = await prepareDev(
      tracked.env,
      opts(f, { targets: ['alpha'], noVerify: true }),
      passDeps(),
    );
    if (!prepared.ok) throw new Error(msg(prepared.error));
    const preparedPlan = prepared.value.plan;
    const preparedResultOrder = prepared.value.preview.results.map((result) => [
      result.skill,
      result.tool,
      result.placementPath,
    ]);
    await f.env.writeTextFile(
      join(storePath, 'SKILL.md'),
      '---\nname: alpha\ndescription: changed store after preview.\n---\n',
    );
    tracked.start();
    const executed = await prepared.value.execute();

    if (!executed.ok) throw new Error(msg(executed.error));
    expect(executed.value.plan).toBe(preparedPlan);
    expect(
      executed.value.results.map((result) => [result.skill, result.tool, result.placementPath]),
    ).toEqual(preparedResultOrder);
    expect(executed.value.results[0]).toMatchObject({
      action: 'refused',
      reason: 'prepared placement state changed before execution',
      error: { code: 'flip-refused' },
    });
    expect(executed.value.executionResults.map(({ operationId }) => operationId)).toEqual(
      preparedPlan.operations.map(({ operationId }) => operationId),
    );
    expect(executed.value.executionResults.map(({ outcome }) => outcome)).toEqual(['failed']);
    expect(executed.value.executionResults.map(({ actualBefore }) => actualBefore)).toEqual(
      preparedPlan.operations.map(({ before }) => before),
    );
    expect(executed.value.executionResults.map(({ actualAfter }) => actualAfter)).toEqual(
      preparedPlan.operations.map(({ before }) => before),
    );
    expect(tracked.writes).toEqual([]);
    expect(await f.env.pathKind(join(f.home, '.claude', 'skills', 'alpha'))).toBe('dir');
  });

  test('dev --source adopts the hand-copied "copied" dir', async () => {
    const r = await runDev(
      f.env,
      opts(f, { targets: ['copied'], source: resolve(f.alphaSrc) }),
      passDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('flipped');
    expect(result?.after).toEqual({ mode: 'dev', symlinkTarget: resolve(f.alphaSrc) });
  });

  // P13 S5b (approved behavior change from P12): a --source that disagrees with the RECORDED dev
  // source now REFUSES rather than silently repointing the record (was: --source wins & updates).
  test('--source disagreeing with the recorded source is refused (P13 S5b)', async () => {
    const adopted = await runDev(
      f.env,
      opts(f, { targets: ['copied'], source: resolve(f.alphaSrc) }),
      passDeps(),
    );
    if (!adopted.ok) throw new Error(msg(adopted.error));
    const pinned = await runPromote(f.env, opts(f, { targets: ['copied'] }), passDeps());
    if (!pinned.ok) throw new Error(msg(pinned.error));

    const redirected = await runDev(
      f.env,
      opts(f, { targets: ['copied'], source: resolve(f.betaSrc) }),
      passDeps(),
    );
    if (!redirected.ok) throw new Error(msg(redirected.error));
    const result = redirected.value.results[0];
    expect(result?.action).toBe('refused');
    expect(result?.error?.code).toBe('flip-refused');
  });

  test('missing recorded dev source -> source-unresolvable error on the pair', async () => {
    const pinned = await runPromote(
      f.env,
      opts(f, { targets: ['gamma'], tools: ['codex'] }),
      passDeps(),
    );
    if (!pinned.ok) throw new Error(msg(pinned.error));
    await rm(f.gammaSrc, { recursive: true, force: true });

    const r = await runDev(f.env, opts(f, { targets: ['gamma'], tools: ['codex'] }), passDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(result?.action).toBe('refused');
    expect(result?.error?.code).toBe('source-unresolvable');
  });
});

describe('runRollback', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('rollback of a committed promote restores the dev symlink', async () => {
    const up = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!up.ok) throw new Error(msg(up.error));
    const live = join(f.home, '.claude', 'skills', 'alpha');
    const promotedLedger = await readLedgerOf(f);
    if (!promotedLedger.ok) throw new Error(msg(promotedLedger.error));
    const promotedPair = getPair(promotedLedger.value, 'alpha', 'claude-code');
    if (!promotedPair?.pinned) throw new Error('promoted pair is missing its pinned record');

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: ['alpha'] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expectRolledBackExecution(
      rb.value,
      pinnedImage(
        'alpha',
        live,
        promotedPair.pinned.contentHash as `sha256:${string}`,
        resolve(f.alphaSrc),
      ),
      devImage(
        'alpha',
        live,
        resolve(f.alphaSrc),
        promotedPair.pinned.contentHash as `sha256:${string}`,
      ),
    );
    expect(await f.env.pathKind(live)).toBe('symlink');
  });

  test('rollback with nothing to roll back -> refused', async () => {
    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: ['beta'] }), op: 'dev' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('refused');
    expect(result?.reason).toContain('nothing to roll back');
  });

  // P15 / issue #11: end-to-end, `promote --rollback --all` and `dev --rollback --all` must roll
  // back the identical set (spec D10). Mixed-state fleet: (a) alpha@claude-code demoted back to dev
  // with its pin retained (last committed op = dev), (b) beta@codex promoted (last committed op =
  // promote), (c) gamma@codex a fresh dev-only symlink with no ledger record. Only (a) and (b) are
  // rollbackable; (c) is untouched by both verbs.
  test('--rollback --all selects the same rollbackable set for both verbs (P15, issue #11)', async () => {
    const up = await runPromote(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!up.ok) throw new Error(msg(up.error));
    const down = await runDev(f.env, opts(f, { targets: ['alpha'] }), passDeps());
    if (!down.ok) throw new Error(msg(down.error));
    const upBeta = await runPromote(
      f.env,
      opts(f, { targets: ['beta'], tools: ['codex'] }),
      passDeps(),
    );
    if (!upBeta.ok) throw new Error(msg(upBeta.error));

    const rolledBack = (r: Awaited<ReturnType<typeof runRollback>>): string[] => {
      if (!r.ok) throw new Error(msg(r.error));
      return r.value.results
        .filter((res) => res.action === 'rolled-back')
        .map((res) => `${res.skill}@${res.tool}`)
        .sort();
    };

    const asPromote = await runRollback(
      f.env,
      { ...opts(f, { all: true, dryRun: true }), op: 'promote' },
      passDeps(),
    );
    const asDev = await runRollback(
      f.env,
      { ...opts(f, { all: true, dryRun: true }), op: 'dev' },
      passDeps(),
    );

    expect(rolledBack(asPromote)).toEqual(rolledBack(asDev));
    expect(rolledBack(asPromote)).toEqual(['alpha@claude-code', 'beta@codex']);
    expect(rolledBack(asPromote)).not.toContain('gamma@codex');
  });
});

// -------------------------------------------------------------------------------------------
// I2: flip-rollback of an interrupted install must warn when it leaves a stale rev on the pair
// -------------------------------------------------------------------------------------------

describe('runRollback — interrupted install-replace reconciliation warning (I2)', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  const devOf = (sourcePath: string): DevRecord => ({
    sourcePath,
    resolvedPath: sourcePath,
    repoRoot: null,
    sourceRelPath: null,
    remote: null,
    recordedAt: NOW,
  });

  const originOf = (skill: string): OriginRecord => ({
    source: `smorinlabs/fixture-harness/${skill}`,
    host: 'github.com',
    repo: 'smorinlabs/fixture-harness',
    skillPath: `plugins/fh/skills/${skill}`,
    refRequested: null,
    refResolved: 'b'.repeat(40),
    pin: false,
    installedAt: NOW,
  });

  const pinnedOf = (storePath: string, rev: string): PinnedRecord => ({
    storePath,
    rev,
    gitSha: null,
    dirty: false,
    contentHash: `sha256:${'0'.repeat(64)}`,
    snapshotAt: NOW,
    verify: 'passed',
    placement: 'symlink',
  });

  const seedJournaledPair = async (
    skill: string,
    journal: Journal,
    pair: Omit<PairRecord, 'journal'>,
  ): Promise<string> => {
    const ledgerPath = ledgerPathOf(f.data);
    const ledger = emptyLedger(NOW);
    setPair(ledger, skill, 'claude-code', { ...pair, journal });
    const model = fromLedgerV1Dto(ledger);
    if (!model.ok) throw new Error(JSON.stringify(model.error));
    const w = await writeLedger(f.env, ledgerPath, model.value);
    if (!w.ok) throw new Error(msg(w.error));
    return ledgerPath;
  };

  test('RED->GREEN: replace-install rollback (before.mode pinned) surfaces the reconcile warning', async () => {
    const skill = 'zeta-replace';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, skill);
    // Old placement bytes still on disk (P1/P2 done, P3/P4 not — mirrors the 'staged' crash phase).
    await f.env.makeDir(live);

    const journal: Journal = {
      op: 'install',
      txId: 'aaaa1111',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'pinned', storePath: null, contentHash: null, liveKind: 'dir' },
      stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-aaaa1111`),
      backupPath: join(skillsRoot, `.skillsmith-backup-${skill}-aaaa1111`),
    };
    await seedJournaledPair(skill, journal, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf('/fake/store/o/r@newrev000000/zeta', 'newrev000000'),
      origin: originOf(skill),
    });

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(result?.reason).toContain('reconcile');
    expect(result?.reason).toContain('ledger');
    expect(result?.reason).toContain('skillsmith install');
    expectRolledBackExecution(
      rb.value,
      pinnedImage(skill, live, null),
      pinnedImage(skill, live, null),
    );

    // The old placement bytes are restored/preserved (the engine already did this part right).
    expect(await f.env.pathKind(live)).toBe('dir');
    const ledgerRes = await readLedger(f.env, ledgerPathOf(f.data));
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    const pair = getPair(ledgerRes.value, skill, 'claude-code');
    expect(pair?.journal).toBeNull();
    expect(pair?.mode).toBe('pinned');
  });

  test('negative: fresh-install rollback (before.mode absent) does NOT surface the reconcile warning', async () => {
    const skill = 'zeta-fresh';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, skill);
    // The half-installed NEW artifact — a fresh install has nothing to restore to.
    await f.env.makeDir(live);

    const journal: Journal = {
      op: 'install',
      txId: 'bbbb2222',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'absent' },
      stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-bbbb2222`),
      backupPath: join(skillsRoot, `.skillsmith-backup-${skill}-bbbb2222`),
    };
    await seedJournaledPair(skill, journal, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf('/fake/store/o/r@newrev000000/zeta', 'newrev000000'),
      origin: originOf(skill),
    });

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(result?.reason ?? '').not.toContain('reconcile');
    expectRolledBackExecution(rb.value, pinnedImage(skill, live, null), absentImage(skill, live));

    // Fresh install rollback deletes the pair entirely (coherent — nothing left to reconcile).
    expect(await f.env.pathKind(live)).toBe('absent');
    const ledgerRes = await readLedger(f.env, ledgerPathOf(f.data));
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    expect(getPair(ledgerRes.value, skill, 'claude-code')).toBeNull();
  });

  test('negative: uninstall-journal rollback does NOT surface the reconcile warning', async () => {
    const skill = 'zeta-uninstall';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, skill);
    const backupPath = join(skillsRoot, `.skillsmith-backup-${skill}-cccc3333`);
    // Committed-live-removed, backup still holding the old bytes (mirrors 'backed-up' phase).
    await f.env.makeDir(backupPath);

    const journal: Journal = {
      op: 'uninstall',
      txId: 'cccc3333',
      phase: 'backed-up',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'pinned', storePath: null, contentHash: null, liveKind: 'dir' },
      stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-cccc3333`),
      backupPath,
    };
    await seedJournaledPair(skill, journal, {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: pinnedOf('/fake/store/o/r@oldrev000000/zeta', 'oldrev000000'),
      origin: originOf(skill),
    });

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(result?.reason ?? '').not.toContain('reconcile');
    expectRolledBackExecution(rb.value, absentImage(skill, live), pinnedImage(skill, live, null));
  });

  test('negative: interrupted promote-journal rollback does NOT surface the reconcile warning', async () => {
    const skill = 'zeta-promote';
    const skillsRoot = join(f.home, '.claude', 'skills');
    const live = join(skillsRoot, skill);
    const target = resolve(f.alphaSrc);
    const targetHash = await contentHashOf(f.env, target);
    if (!targetHash.ok) throw new Error(msg(targetHash.error));
    // Live still the old dev symlink — the promote journal never got past 'staged'.
    await f.env.makeSymlink(target, live);

    const journal: Journal = {
      op: 'promote',
      txId: 'dddd4444',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'dev', symlinkTarget: target, liveKind: 'symlink' },
      stagingPath: join(skillsRoot, `.skillsmith-staging-${skill}-dddd4444`),
      backupPath: join(skillsRoot, `.skillsmith-backup-${skill}-dddd4444`),
    };
    await seedJournaledPair(skill, journal, {
      placementPath: live,
      mode: 'dev',
      dev: devOf(target),
      pinned: null,
    });

    const rb = await runRollback(
      f.env,
      { ...opts(f, { targets: [skill] }), op: 'promote' },
      passDeps(),
    );
    if (!rb.ok) throw new Error(msg(rb.error));
    const result = rb.value.results[0];
    expect(result?.action).toBe('rolled-back');
    expect(result?.reason ?? '').not.toContain('reconcile');
    expectRolledBackExecution(
      rb.value,
      devImage(skill, live, target, targetHash.value as `sha256:${string}`),
      devImage(skill, live, target, targetHash.value as `sha256:${string}`),
    );
  });
});

describe('dry-run', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('writes nothing (ledger absent afterwards) and takes no lock', async () => {
    const r = await runPromote(f.env, opts(f, { targets: ['alpha'], dryRun: true }), passDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.dryRun).toBe(true);
    expect(r.value.results[0]?.action).toBe('flipped');
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
  });
});
