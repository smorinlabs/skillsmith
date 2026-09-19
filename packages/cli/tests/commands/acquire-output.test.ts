import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { FLIP_TOOLS } from '@skillsmith/core';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

// SC-I60-R4 P17 recurrence coverage (issues #46/#60), adapted to P17's canonical
// runtime and v2 wire contract. P17's shared runtime defers exits
// (runtime/io.ts assigns process.exitCode; index.ts falls back signals-first),
// so no product change is expected here: these controls verify that large
// acquisition reports drain byte-complete through pipes. COUNT is 512 because
// P17's uninstall functionally refuses batches of >= 1000 targets with a
// generic error (a separate functional limit outside R4's output-drain scope);
// at 512 both reports still exceed ~400KB, well above the pressure floor.
// P17's different exit contract (including signals-first cancellation status)
// is preserved as-is and is not pinned here.

// Two deterministic real request shapes, each run as source and compiled binary
// through file/pipe/slow-pipe sinks plus one bounded stronger-backpressure sink:
//  1. `install --user --no-verify --json` with COUNT distinct invalid one-component
//     source tokens. Pre-resolution refuses every source (exit 2, v2 DTO with
//     redacted sources, one stderr diagnostic per input).
//  2. `uninstall --user --json` with COUNT distinct absent skill names (exit 0,
//     noop rows, empty stderr).

const COUNT = 512;
const SIZE_FLOOR = 128 * 1024;
const CHILD_DEADLINE_MS = 30_000;
const STRONG_FIRST_DELAY_MS = 100;
const STRONG_CHUNK_MS = 10;
const SLOW_CHUNK_MS = 2;
const REDACTED_SOURCE = '[REJECTED_SOURCE]';

const SOURCES = Array.from(
  { length: COUNT },
  (_, i) => `invalid-fixture-${String(i).padStart(4, '0')}`,
);
const TARGETS = Array.from(
  { length: COUNT },
  (_, i) => `absent-fixture-${String(i).padStart(4, '0')}`,
);
const AGENT_BINARIES = ['codex', 'opencode', 'claude', 'kilo'] as const;

// Agent-detection canary: proves no agent executable was consulted. Detection
// execs `<binary> --version` for binaries found on PATH; a marker here means
// detection ran at all. P17's install path legitimately probes local-only
// `git rev-parse --show-toplevel` before refusing, so unlike main there is no
// git canary here; git resolves to the system binary under a hermetic env.
const CANARY_SCRIPT =
  '#!/bin/sh\necho "canary-hit: $0 $*" >> "$SKILLSMITH_R4_CANARY_LOG"\nexit 1\n';

type Executable = 'source' | 'compiled';
type LargeSink = 'pipe' | 'slow' | 'strong';

interface WireResult {
  skill?: string | null;
  source?: string;
  tool: string | null;
  scope: string | null;
  placementPath: string | null;
  action: string;
  reason: string | null;
  requestIndex?: number;
}

interface WireReport {
  schemaVersion: number;
  kind: string;
  dryRun: boolean;
  saveMode?: string;
  artifactPair?: unknown;
  artifactEffects?: unknown[];
  artifactSelection?: { outcome: string; reason: string | null };
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
    batchPolicy?: string;
    path?: string | null;
  };
  results: WireResult[];
  summary: Record<string, unknown>;
}

interface CellResult {
  code: number;
  signalCode: string | null;
  stdout: string;
  stderr: string;
}

let fixtureRoot = '';
let binary = '';
let agentBin = '';

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
    `[r4p17] ${label} exit=${r.code} sig=${r.signalCode ?? '-'} ` +
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

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'skillsmith-acquire-output-p17-'));
  binary = join(fixtureRoot, 'skillsmith');
  agentBin = join(fixtureRoot, 'agentbin');
  await mkdir(agentBin, { recursive: true });
  for (const name of AGENT_BINARIES) {
    await writeFile(join(agentBin, name), CANARY_SCRIPT);
    await chmod(join(agentBin, name), 0o755);
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
  console.log(
    `[r4p17] compile exit=${compileCode} out=${compileOut.length} err=${compileErr.length}`,
  );
  if (compileCode !== 0) throw new Error(`native compile failed: ${compileOut}\n${compileErr}`);
}, 90_000);

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

