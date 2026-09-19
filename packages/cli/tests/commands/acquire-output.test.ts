import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { FLIP_TOOLS } from '@skillsmith/core';
import { emptyLedger } from '../../../core/src/place/ledger.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

// SC-I60-R4 (issues #46/#60): acquisition report completion and exits.
//
// Two deterministic real request shapes, each run as source and compiled binary
// through file/pipe/slow-pipe sinks plus one bounded stronger-backpressure sink:
//  1. `install --user --no-verify --json` with COUNT distinct invalid one-component
//     source tokens. Pure preflight refuses every source before detection/fetch/store;
//     the action completes through its normal report branch with exit 2 and one
//     stderr diagnostic per input. This is a refusal-report test, not a claim that
//     successful installation was exercised.
//  2. `uninstall --user --json` with COUNT distinct absent skill names. Absent-target
//     handling returns noop rows and exit 0 without a remote or installed agent.
// Failed-result and cancellation controls use actual
// `uninstall <absent> --dry-run --user --json` against healthy/malformed owned
// ledgers, unsignaled and interrupted with SIGINT/SIGTERM while a fixture-owned
// PATH shim holds the real initial `git rev-parse --show-toplevel` observation.

const COUNT = 1024;
const SIZE_FLOOR = 128 * 1024;
const CHILD_DEADLINE_MS = 30_000;
const READY_POLL_MS = 50;
const READY_WAIT_MS = 15_000;
const STRONG_FIRST_DELAY_MS = 100;
const STRONG_CHUNK_MS = 10;
const SLOW_CHUNK_MS = 2;

const SOURCES = Array.from(
  { length: COUNT },
  (_, i) => `invalid-fixture-${String(i).padStart(4, '0')}`,
);
const TARGETS = Array.from(
  { length: COUNT },
  (_, i) => `absent-fixture-${String(i).padStart(4, '0')}`,
);
const LEDGER_TARGET = 'absent-fixture-r4-ledger';
const MALFORMED_LEDGER = '{"schemaVersion":';
const AGENT_BINARIES = ['codex', 'opencode', 'claude', 'kilo'] as const;

// Agent-detection canary: proves no agent executable was consulted. Detection
// (agents/detect-factory.ts) execs `<binary> --version` for binaries found on
// PATH; a marker here means detection ran at all. The git canary extends the
// same proof to install preflight, which must spawn no subprocess.
const CANARY_SCRIPT =
  '#!/bin/sh\necho "canary-hit: $0 $*" >> "$SKILLSMITH_R4_CANARY_LOG"\nexit 1\n';

// Rendezvous shim: matches ONLY the exact gitToplevel argv
// (['-C', ownedCwd, 'rev-parse', '--show-toplevel']) in the owned cwd, writes a
// ready marker, waits up to 160x50ms = 8000ms (bounded inside the 10s plumbing
// timeout) for the parent release, then forwards the exact argv to the pinned
// real git with unchanged streams/exit. Any other argv forwards immediately.
const SHIM_SCRIPT = `#!/bin/sh
if [ "$#" -eq 4 ] && [ "$1" = "-C" ] && [ "$2" = "$SKILLSMITH_R4_OWNED_CWD" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then
  : > "$SKILLSMITH_R4_READY"
  i=0
  while [ ! -e "$SKILLSMITH_R4_RELEASE" ] && [ "$i" -lt 160 ]; do
    sleep 0.05
    i=$((i + 1))
  done
fi
exec "$SKILLSMITH_R4_REAL_GIT" "$@"
`;

type Executable = 'source' | 'compiled';
type LargeSink = 'pipe' | 'slow' | 'strong';
type LedgerState = 'healthy' | 'malformed';

interface WireResult {
  skill?: string | null;
  source?: string;
  tool: string | null;
  scope: string | null;
  placementPath: string | null;
  action: string;
  reason: string | null;
}

interface WireReport {
  schemaVersion: number;
  kind: string;
  dryRun: boolean;
  requested: {
    sources?: string[];
    targets?: string[];
    tools: string[];
    explicitTools: boolean;
    scope: string | null;
    explicitScope?: boolean;
    allScopes?: boolean;
    ref?: string | null;
    pin?: boolean;
    direct?: boolean;
    force: boolean;
    verify?: string;
    deep?: boolean;
  };
  results: WireResult[];
  summary: Record<string, number>;
}

