// SC-I60-MF2A RED characterization: permission classification for skills-root creation.
//
// PLAN_ACCEPTED_NOT_RELEASED — prove-or-invalidate only. These tests assert the
// DESIRED behavior (permission-denied / exit 6) at the selected skills-root mkdir
// catch (packages/core/src/acquire/run.ts placePair). Before the bounded repair
// they FAIL with generic/exit-1, proving the lossy catch. Controls assert
// behavior that must NOT change (generic for EIO/mimics, success when writable).
//
// Lane 1 (core exact-API): wrap the real fixture makeDir; at the exact selected
//   installRoot throw a genuine normalized file-write/makeDir PortError with code
//   'permission' built by the REAL toPortError boundary.
// Lane 2 (deterministic public CLI): real `bun packages/cli/src/index.ts` subprocess
//   under `strace -P <exact-root> --inject=mkdirat:error=EACCES|EPERM`. The plan's
//   Bun --preload wrapper is infeasible (Bun statically binds node: builtins,
//   Bun.plugin refuses builtin override, ESM bypasses Module._load, and Bun issues
//   raw syscalls so LD_PRELOAD cannot intercept); strace injects the identical raw
//   errno beneath the UNMODIFIED production adapter, exact-path only, uid-independent.
// Lane 3 (real-OS public CLI): owned parent non-writable + kernel EACCES probe +
//   unmodified CLI, no strace.
//
// Test-only deps: owned HOME/SKILLSMITH_HOME/TMPDIR/cwd per test, owned local git
// remotes via accepted fixture helpers, stub `claude` binary in an owned bin dir
// (detection only — the install flow never executes the tool binary).

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERIFIED_AGAINST, ok, runInstall } from '@skillsmith/core';
import type { InstallDeps, InstallOptions, SkillSmithError } from '@skillsmith/core';
import type { VerifyReport } from '@skillsmith/core';
import type { ArtifactCoordinatorPorts } from '../../../core/src/artifacts/coordinator-types.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../core/src/artifacts/node-coordinator.ts';
import type { FlipTool } from '../../../core/src/place/types.ts';
import { isNormalizedPortError, toPortError } from '../../../core/src/ports/errors.ts';
import type { RuntimePorts } from '../../../core/src/ports/types.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { acquireExitCode } from '../../src/util/acquire-exit.ts';

setDefaultTimeout(120_000);

const NOW = '2026-07-08T00:00:00.000Z';
const SKILL = 'factor-scan';
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const BIN = 'packages/cli/src/index.ts';

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

// --- core-lane deps (mirror install-run.test.ts) ---

const detectClaudeOnly: InstallDeps['detect'] = async (_env, tool) =>
  tool === 'claude-code'
    ? ok([{ path: '/usr/local/bin/claude-code', version: '1.0.0', installMethod: 'unknown' }])
    : ok([]);

const passVerify: InstallDeps['verify'] = async (_env, opts) => {
  const tools = opts.tools ?? [];
  const tool = tools[0] ?? 'claude-code';
  const report: VerifyReport = {
    schemaVersion: 1,
    target: { path: opts.path, kind: 'skill' },
    requested: {
      tools: [...tools],
      modes: opts.deep ? ['static', 'deep'] : ['static'],
      strict: opts.strict ?? false,
      explicitTools: true,
    },
    verifiedAgainst: VERIFIED_AGAINST,
    summary: {
      verdict: 'pass',
      verified: [tool],
      failed: [],
      skipped: [],
      counts: { error: 0, warning: 0, info: 0 },
    },
    tools: [
      {
        tool,
        available: true,
        toolVersion: '1.0.0',
        versionDrift: false,
        skipReason: null,
        verdict: 'pass',
        modes: [],
      },
    ],
  } as VerifyReport;
  return ok(report);
};

interface CoreWorld {
  fixture: RemoteFixture;
  f: FixtureFleet;
  coordinator: ArtifactCoordinatorPorts;
  fsSource: string;
  expectedRoot: string;
  opts: InstallOptions;
  deps: InstallDeps;
}

