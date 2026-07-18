import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInitApplication } from '../../../core/src/application/init-service.ts';
import type {
  CurrentApplicationContext,
  CurrentCommandRequest,
  InteractionPort,
} from '../../../core/src/application/types.ts';
import type { ArtifactCoordinatorPorts } from '../../../core/src/artifacts/coordinator-types.ts';
import { planInitManifest } from '../../../core/src/artifacts/init.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../core/src/artifacts/manifest.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../core/src/artifacts/node-coordinator.ts';
import { resolveRuntimeConfiguration } from '../../../core/src/config/runtime.ts';
import { validateExecutionPlanShape } from '../../../core/src/execution/scheduler.ts';
import { prepareInitOperationPlan } from '../../../core/src/init/plan.ts';
import { executePreparedInit, observeInitManifest } from '../../../core/src/init/run.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../../core/src/observation/index.ts';
import { createOperationPlan } from '../../../core/src/planning/create.ts';
import { defaultRuntimePorts } from '../../../core/src/ports/default.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { exitCodeForClass } from '../../src/runtime/adapter.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

setDefaultTimeout(30_000);

type UnknownRecord = Record<string, unknown>;

interface CliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface InitFixture {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly bin: string;
}

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fixture = async (): Promise<InitFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-init-contract-'));
  fixtures.push(root);
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  const config = join(root, 'xdg', 'config');
  const data = join(root, 'xdg', 'data');
  const cache = join(root, 'xdg', 'cache');
  const bin = join(root, 'bin');
  await Promise.all(
    [cwd, home, config, data, cache, bin].map((path) => mkdir(path, { recursive: true })),
  );
  const git = Bun.which('git');
  if (git === null) throw new Error('init contract fixture requires git');
  await Promise.all([symlink(process.execPath, join(bin, 'bun')), symlink(git, join(bin, 'git'))]);
  return { root, cwd, home, config, data, cache, bin };
};