interface CellResult {
  code: number;
  signalCode: string | null;
  stdout: string;
  stderr: string;
}

let fixtureRoot = '';
let binary = '';
let realGit = '';
let agentBin = '';
let installBin = '';
let shimBin = '';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const commandFor = (executable: Executable): string[] =>
  executable === 'source' ? [process.execPath, CLI_ENTRYPOINT] : [binary];

const expectAbsent = async (path: string): Promise<void> => {
  let found = false;
  try {
    await stat(path);
    found = true;
  } catch {
    found = false;
  }
  expect(found).toBe(false);
};

const logCell = (label: string, r: CellResult): void => {
  console.log(
    `[r4] ${label} exit=${r.code} sig=${r.signalCode ?? '-'} ` +
      `out=${Buffer.byteLength(r.stdout)} outSha=${sha256(r.stdout)} ` +
      `err=${Buffer.byteLength(r.stderr)} errSha=${sha256(r.stderr)}`,
  );
};

const cellEnv = (
  home: string,
  pathPrefix: string[],
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> => {
  const env = hermeticGitEnv({
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    SKILLSMITH_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'xdg-data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    PATH: [...pathPrefix, process.env.PATH ?? ''].filter((p) => p.length > 0).join(delimiter),
    ...extra,
  });
  env.SKILLSMITH_E2E = undefined;
  env.SKILLSMITH_TEST_PAUSE_AT = undefined;
  return env;
};

const readSlowly = async (
  stream: ReadableStream<Uint8Array>,
  firstDelayMs: number,
  chunkMs: number,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    if (firstDelayMs > 0) await Bun.sleep(firstDelayMs);
    for (;;) {
      const result = await reader.read();
      if (result.done) return text + decoder.decode();
      text += decoder.decode(result.value, { stream: true });
      if (chunkMs > 0) await Bun.sleep(chunkMs);
    }
  } finally {
    reader.releaseLock();
  }
};

const runCell = async (opts: {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  sink: LargeSink | 'file';
}): Promise<CellResult> => {
  const { label, argv, cwd, env, sink } = opts;
  const firstDelay = sink === 'strong' ? STRONG_FIRST_DELAY_MS : 0;
  const chunk = sink === 'slow' ? SLOW_CHUNK_MS : sink === 'strong' ? STRONG_CHUNK_MS : 0;
  const outFile = sink === 'file' ? await open(join(cwd, 'r4.out'), 'w') : undefined;
  const errFile = sink === 'file' ? await open(join(cwd, 'r4.err'), 'w') : undefined;
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      // cellEnv already returns hermeticGitEnv(...); the idempotent re-wrap
      // satisfies the hermetic-test-spawn gate at the literal call site.
      env: hermeticGitEnv(env),
      stdout: outFile?.fd ?? 'pipe',
      stderr: errFile?.fd ?? 'pipe',
    });
    const outP: Promise<string> =
      outFile !== undefined
        ? Promise.resolve('')
        : sink === 'pipe'
          ? new Response(proc.stdout as ReadableStream<Uint8Array>).text()
          : readSlowly(proc.stdout as ReadableStream<Uint8Array>, firstDelay, chunk);
    const errP: Promise<string> =
      errFile !== undefined
        ? Promise.resolve('')
        : new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already exited; the await below observes the final state.
      }
    }, CHILD_DEADLINE_MS);
    try {
      const [code, out, err] = await Promise.all([proc.exited, outP, errP]);
      if (timedOut) throw new Error(`${label}: owned child exceeded ${CHILD_DEADLINE_MS}ms`);
      const stdout = outFile !== undefined ? await readFile(join(cwd, 'r4.out'), 'utf8') : out;
      const stderr = errFile !== undefined ? await readFile(join(cwd, 'r4.err'), 'utf8') : err;
      return { code, signalCode: proc.signalCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await outFile?.close();
    await errFile?.close();
  }
};

