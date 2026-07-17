import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../packages/core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

type UnknownRecord = Record<string, unknown>;

interface CliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let remote: RemoteFixture;

beforeAll(async () => {
  remote = await buildRemoteFixture();
});

afterAll(async () => {
  if (remote !== undefined) await destroyRemoteFixture(remote);
});

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const pathKind = async (path: string): Promise<'absent' | 'file' | 'directory' | 'symlink'> => {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    return 'file';
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return 'absent';
    throw error;
  }
};

const runCli = async (
  cwd: string,
  env: Record<string, string | undefined>,
  args: readonly string[],
): Promise<CliProduct> => {
  const childEnv = hermeticGitEnv({ ...env, CI: '1', NO_COLOR: '1' });
  childEnv.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: childEnv,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

const requireJson = (product: CliProduct, label: string): UnknownRecord => {
  expect(product.exitCode, `${label}: ${product.stderr}`).toBe(0);
  let parsed: unknown;
  try {
    parsed = JSON.parse(product.stdout);
  } catch {
    throw new Error(
      `${label}: stdout was not JSON\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${label}: JSON report was not an object`);
  return parsed;
};

const requireNoSaveReport = (
  report: UnknownRecord,
  kind: 'skillsmith.install' | 'skillsmith.uninstall',
): readonly UnknownRecord[] => {
  expect(report).toMatchObject({
    schemaVersion: 2,
    kind,
    saveMode: 'live-only',
    artifactPair: null,
    artifactSelection: { outcome: 'none', reason: 'no-save' },
  });
  for (const effect of records(report.artifactEffects)) {
    expect(effect).toMatchObject({ manifestAction: 'not-write', lockAction: 'not-write' });
  }
  const results = records(report.results);
  expect(results).not.toHaveLength(0);
  for (const result of results) {
    expect(result.drift).toMatchObject({
      status: 'not-evaluated',
      futureApply: 'depends-on-selected-manifest',
    });
  }
  return results;
};

describe('EWP-WF02', () => {
  test('temporary no-save install, status, noop reinstall, and uninstall stay live-only and retain the store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-wf02-'));
    const home = join(root, 'home');
    const config = join(root, 'config');
    const data = join(root, 'data');
    const cwd = join(root, 'workspace');
    const manifestPath = join(config, 'skillsmith', 'skillsmith.toml');
    const lockPath = join(config, 'skillsmith', 'skillsmith.lock');
    const ledgerPath = join(data, 'placements.json');
    const livePath = join(home, '.claude', 'skills', 'factor-scan');
    const gitConfig = join(root, 'gitconfig');
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(join(config, 'skillsmith'), { recursive: true }),
      mkdir(data, { recursive: true }),
      mkdir(cwd, { recursive: true }),
      writeFile(
        gitConfig,
        `[url "${remote.multiUrl}"]\n\tinsteadOf = ${remote.multiSource}\n[protocol "file"]\n\tallow = always\n`,
      ),
    ]);
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      SKILLSMITH_HOME: data,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_ALLOW_PROTOCOL: 'file:https',
    };
    const source = `${remote.multiSource}//plugins/fh/skills/factor-scan`;
    const install = [
      'install',
      source,
      '--tool',
      'claude-code',
      '--user',
      '--no-save',
      '--no-verify',
      '--json',
    ] as const;

    try {
      expect(
        await Promise.all(
          [manifestPath, lockPath, ledgerPath, livePath].map((path) => pathKind(path)),
        ),
        'temporary workflow starts without portable, ledger, or live state',
      ).toEqual(['absent', 'absent', 'absent', 'absent']);
      expect(await readFile(gitConfig, 'utf8'), 'remote rewrite stays sandbox-local').toContain(
        remote.multiUrl,
      );
      const first = requireJson(await runCli(cwd, env, install), 'first no-save install');
      const firstResults = requireNoSaveReport(first, 'skillsmith.install');
      expect(firstResults).toHaveLength(1);
      expect(firstResults[0]).toMatchObject({
        skill: 'factor-scan',
        tool: 'claude-code',
        scope: 'user',
        action: 'installed',
      });
      expect(await pathKind(manifestPath)).toBe('absent');
      expect(await pathKind(lockPath)).toBe('absent');
      const store = firstResults[0]?.store;
      if (!isRecord(store) || typeof store.path !== 'string') {
        throw new Error('first install did not report its retained store path');
      }
      const storePath = store.path;
      const placementPath = firstResults[0]?.placementPath;
      if (typeof placementPath !== 'string') {
        throw new Error('first install did not report its live placement path');
      }
      expect(await pathKind(storePath)).toBe('directory');
      expect(await pathKind(placementPath)).toBe('symlink');

      const status = requireJson(
        await runCli(cwd, env, ['status', 'factor-scan', '--json']),
        'status after no-save install',
      );
      expect(status).toMatchObject({ schemaVersion: 1, kind: 'skillsmith.status' });
      const entry = records(status.entries).find((candidate) => candidate.name === 'factor-scan');
      if (entry === undefined) throw new Error('status omitted the installed no-save skill');
      expect(entry.desired).toEqual({ state: 'absent' });
      expect(entry.locked).toEqual({ state: 'absent' });
      expect(entry.convergence).toBe('drift');
      const placement = records(entry.placements).find((candidate) => {
        const identity = candidate.identity;
        return isRecord(identity) && identity.tool === 'claude-code' && identity.scope === 'user';
      });
      if (placement === undefined) throw new Error('status omitted the managed-local placement');
      expect(placement).toMatchObject({
        ledger: { state: 'present' },
        live: { state: 'present' },
        classification: 'pinned',
      });
      const factCodes = [...records(entry.facts), ...records(placement.facts)].map(
        (fact) => fact.code,
      );
      expect(factCodes).toContain('live-only');
      expect(factCodes).toContain('live-undeclared');
      expect(await pathKind(manifestPath)).toBe('absent');
      expect(await pathKind(lockPath)).toBe('absent');

      const second = requireJson(await runCli(cwd, env, install), 'noop no-save reinstall');
      const secondResults = requireNoSaveReport(second, 'skillsmith.install');
      expect(secondResults).toHaveLength(1);
      expect(secondResults[0]).toMatchObject({ skill: 'factor-scan', action: 'noop' });
      expect(await pathKind(manifestPath)).toBe('absent');
      expect(await pathKind(lockPath)).toBe('absent');

      const uninstall = requireJson(
        await runCli(cwd, env, [
          'uninstall',
          'factor-scan',
          '--tool',
          'claude-code',
          '--user',
          '--no-save',
          '--json',
        ]),
        'no-save uninstall',
      );
      const uninstallResults = requireNoSaveReport(uninstall, 'skillsmith.uninstall');
      expect(uninstallResults).toHaveLength(1);
      expect(uninstallResults[0]).toMatchObject({
        skill: 'factor-scan',
        action: 'removed',
        storeRetained: storePath,
      });
      expect(await pathKind(placementPath)).toBe('absent');
      expect(await pathKind(storePath)).toBe('directory');
      expect(await pathKind(manifestPath)).toBe('absent');
      expect(await pathKind(lockPath)).toBe('absent');

      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as unknown;
      if (!isRecord(ledger) || !isRecord(ledger.skills)) {
        throw new Error('terminal ledger was not the expected object');
      }
      expect(Object.hasOwn(ledger.skills, 'factor-scan')).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