const runCli = async (
  value: InitFixture,
  args: readonly string[],
  cwd = value.cwd,
): Promise<CliProduct> => {
  const child = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv({
      ...processEnvWithoutConfig(),
      HOME: value.home,
      XDG_CONFIG_HOME: value.config,
      XDG_DATA_HOME: value.data,
      XDG_CACHE_HOME: value.cache,
      SKILLSMITH_HOME: join(value.data, 'skillsmith'),
      CLAUDE_CONFIG_DIR: join(value.home, '.claude'),
      CODEX_HOME: join(value.home, '.codex'),
      PATH: value.bin,
      CI: '1',
      NO_COLOR: '1',
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

const processEnvWithoutConfig = (): Record<string, string | undefined> => {
  const env = { ...process.env };
  env.SKILLSMITH_CONFIG = undefined;
  return env;
};

const json = (product: CliProduct, expectedExit: number, label: string): UnknownRecord => {
  expect(product.exitCode, `${label}\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`).toBe(
    expectedExit,
  );
  let value: unknown;
  try {
    value = JSON.parse(product.stdout);
  } catch {
    throw new Error(`${label}: stdout was not one JSON document`);
  }
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBeFalse();
  return value as UnknownRecord;
};

const readMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const observation = Object.freeze({
  context: createOperationContext({
    command: 'skillsmith init contract test',
    workflow: 'init-contract-test',
    clock: {
      wallNowIso: () => '2026-07-18T00:00:00.000Z',
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: () => 'init-contract-operation' },
  }),
  emitter: createObservationEmitter({ observer: noopObserver }),
});

const noninteractive: InteractionPort = Object.freeze({
  mode: 'noninteractive',
  choose: async () => ({ status: 'refused' as const, reason: 'noninteractive' }),
  confirm: async () => ({ status: 'refused' as const, reason: 'noninteractive' }),
});

const applicationContext = async (
  value: InitFixture,
  overrides: Readonly<{
    ports?: CurrentApplicationContext['ports'];
    artifactCoordinator?: ArtifactCoordinatorPorts;
    configuration?: CurrentApplicationContext['configuration'];
    globalOptions?: CurrentApplicationContext['globalOptions'];
    signal?: AbortSignal;
  }> = {},
): Promise<CurrentApplicationContext> => {
  const basePorts = overrides.ports ?? (await defaultRuntimePorts());
  const ports = Object.freeze({
    ...basePorts,
    homeDir: value.home,
    executableSearchPath: overrides.ports?.executableSearchPath ?? [],
    xdg: Object.freeze({ config: value.config, data: value.data, cache: value.cache }),
  });
  return {
    observation,
    ports,
    artifactCoordinator:
      overrides.artifactCoordinator ??
      (await createTestNodeArtifactCoordinatorPorts(join(value.root, 'coordination'))),
    configuration:
      overrides.configuration ??
      resolveRuntimeConfiguration({
        HOME: value.home,
        XDG_CONFIG_HOME: value.config,
        XDG_DATA_HOME: value.data,
        XDG_CACHE_HOME: value.cache,
        SKILLSMITH_HOME: join(value.data, 'skillsmith'),
      }),
    interaction: noninteractive,
    invocationCwd: value.cwd,
    globalOptions: overrides.globalOptions ?? {},
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
};

const applicationRequest = (options: Readonly<Record<string, unknown>>): CurrentCommandRequest => ({
  arguments: [],
  options,
});

const executionContext = (
  artifactCoordinator: ArtifactCoordinatorPorts,
  signal?: AbortSignal,
): CurrentApplicationContext =>
  ({
    artifactCoordinator,
    ports: {},
    observation,
    ...(signal === undefined ? {} : { signal }),
  }) as unknown as CurrentApplicationContext;

const prepareFilesystemInit = async (
  artifactCoordinator: ArtifactCoordinatorPorts,
  path: string,
  options: Readonly<{ tools?: readonly ['codex']; force: boolean }>,
) => {
  const observed = await observeInitManifest(executionContext(artifactCoordinator), path);
  expect(observed.ok).toBeTrue();
  if (!observed.ok) throw new Error(observed.error.code);
  const skeleton = options.tools === undefined ? {} : { defaults: { tools: options.tools } };
  const classification = planInitManifest({
    skeleton,
    current:
      observed.value.state === 'absent'
        ? { state: 'absent' }
        : { state: 'present', bytes: observed.value.bytes },
    legacyIntent: { requireMatch: [] },
    force: options.force,
  });
  expect(classification.ok).toBeTrue();
  if (!classification.ok) throw new Error(classification.error.message);
  return prepareInitOperationPlan({
    request: {
      tools: options.tools ?? [],
      explicitTools: options.tools !== undefined,
      toolSource: options.tools === undefined ? 'none' : 'explicit',
      scope: null,
      explicitScope: false,
      file: path,
      force: options.force,
    },
    dryRun: false,
    defaults: {
      tools: options.tools ?? null,
      scope: null,
      path: null,
      registryDefault: null,
    },
    selection: {
      outcome: 'selected',
      selectedBy: 'explicit-file',
      manifestPath: path,
      lockPath: join(dirname(path), 'skillsmith.lock'),
      lockSource: 'sibling',
    },
    skeleton,
    classification: classification.value,
    observed: observed.value,
  });
};

describe('EWP-CMD-INIT-TS01', () => {
  test('bare init creates the exact minimal XDG manifest and no sibling lock outside Git', async () => {
    const value = await fixture();
    const manifest = join(value.config, 'skillsmith', 'skillsmith.toml');
    const lock = join(value.config, 'skillsmith', 'skillsmith.lock');

    const product = await runCli(value, ['init']);

    expect(product.exitCode, product.stderr).toBe(0);
    expect(await readFile(manifest, 'utf8')).toBe('version = 1\n');
    expect(await readMaybe(lock)).toBeNull();
    expect(product.stdout).toContain(manifest);
    expect(product.stdout).toContain(lock);
  });

  test('nested Git cwd selects the shared root and exact legacy bytes migrate without a lock', async () => {
    const value = await fixture();
    const repository = join(value.root, 'repo');
    const nested = join(repository, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const git = Bun.spawnSync(['git', 'init', '--quiet', repository], {
      env: hermeticGitEnv(processEnvWithoutConfig()),
    });
    expect(git.exitCode).toBe(0);
    const manifest = join(repository, 'skillsmith.toml');
    const lock = join(repository, 'skillsmith.lock');
    const created = await runCli(value, ['init'], nested);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(await readFile(manifest, 'utf8')).toBe('version = 1\n');
    expect(await readMaybe(lock)).toBeNull();

    await writeFile(manifest, '# retained\ntool = "codex"\nscope = "project"\n');
    const migrated = json(
      await runCli(value, ['init', '--file', manifest, '--json'], nested),
      0,
      'legacy init migration',
    );
    expect(migrated.result).toMatchObject({
      action: 'migrate-project-config',
      before: { shape: 'legacy' },
      after: { state: 'canonical' },
    });
    expect(await readFile(manifest, 'utf8')).toContain('# retained\nversion = 1');
    expect(await readMaybe(lock)).toBeNull();
  });
});

describe('EWP-CMD-INIT-TS02', () => {
  test('explicit file, tool, and project scope shape one non-mutating canonical preview', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'team.toml');
    const report = json(
      await runCli(value, [
        'init',
        '--file',
        'team.toml',
        '--tool',
        'codex',
        '--scope',
        'project',
        '--dry-run',
        '--json',
      ]),
      0,
      'explicit init preview',
    );

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'skillsmith.init',
      reportVersion: 1,
      dryRun: true,
      requested: {
        tools: ['codex'],
        explicitTools: true,
        toolSource: 'explicit',
        scope: 'project',
        explicitScope: true,
        file: manifest,
        force: false,
      },
      defaults: { tools: ['codex'], scope: 'project' },
      artifactSelection: { selectedBy: 'explicit-file', manifestPath: manifest },
      result: { action: 'create-manifest' },
      summary: { changed: 1, unchanged: 0 },
    });
    expect(report.effects).toEqual([
      {
        role: 'manifest',
        action: 'create',
        operationId: (report.result as UnknownRecord).operationId,
        outcome: 'planned',
      },
      { role: 'lock', action: 'not-written', operationId: null, outcome: 'not-run' },
      { role: 'live', action: 'not-written', operationId: null, outcome: 'not-run' },
      { role: 'ledger', action: 'not-written', operationId: null, outcome: 'not-run' },
    ]);
    expect(await readMaybe(manifest)).toBeNull();
  });

  test('non-Git project scope stays at effective cwd and zero detection stays declaration-empty', async () => {
    const value = await fixture();
    const ancestor = join(value.root, 'ancestor');
    const nested = join(ancestor, 'packages', 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(ancestor, 'skillsmith.toml'), 'version = 1\n');
    const nestedManifest = join(nested, 'skillsmith.toml');
    const project = json(
      await runCli(value, ['init', '--scope', 'project', '--dry-run', '--json'], nested),
      0,
      'non-Git nested project init',
    );
    expect(project).toMatchObject({
      requested: { toolSource: 'none', tools: [], scope: 'project' },
      defaults: { tools: null, scope: 'project' },
      artifactSelection: { selectedBy: 'project', manifestPath: nestedManifest },
      result: { action: 'create-manifest' },
    });
    expect(await readMaybe(nestedManifest)).toBeNull();

    const empty = join(value.cwd, 'empty-defaults.toml');
    const zero = json(
      await runCli(value, ['init', '--file', empty, '--dry-run', '--json']),
      0,
      'zero detection init',
    );
    expect(zero).toMatchObject({
      requested: { toolSource: 'none', tools: [] },
      defaults: { tools: null, scope: null, path: null, registryDefault: null },
      result: { action: 'create-manifest' },
    });
    expect(await readMaybe(empty)).toBeNull();
  });

  test('same-path explicit config reuses one canonical or legacy snapshot', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'same-path.toml');
    await writeFile(manifest, 'version = 1\n[defaults]\ntools = ["codex"]\n');
    const canonical = json(
      await runCli(value, ['--config', manifest, 'init', '--file', manifest, '--json']),
      0,
      'same-path canonical config',
    );
    expect(canonical).toMatchObject({
      requested: { tools: ['codex'], toolSource: 'config' },
      result: { action: 'noop', before: { shape: 'canonical' } },
    });

    await writeFile(manifest, 'tool = "codex"\n');
    const legacy = json(
      await runCli(value, ['--config', manifest, 'init', '--file', manifest, '--json']),
      0,
      'same-path legacy config',
    );
    expect(legacy).toMatchObject({
      requested: { tools: ['codex'], toolSource: 'config' },
      result: { action: 'migrate-project-config', before: { shape: 'legacy' } },
    });
    expect(await readFile(manifest, 'utf8')).toContain('version = 1');
  });

  test('mixed writable/read-only tools refuse and deterministic detection failures are fatal', async () => {
    const value = await fixture();
    const mixed = json(
      await runCli(value, [
        'init',
        '--file',
        join(value.cwd, 'mixed.toml'),
        '--tool',
        'codex',
        '--tool',
        'kilo-code',
        '--json',
      ]),
      4,
      'mixed init capability',
    );
    expect(mixed).toMatchObject({ kind: 'error', code: 'capability', exitCode: 4 });

    const base = await defaultRuntimePorts();
    const claudeRoot = join(value.home, '.claude');
    const bin = join(value.root, 'bin');
    const binary = join(bin, 'claude');
    const ports = Object.freeze({
      ...base,
      homeDir: value.home,
      executableSearchPath: [bin],
      xdg: Object.freeze({ config: value.config, data: value.data, cache: value.cache }),
      fileExists: async (path: string) =>
        path === claudeRoot || path === binary ? true : base.fileExists(path),
      runVersion: async () => {
        throw new Error('deterministic detection failure');
      },
    });
    const context = await applicationContext(value, {
      ports,
      configuration: resolveRuntimeConfiguration({
        HOME: value.home,
        XDG_CONFIG_HOME: value.config,
        XDG_DATA_HOME: value.data,
        XDG_CACHE_HOME: value.cache,
        CLAUDE_CONFIG_DIR: claudeRoot,
      }),
    });
    const failed = await runInitApplication(
      applicationRequest({ file: join(value.cwd, 'detection.toml'), dryRun: true }),
      context,
    );
    expect(failed).toMatchObject({
      report: null,
      exitClass: 'failure',
      diagnostics: [{ code: 'init-detection' }],
      mutation: { kind: 'none', changed: 0 },
    });
  });

  test('target appearance and disappearance cannot change the observed config snapshot', async () => {
    const appearedValue = await fixture();
    const appearedPath = join(appearedValue.cwd, 'appeared.toml');
    const appearedBase = await createTestNodeArtifactCoordinatorPorts(
      join(appearedValue.root, 'coordination-race'),
    );
    let injectedAppearance = false;
    const appearanceCoordinator = Object.freeze({
      ...appearedBase,
      observe: async (path: string) => {
        const result = await appearedBase.observe(path);
        if (path === appearedPath && result.kind === 'absent' && !injectedAppearance) {
          injectedAppearance = true;
          await writeFile(appearedPath, 'tool = "kilo-code"\n');
        }
        return result;
      },
    });
    const appearance = await runInitApplication(
      applicationRequest({ file: appearedPath, dryRun: true }),
      await applicationContext(appearedValue, {
        artifactCoordinator: appearanceCoordinator,
        globalOptions: { config: appearedPath },
      }),
    );
    expect(appearance).toMatchObject({
      exitClass: 'success',
      report: {
        requested: { toolSource: 'none', tools: [] },
        defaults: { tools: null },
        result: { action: 'create-manifest' },
      },
    });
    expect(injectedAppearance).toBeTrue();
    expect(await readFile(appearedPath, 'utf8')).toBe('tool = "kilo-code"\n');

    const disappearedValue = await fixture();
    const disappearedPath = join(disappearedValue.cwd, 'disappeared.toml');
    await writeFile(disappearedPath, 'version = 1\n[defaults]\ntools = ["codex"]\n');
    const disappearedBase = await createTestNodeArtifactCoordinatorPorts(
      join(disappearedValue.root, 'coordination-race'),
    );
    let injectedDisappearance = false;
    const disappearanceCoordinator = Object.freeze({
      ...disappearedBase,
      readBytes: async (path: string) => {
        const bytes = await disappearedBase.readBytes(path);
        if (path === disappearedPath && !injectedDisappearance) {
          injectedDisappearance = true;
          await rm(disappearedPath);
        }
        return bytes;
      },
    });
    const disappearance = await runInitApplication(
      applicationRequest({ file: disappearedPath, dryRun: true }),
      await applicationContext(disappearedValue, {
        artifactCoordinator: disappearanceCoordinator,
        globalOptions: { config: disappearedPath },
      }),
    );
    expect(disappearance).toMatchObject({
      exitClass: 'success',
      report: {
        requested: { toolSource: 'config', tools: ['codex'] },
        defaults: { tools: ['codex'] },
        result: { action: 'noop' },
      },
    });
    expect(injectedDisappearance).toBeTrue();
    expect(await readMaybe(disappearedPath)).toBeNull();
  });

  test('explicit user scope selects XDG and a configured read-only tool refuses as capability', async () => {
    const value = await fixture();
    const manifest = join(value.config, 'skillsmith', 'skillsmith.toml');
    const user = json(
      await runCli(value, ['init', '--scope', 'user', '--tool', 'claude-code', '--json']),
      0,
      'explicit user init',
    );
    expect(user).toMatchObject({
      requested: { scope: 'user', explicitScope: true, tools: ['claude-code'] },
      artifactSelection: { selectedBy: 'user', manifestPath: manifest },
    });
    expect(await readFile(manifest, 'utf8')).toContain('scope = "user"');

    const configured = join(value.config, 'skillsmith', 'config.toml');
    await mkdir(join(value.config, 'skillsmith'), { recursive: true });
    await writeFile(configured, 'tool = "kilo-code"\n');
    const denied = json(
      await runCli(value, ['init', '--file', join(value.cwd, 'denied.toml'), '--json']),
      4,
      'configured read-only init tool',
    );
    expect(denied).toMatchObject({ kind: 'error', code: 'capability', exitCode: 4 });
  });

  test('effective writable defaults remain separate from an explicit artifact destination', async () => {
    const value = await fixture();
    const configured = join(value.config, 'skillsmith', 'config.toml');
    const manifest = join(value.cwd, 'configured.toml');
    await mkdir(join(value.config, 'skillsmith'), { recursive: true });
    await writeFile(
      configured,
      'tool = "codex"\nscope = "project"\npath = "./team-skills"\n[registry]\ndefault = "registry.example/team"\n',
    );

    const report = json(
      await runCli(value, ['init', '--file', manifest, '--dry-run', '--json']),
      0,
      'configured init defaults',
    );
    expect(report).toMatchObject({
      requested: {
        tools: ['codex'],
        explicitTools: false,
        toolSource: 'config',
        scope: 'project',
        explicitScope: false,
        file: manifest,
      },
      defaults: {
        tools: ['codex'],
        scope: 'project',
        path: './team-skills',
        registryDefault: 'registry.example/team',
      },
      artifactSelection: { selectedBy: 'explicit-file', manifestPath: manifest },
    });
    expect(await readMaybe(manifest)).toBeNull();

    await writeFile(configured, 'tool = "codex"\nscope = "project"\npath = "team-skills"\n');
    const invalidPath = json(
      await runCli(value, ['init', '--file', manifest, '--dry-run', '--json']),
      2,
      'nonportable configured init path',
    );
    expect(invalidPath).toMatchObject({ kind: 'error', code: 'init-invalid-request' });
    expect(await readMaybe(manifest)).toBeNull();

    await writeFile(
      configured,
      'tool = "codex"\nscope = "project"\n[registry]\ndefault = "https://fixture.invalid/team"\n',
    );
    const invalidRegistry = json(
      await runCli(value, ['init', '--file', manifest, '--dry-run', '--json']),
      3,
      'noncanonical configured init registry',
    );
    expect(invalidRegistry).toMatchObject({ kind: 'error', code: 'init-configuration' });
    expect(await readMaybe(manifest)).toBeNull();
  });
});

