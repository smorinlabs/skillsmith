import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { toolRegistry } from '@skillsmith/core';
import manifest from '../../../../.github/ci-agent-tools.json';
import {
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../core/tests/fixtures/acquire/remote.ts';
import { AgentsJsonSchema } from '../../src/output/agents-json.ts';
import { InstallJsonSchema } from '../../src/output/install-json.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';
import { createDetectionIsolation } from '../fixtures/detection.ts';

const checkout = resolve(import.meta.dir, '../../../..');
const manifestPath = join(checkout, '.github/ci-agent-tools.json');
const mode = process.env.SKILLSMITH_CI_AGENT_MODE ?? 'absent';
const reportPath = process.env.SKILLSMITH_CI_AGENT_REPORT_DIR;
const prefix = process.env.SKILLSMITH_CI_AGENT_PREFIX;
const roots: string[] = [];
const remotes: Awaited<ReturnType<typeof buildRemoteFixture>>[] = [];
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const inside = (parent: string, path: string): boolean => path.startsWith(parent + sep);
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};
const json = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};
const executable = async (path: string) => {
  const target = await realpath(path);
  if (!(await lstat(target)).isFile()) throw new Error(`not a regular executable: ${target}`);
  await access(target, constants.X_OK);
  return { path, realPath: target, sha256: hash(await readFile(target)) };
};
const versionMatches = (text: string, version: string): boolean =>
  new RegExp(`(?:^|[^0-9A-Za-z.])${version.replaceAll('.', '\\.')}($|[^0-9A-Za-z.])`).test(text);

interface ProcessResult {
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cleanup: { term: boolean; kill: boolean; groupGone: boolean; closed: boolean };
  stdout: string;
  stderr: string;
}
interface Workspace {
  root: string;
  cwd: string;
  bin: string;
  home: string;
  data: string;
  config: string;
  env: Record<string, string>;
  sequence: number;
  versions: Map<string, string>;
}