const runSignaledCell = async (opts: {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  readyPath: string;
  releasePath: string;
  signal: 'SIGINT' | 'SIGTERM';
}): Promise<CellResult> => {
  const proc = Bun.spawn(opts.argv, {
    cwd: opts.cwd,
    // cellEnv already returns hermeticGitEnv(...); the idempotent re-wrap
    // satisfies the hermetic-test-spawn gate at the literal call site.
    env: hermeticGitEnv(opts.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const outP = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const errP = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already exited; the await below observes the final state.
    }
  }, CHILD_DEADLINE_MS);
  try {
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < READY_WAIT_MS) {
      try {
        await stat(opts.readyPath);
        ready = true;
        break;
      } catch {
        await Bun.sleep(READY_POLL_MS);
      }
    }
    if (!ready) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Best effort; still await the final state below.
      }
      await proc.exited;
      throw new Error(`${opts.label}: git rendezvous never became ready within ${READY_WAIT_MS}ms`);
    }
    proc.kill(opts.signal);
    await writeFile(opts.releasePath, 'release\n');
    const [code, stdout, stderr] = await Promise.all([proc.exited, outP, errP]);
    if (timedOut) throw new Error(`${opts.label}: owned child exceeded ${CHILD_DEADLINE_MS}ms`);
    return { code, signalCode: proc.signalCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'skillsmith-acquire-output-'));
  binary = join(fixtureRoot, 'skillsmith');
  agentBin = join(fixtureRoot, 'agentbin');
  installBin = join(fixtureRoot, 'installbin');
  shimBin = join(fixtureRoot, 'shimbin');
  await mkdir(agentBin, { recursive: true });
  await mkdir(installBin, { recursive: true });
  await mkdir(shimBin, { recursive: true });
  for (const name of AGENT_BINARIES) {
    await writeFile(join(agentBin, name), CANARY_SCRIPT);
    await writeFile(join(installBin, name), CANARY_SCRIPT);
    await chmod(join(agentBin, name), 0o755);
    await chmod(join(installBin, name), 0o755);
  }
  await writeFile(join(installBin, 'git'), CANARY_SCRIPT);
  await chmod(join(installBin, 'git'), 0o755);
  await writeFile(join(shimBin, 'git'), SHIM_SCRIPT);
  await chmod(join(shimBin, 'git'), 0o755);

  const gitProbe = Bun.spawnSync(['sh', '-c', 'command -v git'], {
    env: hermeticGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  realGit = new TextDecoder().decode(gitProbe.stdout as Uint8Array).trim();
  if (gitProbe.exitCode !== 0 || realGit === '') {
    throw new Error('cannot pin a real git binary for the rendezvous shim');
  }

  const compile = Bun.spawn(
    [process.execPath, 'build', '--compile', '--bytecode', CLI_ENTRYPOINT, '--outfile', binary],
    { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
  );
  const [compileCode, compileOut, compileErr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  console.log(`[r4] compile exit=${compileCode} out=${compileOut.length} err=${compileErr.length}`);
  if (compileCode !== 0) throw new Error(`native compile failed: ${compileOut}\n${compileErr}`);
}, 90_000);

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

const fileRef = new Map<string, CellResult>();

describe('acquire-output file controls (references)', () => {
  for (const executable of ['source', 'compiled'] as const) {
    test(`install ${executable} file: complete refusal report, exit 2, >128KiB`, async () => {
      const home = await mkdtemp(join(fixtureRoot, `install-file-${executable}-`));
      const canaryLog = join(home, 'canary.log');
      const env = cellEnv(home, [installBin], { SKILLSMITH_R4_CANARY_LOG: canaryLog });
      const r = await runCell({
        label: `install/${executable}/file`,
        argv: [...commandFor(executable), 'install', ...SOURCES, '--user', '--no-verify', '--json'],
        cwd: home,
        env,
        sink: 'file',
      });
      logCell(`install/${executable}/file`, r);
      expect(r.signalCode).toBeNull();
      expect(r.code).toBe(2);
      expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(SIZE_FLOOR);
      const parsed = JSON.parse(r.stdout) as WireReport;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.kind).toBe('skillsmith.install');
      expect(parsed.dryRun).toBe(false);
      expect(parsed.requested.sources).toEqual(SOURCES);
      expect(parsed.requested.tools).toEqual([]);
      expect(parsed.requested.explicitTools).toBe(false);
      expect(parsed.requested.scope).toBe('user');
      expect(parsed.requested.explicitScope).toBe(true);
      expect(parsed.requested.ref).toBeNull();
      expect(parsed.requested.pin).toBe(false);
      expect(parsed.requested.direct).toBe(false);
      expect(parsed.requested.force).toBe(false);
      expect(parsed.requested.verify).toBe('skipped');
      expect(parsed.requested.deep).toBe(false);
      expect(parsed.results).toHaveLength(COUNT);
      parsed.results.forEach((res, i) => {
        const source = SOURCES[i];
        if (source === undefined) throw new Error(`missing fixture source ${i}`);
        expect(res.source).toBe(source);
        expect(res.tool).toBeNull();
        expect(res.scope).toBe('user');
        expect(res.placementPath).toBeNull();
        expect(res.action).toBe('refused');
        expect(typeof res.reason).toBe('string');
        expect((res.reason as string).length).toBeGreaterThan(0);
        expect(res).not.toHaveProperty('error');
      });
      expect(parsed.summary).toEqual({
        installed: 0,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: COUNT,
        failed: 0,
      });
      const errLines = r.stderr.split('\n');
      expect(errLines).toHaveLength(COUNT + 1);
      expect(errLines[COUNT]).toBe('');
      parsed.results.forEach((res, i) => {
        expect(errLines[i]).toBe(`error: ${SOURCES[i]}: ${res.reason}`);
      });
      await expectAbsent(canaryLog);
      fileRef.set(`install:${executable}`, r);
    }, 60_000);

    test(`uninstall ${executable} file: complete noop report, exit 0, >128KiB`, async () => {
      const home = await mkdtemp(join(fixtureRoot, `uninstall-file-${executable}-`));
      await expectAbsent(join(home, 'data', 'placements.json'));
      const canaryLog = join(home, 'canary.log');
      const env = cellEnv(home, [agentBin], { SKILLSMITH_R4_CANARY_LOG: canaryLog });
      const r = await runCell({
        label: `uninstall/${executable}/file`,
        argv: [...commandFor(executable), 'uninstall', ...TARGETS, '--user', '--json'],
        cwd: home,
        env,
        sink: 'file',
      });
      logCell(`uninstall/${executable}/file`, r);
      expect(r.signalCode).toBeNull();
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(SIZE_FLOOR);
      const parsed = JSON.parse(r.stdout) as WireReport;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.kind).toBe('skillsmith.uninstall');
      expect(parsed.dryRun).toBe(false);
      expect(parsed.requested.targets).toEqual(TARGETS);
      expect(parsed.requested.tools).toEqual([...FLIP_TOOLS]);
      expect(parsed.requested.explicitTools).toBe(false);
      expect(parsed.requested.scope).toBe('user');
      expect(parsed.requested.allScopes).toBe(false);
      expect(parsed.requested.force).toBe(false);
      expect(parsed.results).toHaveLength(COUNT);
      parsed.results.forEach((res, i) => {
        const target = TARGETS[i];
        if (target === undefined) throw new Error(`missing fixture target ${i}`);
        expect(res.skill).toBe(target);
        expect(res.tool).toBeNull();
        expect(res.scope).toBeNull();
        expect(res.placementPath).toBeNull();
        expect(res.action).toBe('noop');
        expect(res.reason).toBe(`'${target}' is not installed anywhere skillsmith manages`);
        expect(res).not.toHaveProperty('error');
      });
      expect(parsed.summary).toEqual({ removed: 0, noop: COUNT, refused: 0, failed: 0 });
      await expectAbsent(canaryLog);
      fileRef.set(`uninstall:${executable}`, r);
    }, 60_000);
  }
});

