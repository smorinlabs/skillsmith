import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCodexInstallOutput, verifyCodex } from '../../../src/agents/codex/verify.ts';
import type { ExecResult, ScanEnv } from '../../../src/env/types.ts';
import type { VerifyFinding } from '../../../src/verify/types.ts';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'verify');

const ADDED_PLUGIN = 'Added plugin `dummytest` ...';
const FAILED_PARSE =
  'Error: failed to parse plugin.json: EOF while parsing an object at line 6 column 0';
const MARKETPLACE_UNSUPPORTED =
  'Error: invalid marketplace file /root/.agents/plugins/marketplace.json: marketplace root does not contain a supported manifest';
const LIST_JSON =
  '{"installed":[{"name":"dummytest","version":"0.1.0","installed":true,"enabled":true,"source":"skillsmith-mkt"}],"available":[]}';

const STATIC_COVERAGE_NOTICE: VerifyFinding = {
  checkId: 'codex.static-coverage',
  toolSeverity: null,
  normalizedSeverity: 'info',
  message: 'codex static checked the manifest only; run --deep for skill validation',
  file: null,
  subject: 'plugin',
};

// fileExists must resolve real fixture paths (wrapper synthesis reads the real target),
// but must NOT fall through to the real disk for detect()'s well-known-bin-dir probes —
// otherwise a locally installed `codex`/`brew`/etc. binary could make hits nondeterministic.
const fileExistsFake = (p: string): boolean => {
  if (p === '/fake/codex') return true;
  if (p.startsWith(FIXTURES)) return existsSync(p);
  return false;
};

const env = (): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => fileExistsFake(p),
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async (p) => readFile(p, 'utf8'),
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  modifiedAt: async () => null,
  withFileLock: (_p, fn) => fn(),
});

const fakeInstalled = (overrides: Partial<ScanEnv> = {}): ScanEnv => ({
  ...env(),
  path: ['/fake'],
  runVersion: async () => '0.142.5 (Codex CLI)',
  ...overrides,
});

interface Captured {
  args: readonly string[];
  env?: Record<string, string>;
}

describe('parseCodexInstallOutput', () => {
  test('success output ("Added plugin") yields no findings', () => {
    expect(parseCodexInstallOutput(ADDED_PLUGIN, '')).toEqual([]);
  });

  test('failed-to-parse manifest -> codex.manifest error, message after the marker, raw = full line', () => {
    const findings = parseCodexInstallOutput('', FAILED_PARSE);
    expect(findings).toEqual([
      {
        checkId: 'codex.manifest',
        toolSeverity: 'error',
        normalizedSeverity: 'error',
        message: 'EOF while parsing an object at line 6 column 0',
        file: '.codex-plugin/plugin.json',
        subject: 'manifest',
        raw: FAILED_PARSE,
      },
    ]);
  });

  test('unsupported marketplace manifest -> codex.marketplace error, message = full Error line, no raw', () => {
    const findings = parseCodexInstallOutput('', MARKETPLACE_UNSUPPORTED);
    expect(findings).toEqual([
      {
        checkId: 'codex.marketplace',
        toolSeverity: 'error',
        normalizedSeverity: 'error',
        message: MARKETPLACE_UNSUPPORTED,
        file: null,
        subject: 'marketplace',
      },
    ]);
  });
});