describe('EWP-CMD-INIT-TS03', () => {
  test('force replaces only the selected invalid manifest and preserves sibling canaries', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'skillsmith.toml');
    const lock = join(value.cwd, 'skillsmith.lock');
    const live = join(value.cwd, 'live.canary');
    const ledger = join(value.data, 'skillsmith', 'placements.json');
    await mkdir(join(value.data, 'skillsmith'), { recursive: true });
    await writeFile(manifest, 'unknown = true\n');
    await writeFile(lock, 'lock-canary\n');
    await writeFile(live, 'live-canary\n');
    await writeFile(ledger, 'ledger-canary\n');

    const report = json(
      await runCli(value, ['init', '--file', manifest, '--force', '--json']),
      0,
      'forced init replacement',
    );

    expect(report.result).toMatchObject({ action: 'replace-manifest' });
    expect(report.force).toMatchObject({
      requested: true,
      applied: true,
      conflictType: 'destination-exists',
      normalBehavior: 'refuse',
      forcedBehavior: 'backup-and-replace',
      backup: 'required',
    });
    expect(await readFile(manifest, 'utf8')).toBe('version = 1\n');
    expect(await readFile(lock, 'utf8')).toBe('lock-canary\n');
    expect(await readFile(live, 'utf8')).toBe('live-canary\n');
    expect(await readFile(ledger, 'utf8')).toBe('ledger-canary\n');
  });

  test('force never downgrades future state and safely replaces exact non-UTF8 bytes', async () => {
    const value = await fixture();
    const future = join(value.cwd, 'future.toml');
    await writeFile(future, 'version = 2\n');
    const refused = json(
      await runCli(value, ['init', '--file', future, '--force', '--json']),
      3,
      'future init refusal',
    );
    expect(refused).toMatchObject({ kind: 'error', code: 'init-future-manifest', exitCode: 3 });
    expect(await readFile(future, 'utf8')).toBe('version = 2\n');

    const malformed = join(value.cwd, 'malformed.toml');
    const canary = 'P17_OPAQUE_CREDENTIAL_CANARY';
    await writeFile(malformed, Uint8Array.from([0xff, 0xfe, ...new TextEncoder().encode(canary)]));
    await chmod(malformed, 0o640);
    const replaced = await runCli(value, ['init', '--file', malformed, '--force', '--json']);
    const report = json(replaced, 0, 'opaque init replacement');
    expect(report.result).toMatchObject({
      action: 'replace-manifest',
      before: { shape: 'malformed', semanticHash: null },
    });
    expect(`${replaced.stdout}${replaced.stderr}`).not.toContain(canary);
    expect(await readFile(malformed, 'utf8')).toBe('version = 1\n');
    expect((await stat(malformed)).mode & 0o777).toBe(0o640);

    const canonical = join(value.cwd, 'canonical-with-secret-comment.toml');
    const credentialCanary = `ghp_${'1'.repeat(36)}`;
    await writeFile(canonical, `# ${credentialCanary}\nversion = 1\n`);
    await chmod(canonical, 0o640);
    const canonicalProduct = await runCli(value, [
      'init',
      '--file',
      canonical,
      '--tool',
      'codex',
      '--force',
      '--json',
    ]);
    const canonicalReplacement = json(canonicalProduct, 0, 'canonical init replacement');
    expect(canonicalReplacement.result).toMatchObject({
      action: 'replace-manifest',
      before: { shape: 'canonical' },
    });
    expect(`${canonicalProduct.stdout}${canonicalProduct.stderr}`).not.toContain(credentialCanary);
    expect(await readFile(canonical, 'utf8')).toContain('tools = ["codex"]');
    expect((await stat(canonical)).mode & 0o777).toBe(0o640);
  });

  test('canonical equality is a zero-write noop and reports force as unused', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'same.toml');
    await writeFile(manifest, 'version = 1\n');
    await chmod(manifest, 0o644);
    const before = await stat(manifest);
    const report = json(
      await runCli(value, ['init', '--file', manifest, '--force', '--json']),
      0,
      'init noop',
    );
    expect(report).toMatchObject({
      result: { action: 'noop', operationId: null, after: null },
      force: { requested: true, applied: false, conflictType: null },
      summary: { changed: 0, unchanged: 1 },
    });
    const after = await stat(manifest);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o644);
  });

  test('automatic invalid project state stays classifier-owned while explicit config stays authoritative', async () => {
    const value = await fixture();
    const git = Bun.spawnSync(['git', 'init', '--quiet', value.cwd], {
      env: hermeticGitEnv(processEnvWithoutConfig()),
    });
    expect(git.exitCode).toBe(0);
    const manifest = join(value.cwd, 'skillsmith.toml');
    const unsafeCanary = 'P17_UNSAFE_LEGACY_CANARY';
    await writeFile(manifest, `# Authorization: Bearer ${unsafeCanary}\ntool = "kilo-code"\n`);
    const unsafeLegacyProduct = await runCli(value, ['init', '--force', '--json']);
    const unsafeLegacy = json(unsafeLegacyProduct, 3, 'automatic unsafe legacy refusal');
    expect(unsafeLegacy).toMatchObject({
      kind: 'error',
      code: 'init-unsafe-legacy-migration',
      exitCode: 3,
    });
    expect(`${unsafeLegacyProduct.stdout}${unsafeLegacyProduct.stderr}`).not.toContain(
      unsafeCanary,
    );
    expect(await readFile(manifest, 'utf8')).toContain(unsafeCanary);

    await writeFile(manifest, 'unknown = true\n');

    const replaced = json(
      await runCli(value, ['init', '--force', '--json']),
      0,
      'automatic invalid project replacement',
    );
    expect(replaced).toMatchObject({
      artifactSelection: { selectedBy: 'project', manifestPath: manifest },
      result: { action: 'replace-manifest', before: { shape: 'unknown' } },
    });

    await writeFile(manifest, 'version = 2\n');
    const future = json(
      await runCli(value, ['init', '--force', '--json']),
      3,
      'automatic future refusal',
    );
    expect(future).toMatchObject({ kind: 'error', code: 'init-future-manifest' });
    expect(await readFile(manifest, 'utf8')).toBe('version = 2\n');

    const explicit = json(
      await runCli(value, ['--config', manifest, 'init', '--file', manifest, '--force', '--json']),
      3,
      'same-path explicit config refusal',
    );
    expect(explicit).toMatchObject({ kind: 'error', code: 'init-configuration' });
    expect(await readFile(manifest, 'utf8')).toBe('version = 2\n');
  });

  test('empty, mixed, and semantically invalid canonical files share the bounded force matrix', async () => {
    const value = await fixture();
    const cases = [
      { name: 'empty', source: '', shape: 'empty' },
      { name: 'mixed', source: 'version = 1\ntool = "codex"\n', shape: 'mixed' },
      {
        name: 'invalid-canonical',
        source: 'version = 1\n[defaults]\ntools = ["codex"]\npath = "skills"\n',
        shape: 'canonical',
      },
    ] as const;

    for (const item of cases) {
      const manifest = join(value.cwd, `${item.name}.toml`);
      await writeFile(manifest, item.source);
      const refused = json(
        await runCli(value, ['init', '--file', manifest, '--json']),
        3,
        `${item.name} normal refusal`,
      );
      expect(refused).toMatchObject({ kind: 'error', code: 'init-existing-manifest' });
      expect(await readFile(manifest, 'utf8')).toBe(item.source);

      const preview = json(
        await runCli(value, ['init', '--file', manifest, '--force', '--dry-run', '--json']),
        0,
        `${item.name} force preview`,
      );
      expect(preview).toMatchObject({
        dryRun: true,
        result: { action: 'replace-manifest', before: { shape: item.shape } },
        force: {
          requested: true,
          applied: false,
          conflictType: 'destination-exists',
          backup: 'required',
        },
      });
      expect((preview.effects as readonly unknown[])[0]).toMatchObject({
        role: 'manifest',
        action: 'replace',
        outcome: 'planned',
      });
      expect(await readFile(manifest, 'utf8')).toBe(item.source);

      const applied = json(
        await runCli(value, ['init', '--file', manifest, '--force', '--json']),
        0,
        `${item.name} force execution`,
      );
      expect(applied).toMatchObject({
        dryRun: false,
        result: { action: 'replace-manifest', before: { shape: item.shape } },
        force: {
          requested: true,
          applied: true,
          conflictType: 'destination-exists',
          backup: 'required',
        },
      });
      expect((applied.effects as readonly unknown[])[0]).toMatchObject({
        role: 'manifest',
        action: 'replace',
        outcome: 'succeeded',
      });
      expect(await readFile(manifest, 'utf8')).toBe('version = 1\n');
    }
  });
});

