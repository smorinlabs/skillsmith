import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultScanEnv } from '../../../packages/core/src/index.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const CORE_SRC = join(ROOT, 'packages/core/src');
const CLI_SRC = join(ROOT, 'packages/cli/src');
const PORTS_ROOT = join(CORE_SRC, 'ports');

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const readMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

const importMaybe = async (path: string): Promise<UnknownRecord | null> => {
  if ((await readMaybe(path)) === null) return null;
  try {
    const loaded = await import(`${pathToFileURL(path).href}?ewp-p1-ts08`);
    return loaded as UnknownRecord;
  } catch {
    return null;
  }
};

const typescriptFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat().sort();
};

const emptyScanEnv = () => ({
  homeDir: '/home/test',
  path: [] as string[],
  platform: 'linux' as const,
  xdg: { config: '/config', data: '/data', cache: '/cache' },
  fileExists: async () => false,
  realpath: async (path: string) => path,
  listDir: async () => [] as string[],
  readText: async () => '',
  runVersion: async () => 'unknown' as const,
  exec: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }),
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
  withFileLock: async <T>(_path: string, operation: () => Promise<T>) => operation(),
  modifiedAt: async () => null,
});

describe('EWP-P1-TS08', () => {
  test('the public 1.x ScanEnv compatibility facade remains usable', async () => {
    const env = await defaultScanEnv();
    expect(env.homeDir.length).toBeGreaterThan(0);
    expect(env.xdg.config.length).toBeGreaterThan(0);
    expect(env.fileExists).toBeFunction();
    expect(env.exec).toBeFunction();
    expect(env.withFileLock).toBeFunction();
  });

  test('public scoped ports and application context close without aggregate or raw environment bags', async () => {
    const [ports, coreIndex, application] = await Promise.all([
      readMaybe(join(PORTS_ROOT, 'types.ts')),
      readFile(join(CORE_SRC, 'index.ts'), 'utf8'),
      readFile(join(CORE_SRC, 'application/types.ts'), 'utf8'),
    ]);
    expect(ports, 'missing packages/core/src/ports/types.ts').not.toBeNull();
    const contract = ports ?? '';
    for (const name of [
      'PlatformPaths',
      'FileReadPort',
      'FileWritePort',
      'LockPort',
      'PathAccessPort',
      'ProcessPort',
      'GitPort',
      'HttpPort',
      'ClockPort',
      'IdPort',
      'RuntimePorts',
      'ResolvedRuntimeConfiguration',
    ]) {
      expect(contract, `missing public ${name}`).toMatch(
        new RegExp(`(?:interface|type)\\s+${name}\\b`),
      );
      expect(coreIndex, `core index does not export ${name}`).toContain(name);
    }
    expect(application).toContain('RuntimePorts');
    expect(application).toContain('ResolvedRuntimeConfiguration');
    expect(application).not.toMatch(/\benv\s*:\s*ScanEnv\b|\benvVars\s*:/);

    const scanEnvAllow = new Set([
      'packages/core/src/env/default.ts',
      'packages/core/src/env/types.ts',
      'packages/core/src/ports/compatibility.ts',
      'packages/core/src/index.ts',
      'packages/core/src/public-types.ts',
    ]);
    const runtimePortsAllow = new Set([
      'packages/core/src/env/default.ts',
      'packages/core/src/ports/types.ts',
      'packages/core/src/ports/default.ts',
      'packages/core/src/ports/compatibility.ts',
      'packages/core/src/application/types.ts',
      'packages/core/src/index.ts',
      'packages/core/src/public-types.ts',
      'packages/cli/src/runtime/context.ts',
    ]);
    const rawConfigurationAllow = new Set(['packages/core/src/config/runtime.ts']);
    const findings: string[] = [];
    for (const path of [
      ...(await typescriptFiles(CORE_SRC)),
      ...(await typescriptFiles(CLI_SRC)),
    ]) {
      const name = relative(ROOT, path);
      const source = await readFile(path, 'utf8');
      if (/\bScanEnv\b/.test(source) && !scanEnvAllow.has(name)) findings.push(`${name}: ScanEnv`);
      if (/\bRuntimePorts\b/.test(source) && !runtimePortsAllow.has(name))
        findings.push(`${name}: RuntimePorts`);
      if (/\benvVars\b/.test(source) && !rawConfigurationAllow.has(name))
        findings.push(`${name}: raw envVars request bag`);
    }
    expect(findings).toEqual([]);
  });

  test('a compile-negative focused read bundle cannot write, lock, or execute', async () => {
    const tsc = join(ROOT, 'node_modules/.bin/tsc');
    const fixture = join(ROOT, 'tests/ergonomics/fixtures/p1-ts08/tsconfig.json');
    const child = Bun.spawn([tsc, '-p', fixture, '--noEmit'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
    expect(exitCode, output).toBe(0);
  }, 30_000);

  test('focused read fakes and the ScanEnv compatibility adapter preserve behavior', async () => {
    const [compatibility, scans] = await Promise.all([
      importMaybe(join(PORTS_ROOT, 'compatibility.ts')),
      importMaybe(join(CORE_SRC, 'scan/list-skills.ts')),
    ]);
    expect(compatibility, 'missing ScanEnv compatibility adapter').not.toBeNull();
    expect(scans).not.toBeNull();
    const fromScanEnv = compatibility?.runtimePortsFromScanEnv;
    const listSkills = scans?.listSkills;
    expect(fromScanEnv).toBeFunction();
    expect(listSkills).toBeFunction();
    if (typeof fromScanEnv !== 'function' || typeof listSkills !== 'function') return;
    const fake = emptyScanEnv();
    const focused = {
      homeDir: fake.homeDir,
      executableSearchPath: fake.path,
      platform: fake.platform,
      xdg: fake.xdg,
      fileExists: fake.fileExists,
      pathKind: fake.pathKind,
      realpath: fake.realpath,
      listDir: fake.listDir,
      readText: fake.readText,
      readBytes: fake.readBytes,
      readLink: fake.readLink,
      isExecutable: fake.isExecutable,
      modifiedAt: fake.modifiedAt,
    };
    const compatibilityPorts = fromScanEnv(fake, {
      clock: {
        wallNowIso: () => '2026-07-12T00:00:00.000Z',
        epochMilliseconds: () => 0,
        monotonicMilliseconds: () => 0,
      },
      id: { nextId: () => 'fixture-1' },
    });
    const options = {
      cwd: '/project',
      configuration: Object.freeze({ configLayer: Object.freeze({}) }),
    };
    expect(await listSkills(compatibilityPorts, options)).toEqual(
      await listSkills(focused, options),
    );
    expect(focused).not.toHaveProperty('writeTextFile');
    expect(focused).not.toHaveProperty('withFileLock');
    expect(focused).not.toHaveProperty('exec');
    const deterministic = compatibilityPorts as {
      wallNowIso(): string;
      epochMilliseconds(): number;
      monotonicMilliseconds(): number;
      nextId(purpose: string): string;
    };
    expect(deterministic.wallNowIso()).toBe('2026-07-12T00:00:00.000Z');
    expect(deterministic.epochMilliseconds()).toBe(0);
    expect(deterministic.monotonicMilliseconds()).toBe(0);
    expect(deterministic.nextId('parity')).toBe('fixture-1');
  });

  test('default runtime ports and defaultScanEnv share one real adapter implementation', async () => {
    const [defaults, compatibility, legacy] = await Promise.all([
      readMaybe(join(PORTS_ROOT, 'default.ts')),
      readMaybe(join(PORTS_ROOT, 'compatibility.ts')),
      readFile(join(CORE_SRC, 'env/default.ts'), 'utf8'),
    ]);
    expect(defaults, 'missing sole production adapter composition').not.toBeNull();
    expect(compatibility, 'missing compatibility view').not.toBeNull();
    expect(defaults ?? '').toMatch(/defaultRuntimePorts/);
    expect(legacy).toMatch(/defaultRuntimePorts/);
    const realEffect = /from ['"]node:|Bun\.spawn|proper-lockfile|\bprocess\.(?:env|cwd|pid)\b/;
    expect(compatibility ?? '').not.toMatch(realEffect);
    expect(legacy).not.toMatch(realEffect);
  });

  test('typed configuration resolves only the exact whitelist and discards secret canaries', async () => {
    const runtimeConfig = await importMaybe(join(CORE_SRC, 'config/runtime.ts'));
    expect(runtimeConfig, 'missing typed runtime configuration resolver').not.toBeNull();
    const resolveConfiguration = runtimeConfig?.resolveRuntimeConfiguration;
    expect(resolveConfiguration).toBeFunction();
    if (typeof resolveConfiguration !== 'function') return;
    const secret = 'p17-secret-value-never-forward';
    const resolved = resolveConfiguration({
      SKILLSMITH_TOOL: 'codex',
      SKILLSMITH_SCOPE: 'project',
      SKILLSMITH_PATH: '/skills',
      SKILLSMITH_REGISTRY: 'stable',
      SKILLSMITH_CONFIG: '/project/skillsmith.toml',
      SKILLSMITH_HOME: '/state',
      CLAUDE_CONFIG_DIR: '/claude',
      CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
      CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/managed/settings.json',
      CODEX_HOME: '/codex',
      KILO_DISABLE_EXTERNAL_SKILLS: 'true',
      OPENCODE_CONFIG_DIR: '/opencode',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
      FORCE_COLOR: '1',
      NO_COLOR: '1',
      SKILLSMITH_E2E: '1',
      SKILLSMITH_TEST_PAUSE_AT: 'live',
      P17_SECRET_CANARY: secret,
    });
    expect(Object.isFrozen(resolved)).toBeTrue();
    expect(Object.isFrozen(resolved.configLayer)).toBeTrue();
    expect(Object.keys(resolved).sort()).toEqual(
      [
        'configLayer',
        'explicitConfigPath',
        'skillsmithHome',
        'claudeConfigDir',
        'claudePolicySkillsDisabled',
        'claudeManagedSettingsPath',
        'codexHome',
        'kiloExternalSkillsDisabled',
        'opencodeConfigDir',
        'opencodeClaudeSkillsDisabled',
        'forceColor',
        'noColor',
        'journalPause',
      ].sort(),
    );
    expect(Object.keys(resolved.configLayer).sort()).toEqual(
      ['tool', 'scope', 'path', 'registry'].sort(),
    );
    expect(JSON.stringify(resolved)).not.toContain('P17_SECRET_CANARY');
    expect(JSON.stringify(resolved)).not.toContain(secret);
    expect(resolved).toMatchObject({
      configLayer: {
        tool: 'codex',
        scope: 'project',
        path: '/skills',
        registry: { default: 'stable' },
      },
      explicitConfigPath: '/project/skillsmith.toml',
      skillsmithHome: '/state',
      claudeConfigDir: '/claude',
      claudePolicySkillsDisabled: true,
      claudeManagedSettingsPath: '/managed/settings.json',
      codexHome: '/codex',
      kiloExternalSkillsDisabled: true,
      opencodeConfigDir: '/opencode',
      opencodeClaudeSkillsDisabled: true,
      forceColor: true,
      noColor: true,
      journalPause: 'live',
    });
    expect(
      resolveConfiguration({
        KILO_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      }),
    ).toMatchObject({
      kiloExternalSkillsDisabled: false,
      opencodeClaudeSkillsDisabled: false,
    });
  });

  test('Git and HTTP domain code use intent-level ports rather than raw argv or fetch', async () => {
    const [gitContract, networkCheck] = await Promise.all([
      readMaybe(join(PORTS_ROOT, 'git.ts')),
      readFile(join(CORE_SRC, 'doctor/checks/network-reach.ts'), 'utf8'),
    ]);
    expect(gitContract, 'missing high-level GitPort adapter').not.toBeNull();
    for (const operation of [
      'findRepositoryRoot',
      'inspectWorktree',
      'inspectRemoteRef',
      'resolveRemoteRef',
      'initializeFetch',
      'fetchRef',
      'listTree',
      'readBlob',
      'materializeTree',
    ])
      expect(gitContract ?? '', `missing GitPort operation ${operation}`).toContain(operation);

    const allow = new Set([
      'packages/core/src/env/git.ts',
      // Private account-helper process adapter; it does not execute Git or accept Git argv.
      'packages/core/src/artifacts/node-coordinator.ts',
      'packages/core/src/ports/default.ts',
      'packages/core/src/ports/git.ts',
      'packages/core/src/ports/compatibility.ts',
    ]);
    const rawGit =
      /\bexecGit\b|\bBun\.spawn(?:Sync)?\s*\(|\bexec\s*\(\s*['"]git['"]|from ['"]node:child_process['"]/;
    const gitDomain = new Set([
      'packages/core/src/acquire/fetch.ts',
      'packages/core/src/acquire/run.ts',
      'packages/core/src/place/store.ts',
      'packages/core/src/context/project.ts',
    ]);
    const findings: string[] = [];
    for (const path of await typescriptFiles(CORE_SRC)) {
      const name = relative(ROOT, path);
      if (allow.has(name)) continue;
      const source = await readFile(path, 'utf8');
      if (rawGit.test(source)) findings.push(`${name}: raw Git execution`);
      if (
        gitDomain.has(name) &&
        /\bProcessPort\b|\.exec\b|\[\s*['"]exec['"]\s*\]|\{[\s\S]{0,120}\bexec\s*(?::\s*\w+)?\s*[,}]/.test(
          source,
        )
      )
        findings.push(`${name}: arbitrary process access in Git domain`);
    }
    expect(findings).toEqual([]);
    expect(networkCheck).toContain('HttpPort');
    expect(networkCheck).not.toMatch(/\bfetch\s*\(/);
  });

  test('real adapter failures are safe structured PortError values', async () => {
    const [defaults, errors] = await Promise.all([
      importMaybe(join(PORTS_ROOT, 'default.ts')),
      importMaybe(join(PORTS_ROOT, 'errors.ts')),
    ]);
    expect(defaults, 'missing defaultRuntimePorts').not.toBeNull();
    expect(errors, 'missing PortError helpers').not.toBeNull();
    const build = defaults?.defaultRuntimePorts;
    const isPortError = errors?.isPortError;
    expect(build).toBeFunction();
    expect(isPortError).toBeFunction();
    if (typeof build !== 'function' || typeof isPortError !== 'function') return;
    const ports = (await build()) as {
      readText(path: string): Promise<string>;
      exec(command: string, args: readonly string[]): Promise<unknown>;
      git: {
        readBlob(request: {
          repositoryRoot: string;
          ref: string;
          path: string;
        }): Promise<unknown>;
      };
      http: {
        request(request: {
          url: string;
          method: string;
          headers: Readonly<Record<string, string>>;
          timeoutMs: number;
        }): Promise<unknown>;
      };
    };
    const capture = async (operation: () => Promise<unknown>): Promise<unknown> => {
      try {
        await operation();
      } catch (error) {
        return error;
      }
      return null;
    };
    const failures = [
      {
        expected: { capability: 'file-read', operation: 'readText' },
        value: await capture(() => ports.readText('/definitely/missing/p17-port-error')),
      },
      {
        expected: { capability: 'process', operation: 'exec' },
        value: await capture(() => ports.exec('/definitely/missing/p17-command', [])),
      },
      {
        expected: { capability: 'git', operation: 'readBlob' },
        value: await capture(() =>
          ports.git.readBlob({
            repositoryRoot: '/definitely/missing/p17-repository',
            ref: 'HEAD',
            path: 'SKILL.md',
          }),
        ),
      },
      {
        expected: { capability: 'http', operation: 'request' },
        value: await capture(() =>
          ports.http.request({
            url: 'not a valid URL',
            method: 'GET',
            headers: {},
            timeoutMs: 100,
          }),
        ),
      },
    ];
    const codes = new Set([
      'not-found',
      'permission',
      'unavailable',
      'timeout',
      'cancelled',
      'conflict',
      'invalid',
      'io',
    ]);
    for (const failure of failures) {
      expect(isPortError(failure.value), JSON.stringify(failure.expected)).toBeTrue();
      expect(failure.value).toMatchObject(failure.expected);
      expect(record(failure.value) && 'cause' in failure.value).toBeFalse();
      expect(record(failure.value) && codes.has(failure.value.code as string)).toBeTrue();
      expect(record(failure.value) && typeof failure.value.message === 'string').toBeTrue();
      const context = record(failure.value) ? failure.value.context : null;
      expect(record(context)).toBeTrue();
      expect(
        record(context) &&
          Object.values(context).every(
            (value) =>
              value === null ||
              typeof value === 'string' ||
              typeof value === 'number' ||
              typeof value === 'boolean',
          ),
      ).toBeTrue();
      const serialized = JSON.stringify(failure.value);
      expect(serialized).not.toMatch(/"(?:cause|stack)"|p17-secret-value-never-forward/);
    }
  });

  test('clock and ID dependencies replace ambient time and randomness in domain code', async () => {
    const [ledgerModule, fetchModule] = await Promise.all([
      importMaybe(join(CORE_SRC, 'place/ledger.ts')),
      importMaybe(join(CORE_SRC, 'acquire/fetch.ts')),
    ]);
    expect(ledgerModule).not.toBeNull();
    expect(fetchModule).not.toBeNull();
    const emptyLedgerModel = ledgerModule?.emptyLedgerModel;
    const writeLedger = ledgerModule?.writeLedger;
    const sweepFetchOrphans = fetchModule?.sweepFetchOrphans;
    expect(emptyLedgerModel).toBeFunction();
    expect(writeLedger).toBeFunction();
    expect(sweepFetchOrphans).toBeFunction();
    if (
      typeof emptyLedgerModel !== 'function' ||
      typeof writeLedger !== 'function' ||
      typeof sweepFetchOrphans !== 'function'
    )
      return;
    const fixedNow = '2026-07-12T01:02:03.000Z';
    const fixedId = 'p17-fixed-ledger-id';
    const writes: Array<{ path: string; text: string }> = [];
    const purposes: string[] = [];
    const effectPorts = {
      writeTextFile: async (path: string, text: string) => writes.push({ path, text }),
      fsyncFile: async () => {},
      rename: async () => {},
      fsyncDir: async () => {},
      removeTree: async () => {},
      wallNowIso: () => fixedNow,
      epochMilliseconds: () => 123,
      monotonicMilliseconds: () => 456,
      nextId: (purpose: string) => {
        purposes.push(purpose);
        return fixedId;
      },
    };
    const writeResult = await writeLedger(
      effectPorts,
      '/state/placements.json',
      emptyLedgerModel('earlier'),
    );
    expect(writeResult).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toContain(fixedId);
    expect(writes[0]?.text).toContain(fixedNow);
    expect(purposes).toHaveLength(1);
    expect(purposes[0]?.length).toBeGreaterThan(0);

    const removed: string[] = [];
    await sweepFetchOrphans(
      {
        pathKind: async () => 'dir',
        listDir: async () => ['fresh', 'stale'],
        modifiedAt: async (path: string) => (path.endsWith('/fresh') ? 9_500_000 : 1_000),
        removeTree: async (path: string) => {
          removed.push(path);
        },
        epochMilliseconds: () => 10_000_000,
      },
      '/state',
    );
    expect(removed).toEqual(['/state/.fetch/stale']);

    const allow = new Set([
      // Parses injected timestamps for journal canonicalization; neither module reads now.
      'packages/core/src/acquire/run.ts',
      'packages/core/src/acquire/uninstall.ts',
      'packages/core/src/application/gc-service.ts',
      'packages/core/src/gc/execute.ts',
      'packages/core/src/place/execute.ts',
      'packages/core/src/place/run.ts',
      'packages/core/src/place/ledger-migration.ts',
      // Focused production ID adapter for private artifact coordination.
      'packages/core/src/artifacts/node-coordinator.ts',
      // Focused private durable ledger adapter owns its production fallback IDs.
      'packages/core/src/artifacts/ledger-writer.ts',
      'packages/core/src/ports/default.ts',
      // Parses an injected wall-clock value to enforce canonical UTC ISO form; it never reads now.
      'packages/core/src/observation/operation-context.ts',
    ]);
    const pattern =
      /\bDate\.now\s*\(|\bnew Date\s*\(|\bDate\s*\(|\bperformance\.now\s*\(|\bBun\.nanoseconds\s*\(|\bMath\.random\s*\(|\brandomUUID\b|\brandomBytes\b|\brandomFill\b|\brandomInt\b|\bgetRandomValues\b|\bprocess\.(?:pid|hrtime|uptime)\b|\bTemporal\.Now\b/;
    const findings: string[] = [];
    for (const path of await typescriptFiles(CORE_SRC)) {
      const name = relative(ROOT, path);
      if (allow.has(name)) continue;
      const source = await readFile(path, 'utf8');
      if (pattern.test(source)) findings.push(name);
    }
    expect(findings).toEqual([]);
  });

  test('lint gates own ambient effects, compatibility imports, and real adapters', async () => {
    const negativeSource = [
      "import { defaultRuntimePorts } from './ports/default.ts';",
      "import type { ScanEnv } from './env/types.ts';",
      "import type { RuntimePorts } from './ports/types.ts';",
      'void process.env;',
      'void process.cwd();',
      'void Date.now();',
      'void Math.random();',
      'void crypto.randomUUID();',
      'void process.getuid?.();',
      "void fetch('https://example.invalid');",
      'void defaultRuntimePorts; void (null as unknown as ScanEnv); void (null as unknown as RuntimePorts);',
    ].join('\n');
    const lintChild = Bun.spawn(
      [
        join(ROOT, 'node_modules/.bin/eslint'),
        '--stdin',
        '--stdin-filename',
        'packages/core/src/p17-lint-negative.ts',
        '--format',
        'json',
      ],
      { cwd: ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    lintChild.stdin.write(negativeSource);
    lintChild.stdin.end();
    const lintExit = await lintChild.exited;
    const lintStdout = await new Response(lintChild.stdout).text();
    const lintStderr = await new Response(lintChild.stderr).text();
    expect(lintExit, `${lintStdout}\n${lintStderr}`).toBe(1);
    const lintReports = JSON.parse(lintStdout) as Array<{
      messages: Array<{ line: number }>;
    }>;
    const rejectedLines = new Set(
      lintReports.flatMap((report) => report.messages.map((m) => m.line)),
    );
    for (let line = 1; line <= 10; line += 1)
      expect(rejectedLines, `ESLint did not reject negative canary line ${line}`).toContain(line);

    const eslint = await readFile(join(ROOT, 'eslint.config.js'), 'utf8');
    for (const required of [
      'process.env',
      'process.cwd',
      'process.getuid',
      'ScanEnv',
      'RuntimePorts',
      'Date.now',
      'Math.random',
      'randomUUID',
      'fetch',
      'ports/default',
    ])
      expect(eslint, `missing lint ownership for ${required}`).toContain(required);

    const processAllow = new Set([
      'packages/core/src/ports/default.ts',
      'packages/cli/src/runtime/context.ts',
      'packages/cli/src/runtime/presentation.ts',
    ]);
    const fetchAllow = new Set(['packages/core/src/ports/http.ts']);
    const uidAllow = new Set(['packages/core/src/ports/default.ts']);
    const realImplementationAllow = new Set([
      'packages/core/src/artifacts/node-coordinator.ts',
      'packages/core/src/artifacts/recovery-file.ts',
      // Focused private adapter for durable ledger replacement and recovery.
      'packages/core/src/artifacts/ledger-writer.ts',
      'packages/core/src/ports/default.ts',
    ]);
    const defaultAdapterImportAllow = new Set([
      'packages/core/src/env/default.ts',
      'packages/core/src/index.ts',
      'packages/cli/src/runtime/context.ts',
    ]);
    const realEffectImport =
      /from ['"]node:(?:fs|child_process|os)(?:\/[^'"]*)?['"]|from ['"]proper-lockfile['"]|\bBun\.spawn(?:Sync)?\s*\(/;
    const rawFindings: string[] = [];
    for (const path of [
      ...(await typescriptFiles(CORE_SRC)),
      ...(await typescriptFiles(CLI_SRC)),
    ]) {
      const name = relative(ROOT, path);
      const source = await readFile(path, 'utf8');
      if (/\bprocess\.(?:env|cwd)\b/.test(source) && !processAllow.has(name))
        rawFindings.push(`${name}: raw process environment`);
      if (/\bprocess\.getuid\b/.test(source) && !uidAllow.has(name))
        rawFindings.push(`${name}: ambient uid probe`);
      if (/\bfetch\s*\(/.test(source) && !fetchAllow.has(name))
        rawFindings.push(`${name}: ambient fetch`);
      if (realEffectImport.test(source) && !realImplementationAllow.has(name))
        rawFindings.push(`${name}: real effect implementation outside reviewed adapters`);
      if (/ports\/default(?:\.ts)?['"]/.test(source) && !defaultAdapterImportAllow.has(name))
        rawFindings.push(`${name}: real adapter import outside composition`);
    }
    expect(rawFindings).toEqual([]);
  }, 30_000);
});