// A separate process group owns descendants as well as the launcher. A launcher exit does
// not end the deadline while an inherited output pipe or another group member remains.
const run = async (workspace: Workspace, label: string, argv: string[]): Promise<ProcessResult> => {
  const startedAt = new Date().toISOString();
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: workspace.cwd,
    env: workspace.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let closed = false;
  let spawnError: Error | undefined;
  const completed = new Promise<void>((resolveDone) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', () => {
      closed = true;
      resolveDone();
    });
  });
  const alive = (): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const waitUntil = async (milliseconds: number): Promise<boolean> => {
    const end = Date.now() + milliseconds;
    while ((!closed || alive()) && Date.now() < end) await Bun.sleep(25);
    return closed && !alive();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = await Promise.race([
    completed.then(() => false),
    new Promise<boolean>((resolveTimer) => {
      timer = setTimeout(() => resolveTimer(true), 30_000);
    }),
  ]);
  clearTimeout(timer);
  const cleanup = { term: false, kill: false, groupGone: false, closed };
  if (expired || alive()) {
    if (alive() && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM');
      cleanup.term = true;
    }
    if (!(await waitUntil(10_000))) {
      if (alive() && child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL');
        cleanup.kill = true;
      }
      await waitUntil(5_000);
    }
  }
  cleanup.closed = closed;
  cleanup.groupGone = !alive();
  if (!closed) {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  const result: ProcessResult = {
    argv,
    exitCode: child.exitCode,
    signal: child.signalCode,
    timedOut: expired,
    cleanup,
    stdout,
    stderr,
  };
  const stem = join(workspace.root, `${++workspace.sequence}-${label}`);
  await writeFile(`${stem}.stdout`, stdout, { flag: 'wx' });
  await writeFile(`${stem}.stderr`, stderr, { flag: 'wx' });
  await json(`${stem}.json`, {
    ...result,
    startedAt,
    endedAt: new Date().toISOString(),
    cwd: workspace.cwd,
    environment: workspace.env,
    stdoutPath: `${stem}.stdout`,
    stderrPath: `${stem}.stderr`,
    stdoutSha256: hash(stdout),
    stderrSha256: hash(stderr),
    spawnError: spawnError?.message ?? null,
  });
  if (spawnError) throw spawnError;
  if (expired || !cleanup.groupGone || !closed || cleanup.term) {
    throw new Error(`child deadline/cleanup failure: ${label}; see ${stem}.json`);
  }
  return result;
};

interface PackageReceipt {
  id: string;
  binary: string;
  package: string;
  version: string;
  packageJsonPath: string;
  packageJsonSha256: string;
  bindingPath: string;
  realPath: string;
  sha256: string;
  versionStdout: string;
  versionStderr: string;
  versionFirstLine: string;
}

const validatePrefix = async (): Promise<PackageReceipt[]> => {
  const missing = [];
  for (const tool of manifest.tools) {
    if (!prefix || !isAbsolute(prefix) || !(await exists(join(prefix, 'bin', tool.binary)))) {
      missing.push(tool.binary);
    }
  }
  if (missing.length > 0)
    throw new Error(`present preparation failed: missing tools: ${missing.join(', ')}`);
  if (
    !prefix ||
    resolve(prefix) !== prefix ||
    (await realpath(prefix)) !== prefix ||
    !prefix.endsWith('/prefix')
  ) {
    throw new Error(
      'present preparation failed: prefix must be a canonical owned installer prefix',
    );
  }
  const root = dirname(prefix);
  const receiptPath = join(root, 'receipt.json');
  if (!(await lstat(receiptPath)).isFile())
    throw new Error('installer receipt must be a regular file');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
    schemaVersion: number;
    status: string;
    root: string;
    prefix: string;
    manifestSha256: string;
    packages: PackageReceipt[];
  };
  expect(receipt.schemaVersion).toBe(1);
  expect(receipt.status).toBe('success');
  expect(receipt.root).toBe(root);
  expect(receipt.prefix).toBe(prefix);
  expect(receipt.manifestSha256).toBe(hash(await readFile(manifestPath)));
  expect(receipt.packages.map((item) => item.id).sort()).toEqual([...toolRegistry.ids].sort());
  for (const tool of manifest.tools) {
    const item = receipt.packages.find((candidate) => candidate.id === tool.id);
    if (!item) throw new Error(`missing installer receipt row: ${tool.id}`);
    expect({
      id: item.id,
      binary: item.binary,
      package: item.package,
      version: item.version,
    }).toEqual(tool);
    const binding = await executable(join(prefix, 'bin', tool.binary));
    expect(inside(prefix, binding.realPath)).toBe(true);
    expect(item.bindingPath).toBe(binding.path);
    expect(item.realPath).toBe(binding.realPath);
    expect(item.sha256).toBe(binding.sha256);
    const packageJson = join(prefix, 'lib/node_modules', tool.package, 'package.json');
    expect(item.packageJsonPath).toBe(packageJson);
    expect(inside(prefix, await realpath(packageJson))).toBe(true);
    const bytes = await readFile(packageJson);
    expect(item.packageJsonSha256).toBe(hash(bytes));
    expect(JSON.parse(bytes.toString())).toMatchObject({
      name: tool.package,
      version: tool.version,
    });
    expect(versionMatches(item.versionStdout, tool.version)).toBe(true);
    expect(item.versionFirstLine).toBe(item.versionStdout.trim().split(/\r?\n/)[0] ?? '');
  }
  return receipt.packages;
};

beforeAll(async () => {
  if (mode !== 'absent' && mode !== 'present')
    throw new Error(`invalid agent environment mode: ${mode}`);
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.tools.map((tool) => tool.id).sort()).toEqual([...toolRegistry.ids].sort());
  expect(new Set(manifest.tools.map((tool) => tool.binary)).size).toBe(4);
  if (reportPath !== undefined) {
    if (
      !isAbsolute(reportPath) ||
      resolve(reportPath) !== reportPath ||
      (await realpath(reportPath)) !== reportPath
    ) {
      throw new Error('report directory must be an absolute canonical empty directory');
    }
    if (!(await lstat(reportPath)).isDirectory() || (await readdir(reportPath)).length !== 0) {
      throw new Error('report directory must be an empty owned directory');
    }
  }
  if (mode === 'present') await validatePrefix();
});

afterAll(async () => {
  for (const remote of remotes) await destroyRemoteFixture(remote);
  if (!reportPath) for (const root of roots) await rm(root, { recursive: true, force: true });
});