describe('EWP-CMD-INIT-TS04', () => {
  test('dry-run and execution expose the same immutable create operation', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'skillsmith.toml');
    const args = ['init', '--file', manifest, '--tool', 'codex', '--json'] as const;
    const preview = json(
      await runCli(value, [...args.slice(0, -1), '--dry-run', '--json']),
      0,
      'init dry-run',
    );
    expect(await readMaybe(manifest)).toBeNull();
    const executed = json(await runCli(value, args), 0, 'init execution');

    expect(preview.result).toEqual(executed.result);
    expect((preview.effects as readonly unknown[])[0]).toMatchObject({ outcome: 'planned' });
    expect((executed.effects as readonly unknown[])[0]).toMatchObject({ outcome: 'succeeded' });
    expect(await readFile(manifest, 'utf8')).toContain('tools = ["codex"]');
  });

  test('full inode and parent revisions refuse same-byte concurrent replacements', async () => {
    const value = await fixture();
    const coordinator = await createTestNodeArtifactCoordinatorPorts(
      join(value.root, 'coordination-revisions'),
    );
    const project = join(value.root, 'revision-project');
    await mkdir(project);
    const manifest = join(project, 'skillsmith.toml');
    const source = new TextEncoder().encode('version = 1\n');
    await writeFile(manifest, source, { mode: 0o600 });
    const prepared = await prepareFilesystemInit(coordinator, manifest, {
      tools: ['codex'],
      force: true,
    });
    const before = await coordinator.observe(manifest);
    const peer = join(project, 'peer.toml');
    await writeFile(peer, source, { mode: 0o600 });
    await rename(peer, manifest);
    expect((await coordinator.observe(manifest)).identity).not.toBe(before.identity);
    expect(await executePreparedInit(executionContext(coordinator), prepared)).toMatchObject({
      ok: false,
      error: { code: 'init-precondition-changed', exitClass: 'state' },
    });
    expect(new Uint8Array(await readFile(manifest))).toEqual(source);

    const absentPath = join(project, 'absent.toml');
    const absent = await prepareFilesystemInit(coordinator, absentPath, { force: false });
    const displaced = join(value.root, 'displaced-revision-project');
    await rename(project, displaced);
    await mkdir(project);
    expect(await executePreparedInit(executionContext(coordinator), absent)).toMatchObject({
      ok: false,
      error: { code: 'init-precondition-changed', exitClass: 'state' },
    });
    expect(await Bun.file(absentPath).exists()).toBeFalse();
  });

  test('observation errors and pre/post-commit cancellation retain exact exit and durability classes', async () => {
    const observationCases = [
      { code: 'ENOENT', expectedCode: 'init-observation-changed', exitClass: 'state' },
      { code: 'EACCES', expectedCode: 'init-observation-permission', exitClass: 'permission' },
      { code: 'EIO', expectedCode: 'init-observation-failed', exitClass: 'failure' },
      { code: 'ABORT_ERR', expectedCode: 'init-cancelled', exitClass: 'cancelled' },
    ] as const;
    for (const item of observationCases) {
      const context = {
        artifactCoordinator: {
          observe: async () => {
            throw Object.assign(new Error('safe fixture failure'), { code: item.code });
          },
        },
      } as unknown as CurrentApplicationContext;
      expect(await observeInitManifest(context, '/fixture/skillsmith.toml')).toMatchObject({
        ok: false,
        error: { code: item.expectedCode, exitClass: item.exitClass },
      });
    }

    const value = await fixture();
    const base = await createTestNodeArtifactCoordinatorPorts(
      join(value.root, 'coordination-cancellation'),
    );
    const beforePath = join(value.cwd, 'cancel-before.toml');
    const before = await prepareFilesystemInit(base, beforePath, { force: false });
    const precommit = new AbortController();
    precommit.abort();
    expect(
      await executePreparedInit(executionContext(base, precommit.signal), before),
    ).toMatchObject({
      ok: false,
      error: { code: 'init-cancelled', exitClass: 'cancelled', durableState: 'before' },
    });
    expect(await Bun.file(beforePath).exists()).toBeFalse();

    const afterPath = join(value.cwd, 'cancel-after.toml');
    const after = await prepareFilesystemInit(base, afterPath, { force: false });
    const committed = new AbortController();
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: Parameters<NonNullable<typeof base.afterBarrier>>[0]) => {
        if (barrier.kind === 'record-durable' && barrier.cursor === 'committed') committed.abort();
      },
    });
    expect(
      await executePreparedInit(executionContext(ports, committed.signal), after),
    ).toMatchObject({
      ok: false,
      error: { code: 'init-cancelled', exitClass: 'cancelled', durableState: 'after' },
    });
    expect(await readFile(afterPath, 'utf8')).toBe('version = 1\n');
    expect(await base.recovery.discover()).toEqual([]);
  });

  test('post-commit cancellation reports the durable after image and applied mutation', async () => {
    const value = await fixture();
    const base = await createTestNodeArtifactCoordinatorPorts(
      join(value.root, 'coordination-application-cancellation'),
    );
    const committed = new AbortController();
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: Parameters<NonNullable<typeof base.afterBarrier>>[0]) => {
        if (barrier.kind === 'record-durable' && barrier.cursor === 'committed') committed.abort();
      },
    });
    const manifest = join(value.cwd, 'application-cancel-after.toml');
    const outcome = await runInitApplication(
      applicationRequest({ file: manifest }),
      await applicationContext(value, {
        artifactCoordinator: ports,
        signal: committed.signal,
      }),
    );
    expect(outcome).toMatchObject({
      exitClass: 'cancelled',
      diagnostics: [{ code: 'init-cancelled' }],
      mutation: { kind: 'applied', planned: 1, changed: 1, failed: 0 },
      report: {
        result: { action: 'create-manifest', after: { state: 'canonical' } },
      },
    });
    expect(outcome.report?.effects[0]).toMatchObject({
      role: 'manifest',
      action: 'create',
      outcome: 'succeeded',
    });
    expect(await readFile(manifest, 'utf8')).toBe('version = 1\n');
    expect(await base.recovery.discover()).toEqual([]);
  });

  test('plan construction and scheduling reject hostile shape, path, and digest data', async () => {
    const value = await fixture();
    const coordinator = await createTestNodeArtifactCoordinatorPorts(
      join(value.root, 'coordination-hostile-plan'),
    );
    const manifest = join(value.cwd, 'hostile.toml');
    await writeFile(manifest, Uint8Array.from([0xff, 0xfe]));
    const prepared = await prepareFilesystemInit(coordinator, manifest, { force: true });
    validateExecutionPlanShape(prepared.plan);
    const operation = prepared.plan.operations[0];
    expect(operation).toBeDefined();
    if (
      operation === undefined ||
      operation.before.kind !== 'opaque-manifest' ||
      operation.after.kind !== 'manifest'
    )
      return;

    expect(() =>
      createOperationPlan({
        ...prepared.plan,
        operations: [
          {
            ...operation,
            before: { ...operation.before, shape: 'future' },
          } as never,
        ],
      }),
    ).toThrow(/shape/i);
    expect(() =>
      createOperationPlan({
        ...prepared.plan,
        operations: [
          {
            ...operation,
            before: { ...operation.before, byteHash: 'sha256:not-a-digest' },
          } as never,
        ],
      }),
    ).toThrow(/byteHash/i);

    const wrongPathPlan = createOperationPlan({
      ...prepared.plan,
      operations: [
        {
          ...operation,
          after: {
            ...operation.after,
            location: { kind: 'machine-bound', path: join(value.cwd, 'other.toml') },
          },
        },
      ],
    });
    expect(() => validateExecutionPlanShape(wrongPathPlan)).toThrow(/artifact-only mutation/i);
    expect(new Uint8Array(await readFile(manifest))).toEqual(Uint8Array.from([0xff, 0xfe]));
  });
});

