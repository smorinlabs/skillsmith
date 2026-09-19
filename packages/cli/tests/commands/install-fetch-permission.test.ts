// SC-I60-MF2B Phase A characterization — git-init permission failure classification.
//
// Load-bearing REDs (core + public CLI) assert the DESIRED contract: a real
// local init kernel denial must surface as permission-denied / exit 6. They
// FAIL at base 44173ce (source-unresolvable / exit 5) — that failure IS the
// MF2B proof. No production repair is authorized in Phase A.
// Controls pin behavior that must NOT change (invalid ref / unreachable /
// file collision / misleading-text negative / typed-permission GREEN).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchRepo } from '../../../core/src/acquire/fetch.ts';
import { errorMessage } from '../../../core/src/errors.ts';
import { defaultRuntimePorts } from '../../../core/src/ports/default.ts';
import { toPortError } from '../../../core/src/ports/errors.ts';
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
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';
import {
  MF2B_REAL_GIT,
  mf2bObserverScript,
  readMf2bObserverLog,
} from '../fixtures/mf2b-git-forwarding-observer.ts';

setDefaultTimeout(60_000);

let remote: RemoteFixture;
let coreEnv: RuntimePorts;

beforeAll(async () => {
  remote = await buildRemoteFixture();
  coreEnv = await defaultRuntimePorts();
});

afterAll(async () => {
  await destroyRemoteFixture(remote);
});

interface Mf2bOwnedRoot {
  root: string;
  logPath: string;
  gitConfig: string;
  fixBin: string;
  xdg: string;
  tmpOwned: string;
}