describe('acquire-output pipes (byte-complete reports)', () => {
  for (const executable of ['source', 'compiled'] as const) {
    for (const sink of ['pipe', 'slow', 'strong'] as const) {
      test(`install ${executable} ${sink}: byte-complete refusal report`, async () => {
        const ref = fileRef.get(`install:${executable}`);
        if (!ref) throw new Error('file control reference missing (file tests must run first)');
        const home = await mkdtemp(join(fixtureRoot, `install-${sink}-${executable}-`));
        const canaryLog = join(home, 'canary.log');
        const env = cellEnv(home, [installBin], { SKILLSMITH_R4_CANARY_LOG: canaryLog });
        const r = await runCell({
          label: `install/${executable}/${sink}`,
          argv: [
            ...commandFor(executable),
            'install',
            ...SOURCES,
            '--user',
            '--no-verify',
            '--json',
          ],
          cwd: home,
          env,
          sink,
        });
        logCell(`install/${executable}/${sink}`, r);
        expect(r.signalCode).toBeNull();
        expect(r.code).toBe(2);
        expect(Buffer.byteLength(r.stdout)).toBe(Buffer.byteLength(ref.stdout));
        expect(sha256(r.stdout)).toBe(sha256(ref.stdout));
        expect(r.stdout).toBe(ref.stdout);
        expect(r.stderr).toBe(ref.stderr);
        const parsed = JSON.parse(r.stdout) as WireReport;
        expect(parsed.requested.sources).toEqual(SOURCES);
        expect(parsed.results).toHaveLength(COUNT);
        expect(parsed.summary.refused).toBe(COUNT);
        await expectAbsent(canaryLog);
      }, 60_000);

      test(`uninstall ${executable} ${sink}: byte-complete noop report`, async () => {
        const ref = fileRef.get(`uninstall:${executable}`);
        if (!ref) throw new Error('file control reference missing (file tests must run first)');
        const home = await mkdtemp(join(fixtureRoot, `uninstall-${sink}-${executable}-`));
        await expectAbsent(join(home, 'data', 'placements.json'));
        const canaryLog = join(home, 'canary.log');
        const env = cellEnv(home, [agentBin], { SKILLSMITH_R4_CANARY_LOG: canaryLog });
        const r = await runCell({
          label: `uninstall/${executable}/${sink}`,
          argv: [...commandFor(executable), 'uninstall', ...TARGETS, '--user', '--json'],
          cwd: home,
          env,
          sink,
        });
        logCell(`uninstall/${executable}/${sink}`, r);
        expect(r.signalCode).toBeNull();
        expect(r.code).toBe(0);
        expect(Buffer.byteLength(r.stdout)).toBe(Buffer.byteLength(ref.stdout));
        expect(sha256(r.stdout)).toBe(sha256(ref.stdout));
        expect(r.stdout).toBe(ref.stdout);
        expect(r.stderr).toBe(ref.stderr);
        const parsed = JSON.parse(r.stdout) as WireReport;
        expect(parsed.requested.targets).toEqual(TARGETS);
        expect(parsed.results).toHaveLength(COUNT);
        expect(parsed.summary.noop).toBe(COUNT);
        await expectAbsent(canaryLog);
      }, 60_000);
    }
  }
});

