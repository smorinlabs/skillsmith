import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { statfsSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillSmithError } from '@skillsmith/core';
import { getLedgerPairAt, readLedgerState } from '../../../core/src/place/ledger.ts';
import { ledgerPathOf } from '../../../core/src/place/paths.ts';
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
import { InstallJsonSchema } from '../../src/output/install-json.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

// SC-I60-R3: a force replacement that preserves an edited direct copy must report the kept backup
// (and its real path) through the existing result reason — over the real public CLI, JSON and
// human, on both the canonical desired-state route and --no-save. Ordinary coverage: no E2E gate,
// no crash/pause seams. Every test owns its HOME/XDG/data/cwd, its global Git rewrite, its tool
// dir, and its placement roots; the child CLI resolves/fetches/materializes through real Git.
setDefaultTimeout(60_000);

const SKILL = 'factor-scan';
const TOOL = 'claude-code';

const BUN = Bun.which('bun');
if (BUN === null) throw new Error('bun must be on PATH to spawn the source CLI');
const GIT = Bun.which('git');
if (GIT === null) throw new Error('git must be on PATH for the fixture-owned tool dir');

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface CliCtx {
  cwd: string;
  gitconfig: string;
  overrides: Record<string, string | undefined>;
}

const runCli = async (
  ctx: CliCtx,
  args: readonly string[],
  executable: readonly string[],
): Promise<CliResult> => {
  const proc = Bun.spawn([...executable, ...args], {
    cwd: ctx.cwd,
    env: hermeticGitEnv(ctx.overrides, { globalConfigPath: ctx.gitconfig }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, code };
  } finally {
    proc.kill();
    await proc.exited;
  }
};

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

/** Fails with the full process transcript, not just a bare exit-code mismatch. */
const requireExit = (r: CliResult, expected: number, label: string): void => {
  if (r.code !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
};

let remote: RemoteFixture;
let nativeRoot = '';
let compiledBinary = '';

// The bounded compiled-CLI control needs room for the ~100MB native binary plus fixture churn.
// When the scratch filesystem cannot fit it, only that control skips (disclosed); the six source
// CLI tests still run. Native/hosted acceptance remains a later gate.
const NATIVE_MIN_FREE_BYTES = 300 * 1024 * 1024;
const nativeCompileSupported = (): boolean => {
  try {
    const s = statfsSync(tmpdir());
    return s.bavail * s.bsize >= NATIVE_MIN_FREE_BYTES;
  } catch {
    return false;
  }
};
const NATIVE_ENABLED = nativeCompileSupported();

beforeAll(async () => {
  remote = await buildRemoteFixture();
  if (!NATIVE_ENABLED) return;
  // Bounded compiled-CLI recurrence control uses the existing native-build recipe.
  nativeRoot = await mkdtemp(join(tmpdir(), 'skillsmith-preserved-backup-'));
  compiledBinary = join(nativeRoot, 'skillsmith');
  const compile = Bun.spawn(
    [BUN, 'build', '--compile', '--bytecode', CLI_ENTRYPOINT, '--outfile', compiledBinary],
    { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`native compile failed: ${stdout}\n${stderr}`);
}, 180_000);

afterAll(async () => {
  await destroyRemoteFixture(remote);
  if (nativeRoot) await rm(nativeRoot, { recursive: true, force: true });
});

let f: FixtureFleet;
let ctx: CliCtx;
let fsSource: string;
let skillsRoot: string;
let liveDir: string;
let liveSkillFile: string;
let sourceExe: readonly string[];

beforeEach(async () => {
  f = await buildFixtureFleet();
  fsSource = `${remote.multiSource}//plugins/fh/skills/factor-scan`;
  skillsRoot = join(f.home, '.claude', 'skills');
  liveDir = join(skillsRoot, SKILL);
  liveSkillFile = join(liveDir, 'SKILL.md');
  sourceExe = [BUN, CLI_ENTRYPOINT];

  // Fixture-owned global Git config: the accepted fixture-only HTTPS origins rewrite to owned
  // local bare repositories, with file transport permitted only in this owned config. Production
  // Git sanitization strips GIT_CONFIG_COUNT, so the rewrite lives here, not in env vars.
  const gitconfig = join(f.base, 'gitconfig-owned');
  await writeFile(
    gitconfig,
    [
      `[url "${remote.multiUrl}"]`,
      `\tinsteadOf = ${remote.multiSource}`,
      `[url "${remote.singleUrl}"]`,
      `\tinsteadOf = ${remote.singleSource}`,
      `[url "${remote.rootUrl}"]`,
      `\tinsteadOf = ${remote.rootSource}`,
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );

  // Fixture-owned tool dir: a version-query-only `claude` fixture plus the released git/bun.
  const bin = join(f.base, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'claude'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.0.0-fixture"; exit 0; fi\necho "fixture claude: only --version is supported" >&2\nexit 1\n',
  );
  await chmod(join(bin, 'claude'), 0o755);
  await symlink(GIT, join(bin, 'git'));
  await symlink(BUN, join(bin, 'bun'));

  const cwd = join(f.base, 'cwd');
  await mkdir(cwd, { recursive: true });
  ctx = {
    cwd,
    gitconfig,
    overrides: {
      HOME: f.home,
      XDG_DATA_HOME: join(f.home, '.local', 'share'),
      XDG_CONFIG_HOME: join(f.home, '.config'),
      XDG_CACHE_HOME: join(f.home, '.cache'),
      SKILLSMITH_HOME: f.data,
      PATH: bin,
    },
  };
});

afterEach(async () => {
  await destroyFixtureFleet(f);
});

const addedEntries = (before: readonly string[], after: readonly string[]): string[] => {
  const seen = new Set(before);
  return after.filter((name) => !seen.has(name));
};

const ledgerPair = async () => {
  const r = await readLedgerState(f.env, ledgerPathOf(f.data));
  if (!r.ok) throw new Error(msg(r.error));
  if (r.value.state !== 'present') throw new Error('expected persisted ledger');
  const pair = getLedgerPairAt(r.value.model, null, SKILL, TOOL);
  if (pair === null) throw new Error('expected a ledger pair for the installed skill');
  return pair;
};

const seedDirectCopy = async (
  extraArgs: readonly string[],
  executable: readonly string[],
): Promise<{ storeSkillFile: string; originalBytes: string }> => {
  const seed = await runCli(
    ctx,
    [
      '--no-prompt',
      'install',
      fsSource,
      '--tool',
      TOOL,
      '--no-verify',
      '--user',
      '--direct',
      '--json',
      ...extraArgs,
    ],
    executable,
  );
  requireExit(seed, 0, 'seed install');
  const report = InstallJsonSchema.parse(JSON.parse(seed.stdout));
  expect(report.saveMode).toBe(extraArgs.includes('--no-save') ? 'live-only' : 'desired-state');
  expect(report.summary.installed).toBe(1);
  expect(report.results).toHaveLength(1);
  const installed = report.results[0];
  if (installed === undefined) throw new Error('seed install produced no result');
  expect(installed).toMatchObject({
    skill: SKILL,
    tool: TOOL,
    scope: 'user',
    action: 'installed',
    placement: 'copy',
    placementPath: liveDir,
  });
  expect(installed.origin?.refResolved).toBe(remote.multiHead);
  if (installed.store === null) throw new Error('seed install recorded no store entry');
  expect(installed.store.reused).toBe(false);
  expect(await f.env.pathKind(liveDir)).toBe('dir');
  const storeSkillFile = join(installed.store.path, 'SKILL.md');
  const originalBytes = await readFile(storeSkillFile, 'utf8');
  expect(await readFile(liveSkillFile, 'utf8')).toBe(originalBytes);
  const pair = await ledgerPair();
  expect(pair.pinned?.placement).toBe('copy');
  expect(pair.journal).toBeNull();
  return { storeSkillFile, originalBytes };
};

describe('install preserved-backup notice (SC-I60-R3)', () => {
  test('JSON + desired-state: edited direct-copy → symlink force replacement reports the kept backup', async () => {
    const { storeSkillFile, originalBytes } = await seedDirectCopy([], sourceExe);
    const before = await f.env.listDir(skillsRoot);

    await appendFile(liveSkillFile, '\nSC-I60-R3 CLI edited-copy marker (direct-to-symlink)\n');
    const editedBytes = await readFile(liveSkillFile, 'utf8');
    expect(editedBytes).not.toBe(originalBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    const r = await runCli(
      ctx,
      [
        '--no-prompt',
        'install',
        fsSource,
        '--tool',
        TOOL,
        '--no-verify',
        '--user',
        '--force',
        '--json',
      ],
      sourceExe,
    );
    requireExit(r, 0, 'force replace');
    const report = InstallJsonSchema.parse(JSON.parse(r.stdout));
    expect(report.saveMode).toBe('desired-state');
    expect(report.summary.updated).toBe(1);
    expect(report.results).toHaveLength(1);
    const result = report.results[0];
    if (result === undefined) throw new Error('force replace produced no result');
    expect(result).toMatchObject({
      skill: SKILL,
      tool: TOOL,
      scope: 'user',
      action: 'updated',
      placement: 'symlink',
      placementPath: liveDir,
    });
    expect(result.origin?.refResolved).toBe(remote.multiHead);
    expect(result.store?.reused).toBe(true);
    expect(result.executionOutcome).toBe('succeeded');
    expect(result.drift.status).toBe('in-sync');
    expect(await f.env.pathKind(liveDir)).toBe('symlink');
    expect(await readFile(liveSkillFile, 'utf8')).toBe(originalBytes);
    const pair = await ledgerPair();
    expect(pair.pinned?.placement).toBe('symlink');
    expect(pair.journal).toBeNull();

    const added = addedEntries(before, await f.env.listDir(skillsRoot));
    expect(added).toHaveLength(1);
    const backupName = added[0];
    if (backupName === undefined) throw new Error('expected one retained backup entry');
    expect(backupName.startsWith(`.skillsmith-backup-${SKILL}-`)).toBe(true);
    const backupPath = join(skillsRoot, backupName);
    expect(await f.env.pathKind(backupPath)).toBe('dir');
    expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(editedBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    expect(result.reason).not.toBeNull();
    expect(result.reason ?? '').toContain('kept backup');
    expect(result.reason ?? '').toContain(backupPath);
  });

  test('JSON + desired-state: edited direct-copy → copy force replacement reports the first-stage backup', async () => {
    const { storeSkillFile, originalBytes } = await seedDirectCopy([], sourceExe);
    const before = await f.env.listDir(skillsRoot);

    await appendFile(liveSkillFile, '\nSC-I60-R3 CLI edited-copy marker (direct-to-copy)\n');
    const editedBytes = await readFile(liveSkillFile, 'utf8');
    expect(editedBytes).not.toBe(originalBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    const r = await runCli(
      ctx,
      [
        '--no-prompt',
        'install',
        fsSource,
        '--tool',
        TOOL,
        '--no-verify',
        '--user',
        '--direct',
        '--force',
        '--json',
      ],
      sourceExe,
    );
    requireExit(r, 0, 'force replace');
    const report = InstallJsonSchema.parse(JSON.parse(r.stdout));
    expect(report.saveMode).toBe('desired-state');
    expect(report.summary.updated).toBe(1);
    expect(report.results).toHaveLength(1);
    const result = report.results[0];
    if (result === undefined) throw new Error('force replace produced no result');
    expect(result).toMatchObject({
      skill: SKILL,
      tool: TOOL,
      scope: 'user',
      action: 'updated',
      placement: 'copy',
      placementPath: liveDir,
    });
    expect(result.origin?.refResolved).toBe(remote.multiHead);
    expect(result.store?.reused).toBe(true);
    expect(await f.env.pathKind(liveDir)).toBe('dir');
    expect(await readFile(liveSkillFile, 'utf8')).toBe(originalBytes);
    const pair = await ledgerPair();
    expect(pair.pinned?.placement).toBe('copy');
    expect(pair.journal).toBeNull();

    const added = addedEntries(before, await f.env.listDir(skillsRoot));
    expect(added).toHaveLength(1);
    const backupName = added[0];
    if (backupName === undefined) throw new Error('expected one retained backup entry');
    expect(backupName.startsWith(`.skillsmith-backup-${SKILL}-`)).toBe(true);
    const backupPath = join(skillsRoot, backupName);
    expect(await f.env.pathKind(backupPath)).toBe('dir');
    expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(editedBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    expect(result.reason).not.toBeNull();
    expect(result.reason ?? '').toContain('kept backup');
    expect(result.reason ?? '').toContain(backupPath);
  });

  test('JSON + --no-save: edited direct-copy → copy force replacement reports the kept backup', async () => {
    const { storeSkillFile, originalBytes } = await seedDirectCopy(['--no-save'], sourceExe);
    const before = await f.env.listDir(skillsRoot);

    await appendFile(liveSkillFile, '\nSC-I60-R3 CLI edited-copy marker (no-save)\n');
    const editedBytes = await readFile(liveSkillFile, 'utf8');
    expect(editedBytes).not.toBe(originalBytes);

    const r = await runCli(
      ctx,
      [
        '--no-prompt',
        'install',
        fsSource,
        '--tool',
        TOOL,
        '--no-verify',
        '--user',
        '--direct',
        '--force',
        '--no-save',
        '--json',
      ],
      sourceExe,
    );
    requireExit(r, 0, 'force replace');
    const report = InstallJsonSchema.parse(JSON.parse(r.stdout));
    expect(report.saveMode).toBe('live-only');
    expect(report.summary.updated).toBe(1);
    expect(report.results).toHaveLength(1);
    const result = report.results[0];
    if (result === undefined) throw new Error('force replace produced no result');
    expect(result).toMatchObject({
      skill: SKILL,
      tool: TOOL,
      scope: 'user',
      action: 'updated',
      placement: 'copy',
      placementPath: liveDir,
    });
    expect(await f.env.pathKind(liveDir)).toBe('dir');
    expect(await readFile(liveSkillFile, 'utf8')).toBe(originalBytes);

    const added = addedEntries(before, await f.env.listDir(skillsRoot));
    expect(added).toHaveLength(1);
    const backupName = added[0];
    if (backupName === undefined) throw new Error('expected one retained backup entry');
    const backupPath = join(skillsRoot, backupName);
    expect(await f.env.pathKind(backupPath)).toBe('dir');
    expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(editedBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    expect(result.reason).not.toBeNull();
    expect(result.reason ?? '').toContain('kept backup');
    expect(result.reason ?? '').toContain(backupPath);
  });

  test('JSON + desired-state: untouched direct-copy → copy force replacement claims no kept backup', async () => {
    await seedDirectCopy([], sourceExe);
    const before = await f.env.listDir(skillsRoot);

    const r = await runCli(
      ctx,
      [
        '--no-prompt',
        'install',
        fsSource,
        '--tool',
        TOOL,
        '--no-verify',
        '--user',
        '--direct',
        '--force',
        '--json',
      ],
      sourceExe,
    );
    requireExit(r, 0, 'force replace');
    const report = InstallJsonSchema.parse(JSON.parse(r.stdout));
    expect(report.summary.updated).toBe(1);
    const result = report.results[0];
    if (result === undefined) throw new Error('force replace produced no result');
    expect(result.action).toBe('updated');
    expect(result.placement).toBe('copy');
    expect(await f.env.pathKind(liveDir)).toBe('dir');
    expect(addedEntries(before, await f.env.listDir(skillsRoot))).toEqual([]);
    expect(result.reason ?? '').not.toContain('kept backup');
  });

  test('human + desired-state: edited direct-copy → symlink force replacement prints the kept backup', async () => {
    const { storeSkillFile, originalBytes } = await seedDirectCopy([], sourceExe);
    const before = await f.env.listDir(skillsRoot);

    await appendFile(liveSkillFile, '\nSC-I60-R3 CLI edited-copy marker (human symlink)\n');
    const editedBytes = await readFile(liveSkillFile, 'utf8');
    expect(editedBytes).not.toBe(originalBytes);

    const r = await runCli(
      ctx,
      ['--no-prompt', 'install', fsSource, '--tool', TOOL, '--no-verify', '--user', '--force'],
      sourceExe,
    );
    requireExit(r, 0, 'force replace');
    expect(r.stdout).toContain('1 updated');
    expect(await f.env.pathKind(liveDir)).toBe('symlink');

    const added = addedEntries(before, await f.env.listDir(skillsRoot));
    expect(added).toHaveLength(1);
    const backupName = added[0];
    if (backupName === undefined) throw new Error('expected one retained backup entry');
    const backupPath = join(skillsRoot, backupName);
    expect(await f.env.pathKind(backupPath)).toBe('dir');
    expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(editedBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    expect(r.stdout).toContain('kept backup');
    expect(r.stdout).toContain(backupPath);
  });

  test('human + --no-save: edited direct-copy → copy force replacement prints the kept backup', async () => {
    const { storeSkillFile, originalBytes } = await seedDirectCopy(['--no-save'], sourceExe);
    const before = await f.env.listDir(skillsRoot);

    await appendFile(liveSkillFile, '\nSC-I60-R3 CLI edited-copy marker (human no-save)\n');
    const editedBytes = await readFile(liveSkillFile, 'utf8');
    expect(editedBytes).not.toBe(originalBytes);

    const r = await runCli(
      ctx,
      [
        '--no-prompt',
        'install',
        fsSource,
        '--tool',
        TOOL,
        '--no-verify',
        '--user',
        '--direct',
        '--force',
        '--no-save',
      ],
      sourceExe,
    );
    requireExit(r, 0, 'force replace');
    expect(r.stdout).toContain('1 updated');
    expect(r.stdout).toContain('not inspected or changed (--no-save)');
    expect(await f.env.pathKind(liveDir)).toBe('dir');

    const added = addedEntries(before, await f.env.listDir(skillsRoot));
    expect(added).toHaveLength(1);
    const backupName = added[0];
    if (backupName === undefined) throw new Error('expected one retained backup entry');
    const backupPath = join(skillsRoot, backupName);
    expect(await f.env.pathKind(backupPath)).toBe('dir');
    expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(editedBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    expect(r.stdout).toContain('kept backup');
    expect(r.stdout).toContain(backupPath);
  });

  test.skipIf(!NATIVE_ENABLED)(
    'compiled CLI + desired-state: edited direct-copy → copy force replacement reports the kept backup',
    async () => {
      const { storeSkillFile, originalBytes } = await seedDirectCopy([], [compiledBinary]);
      const before = await f.env.listDir(skillsRoot);

      await appendFile(liveSkillFile, '\nSC-I60-R3 CLI edited-copy marker (compiled)\n');
      const editedBytes = await readFile(liveSkillFile, 'utf8');
      expect(editedBytes).not.toBe(originalBytes);

      const r = await runCli(
        ctx,
        [
          '--no-prompt',
          'install',
          fsSource,
          '--tool',
          TOOL,
          '--no-verify',
          '--user',
          '--direct',
          '--force',
          '--json',
        ],
        [compiledBinary],
      );
      requireExit(r, 0, 'force replace');
      const report = InstallJsonSchema.parse(JSON.parse(r.stdout));
      expect(report.saveMode).toBe('desired-state');
      expect(report.summary.updated).toBe(1);
      const result = report.results[0];
      if (result === undefined) throw new Error('force replace produced no result');
      expect(result.action).toBe('updated');
      expect(result.placement).toBe('copy');

      const added = addedEntries(before, await f.env.listDir(skillsRoot));
      expect(added).toHaveLength(1);
      const backupName = added[0];
      if (backupName === undefined) throw new Error('expected one retained backup entry');
      const backupPath = join(skillsRoot, backupName);
      expect(await f.env.pathKind(backupPath)).toBe('dir');
      expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(editedBytes);
      expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

      expect(result.reason).not.toBeNull();
      expect(result.reason ?? '').toContain('kept backup');
      expect(result.reason ?? '').toContain(backupPath);
    },
  );
});