const buildCoreWorld = async (): Promise<CoreWorld> => {
  const fixture = await buildRemoteFixture();
  const f = await buildFixtureFleet();
  const coordinator = await createTestNodeArtifactCoordinatorPorts(
    join(f.base, 'artifact-coordination'),
  );
  const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
  const expectedRoot = join(f.env.homeDir, '.claude', 'skills');
  const opts: InstallOptions = {
    sources: [fsSource],
    tools: ['claude-code' as FlipTool],
    scope: 'user',
    noVerify: true,
    cwd: f.base,
    configuration: f.configuration,
  };
  let n = 0;
  const deps: InstallDeps = {
    verify: passVerify,
    detect: detectClaudeOnly,
    transport: fixture.transport,
    artifactCoordinator: coordinator,
    now: () => NOW,
    newTxId: () => (0x20000000 + n++).toString(16).slice(-8),
  };
  return { fixture, f, coordinator, fsSource, expectedRoot, opts, deps };
};

const destroyCoreWorld = async (w: CoreWorld): Promise<void> => {
  await destroyFixtureFleet(w.f);
  await destroyRemoteFixture(w.fixture);
};

const kindOf = async (p: string): Promise<string> => {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isDirectory()) return 'dir';
    return 'file';
  } catch {
    return 'absent';
  }
};

// Genuine normalized permission PortError via the REAL production boundary.
const genuinePermissionFault = (rawCode: 'EACCES' | 'EPERM', path: string): unknown => {
  const raw = new Error(`${rawCode}: permission denied, mkdir '${path}'`) as Error & {
    code: string;
  };
  raw.code = rawCode;
  const normalized = toPortError(raw, {
    capability: 'file-write',
    operation: 'makeDir',
    context: { path },
  });
  if (!isNormalizedPortError(normalized) || normalized.code !== 'permission') {
    throw new Error('fault harness failed to build a genuine normalized permission PortError');
  }
  return normalized;
};

// --- CLI-lane harness (real subprocess) ---

interface CliWorld {
  fixture: RemoteFixture;
  f: FixtureFleet;
  fsSource: string;
  home: string;
  root: string;
  tmp: string;
  env: Record<string, string | undefined>;
  gitconfig: string;
}

const buildCliWorld = async (): Promise<CliWorld> => {
  const fixture = await buildRemoteFixture();
  const f = await buildFixtureFleet();
  const home = await realpath(f.home);
  const root = join(home, '.claude', 'skills');
  const tmp = join(f.base, 'tmp');
  await mkdir(tmp, { recursive: true });
  // Stub tool binary for REAL detection (detection only; install never execs it).
  const binDir = join(f.base, 'bin');
  await mkdir(binDir, { recursive: true });
  const stub = join(binDir, 'claude');
  await writeFile(stub, '#!/bin/sh\necho "claude stub 0.0.0"\n');
  await chmod(stub, 0o755);
  // Missing-root scenario: Fleet pre-creates the root; the plan tests creation.
  await rm(root, { recursive: true, force: true });
  // Networkless transport for the REAL CLI: production git strips GIT_CONFIG_COUNT
  // on every exec, so the fixture's GIT_CONFIG_* rewrite env cannot survive a real
  // subprocess. Instead pin an OWNED global gitconfig with url.insteadOf rewrites
  // (global config is honored by production by design).
  const gitconfig = join(f.base, 'gitconfig');
  await writeFile(
    gitconfig,
    [
      `[url "${fixture.multiUrl}"]`,
      `  insteadOf = ${fixture.multiSource}`,
      `[url "${fixture.singleUrl}"]`,
      `  insteadOf = ${fixture.singleSource}`,
      `[url "${fixture.rootUrl}"]`,
      `  insteadOf = ${fixture.rootSource}`,
      '[protocol "file"]',
      '  allow = always',
      '',
    ].join('\n'),
  );
  const rawEnv = hermeticGitEnv(
    {
      HOME: home,
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      SKILLSMITH_HOME: f.data,
      TMPDIR: tmp,
      GIT_ALLOW_PROTOCOL: 'file:https',
      PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
    },
    { globalConfigPath: gitconfig },
  );
  // Scrub ambient SKILLSMITH_* overrides except the owned ones set above.
  for (const key of Object.keys(rawEnv)) {
    if (key.startsWith('SKILLSMITH_') && key !== 'SKILLSMITH_HOME') delete rawEnv[key];
  }
  const fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
  return { fixture, f, fsSource, home, root, tmp, env: rawEnv, gitconfig };
};