const workspace = async (label: string): Promise<Workspace> => {
  const root = await mkdtemp(join(reportPath ?? tmpdir(), `skillsmith-agent-${label}-`));
  roots.push(root);
  const cwd = join(root, 'repository');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const data = join(root, 'data');
  for (const path of [cwd, bin, home, config, data, join(root, 'cache'), join(root, 'tmp')]) {
    await mkdir(path);
  }
  const gitConfig = join(root, 'gitconfig');
  await writeFile(gitConfig, '');
  const env: Record<string, string> = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: join(root, 'cache'),
    SKILLSMITH_HOME: join(data, 'skillsmith'),
    TMPDIR: join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: '1',
    NO_COLOR: '1',
  };
  const value: Workspace = {
    root,
    cwd,
    bin,
    home,
    config,
    data: env.SKILLSMITH_HOME as string,
    env,
    sequence: 0,
    versions: new Map(),
  };
  for (const name of ['git', 'node']) {
    const found = Bun.which(name);
    if (!found) throw new Error(`required fixture executable missing: ${name}`);
    const binding = await executable(found);
    await symlink(binding.realPath, join(bin, name));
    const observed = await run(value, `${name}-version`, [join(bin, name), '--version']);
    expect(observed.exitCode).toBe(0);
    await json(join(root, `${name}-binding.json`), { ...binding, version: observed.stdout.trim() });
  }
  if (mode === 'present') {
    const packages = await validatePrefix();
    for (const tool of manifest.tools) {
      const item = packages.find((candidate) => candidate.id === tool.id);
      if (!item) throw new Error(`missing package ${tool.id}`);
      await symlink(item.bindingPath, join(bin, tool.binary));
      const result = await run(value, `${tool.binary}-version`, [
        join(bin, tool.binary),
        '--version',
      ]);
      expect(result.exitCode).toBe(0);
      expect(versionMatches(result.stdout, tool.version)).toBe(true);
      const firstLine = result.stdout.trim().split(/\r?\n/)[0];
      if (!firstLine) throw new Error(`empty version from ${tool.binary}`);
      value.versions.set(tool.id, firstLine);
    }
  }
  await json(join(root, 'environment.json'), {
    mode,
    env,
    bun: await executable(process.execPath),
    manifestSha256: hash(await readFile(manifestPath)),
  });
  return value;
};

const product = async (value: Workspace, label: string, args: string[], discovery = false) => {
  const isolation = await createDetectionIsolation(value.root, value.env);
  const fixed = ['/opt/homebrew/bin', '/usr/local/bin'].flatMap((dir) =>
    manifest.tools.map((tool) => join(dir, tool.binary)),
  );
  for (const candidate of fixed) expect(isolation.blockedPaths).toContain(candidate);
  for (const tool of manifest.tools)
    expect(isolation.blockedPaths).not.toContain(join(value.bin, tool.binary));
  expect(await exists(isolation.trace)).toBe(false);
  const result = await run(value, label, [
    process.execPath,
    '--preload',
    isolation.preload,
    CLI_ENTRYPOINT,
    ...args,
  ]);
  const trace = (await exists(isolation.trace)) ? await readFile(isolation.trace, 'utf8') : '';
  if (discovery) for (const candidate of fixed) expect(trace).toContain(candidate);
  for (const tool of manifest.tools) expect(trace).not.toContain(join(value.bin, tool.binary));
  await json(join(isolation.preload, '..', 'receipt.json'), {
    ...isolation,
    trace,
    argv: result.argv,
  });
  return result;
};

type Agents = ReturnType<typeof AgentsJsonSchema.parse>;
const assertDiscovery = (value: Workspace, report: Agents, missing?: string): void => {
  expect(report.schemaVersion).toBe(2);
  expect(report.kind).toBe('skillsmith.agents');
  expect(report.detections.map((row) => row.tool).sort()).toEqual([...toolRegistry.ids].sort());
  expect(report.capabilities.tools.map((row) => row.id).sort()).toEqual(
    [...toolRegistry.ids].sort(),
  );
  for (const tool of manifest.tools) {
    const capabilities = report.capabilities.tools.find((row) => row.id === tool.id);
    expect(capabilities?.operations as unknown).toEqual(
      toolRegistry.get(tool.id)?.descriptor.operations,
    );
    expect(capabilities?.operations.detect.supported).toBe(true);
    expect(capabilities?.operations['inventory-skills'].supported).toBe(true);
    expect(capabilities?.operations.install.supported).toBe(
      ['claude-code', 'codex'].includes(tool.id),
    );
    expect(capabilities?.operations['verify-static'].supported).toBe(
      ['claude-code', 'codex'].includes(tool.id),
    );
    const installations = report.detections.find((row) => row.tool === tool.id)?.installations;
    if (mode !== 'present' || missing === tool.id) {
      expect(installations).toEqual([]);
      continue;
    }
    expect(installations).toHaveLength(1);
    const installation = installations?.[0];
    if (!installation) throw new Error(`missing ${tool.id} installation`);
    expect([value.versions.get(tool.id) ?? '', 'unknown']).toContain(installation.version);
    expect(installations).toEqual([
      {
        path: join(value.bin, tool.binary),
        version: installation.version,
        installMethod: 'unknown',
      },
    ]);
  }
};