const seedLedger = async (home: string, state: LedgerState): Promise<void> => {
  const dataDir = join(home, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, 'placements.json'),
    state === 'healthy'
      ? JSON.stringify(emptyLedger('2026-01-01T00:00:00.000Z'))
      : MALFORMED_LEDGER,
  );
};

const expectHealthyDryRunReport = (stdout: string): void => {
  const parsed = JSON.parse(stdout) as WireReport;
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.kind).toBe('skillsmith.uninstall');
  expect(parsed.dryRun).toBe(true);
  expect(parsed.requested.targets).toEqual([LEDGER_TARGET]);
  expect(parsed.requested.tools).toEqual([...FLIP_TOOLS]);
  expect(parsed.requested.explicitTools).toBe(false);
  expect(parsed.requested.scope).toBe('user');
  expect(parsed.requested.allScopes).toBe(false);
  expect(parsed.requested.force).toBe(false);
  expect(parsed.results).toHaveLength(1);
  const res = parsed.results[0];
  if (res === undefined) throw new Error('missing dry-run result');
  expect(res.skill).toBe(LEDGER_TARGET);
  expect(res.tool).toBeNull();
  expect(res.scope).toBeNull();
  expect(res.placementPath).toBeNull();
  expect(res.action).toBe('noop');
  expect(res.reason).toBe(`'${LEDGER_TARGET}' is not installed anywhere skillsmith manages`);
  expect(res).not.toHaveProperty('error');
  expect(parsed.summary).toEqual({ removed: 0, noop: 1, refused: 0, failed: 0 });
};