const fileRef = new Map<string, CellResult>();
const EMPTY_DESIRED_STATE = { changed: 0, unchanged: 0, retained: 0, notWritten: 0, failed: 0 };

describe('acquire-output file controls (references)', () => {
  for (const executable of ['source', 'compiled'] as const) {
    test(`install ${executable} file: complete refusal report, exit 2, >128KiB`, async () => {
      const home = await mkdtemp(join(fixtureRoot, `install-file-${executable}-`));
      const canaryLog = join(home, 'canary.log');
      const env = cellEnv(home, [agentBin], { SKILLSMITH_R4_CANARY_LOG: canaryLog });
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
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.kind).toBe('skillsmith.install');
      expect(parsed.dryRun).toBe(false);
      expect(parsed.saveMode).toBe('desired-state');
      expect(parsed.artifactPair).toBeNull();
      expect(parsed.artifactEffects).toEqual([]);
      expect(parsed.artifactSelection).toEqual({
        outcome: 'none',
        reason: 'pre-resolution-failure',
      });
      expect(parsed.requested.sources).toEqual(new Array<string>(COUNT).fill(REDACTED_SOURCE));
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
      expect(parsed.requested.batchPolicy).toBe('fail-fast');
      expect(parsed.requested.path).toBeNull();
      expect(parsed.results).toHaveLength(COUNT);
      for (const [i, res] of parsed.results.entries()) {
        expect(res.source).toBe(REDACTED_SOURCE);
        expect(res.tool).toBeNull();
        expect(res.scope).toBe('user');
        expect(res.placementPath).toBeNull();
        expect(res.action).toBe('refused');
        expect(typeof res.reason).toBe('string');
        expect((res.reason as string).length).toBeGreaterThan(0);
        expect(res.requestIndex).toBe(i);
        expect(res).not.toHaveProperty('error');
      }
      expect(parsed.summary).toEqual({
        installed: 0,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: COUNT,
        failed: 0,
        desiredState: EMPTY_DESIRED_STATE,
      });
      const errLines = r.stderr.split('\n');
      expect(errLines).toHaveLength(COUNT + 1);
      expect(errLines[COUNT]).toBe('');
      for (const res of parsed.results) {
        const idx = res.requestIndex;
        if (idx === undefined) throw new Error('missing requestIndex');
        expect(errLines[idx]).toBe(`error: ${REDACTED_SOURCE}: ${res.reason}`);
      }
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
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.kind).toBe('skillsmith.uninstall');
      expect(parsed.dryRun).toBe(false);
      expect(parsed.saveMode).toBe('desired-state');
      expect(parsed.artifactPair).toBeNull();
      expect(parsed.artifactEffects).toEqual([]);
      expect(parsed.artifactSelection).toEqual({ outcome: 'none', reason: 'no-owner' });
      expect(parsed.requested.targets).toEqual(TARGETS);
      expect(parsed.requested.tools).toEqual([...FLIP_TOOLS]);
      expect(parsed.requested.explicitTools).toBe(false);
      expect(parsed.requested.scope).toBe('user');
      expect(parsed.requested.allScopes).toBe(false);
      expect(parsed.requested.force).toBe(false);
      expect(parsed.requested.batchPolicy).toBe('fail-fast');
      expect(parsed.results).toHaveLength(COUNT);
      for (const [i, res] of parsed.results.entries()) {
        const target = TARGETS[i];
        if (target === undefined) throw new Error(`missing fixture target ${i}`);
        expect(res.skill).toBe(target);
        expect(res.tool).toBeNull();
        expect(res.scope).toBeNull();
        expect(res.placementPath).toBeNull();
        expect(res.action).toBe('noop');
        expect(res.reason).toBe(`'${target}' is not installed anywhere skillsmith manages`);
        expect(res.requestIndex).toBe(i);
        expect(res).not.toHaveProperty('error');
      }
      expect(parsed.summary).toEqual({
        removed: 0,
        noop: COUNT,
        refused: 0,
        failed: 0,
        desiredState: EMPTY_DESIRED_STATE,
      });
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
        const env = cellEnv(home, [agentBin], { SKILLSMITH_R4_CANARY_LOG: canaryLog });
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
        expect(parsed.requested.sources).toEqual(new Array<string>(COUNT).fill(REDACTED_SOURCE));
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