test('CI-T01: four supported agents obey the owned executable environment', async () => {
  const value = await workspace('discovery');
  const discover = async (label: string): Promise<Agents> => {
    const result = await product(value, label, ['agents', '--json'], true);
    expect(result.exitCode).toBe(0);
    const report = AgentsJsonSchema.parse(JSON.parse(result.stdout));
    await json(join(value.root, `${label}-parsed.json`), report);
    return report;
  };
  const allTools = await discover('all-tools');
  assertDiscovery(value, allTools);
  if (mode === 'present') {
    const unknownVersion = structuredClone(allTools);
    const unknownKilo = unknownVersion.detections.find((row) => row.tool === 'kilo-code');
    const unknownInstallation = unknownKilo?.installations[0];
    if (!unknownInstallation)
      throw new Error('missing Kilo installation for unknown-version control');
    unknownInstallation.version = 'unknown';
    assertDiscovery(value, unknownVersion);
    const observedDirectKilo = value.versions.get('kilo-code') ?? '';
    const wrongVersion = structuredClone(allTools);
    const wrongKilo = wrongVersion.detections.find((row) => row.tool === 'kilo-code');
    const wrongInstallation = wrongKilo?.installations[0];
    if (!wrongInstallation) throw new Error('missing Kilo installation for wrong-version control');
    wrongInstallation.version = 'not-a-direct-version';
    expect(wrongInstallation.version).not.toBe(observedDirectKilo);
    expect(wrongInstallation.version).not.toBe('unknown');
    expect(() => assertDiscovery(value, wrongVersion)).toThrow();
    await json(join(value.root, 'discovery-version-controls.json'), {
      kind: 'constructed-discovery-version-controls',
      actualProductExecutions: 0,
      observedDirectKilo,
      unknownSentinelAccepted: true,
      wrongNonSentinelRejected: true,
      unknownReport: unknownVersion,
      wrongReport: wrongVersion,
    });
    const path = join(value.bin, 'codex');
    const target = await readlink(path);
    await unlink(path);
    try {
      const incomplete = await discover('missing-codex');
      assertDiscovery(value, incomplete, 'codex');
      expect(() => assertDiscovery(value, incomplete)).toThrow();
      await json(join(value.root, 'missing-binding-rejected.json'), {
        completenessAssertionRejected: true,
        report: incomplete,
      });
    } finally {
      await symlink(target, path);
    }
    assertDiscovery(value, await discover('restored-codex'));
  }
});

type Snapshot = {
  kind: string;
  sha256?: string;
  bytes?: string;
  target?: string;
  entries?: Record<string, Snapshot>;
};
const snapshot = async (path: string): Promise<Snapshot> => {
  if (!(await exists(path))) return { kind: 'absent' };
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: await readlink(path) };
  if (stat.isFile()) {
    const bytes = await readFile(path);
    return { kind: 'file', sha256: hash(bytes), bytes: bytes.toString('base64') };
  }
  if (stat.isDirectory()) {
    const entries: Record<string, Snapshot> = {};
    for (const name of (await readdir(path)).sort())
      entries[name] = await snapshot(join(path, name));
    return { kind: 'directory', entries };
  }
  throw new Error(`unexpected fixture node kind: ${path}`);
};