const destroyCliWorld = async (w: CliWorld): Promise<void> => {
  await destroyFixtureFleet(w.f);
  await destroyRemoteFixture(w.fixture);
};

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const runCli = async (w: CliWorld, args: string[]): Promise<CliResult> => {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    cwd: REPO_ROOT,
    env: hermeticGitEnv(w.env, { globalConfigPath: w.gitconfig }),
    stdout: 'pipe',
    stderr: 'pipe',
  } as const);
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

const STRACE = 'strace';

const runCliUnderFault = async (
  w: CliWorld,
  args: string[],
  errno: 'EACCES' | 'EPERM' | 'EIO',
): Promise<CliResult & { sidecar: string; injected: number }> => {
  const sidecar = join(w.tmp, `strace-${errno}.log`);
  const proc = Bun.spawn(
    [
      STRACE,
      '-P',
      w.root,
      '-e',
      'trace=mkdir,mkdirat',
      `--inject=mkdirat:error=${errno}`,
      `--inject=mkdir:error=${errno}`,
      '-f',
      '-o',
      sidecar,
      'bun',
      BIN,
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      env: hermeticGitEnv(w.env, { globalConfigPath: w.gitconfig }),
      stdout: 'pipe',
      stderr: 'pipe',
    } as const,
  );
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  let injected = -1;
  try {
    const log = await readFile(sidecar, 'utf8');
    injected = log
      .split('\n')
      .filter((line) => line.includes('(INJECTED)') && line.includes(w.root)).length;
  } catch {
    injected = -1;
  }
  return { stdout, stderr, code, sidecar, injected };
};

const INSTALL_ARGS = (fsSource: string): string[] => [
  'install',
  fsSource,
  '--tool',
  'claude-code',
  '--no-verify',
  '--user',
];