describe('verifyCodex static mode', () => {
  test('happy path (dummytest): 3 exec calls, non-empty CODEX_HOME, pass, coverage-notice only', async () => {
    const calls: Captured[] = [];
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        calls.push({ args, ...(opts?.env !== undefined ? { env: opts.env } : {}) });
        const step = args[1];
        if (step === 'marketplace') return { code: 0, stdout: '', stderr: '', timedOut: false };
        if (step === 'add') return { code: 0, stdout: ADDED_PLUGIN, stderr: '', timedOut: false };
        if (step === 'list') return { code: 0, stdout: LIST_JSON, stderr: '', timedOut: false };
        throw new Error(`unexpected exec call: ${args.join(' ')}`);
      },
    });

    const r = await verifyCodex(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.skipReason).toBeNull();
    expect(mode?.coverage).toEqual({ manifest: true, skills: false });
    expect(mode?.verdict).toBe('pass');
    expect(mode?.findings).toEqual([STATIC_COVERAGE_NOTICE]);
    expect(mode?.command).toBe(
      'codex plugin marketplace add <root> && codex plugin add dummytest@<mkt>',
    );

    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.env?.CODEX_HOME).toBeTruthy();

    const root = calls[0]?.args[3];
    const home = calls[0]?.env?.CODEX_HOME;
    expect(typeof root).toBe('string');
    expect(typeof home).toBe('string');
    expect(existsSync(root as string)).toBe(false);
    expect(existsSync(home as string)).toBe(false);
  });

  test('bad manifest (codex-badplug): failed-to-parse on add -> fail, manifest error + coverage notice', async () => {
    const calls: Captured[] = [];
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        calls.push({ args, ...(opts?.env !== undefined ? { env: opts.env } : {}) });
        const step = args[1];
        if (step === 'marketplace') return { code: 0, stdout: '', stderr: '', timedOut: false };
        if (step === 'add') return { code: 1, stdout: '', stderr: FAILED_PARSE, timedOut: false };
        throw new Error(`unexpected exec call: ${args.join(' ')}`);
      },
    });

    const r = await verifyCodex(scanEnv, {
      path: join(FIXTURES, 'codex-badplug'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.verdict).toBe('fail');
    expect(mode?.findings).toEqual([
      {
        checkId: 'codex.manifest',
        toolSeverity: 'error',
        normalizedSeverity: 'error',
        message: 'EOF while parsing an object at line 6 column 0',
        file: '.codex-plugin/plugin.json',
        subject: 'manifest',
        raw: FAILED_PARSE,
      },
      STATIC_COVERAGE_NOTICE,
    ]);

    // Unparsable plugin.json -> wrapper falls back to basename(opts.path).
    expect(calls[1]?.args).toEqual(['plugin', 'add', 'codex-badplug@skillsmith-mkt']);
    expect(mode?.command).toBe(
      'codex plugin marketplace add <root> && codex plugin add codex-badplug@<mkt>',
    );
  });

  test('marketplace-layout failure -> codex.marketplace error, fail, plugin add never called', async () => {
    const calls: Captured[] = [];
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        calls.push({ args, ...(opts?.env !== undefined ? { env: opts.env } : {}) });
        return { code: 1, stdout: '', stderr: MARKETPLACE_UNSUPPORTED, timedOut: false };
      },
    });

    const r = await verifyCodex(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.verdict).toBe('fail');
    expect(mode?.findings).toEqual([
      {
        checkId: 'codex.marketplace',
        toolSeverity: 'error',
        normalizedSeverity: 'error',
        message: MARKETPLACE_UNSUPPORTED,
        file: null,
        subject: 'marketplace',
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  test('list --json returns garbage -> status error, skipReason exec-error', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args): Promise<ExecResult> => {
        const step = args[1];
        if (step === 'marketplace') return { code: 0, stdout: '', stderr: '', timedOut: false };
        if (step === 'add') return { code: 0, stdout: ADDED_PLUGIN, stderr: '', timedOut: false };
        if (step === 'list') return { code: 0, stdout: 'not json{{{', stderr: '', timedOut: false };
        throw new Error(`unexpected exec call: ${args.join(' ')}`);
      },
    });

    const r = await verifyCodex(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('exec-error');
    expect(mode?.verdict).toBeNull();
  });

  test('timedOut on the first (marketplace) call -> status error, skipReason timeout', async () => {
    const scanEnv = fakeInstalled({
      exec: async (): Promise<ExecResult> => ({
        code: 124,
        stdout: '',
        stderr: '',
        timedOut: true,
      }),
    });

    const r = await verifyCodex(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('timeout');
    expect(mode?.verdict).toBeNull();
  });

  test('target without .codex-plugin/plugin.json (claude-noname) -> pass, no-manifest info, zero exec calls', async () => {
    let execCalls = 0;
    const scanEnv = fakeInstalled({
      exec: async (): Promise<ExecResult> => {
        execCalls++;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
    });

    const r = await verifyCodex(scanEnv, {
      path: join(FIXTURES, 'claude-noname'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.modes[0]).toEqual({
      mode: 'static',
      status: 'ran',
      skipReason: null,
      coverage: { manifest: false, skills: false },
      verdict: 'pass',
      command: '(skipped: no .codex-plugin/plugin.json)',
      findings: [
        {
          checkId: 'codex.no-manifest',
          toolSeverity: null,
          normalizedSeverity: 'info',
          message: 'no .codex-plugin/plugin.json found; codex manifest check not applicable',
          file: null,
          subject: 'manifest',
        },
      ],
    });
    expect(execCalls).toBe(0);
  });

  test('detect finds nothing -> available false, not-installed, modes []', async () => {
    const scanEnv = env(); // path: [], fileExists never matches '/fake/codex'
    const r = await verifyCodex(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      tool: 'codex',
      available: false,
      toolVersion: null,
      versionDrift: false,
      skipReason: 'not-installed',
      verdict: 'inconclusive',
      modes: [],
    });
  });

  test('version drift: 0.150.0 differs from verified 0.142.5 -> versionDrift true + info finding appended', async () => {
    const scanEnv = fakeInstalled({
      runVersion: async () => '0.150.0 (Codex CLI)',
      exec: async (_cmd, args): Promise<ExecResult> => {
        const step = args[1];
        if (step === 'marketplace') return { code: 0, stdout: '', stderr: '', timedOut: false };
        if (step === 'add') return { code: 0, stdout: ADDED_PLUGIN, stderr: '', timedOut: false };
        if (step === 'list') return { code: 0, stdout: LIST_JSON, stderr: '', timedOut: false };
        throw new Error(`unexpected exec call: ${args.join(' ')}`);
      },
    });

    const r = await verifyCodex(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.toolVersion).toBe('0.150.0');
    expect(r.value.versionDrift).toBe(true);
    expect(r.value.modes[0]?.findings).toEqual([
      STATIC_COVERAGE_NOTICE,
      {
        checkId: 'codex.version-drift',
        toolSeverity: null,
        normalizedSeverity: 'info',
        message: 'codex 0.150.0 differs from verified 0.142.5; parsing may be less reliable',
        file: null,
        subject: 'plugin',
      },
    ]);
  });
});