for (const tool of ['claude-code', 'codex'] as const) {
  test(`CI-${tool === 'claude-code' ? 'T02' : 'T03'}: ${tool} install checks availability without saving portable state`, async () => {
    const value = await workspace(tool);
    const remote = await buildRemoteFixture();
    remotes.push(remote);
    await writeFile(
      value.env.GIT_CONFIG_GLOBAL as string,
      `[url "${remote.multiUrl}"]\n\tinsteadOf = ${remote.multiSource}\n`,
    );
    const source = `${remote.multiSource}//plugins/fh/skills/factor-scan`;
    const portable = [
      join(value.cwd, 'skillsmith.toml'),
      join(value.cwd, 'skillsmith.lock'),
      join(value.config, 'skillsmith/skillsmith.toml'),
      join(value.config, 'skillsmith/skillsmith.lock'),
    ];
    for (const path of portable) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'owned no-save sentinel: deliberately not parsed\n');
    }
    const liveRoots = [
      join(value.home, '.claude/skills'),
      join(value.home, '.agents/skills'),
      join(value.home, '.codex/skills'),
      join(value.cwd, '.claude/skills'),
      join(value.cwd, '.agents/skills'),
    ];
    const live = join(
      value.home,
      tool === 'claude-code' ? '.claude/skills/factor-scan' : '.agents/skills/factor-scan',
    );
    const ledger = join(value.data, 'placements.json');
    const store = join(value.data, 'store');
    const paths = [...portable, ...liveRoots, ledger, store];
    const observe = async () =>
      Object.fromEntries(
        await Promise.all(paths.map(async (path) => [path, await snapshot(path)])),
      );
    const before = await observe();
    await json(join(value.root, 'state-before.json'), before);
    const result = await product(value, 'install', [
      'install',
      source,
      '--tool',
      tool,
      '--scope',
      'user',
      '--no-save',
      '--no-verify',
      '--json',
    ]);
    const after = await observe();
    await json(join(value.root, 'state-after.json'), after);
    expect(result.exitCode).toBe(mode === 'present' ? 0 : 4);
    const report = InstallJsonSchema.parse(JSON.parse(result.stdout));
    await json(join(value.root, 'install-parsed.json'), report);
    expect(report).toMatchObject({
      schemaVersion: 2,
      kind: 'skillsmith.install',
      saveMode: 'live-only',
      artifactPair: null,
      artifactSelection: { outcome: 'none', reason: 'no-save' },
      requested: { tools: [tool], scope: 'user', explicitScope: true, verify: 'skipped' },
    });
    expect(report.results).toHaveLength(1);
    const row = report.results[0];
    if (!row) throw new Error('missing install result');
    for (const path of portable) expect(after[path]).toEqual(before[path]);
    if (mode === 'absent') {
      expect(row).toMatchObject({
        tool,
        action: 'refused',
        store: null,
        placement: null,
        placementPath: null,
      });
      expect(row.reason).toContain('not detected');
      expect(after).toEqual(before);
    } else {
      expect(row).toMatchObject({
        tool,
        skill: 'factor-scan',
        scope: 'user',
        action: 'installed',
        placement: 'symlink',
        placementPath: live,
        verify: null,
      });
      expect(row.store).not.toBeNull();
      if (!row.store) throw new Error('missing returned store');
      expect(inside(store, row.store.path)).toBe(true);
      expect((await lstat(live)).isSymbolicLink()).toBe(true);
      expect(await realpath(live)).toBe(row.store.path);
      expect(inside(store, await realpath(live))).toBe(true);
      expect(await readFile(join(live, 'SKILL.md'), 'utf8')).toBe(
        await readFile(join(remote.multiWork, 'plugins/fh/skills/factor-scan/SKILL.md'), 'utf8'),
      );
      const ledgerValue = JSON.parse(await readFile(ledger, 'utf8'));
      expect(ledgerValue).toMatchObject({
        schemaVersion: 2,
        kind: 'skillsmith.placements',
        skills: {
          'factor-scan': {
            tools: {
              [tool]: {
                placementPath: live,
                mode: 'pinned',
                pinned: { storePath: row.store.path, verify: 'skipped' },
              },
            },
          },
        },
        transactions: {},
      });
      for (const root of liveRoots) {
        if (inside(root, live)) expect(await readdir(root)).toEqual(['factor-scan']);
        else expect(after[root]).toEqual(before[root]);
      }
    }
    const scratch: Record<string, Snapshot> = {};
    for (const path of [
      join(value.data, '.fetch'),
      join(store, '.staging'),
      join(value.data, 'placements.json.lock'),
    ]) {
      scratch[path] = await snapshot(path);
      expect(['absent', 'directory']).toContain(scratch[path]?.kind);
      if (scratch[path]?.kind === 'directory') expect(scratch[path]?.entries).toEqual({});
    }
    await json(join(value.root, 'scratch-final.json'), scratch);
  });
}