/** Owned bin (observer `git` + fake `claude`), gitconfig, xdg, tmp. No network. */
const buildOwnedRoot = async (
  extraRewrites: ReadonlyArray<readonly [string, string]> = [],
): Promise<Mf2bOwnedRoot> => {
  const root = await mkdtemp(join(tmpdir(), 'mf2b-cli-'));
  const obsBin = join(root, 'obsbin');
  await mkdir(obsBin, { recursive: true });
  await writeFile(join(obsBin, 'git'), mf2bObserverScript(MF2B_REAL_GIT), { mode: 0o755 });
  const logPath = join(root, 'git-calls.jsonl');
  await writeFile(logPath, '');
  const fixBin = join(root, 'fixbin');
  await mkdir(fixBin, { recursive: true });
  await writeFile(
    join(fixBin, 'claude'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.202"; exit 0; fi\nexit 0\n',
    { mode: 0o755 },
  );
  const rewrites: ReadonlyArray<readonly [string, string]> = [
    [remote.multiSource, remote.multiUrl],
    [remote.singleSource, remote.singleUrl],
    [remote.rootSource, remote.rootUrl],
    ...extraRewrites,
  ];
  const gitConfig = join(root, 'fixture-gitconfig');
  await writeFile(
    gitConfig,
    [
      ...rewrites.flatMap(([insteadOf, local]) => [
        `[url "${local}"]`,
        `\tinsteadOf = ${insteadOf}`,
      ]),
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );
  const xdg = join(root, 'xdg');
  const tmpOwned = join(root, 'tmp');
  await mkdir(xdg, { recursive: true });
  await mkdir(tmpOwned, { recursive: true });
  return { root, logPath, gitConfig, fixBin, xdg, tmpOwned };
};

const cliEnvFor = (fleet: FixtureFleet, owned: Mf2bOwnedRoot): Record<string, string | undefined> =>
  hermeticGitEnv(
    {
      HOME: fleet.home,
      XDG_CONFIG_HOME: join(owned.xdg, 'config'),
      XDG_DATA_HOME: join(owned.xdg, 'data'),
      XDG_CACHE_HOME: join(owned.xdg, 'cache'),
      TMPDIR: owned.tmpOwned,
      SKILLSMITH_HOME: fleet.data,
      PATH: `${join(owned.root, 'obsbin')}:${owned.fixBin}:${process.env.PATH}`,
      MF2B_GIT_LOG: owned.logPath,
      CI: '1',
      NO_COLOR: '1',
    },
    { globalConfigPath: owned.gitConfig },
  );

const runCli = async (
  args: readonly string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
    cwd,
    // cliEnvFor already returns hermeticGitEnv(...); the idempotent re-wrap
    // satisfies the hermetic-test-spawn gate at the literal call site while
    // preserving the fixture globalConfigPath passthrough.
    env: hermeticGitEnv(
      env,
      env.GIT_CONFIG_GLOBAL === undefined ? {} : { globalConfigPath: env.GIT_CONFIG_GLOBAL },
    ),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
};

const SINGLE_SKILL = '//tools/deep/skills/lint';

/** Real kernel-denial probe at the same destination/user. Returns the errno code. */
const probeDeny = async (fetchRoot: string): Promise<string> => {
  try {
    await mkdir(join(fetchRoot, 'probe-child'));
    return 'UNEXPECTED-SUCCESS';
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

describe('SC-I60-MF2B git-init permission classification', () => {
  test('control: successful networkless install exits 0 through real init', async () => {
    const fleet = await buildFixtureFleet();
    const owned = await buildOwnedRoot();
    try {
      const r = await runCli(
        [
          'install',
          `${remote.singleSource}${SINGLE_SKILL}`,
          '--tool',
          'claude-code',
          '--no-verify',
          '--user',
          '--no-prompt',
        ],
        cliEnvFor(fleet, owned),
        fleet.base,
      );
      expect(r.code).toBe(0);
      const calls = await readMf2bObserverLog(owned.logPath);
      const inits = calls.filter((c) => c.argv[1] === 'init');
      expect(inits.length).toBe(1);
      expect(inits[0]?.exit).toBe(0);
      expect(inits[0]?.argv.slice(0, 3)).toEqual(['git', 'init', '--']);
      expect(inits[0]?.argv[3]?.startsWith(`${join(fleet.data, '.fetch')}/`)).toBe(true);
    } finally {
      await destroyFixtureFleet(fleet);
      await rm(owned.root, { recursive: true, force: true });
    }
  });

  test('core RED: real local-init kernel denial yields permission-denied', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'mf2b-core-'));
    const owned = await buildOwnedRoot();
    const prevPath = process.env.PATH;
    const prevLog = process.env.MF2B_GIT_LOG;
    try {
      process.env.PATH = `${join(owned.root, 'obsbin')}:${prevPath}`;
      process.env.MF2B_GIT_LOG = owned.logPath;
      const fetchRoot = join(scratch, 'data', '.fetch');
      await mkdir(fetchRoot, { recursive: true });
      await chmod(fetchRoot, 0o555);
      try {
        const mode = ((await stat(fetchRoot)).mode & 0o777).toString(8);
        expect(mode).toBe('555');
        expect(await probeDeny(fetchRoot)).toBe('EACCES');
        const deniedDir = join(fetchRoot, 'tx-denied');
        const res = await fetchRepo(coreEnv, {
          cloneUrl: remote.multiUrl,
          ref: null,
          fetchDir: deniedDir,
        });
        // Provenance (green): real failure, real init boundary, no follow-on remote add.
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(errorMessage(res.error)).toContain('permission denied');
        const calls = await readMf2bObserverLog(owned.logPath);
        const inits = calls.filter((c) => c.argv[1] === 'init');
        expect(inits.length).toBe(1);
        expect(inits[0]?.exe).toBe(MF2B_REAL_GIT);
        expect(inits[0]?.argv).toEqual(['git', 'init', '--', deniedDir]);
        expect(inits[0]?.exit).toBe(128);
        expect(inits[0]?.stderr).toContain('Permission denied');
        expect(calls.some((c) => c.argv.includes('remote'))).toBe(false);
        // RED: desired contract — currently source-unresolvable (the MF2B bug).
        expect(res.error.code).toBe('permission-denied');
      } finally {
        await chmod(fetchRoot, 0o755);
      }
    } finally {
      if (prevPath === undefined) process.env.PATH = undefined;
      else process.env.PATH = prevPath;
      if (prevLog === undefined) process.env.MF2B_GIT_LOG = undefined;
      else process.env.MF2B_GIT_LOG = prevLog;
      await rm(scratch, { recursive: true, force: true });
      await rm(owned.root, { recursive: true, force: true });
    }
  });

  test('public CLI RED (human): denied .fetch parent exits 6', async () => {
    const fleet = await buildFixtureFleet();
    const owned = await buildOwnedRoot();
    try {
      const fetchRoot = join(fleet.data, '.fetch');
      await mkdir(fetchRoot, { recursive: true });
      await chmod(fetchRoot, 0o555);
      try {
        expect(((await stat(fetchRoot)).mode & 0o777).toString(8)).toBe('555');
        expect(await probeDeny(fetchRoot)).toBe('EACCES');
        const r = await runCli(
          [
            'install',
            `${remote.singleSource}${SINGLE_SKILL}`,
            '--tool',
            'claude-code',
            '--no-verify',
            '--user',
            '--no-prompt',
          ],
          cliEnvFor(fleet, owned),
          fleet.base,
        );
        // Provenance (green): real failure, no live installation, traced init denial.
        expect(r.code).not.toBe(0);
        expect(`${r.stdout}\n${r.stderr}`).toContain('permission denied');
        const { lstat } = await import('node:fs/promises');
        const liveKind = await lstat(join(fleet.home, '.claude', 'skills', 'lint')).then(
          () => 'present',
          () => 'absent',
        );
        expect(liveKind).toBe('absent');
        const calls = await readMf2bObserverLog(owned.logPath);
        const inits = calls.filter((c) => c.argv[1] === 'init');
        expect(inits.length).toBe(1);
        expect(inits[0]?.exit).toBe(128);
        expect(inits[0]?.argv[3]?.startsWith(`${fetchRoot}/`)).toBe(true);
        expect(inits[0]?.stderr).toContain('Permission denied');
        // RED: desired contract — currently exit 5 (the MF2B bug).
        expect(r.code).toBe(6);
      } finally {
        await chmod(fetchRoot, 0o755);
      }
    } finally {
      await destroyFixtureFleet(fleet);
      await rm(owned.root, { recursive: true, force: true });
    }
  });

  test('public CLI RED (JSON): denied .fetch parent exits 6 with a failed result', async () => {
    const fleet = await buildFixtureFleet();
    const owned = await buildOwnedRoot();
    try {
      const fetchRoot = join(fleet.data, '.fetch');
      await mkdir(fetchRoot, { recursive: true });
      await chmod(fetchRoot, 0o555);
      try {
        expect(await probeDeny(fetchRoot)).toBe('EACCES');
        const r = await runCli(
          [
            'install',
            `${remote.singleSource}${SINGLE_SKILL}`,
            '--tool',
            'claude-code',
            '--no-verify',
            '--user',
            '--no-prompt',
            '--json',
          ],
          cliEnvFor(fleet, owned),
          fleet.base,
        );
        expect(r.code).not.toBe(0);
        const report = JSON.parse(r.stdout) as {
          results: Array<{ action: string; reason: string; skill: null; placement: null }>;
        };
        expect(report.results.length).toBe(1);
        expect(report.results[0]?.action).toBe('failed');
        expect(report.results[0]?.reason).toContain('permission denied');
        expect(report.results[0]?.skill).toBeNull();
        // RED: desired contract — currently exit 5 (the MF2B bug).
        expect(r.code).toBe(6);
      } finally {
        await chmod(fetchRoot, 0o755);
      }
    } finally {
      await destroyFixtureFleet(fleet);
      await rm(owned.root, { recursive: true, force: true });
    }
  });

  test('control: invalid ref stays exit 5 (source-unresolvable, not permission)', async () => {
    const fleet = await buildFixtureFleet();
    const owned = await buildOwnedRoot();
    try {
      const r = await runCli(
        [
          'install',
          `${remote.singleSource}${SINGLE_SKILL}`,
          '--tool',
          'claude-code',
          '--no-verify',
          '--user',
          '--no-prompt',
          '--ref',
          'does-not-exist-xyz',
        ],
        cliEnvFor(fleet, owned),
        fleet.base,
      );
      expect(r.code).toBe(5);
      expect(`${r.stdout}\n${r.stderr}`).not.toContain('Permission denied');
    } finally {
      await destroyFixtureFleet(fleet);
      await rm(owned.root, { recursive: true, force: true });
    }
  });

  test('control: unreachable owned source stays exit 5', async () => {
    const fleet = await buildFixtureFleet();
    const owned = await buildOwnedRoot([
      [
        'https://fixture.invalid/acme/missing.git',
        `file://${join(tmpdir(), 'mf2b-owned-absent')}/missing.git`,
      ],
    ]);
    try {
      const r = await runCli(
        [
          'install',
          'https://fixture.invalid/acme/missing.git',
          '--tool',
          'claude-code',
          '--no-verify',
          '--user',
          '--no-prompt',
        ],
        cliEnvFor(fleet, owned),
        fleet.base,
      );
      expect(r.code).toBe(5);
      expect(`${r.stdout}\n${r.stderr}`).not.toContain('Permission denied');
    } finally {
      await destroyFixtureFleet(fleet);
      await rm(owned.root, { recursive: true, force: true });
    }
  });

  test('control: file collision at the init destination stays source-unresolvable', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'mf2b-core-'));
    try {
      const collidePath = join(scratch, 'collide-file');
      await writeFile(collidePath, 'x');
      const res = await fetchRepo(coreEnv, {
        cloneUrl: remote.multiUrl,
        ref: null,
        fetchDir: collidePath,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // Same exit 128 as the permission denial, but a nonpermission cause:
      // exit code alone must never become the permission discriminator.
      expect(res.error.code).toBe('source-unresolvable');
      expect(errorMessage(res.error)).toContain('File exists');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('negative control: misleading permission phrase on a nonpermission error stays source-unresolvable', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'mf2b-core-'));
    try {
      const res = await fetchRepo(
        {
          git: {
            ...coreEnv.git,
            initializeFetch: async () => {
              throw toPortError('remote authentication refused', {
                capability: 'git',
                operation: 'initializeFetch',
                code: 'unavailable',
                message: 'git init failed: Permission denied (publickey) — remote auth refused',
                context: { repositoryRoot: join(scratch, 'tx') },
              });
            },
          },
        },
        { cloneUrl: remote.multiUrl, ref: null, fetchDir: join(scratch, 'tx') },
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // Synthetic only (never a kernel-denial RED): naive stderr substring
      // matching would misclassify this remote-shaped failure as permission.
      expect(res.error.code).toBe('source-unresolvable');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('GREEN preservation: typed EACCES from init stays permission-denied', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'mf2b-core-'));
    try {
      const res = await fetchRepo(
        {
          git: {
            ...coreEnv.git,
            initializeFetch: async () => {
              throw Object.assign(new Error('synthetic typed denial'), { code: 'EACCES' });
            },
          },
        },
        { cloneUrl: remote.multiUrl, ref: null, fetchDir: join(scratch, 'tx') },
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // Separate already-correct path (fetch.ts sourceFailure); not the RED proof.
      expect(res.error.code).toBe('permission-denied');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