let malformedStderrRef: string | null = null;

const expectMalformedStderr = (errTxt: string): void => {
  expect(errTxt.startsWith('error: ledger is not valid JSON: ')).toBe(true);
  expect(errTxt.endsWith('\n')).toBe(true);
  expect(errTxt.trim().split('\n')).toHaveLength(1);
  expect(errTxt).not.toContain('fatal:');
  expect(errTxt).not.toContain('skillsmith.uninstall');
  if (malformedStderrRef === null) {
    malformedStderrRef = errTxt;
  } else {
    expect(errTxt).toBe(malformedStderrRef);
  }
};

describe('acquire-output failed-result controls (dry-run ledger)', () => {
  for (const executable of ['source', 'compiled'] as const) {
    for (const state of ['healthy', 'malformed'] as const) {
      test(`uninstall ${executable} dry-run ${state} ledger, unsignaled`, async () => {
        const home = await mkdtemp(join(fixtureRoot, `ledger-${state}-${executable}-`));
        await seedLedger(home, state);
        const canaryLog = join(home, 'canary.log');
        const env = cellEnv(home, [agentBin], { SKILLSMITH_R4_CANARY_LOG: canaryLog });
        const r = await runCell({
          label: `uninstall/${executable}/dry-run/${state}/unsignaled`,
          argv: [
            ...commandFor(executable),
            'uninstall',
            LEDGER_TARGET,
            '--dry-run',
            '--user',
            '--json',
          ],
          cwd: home,
          env,
          sink: 'pipe',
        });
        logCell(`uninstall/${executable}/dry-run/${state}/unsignaled`, r);
        expect(r.signalCode).toBeNull();
        if (state === 'healthy') {
          expect(r.code).toBe(0);
          expect(r.stderr).toBe('');
          expectHealthyDryRunReport(r.stdout);
        } else {
          expect(r.code).toBe(3);
          expect(r.stdout).toBe('');
          expectMalformedStderr(r.stderr);
        }
        await expectAbsent(canaryLog);
      }, 60_000);
    }
  }
});

describe('acquire-output cancellation controls (SIGINT/SIGTERM during git rendezvous)', () => {
  for (const executable of ['source', 'compiled'] as const) {
    for (const state of ['healthy', 'malformed'] as const) {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        test(`uninstall ${executable} dry-run ${state} ledger, ${signal}: exit 130`, async () => {
          const home = await mkdtemp(join(fixtureRoot, `signal-${state}-${executable}-`));
          await seedLedger(home, state);
          const readyPath = join(home, 'git.ready');
          const releasePath = join(home, 'git.release');
          const canaryLog = join(home, 'canary.log');
          const env = cellEnv(home, [shimBin, agentBin], {
            SKILLSMITH_R4_OWNED_CWD: home,
            SKILLSMITH_R4_READY: readyPath,
            SKILLSMITH_R4_RELEASE: releasePath,
            SKILLSMITH_R4_REAL_GIT: realGit,
            SKILLSMITH_R4_CANARY_LOG: canaryLog,
          });
          const r = await runSignaledCell({
            label: `uninstall/${executable}/dry-run/${state}/${signal}`,
            argv: [
              ...commandFor(executable),
              'uninstall',
              LEDGER_TARGET,
              '--dry-run',
              '--user',
              '--json',
            ],
            cwd: home,
            env,
            readyPath,
            releasePath,
            signal,
          });
          logCell(`uninstall/${executable}/dry-run/${state}/${signal}`, r);
          expect(r.signalCode).toBeNull();
          expect(r.code).toBe(130);
          if (state === 'healthy') {
            expect(r.stderr).toBe('');
            expectHealthyDryRunReport(r.stdout);
          } else {
            expect(r.stdout).toBe('');
            expectMalformedStderr(r.stderr);
          }
          await expectAbsent(canaryLog);
        }, 60_000);
      }
    }
  }
});