const transcript = (r: CliResult): string =>
  `exit=${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

describe('SC-I60-MF2A lane 1 — core exact-API (real makeDir wrapper, genuine PortError)', () => {
  test('RED: EACCES-derived permission PortError at selected root yields permission-denied', async () => {
    const w = await buildCoreWorld();
    try {
      const calls: string[] = [];
      let faulted = 0;
      const fault = genuinePermissionFault('EACCES', w.expectedRoot);
      const env: RuntimePorts = {
        ...w.f.env,
        makeDir: async (p: string): Promise<void> => {
          calls.push(p);
          if (p === w.expectedRoot) {
            faulted++;
            throw fault;
          }
          return w.f.env.makeDir(p);
        },
      };
      const r = await runInstall(env, w.opts, w.deps);
      if (!r.ok) throw new Error(`report-level failure (setup?): ${msg(r.error)}`);
      expect(faulted).toBeGreaterThanOrEqual(1);
      expect(r.value.results.length).toBe(1);
      const one = r.value.results[0];
      if (!one) throw new Error('expected exactly one install result');
      expect(one.action).toBe('failed');
      expect(await kindOf(join(w.expectedRoot, SKILL))).toBe('absent');
      // DESIRED (pre-repair RED: actual is generic / exit 1).
      expect(one.error?.code).toBe('permission-denied');
      expect(acquireExitCode(r.value)).toBe(6);
    } finally {
      await destroyCoreWorld(w);
    }
  });

  test('RED: EPERM-derived permission PortError at selected root yields permission-denied', async () => {
    const w = await buildCoreWorld();
    try {
      let faulted = 0;
      const fault = genuinePermissionFault('EPERM', w.expectedRoot);
      const env: RuntimePorts = {
        ...w.f.env,
        makeDir: async (p: string): Promise<void> => {
          if (p === w.expectedRoot) {
            faulted++;
            throw fault;
          }
          return w.f.env.makeDir(p);
        },
      };
      const r = await runInstall(env, w.opts, w.deps);
      if (!r.ok) throw new Error(`report-level failure (setup?): ${msg(r.error)}`);
      expect(faulted).toBeGreaterThanOrEqual(1);
      const one = r.value.results[0];
      if (!one) throw new Error('expected exactly one install result');
      expect(one.action).toBe('failed');
      expect(one.error?.code).toBe('permission-denied');
      expect(acquireExitCode(r.value)).toBe(6);
    } finally {
      await destroyCoreWorld(w);
    }
  });

  test('CONTROL: normalized io PortError at selected root stays generic/exit-1', async () => {
    const w = await buildCoreWorld();
    try {
      const raw = new Error(`EIO: i/o error, mkdir '${w.expectedRoot}'`) as Error & {
        code: string;
      };
      raw.code = 'EIO';
      const fault = toPortError(raw, {
        capability: 'file-write',
        operation: 'makeDir',
        context: { path: w.expectedRoot },
      });
      expect(isNormalizedPortError(fault)).toBe(true);
      expect(fault.code).toBe('io');
      const env: RuntimePorts = {
        ...w.f.env,
        makeDir: async (p: string): Promise<void> => {
          if (p === w.expectedRoot) throw fault;
          return w.f.env.makeDir(p);
        },
      };
      const r = await runInstall(env, w.opts, w.deps);
      if (!r.ok) throw new Error(`report-level failure (setup?): ${msg(r.error)}`);
      const one = r.value.results[0];
      if (!one) throw new Error('expected exactly one install result');
      expect(one.action).toBe('failed');
      expect(one.error?.code).toBe('generic');
      expect(acquireExitCode(r.value)).toBe(1);
    } finally {
      await destroyCoreWorld(w);
    }
  });

  test('CONTROL: unregistered permission-lookalike object stays generic/exit-1', async () => {
    const w = await buildCoreWorld();
    try {
      const mimic = {
        capability: 'file-write',
        operation: 'makeDir',
        code: 'permission',
        message: 'permission denied',
        context: { path: w.expectedRoot },
      };
      expect(isNormalizedPortError(mimic)).toBe(false);
      const env: RuntimePorts = {
        ...w.f.env,
        makeDir: async (p: string): Promise<void> => {
          if (p === w.expectedRoot) throw mimic;
          return w.f.env.makeDir(p);
        },
      };
      const r = await runInstall(env, w.opts, w.deps);
      if (!r.ok) throw new Error(`report-level failure (setup?): ${msg(r.error)}`);
      const one = r.value.results[0];
      if (!one) throw new Error('expected exactly one install result');
      expect(one.action).toBe('failed');
      expect(one.error?.code).toBe('generic');
      expect(acquireExitCode(r.value)).toBe(1);
    } finally {
      await destroyCoreWorld(w);
    }
  });

  test('CONTROL: plain Error mentioning EACCES (no code) stays generic/exit-1', async () => {
    const w = await buildCoreWorld();
    try {
      const env: RuntimePorts = {
        ...w.f.env,
        makeDir: async (p: string): Promise<void> => {
          if (p === w.expectedRoot) throw new Error('EACCES: permission denied, mkdir');
          return w.f.env.makeDir(p);
        },
      };
      const r = await runInstall(env, w.opts, w.deps);
      if (!r.ok) throw new Error(`report-level failure (setup?): ${msg(r.error)}`);
      const one = r.value.results[0];
      if (!one) throw new Error('expected exactly one install result');
      expect(one.action).toBe('failed');
      expect(one.error?.code).toBe('generic');
      expect(acquireExitCode(r.value)).toBe(1);
    } finally {
      await destroyCoreWorld(w);
    }
  });

  test('CONTROL: writable missing skills root installs normally', async () => {
    const w = await buildCoreWorld();
    try {
      await rm(w.expectedRoot, { recursive: true, force: true });
      const r = await runInstall(w.f.env, w.opts, w.deps);
      if (!r.ok) throw new Error(`report-level failure (setup?): ${msg(r.error)}`);
      const one = r.value.results[0];
      if (!one) throw new Error('expected exactly one install result');
      expect(one.action).toBe('installed');
      expect(one.error).toBeUndefined();
      expect(acquireExitCode(r.value)).toBe(0);
      expect(await kindOf(join(w.expectedRoot, SKILL))).toBe('symlink');
    } finally {
      await destroyCoreWorld(w);
    }
  });
});

// strace fault injection is Linux-only; skip the lane where it cannot run
// (Bun.which tool gate per dev-source-live.test.ts precedent).
const lane2StraceOk = process.platform === 'linux' && Bun.which('strace') !== null;

describe.skipIf(!lane2StraceOk)(
  'SC-I60-MF2A lane 2 — deterministic public CLI (exact-path errno fault)',
  () => {
    test('CONTROL: unmodified CLI installs into writable missing root (exit 0)', async () => {
      const w = await buildCliWorld();
      try {
        const r = await runCli(w, INSTALL_ARGS(w.fsSource));
        if (r.code !== 0) throw new Error(`success control failed:\n${transcript(r)}`);
        expect(await kindOf(join(w.root, SKILL))).toBe('symlink');
      } finally {
        await destroyCliWorld(w);
      }
    });

    test('RED: EACCES at exact skills root yields exit 6 (default route)', async () => {
      const w = await buildCliWorld();
      try {
        const r = await runCliUnderFault(w, INSTALL_ARGS(w.fsSource), 'EACCES');
        expect(r.injected).toBeGreaterThanOrEqual(1);
        const combined = `${r.stdout}\n${r.stderr}`;
        expect(combined).toContain(`cannot create skills root ${w.root}`);
        expect(await kindOf(join(w.root, SKILL))).toBe('absent');
        // DESIRED (pre-repair RED: actual is exit 1).
        if (r.code !== 6) throw new Error(`RED evidence — expected exit 6, got:\n${transcript(r)}`);
      } finally {
        await destroyCliWorld(w);
      }
    });

    test('RED: EPERM at exact skills root yields exit 6 (default route)', async () => {
      const w = await buildCliWorld();
      try {
        const r = await runCliUnderFault(w, INSTALL_ARGS(w.fsSource), 'EPERM');
        expect(r.injected).toBeGreaterThanOrEqual(1);
        const combined = `${r.stdout}\n${r.stderr}`;
        expect(combined).toContain(`cannot create skills root ${w.root}`);
        if (r.code !== 6) throw new Error(`RED evidence — expected exit 6, got:\n${transcript(r)}`);
      } finally {
        await destroyCliWorld(w);
      }
    });

    test('RED: EACCES at exact skills root yields exit 6 (--no-save route)', async () => {
      const w = await buildCliWorld();
      try {
        const r = await runCliUnderFault(w, [...INSTALL_ARGS(w.fsSource), '--no-save'], 'EACCES');
        expect(r.injected).toBeGreaterThanOrEqual(1);
        const combined = `${r.stdout}\n${r.stderr}`;
        expect(combined).toContain(`cannot create skills root ${w.root}`);
        if (r.code !== 6) throw new Error(`RED evidence — expected exit 6, got:\n${transcript(r)}`);
      } finally {
        await destroyCliWorld(w);
      }
    });

    test('CONTROL: EIO at exact skills root stays exit 1', async () => {
      const w = await buildCliWorld();
      try {
        const r = await runCliUnderFault(w, INSTALL_ARGS(w.fsSource), 'EIO');
        expect(r.injected).toBeGreaterThanOrEqual(1);
        const combined = `${r.stdout}\n${r.stderr}`;
        expect(combined).toContain(`cannot create skills root ${w.root}`);
        if (r.code !== 1)
          throw new Error(`EIO control failed — expected exit 1, got:\n${transcript(r)}`);
      } finally {
        await destroyCliWorld(w);
      }
    });
  },
);

describe('SC-I60-MF2A lane 3 — real-OS denial (unmodified CLI, no fault harness)', () => {
  test('RED?: non-writable owned parent yields kernel EACCES and exit 6', async () => {
    const w = await buildCliWorld();
    const parent = join(w.home, '.claude');
    try {
      // Kernel probe first: the exact mkdir must really fail with EACCES.
      await chmod(parent, 0o555);
      let probeCode: string | null = null;
      try {
        await mkdir(w.root);
      } catch (e) {
        probeCode = (e as { code?: string }).code ?? null;
      }
      expect(probeCode).toBe('EACCES');
      const r = await runCli(w, INSTALL_ARGS(w.fsSource));
      const combined = `${r.stdout}\n${r.stderr}`;
      expect(combined).toContain(`cannot create skills root ${w.root}`);
      expect(await kindOf(join(w.root, SKILL))).toBe('absent');
      // DESIRED (pre-repair RED: actual is exit 1).
      if (r.code !== 6) throw new Error(`RED evidence — expected exit 6, got:\n${transcript(r)}`);
    } finally {
      await chmod(parent, 0o755);
      await destroyCliWorld(w);
    }
  });
});