describe('EWP-CMD-INIT-TS05', () => {
  test('help, completion, JSON errors, and the activated grammar agree', async () => {
    const value = await fixture();
    const help = await runCli(value, ['init', '--help']);
    expect(help.exitCode, help.stderr).toBe(0);
    for (const fragment of [
      '--file <path>',
      '--tool <name>',
      '--scope <scope>',
      '--force',
      '--dry-run',
    ]) {
      expect(help.stdout).toContain(fragment);
    }

    const completion = await runCli(value, ['completion', 'bash']);
    expect(completion.exitCode, completion.stderr).toBe(0);
    expect(completion.stdout).toContain('init');

    const unsupported = json(
      await runCli(value, ['init', '--tool', 'kilo-code', '--json']),
      4,
      'init unsupported mutation tool',
    );
    expect(unsupported).toMatchObject({ kind: 'error', code: 'capability', exitCode: 4 });
  });

  test('singular selectors and scope sugar conflicts fail through shared JSON usage errors', async () => {
    const value = await fixture();
    for (const args of [
      ['init', '--file', 'a.toml', '--file', 'b.toml', '--json'],
      ['init', '--scope', 'user', '--user', '--json'],
      ['init', '--project', '--user', '--json'],
    ]) {
      const result = json(await runCli(value, args), 2, args.join(' '));
      expect(result).toMatchObject({ kind: 'error', exitCode: 2 });
    }
  });

  test('produced manifests immediately parse and their operation plans pass shared validation', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'validated.toml');
    const created = json(
      await runCli(value, ['init', '--file', manifest, '--tool', 'codex', '--json']),
      0,
      'validated init creation',
    );
    expect(created).toMatchObject({ result: { action: 'create-manifest' } });
    const source = await readFile(manifest, 'utf8');
    const document = readManifestSource(source);
    expect(document.ok).toBeTrue();
    if (!document.ok) return;
    expect(normalizeManifestDocument(document.value)).toMatchObject({
      ok: true,
      value: { version: 1, defaults: { tools: ['codex'] } },
    });

    const coordinator = await createTestNodeArtifactCoordinatorPorts(
      join(value.root, 'coordination-validation'),
    );
    const prepared = await prepareFilesystemInit(coordinator, manifest, {
      tools: ['codex'],
      force: true,
    });
    validateExecutionPlanShape(prepared.plan);
    expect(prepared.result).toMatchObject({ action: 'noop' });
    expect(prepared.plan.operations).toHaveLength(0);
  });

  test('permission and cancellation outcomes retain shared numeric exit mappings', async () => {
    const value = await fixture();
    const manifest = join(value.cwd, 'exit-map.toml');
    const cases = [
      {
        code: 'EACCES',
        expectedDiagnostic: 'init-observation-permission',
        exitClass: 'permission',
        exitCode: 6,
      },
      {
        code: 'ABORT_ERR',
        expectedDiagnostic: 'init-cancelled',
        exitClass: 'cancelled',
        exitCode: 130,
      },
    ] as const;
    for (const item of cases) {
      const coordinator = {
        observe: async () => {
          throw Object.assign(new Error('safe fixture failure'), { code: item.code });
        },
      } as unknown as ArtifactCoordinatorPorts;
      const context = await applicationContext(value, { artifactCoordinator: coordinator });
      const outcome = await runInitApplication(
        applicationRequest({ file: manifest, dryRun: true }),
        context,
      );
      expect(outcome).toMatchObject({
        report: null,
        exitClass: item.exitClass,
        diagnostics: [{ code: item.expectedDiagnostic }],
      });
      expect(exitCodeForClass(outcome.exitClass)).toBe(item.exitCode);
    }
  });
});
