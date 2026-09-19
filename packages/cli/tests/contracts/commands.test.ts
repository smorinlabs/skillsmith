import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Command } from 'commander';

const ROOT = join(import.meta.dir, '../../../..');
const FIXTURE_ROOT = join(ROOT, 'tests/ergonomics/fixtures/g3a02-contracts');

const LITERAL_GUARDS = Object.freeze([
  Object.freeze({
    path: join(FIXTURE_ROOT, 'commands-fleet.json'),
    bytes: 8042,
    sha256: '61350b30c5b9b4627703f5a3a0aae8158701398e7bfb99f359738e25be328ac5',
  }),
  Object.freeze({
    path: join(FIXTURE_ROOT, 'commands-compact.golden.txt'),
    bytes: 674,
    sha256: 'ff36d36063dd9d46cfb93c39f99813c0c13234889e1b95c750288979aaafbc18',
  }),
  Object.freeze({
    path: join(FIXTURE_ROOT, 'commands-long.golden.txt'),
    bytes: 3930,
    sha256: '11dd262778e9a518d9f7e0a81e4f8e2ea29f40753217b5373b1cc84d13893070',
  }),
  Object.freeze({
    path: join(FIXTURE_ROOT, 'commands-v2.golden.json'),
    bytes: 8181,
    sha256: 'c9b0b013a923c2950b9a1cf05be4437b195d77dc099e535824f61b4d92e89a1a',
  }),
]);

const FAMILY_ALLOCATION = Object.freeze({
  'EWP-CMD-COMMANDS-TS01': Object.freeze([
    'family 33: compact, long, empty, and canonical rendering',
    'family 34: commands@2 complete strict JSON and historical commands@1 stability',
  ]),
  'EWP-CMD-COMMANDS-TS02': Object.freeze([
    'family 35: tool, scope, glob, enabled-state, relation, and filter-noop matrices',
    'family 36: shared project-root invariance across root, nested, -C, worktree, and symlink contexts',
  ]),
  'EWP-CMD-COMMANDS-TS03': Object.freeze([
    'family 37: invalid input and known unsupported capability refusal before I/O',
    'family 38: semantic failures, cancellation, multi-error precedence, and read-only effects',
  ]),
  'EWP-CMD-COMMANDS-TS04': Object.freeze([
    'family 39: plugin, standalone, local-project, alias, shared-target, and provenance conflicts',
    'family 40: generated 4096-command completeness, compact bound, repeat identity, and linear reads',
  ]),
});

type UnknownRecord = Record<string, unknown>;
type ReadonlyUnknownRecord = Readonly<Record<string, unknown>>;
type RunCommandsApplication = (
  request: ReadonlyUnknownRecord,
  context: ReadonlyUnknownRecord,
) => Promise<ReadonlyUnknownRecord>;
type ValidateOptionInvocation = (
  command: string,
  args: readonly string[],
) =>
  | Readonly<{ readonly ok: true }>
  | Readonly<{ readonly ok: false; readonly error: UnknownRecord }>;
type CommandRenderer = Readonly<{
  human(outcome: ReadonlyUnknownRecord): unknown;
  json(outcome: ReadonlyUnknownRecord): unknown;
}>;
type CommandSpec = Readonly<{
  readonly path: string;
  readonly options: readonly ReadonlyUnknownRecord[];
}>;
type WireRegistry = Readonly<{
  forCommand(command: string):
    | Readonly<{
        readonly descriptor: ReadonlyUnknownRecord;
        validate(value: unknown): ReadonlyUnknownRecord;
        encode(value: unknown): ReadonlyUnknownRecord;
      }>
    | undefined;
}>;

interface CommandsFixture {
  readonly selection: ReadonlyUnknownRecord;
  readonly entries: readonly UnknownRecord[];
}

interface PortBehavior {
  readonly fileExists?: (path: string) => boolean | Promise<boolean>;
  readonly listDir?: (path: string) => readonly string[] | Promise<readonly string[]>;
  readonly readText?: (path: string) => string | Promise<string>;
  readonly realpath?: (path: string) => string | Promise<string>;
}

interface PortCounts {
  fileExists: number;
  listDir: number;
  readText: number;
  realpath: number;
  writes: number;
}

let fixture: CommandsFixture;
let compactGolden: string;
let longGolden: string;
let commandsV2GoldenText: string;
let commandsV2Golden: UnknownRecord;
let runCommandsApplication: RunCommandsApplication;
let validateOptionInvocation: ValidateOptionInvocation;
let commandRenderer: CommandRenderer;
let currentCommandSpecs: readonly CommandSpec[];
let currentOptionRelations: readonly ReadonlyUnknownRecord[];
let currentWireCommandMappings: readonly ReadonlyUnknownRecord[];
let currentWireContractRegistry: WireRegistry;
let commandsV1Codec: ReadonlyUnknownRecord;
let toCommandsV1Dto: (report: ReadonlyUnknownRecord) => UnknownRecord;

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';
  const output = value as ReadonlyUnknownRecord;
  return [output.stdout, output.stderr]
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .join('');
};

const outcome = (report: ReadonlyUnknownRecord): ReadonlyUnknownRecord =>
  Object.freeze({
    report,
    diagnostics: Object.freeze([]),
    exitClass: 'success',
    mutation: Object.freeze({
      kind: 'none',
      planned: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
    }),
    deprecations: Object.freeze([]),
  });

const request = (
  names: readonly string[] = [],
  options: Readonly<Record<string, unknown>> = {},
): ReadonlyUnknownRecord => Object.freeze({ arguments: Object.freeze([names]), options });

const projectContext = (
  invocationCwd: string,
  effectiveCwd: string,
  projectRoot: string | null,
  projectKind: 'git' | 'none' = projectRoot === null ? 'none' : 'git',
): ReadonlyUnknownRecord =>
  Object.freeze({
    invocationCwd,
    effectiveCwd,
    projectRoot,
    projectIdentity: projectRoot,
    projectKind,
    discoveredConfigPath: null,
    explicitConfigPath: null,
  });

const effectiveConfig = (tool = 'claude-code'): ReadonlyUnknownRecord =>
  Object.freeze({
    value: Object.freeze({ tool }),
    sources: Object.freeze({ tool: 'user' }),
    layers: Object.freeze({
      defaults: Object.freeze({}),
      system: Object.freeze({}),
      user: Object.freeze({ tool }),
      project: Object.freeze({}),
      'explicit-file': Object.freeze({}),
      env: Object.freeze({}),
      cli: Object.freeze({}),
    }),
    paths: Object.freeze({}),
  });

const runtimeConfiguration = (): ReadonlyUnknownRecord =>
  Object.freeze({
    configLayer: Object.freeze({}),
    explicitConfigPath: undefined,
    skillsmithHome: undefined,
    claudeConfigDir: undefined,
    claudePolicySkillsDisabled: false,
    claudeManagedSettingsPath: undefined,
    codexHome: undefined,
    kiloExternalSkillsDisabled: false,
    opencodeConfigDir: undefined,
    opencodeClaudeSkillsDisabled: false,
    forceColor: false,
    noColor: true,
    journalPause: undefined,
  });

const makePorts = (
  behavior: PortBehavior = {},
  homeDir = '/home/alice',
): Readonly<{ readonly ports: ReadonlyUnknownRecord; readonly counts: PortCounts }> => {
  const counts: PortCounts = { fileExists: 0, listDir: 0, readText: 0, realpath: 0, writes: 0 };
  const writeTrap = async (): Promise<never> => {
    counts.writes += 1;
    throw new Error('commands inventory attempted a write');
  };
  const ports: ReadonlyUnknownRecord = {
    homeDir,
    executableSearchPath: Object.freeze([]),
    platform: 'linux',
    xdg: Object.freeze({
      config: join(homeDir, '.config'),
      data: join(homeDir, '.local/share'),
      cache: join(homeDir, '.cache'),
    }),
    fileExists: async (path: string) => {
      counts.fileExists += 1;
      return (await behavior.fileExists?.(path)) ?? false;
    },
    listDir: async (path: string) => {
      counts.listDir += 1;
      return (await behavior.listDir?.(path)) ?? [];
    },
    readText: async (path: string) => {
      counts.readText += 1;
      return (await behavior.readText?.(path)) ?? '';
    },
    realpath: async (path: string) => {
      counts.realpath += 1;
      return (await behavior.realpath?.(path)) ?? path;
    },
    pathKind: async () => 'absent',
    readBytes: async () => new Uint8Array(),
    readLink: async () => '',
    isExecutable: async () => false,
    modifiedAt: async () => null,
    readFileMetadata: async () => Object.freeze({ kind: 'absent', mode: null, identity: null }),
    assertWritableDirectory: writeTrap,
    makeDir: writeTrap,
    writeTextFile: writeTrap,
    makeSymlink: writeTrap,
    rename: writeTrap,
    copyTree: writeTrap,
    removeTree: writeTrap,
    fsyncFile: writeTrap,
    fsyncDir: writeTrap,
    setFileMode: writeTrap,
    withFileLock: async () => writeTrap(),
    exec: async () => {
      throw new Error('commands inventory attempted generic execution');
    },
    runVersion: async () => 'unknown',
    wallNowIso: () => '2026-07-15T00:00:00.000Z',
    epochMilliseconds: () => 0,
    monotonicMilliseconds: () => 0,
    nextId: () => 'commands-contract',
    git: Object.freeze({
      findRepositoryRoot: async () => null,
      inspectWorktree: async () =>
        Object.freeze({
          repositoryRoot: '/repo',
          headSha: 'a'.repeat(40),
          remoteUrl: null,
          dirtySummary: null,
        }),
      resolveRemoteRef: async () => null,
      initializeFetch: async () => writeTrap(),
      fetchRef: async () => writeTrap(),
      listTree: async () => [],
      readBlob: async () => new Uint8Array(),
      materializeTree: async () => writeTrap(),
    }),
    http: Object.freeze({ request: async () => ({ status: 200, ok: true }) }),
  };
  return Object.freeze({ ports: Object.freeze(ports), counts });
};

const contextFor = (
  ports: ReadonlyUnknownRecord,
  project: ReadonlyUnknownRecord = projectContext('/repo', '/repo', '/repo'),
  signal?: AbortSignal,
): ReadonlyUnknownRecord =>
  Object.freeze({
    ports,
    configuration: runtimeConfiguration(),
    interaction: Object.freeze({
      mode: 'noninteractive',
      choose: async () => Object.freeze({ status: 'refused', reason: 'not used' }),
      confirm: async () => Object.freeze({ status: 'refused', reason: 'not used' }),
    }),
    invocationCwd: project.invocationCwd,
    globalOptions: Object.freeze({}),
    projectContext: project,
    effectiveConfig: effectiveConfig(),
    ...(signal === undefined ? {} : { signal }),
  });

const poisonedContext = (): ReadonlyUnknownRecord =>
  new Proxy({} as UnknownRecord, {
    get: (_target, property) => {
      throw new Error(`unexpected I/O context access: ${String(property)}`);
    },
  });

const captureRun = async (
  commandRequest: ReadonlyUnknownRecord,
  context: ReadonlyUnknownRecord,
): Promise<ReadonlyUnknownRecord> => {
  try {
    return Object.freeze({
      kind: 'outcome',
      value: await runCommandsApplication(commandRequest, context),
    });
  } catch (error) {
    return Object.freeze({ kind: 'throw', error: String(error) });
  }
};

const semanticResult = (captured: ReadonlyUnknownRecord): ReadonlyUnknownRecord => {
  if (captured.kind !== 'outcome') return captured;
  const value = captured.value as ReadonlyUnknownRecord;
  const report = value.report as ReadonlyUnknownRecord;
  const diagnostics = value.diagnostics as readonly ReadonlyUnknownRecord[];
  return Object.freeze({
    kind: 'outcome',
    exitClass: value.exitClass,
    diagnostic: diagnostics[0]?.code ?? null,
    entries: Array.isArray(report.entries) ? report.entries.length : null,
    selection: report.selection ?? null,
    mutation: (value.mutation as ReadonlyUnknownRecord).kind,
  });
};

beforeAll(async () => {
  // Literal fixture integrity is established before any planned production authority is imported.
  for (const guard of LITERAL_GUARDS) {
    const bytes = await Bun.file(guard.path).arrayBuffer();
    expect(bytes.byteLength, guard.path).toBe(guard.bytes);
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), guard.path).toBe(
      guard.sha256,
    );
  }
  expect(Object.keys(FAMILY_ALLOCATION)).toEqual([
    'EWP-CMD-COMMANDS-TS01',
    'EWP-CMD-COMMANDS-TS02',
    'EWP-CMD-COMMANDS-TS03',
    'EWP-CMD-COMMANDS-TS04',
  ]);
  expect(Object.values(FAMILY_ALLOCATION).flat()).toHaveLength(8);
  expect(new Set(Object.values(FAMILY_ALLOCATION).flat()).size).toBe(8);

  fixture = JSON.parse(await Bun.file(LITERAL_GUARDS[0]?.path ?? '').text()) as CommandsFixture;
  compactGolden = await Bun.file(LITERAL_GUARDS[1]?.path ?? '').text();
  longGolden = await Bun.file(LITERAL_GUARDS[2]?.path ?? '').text();
  commandsV2GoldenText = await Bun.file(LITERAL_GUARDS[3]?.path ?? '').text();
  commandsV2Golden = JSON.parse(commandsV2GoldenText) as UnknownRecord;
  expect(fixture.entries).toHaveLength(16);
  expect(new Set(fixture.entries.map((entry) => `${entry.tool}:${entry.scope}`)).size).toBe(8);
  expect(new Set(fixture.entries.map((entry) => entry.enabled))).toEqual(
    new Set(['on', 'off', 'unset']),
  );
  expect(compactGolden.split('\n')).toHaveLength(23);
  expect(longGolden.split('\n')).toHaveLength(23);
  expect(commandsV2Golden).toMatchObject({
    schemaVersion: 2,
    kind: 'skillsmith.commands',
    summary: { total: 16 },
  });
  expect(commandsV2GoldenText).toBe(`${JSON.stringify(commandsV2Golden, null, 2)}\n`);

  const [applicationModule, rendererModule, specModule, v1Module, wireModule] = await Promise.all([
    import('../../../core/src/application/read-services.ts'),
    import('../../src/runtime/current-renderers.ts'),
    import('../../src/spec/index.ts'),
    import('../../../core/src/contracts/v1/commands.ts'),
    import('../../src/contracts/wire-contracts.ts'),
  ]);
  runCommandsApplication =
    applicationModule.runCommandsApplication as unknown as RunCommandsApplication;
  validateOptionInvocation =
    specModule.validateOptionInvocation as unknown as ValidateOptionInvocation;
  currentCommandSpecs = specModule.CURRENT_COMMAND_SPECS as unknown as readonly CommandSpec[];
  currentOptionRelations =
    specModule.CURRENT_OPTION_RELATIONS as unknown as readonly ReadonlyUnknownRecord[];
  currentWireCommandMappings =
    wireModule.currentWireCommandMappings as unknown as readonly ReadonlyUnknownRecord[];
  currentWireContractRegistry = wireModule.currentWireContractRegistry as unknown as WireRegistry;
  commandsV1Codec = v1Module.commandsV1Codec as unknown as ReadonlyUnknownRecord;
  toCommandsV1Dto = v1Module.toCommandsV1Dto as unknown as (
    report: ReadonlyUnknownRecord,
  ) => UnknownRecord;
  commandRenderer = (
    rendererModule.createCurrentRendererRegistry(new Command()) as unknown as Readonly<{
      commands: CommandRenderer;
    }>
  ).commands;
});

describe('EWP-CMD-COMMANDS-TS01', () => {
  test('family 33: compact, long, empty, and canonical rendering', () => {
    const compact = textOf(commandRenderer.human(outcome({ ...fixture, long: false })));
    const long = textOf(commandRenderer.human(outcome({ ...fixture, long: true })));
    const reversed = textOf(
      commandRenderer.human(
        outcome({
          ...fixture,
          entries: Object.freeze([...fixture.entries].reverse()),
          long: false,
        }),
      ),
    );
    const empty = textOf(
      commandRenderer.human(
        outcome({
          selection: { ...fixture.selection, outcome: 'selected' },
          entries: Object.freeze([]),
          long: false,
        }),
      ),
    );
    expect({ compact, long, reversed, empty }).toEqual({
      compact: compactGolden,
      long: longGolden,
      reversed: compactGolden,
      empty: 'No slash commands installed.\n',
    });
  });

  test('family 34: commands@2 complete strict JSON and historical commands@1 stability', () => {
    const rendered = textOf(commandRenderer.json(outcome({ ...fixture, long: false })));
    const renderedLong = textOf(commandRenderer.json(outcome({ ...fixture, long: true })));
    const selected = currentWireContractRegistry.forCommand('skillsmith commands');
    const historicalDto = toCommandsV1Dto({ entries: fixture.entries, long: false });
    const historicalDescriptor = commandsV1Codec.descriptor as ReadonlyUnknownRecord;
    const historicalEncoded = (commandsV1Codec.encode as (value: unknown) => ReadonlyUnknownRecord)(
      historicalDto,
    );
    const historicalText = historicalEncoded.value as string;
    const topLevelUnknown = { ...commandsV2Golden, future: true };
    const nestedUnknown = structuredClone(commandsV2Golden);
    const nestedEntries = nestedUnknown.entries as UnknownRecord[];
    nestedEntries[0] = { ...nestedEntries[0], future: true };
    const futureVersion = { ...commandsV2Golden, schemaVersion: 3 };
    expect({
      bytes: rendered,
      parsed: JSON.parse(rendered),
      longIdentity: renderedLong,
      terminalLf: rendered.endsWith('\n'),
      descriptor: selected?.descriptor,
      mapping: currentWireCommandMappings.find(
        (candidate) => candidate.commandPath === 'skillsmith commands',
      ),
      historical: {
        descriptor: historicalDescriptor,
        dto: historicalDto,
        encoded: historicalEncoded.ok,
        bytes: historicalText.length,
        sha256: new Bun.CryptoHasher('sha256').update(historicalText).digest('hex'),
      },
      strict: {
        current: selected?.validate(commandsV2Golden).ok,
        topLevelUnknown: selected?.validate(topLevelUnknown).ok,
        nestedUnknown: selected?.validate(nestedUnknown).ok,
        futureVersion: selected?.validate(futureVersion).ok,
      },
    }).toEqual({
      bytes: commandsV2GoldenText,
      parsed: commandsV2Golden,
      longIdentity: commandsV2GoldenText,
      terminalLf: true,
      descriptor: expect.objectContaining({
        id: 'commands',
        version: 2,
        wireKind: 'skillsmith.commands',
        unknownFields: 'reject-recursive',
      }),
      mapping: expect.objectContaining({
        commandPath: 'skillsmith commands',
        contractId: 'commands',
        version: 2,
      }),
      historical: {
        descriptor: expect.objectContaining({ id: 'commands', version: 1 }),
        dto: expect.objectContaining({ schemaVersion: 1, commands: expect.any(Array) }),
        encoded: true,
        bytes: 7166,
        sha256: '399832c8d8b3764c3a9f732b16e58c14b9f73940296464426d693d309bbcaa58',
      },
      strict: {
        current: true,
        topLevelUnknown: false,
        nestedUnknown: false,
        futureVersion: false,
      },
    });
  });
});

describe('EWP-CMD-COMMANDS-TS02', () => {
  test('family 35: tool, scope, glob, enabled-state, relation, and filter-noop matrices', async () => {
    const spec = currentCommandSpecs.find((candidate) => candidate.path === 'skillsmith commands');
    const optionNames = spec?.options.map((option) => option.long) ?? [];
    const relationKinds = currentOptionRelations
      .filter((relation) => relation.command === 'skillsmith commands')
      .map((relation) => relation.kind);
    const invocationMatrix = [
      validateOptionInvocation('skillsmith commands', ['--enabled', '--disabled']),
      validateOptionInvocation('skillsmith commands', ['--scope', 'user', '--project']),
      validateOptionInvocation('skillsmith commands', ['--tool', 'codex', '--tool', 'claude-code']),
    ];
    const { ports, counts } = makePorts();
    const filtered = semanticResult(
      await captureRun(request(['missing-*'], { enabled: true }), contextFor(ports)),
    );
    const userRoot = '/home/alice/.claude/commands';
    const projectRoot = '/repo/.claude/commands';
    const directories: Record<string, readonly string[]> = {
      [userRoot]: ['beta.md', 'alpha.md'],
      [projectRoot]: ['gamma.md', 'alpha.md'],
    };
    const matrixPorts = makePorts({
      fileExists: (path) =>
        path in directories ||
        path.endsWith('/alpha.md') ||
        path.endsWith('/beta.md') ||
        path.endsWith('/gamma.md'),
      listDir: (path) => directories[path] ?? [],
      readText: (path) =>
        `---\ndescription: ${path.slice(path.lastIndexOf('/') + 1, -3)} command\n---\n`,
    });
    const filterMatrix = await Promise.all([
      captureRun(request(['alpha'], { scope: 'user' }), contextFor(matrixPorts.ports)),
      captureRun(request(['a*', 'gamma'], { scope: 'project' }), contextFor(matrixPorts.ports)),
      captureRun(
        request([], { scope: 'user', tool: ['claude-code', 'claude-code'], enabled: true }),
        contextFor(matrixPorts.ports),
      ),
      captureRun(request([], { scope: 'user', disabled: true }), contextFor(matrixPorts.ports)),
    ]);
    expect({
      optionNames,
      relationKinds,
      invocationMatrix,
      filtered,
      filterMatrix: filterMatrix.map(semanticResult),
      writes: counts.writes + matrixPorts.counts.writes,
    }).toEqual({
      optionNames: expect.arrayContaining([
        '--tool',
        '--scope',
        '--user',
        '--project',
        '--enabled',
        '--disabled',
        '--unconfigured',
        '--long',
        '--json',
      ]),
      relationKinds: expect.arrayContaining(['exclusive-group', 'scope-consistency']),
      invocationMatrix: [
        expect.objectContaining({ ok: false }),
        expect.objectContaining({ ok: false }),
        { ok: true },
      ],
      filtered: {
        kind: 'outcome',
        exitClass: 'success',
        diagnostic: null,
        entries: 0,
        selection: {
          source: 'bounded-default',
          tools: ['claude-code'],
          scopes: ['user', 'project'],
          filters: { names: ['missing-*'], enabled: 'enabled-only' },
          outcome: 'filter-noop',
        },
        mutation: 'none',
      },
      filterMatrix: [
        expect.objectContaining({
          exitClass: 'success',
          entries: 1,
          selection: expect.objectContaining({
            tools: ['claude-code'],
            scopes: ['user'],
            filters: { names: ['alpha'], enabled: null },
            outcome: 'selected',
          }),
        }),
        expect.objectContaining({
          exitClass: 'success',
          entries: 2,
          selection: expect.objectContaining({
            tools: ['claude-code'],
            scopes: ['project'],
            filters: { names: ['a*', 'gamma'], enabled: null },
            outcome: 'selected',
          }),
        }),
        expect.objectContaining({
          exitClass: 'success',
          entries: 2,
          selection: expect.objectContaining({
            tools: ['claude-code'],
            scopes: ['user'],
            filters: { names: [], enabled: 'enabled-only' },
            outcome: 'selected',
          }),
        }),
        expect.objectContaining({
          exitClass: 'success',
          entries: 0,
          selection: expect.objectContaining({
            tools: ['claude-code'],
            scopes: ['user'],
            filters: { names: [], enabled: 'disabled-only' },
            outcome: 'filter-noop',
          }),
        }),
      ],
      writes: 0,
    });
  });

  test('family 36: shared project-root invariance across root, nested, -C, worktree, and symlink contexts', async () => {
    const root = '/repo';
    const commandRoot = join(root, '.claude/commands');
    const commandPath = join(commandRoot, 'root-proof.md');
    const contexts = [
      projectContext(root, root, root),
      projectContext('/repo/packages/app', '/repo/packages/app', root),
      projectContext('/elsewhere', root, root),
      projectContext('/worktrees/topic', '/worktrees/topic', root),
      projectContext('/repo-link', '/repo', root),
    ];
    const results: UnknownRecord[] = [];
    for (const project of contexts) {
      const { ports, counts } = makePorts({
        fileExists: (path) => path === commandRoot || path === commandPath,
        listDir: (path) => (path === commandRoot ? ['root-proof.md'] : []),
        readText: () => '---\ndescription: shared root proof\n---\n',
      });
      const captured = await captureRun(
        request([], { scope: 'project' }),
        contextFor(ports, project),
      );
      const semantic = semanticResult(captured);
      const value = captured.kind === 'outcome' ? (captured.value as ReadonlyUnknownRecord) : null;
      const report = value?.report as ReadonlyUnknownRecord | undefined;
      const entries = (report?.entries as readonly ReadonlyUnknownRecord[] | undefined) ?? [];
      results.push({
        semantic,
        path: entries[0]?.path ?? null,
        root: entries[0]?.root ?? null,
        writes: counts.writes,
      });
    }
    expect(results).toEqual(
      contexts.map(() => ({
        semantic: {
          kind: 'outcome',
          exitClass: 'success',
          diagnostic: null,
          entries: 1,
          selection: {
            source: 'bounded-default',
            tools: ['claude-code'],
            scopes: ['project'],
            filters: { names: [], enabled: null },
            outcome: 'selected',
          },
          mutation: 'none',
        },
        path: commandPath,
        root: commandRoot,
        writes: 0,
      })),
    );
  });
});

describe('EWP-CMD-COMMANDS-TS03', () => {
  test('family 37: invalid input and known unsupported capability refusal before I/O', async () => {
    const cases = await Promise.all([
      captureRun(request([], { tool: ['future-tool'] }), poisonedContext()),
      captureRun(request([], { scope: 'workspace' }), poisonedContext()),
      captureRun(request([], { scope: 'system' }), poisonedContext()),
      captureRun(request([], { enabled: true, disabled: true }), poisonedContext()),
      captureRun(request(['[']), poisonedContext()),
      captureRun(request(['bad\0glob']), poisonedContext()),
    ]);
    expect(cases.map(semanticResult)).toEqual([
      expect.objectContaining({ kind: 'outcome', exitClass: 'usage', diagnostic: 'invalid-enum' }),
      expect.objectContaining({ kind: 'outcome', exitClass: 'usage' }),
      expect.objectContaining({ kind: 'outcome', exitClass: 'capability' }),
      expect.objectContaining({ kind: 'outcome', exitClass: 'usage' }),
      expect.objectContaining({ kind: 'outcome', exitClass: 'usage' }),
      expect.objectContaining({ kind: 'outcome', exitClass: 'usage' }),
    ]);
  });

  test('family 38: semantic failures, cancellation, multi-error precedence, and read-only effects', async () => {
    const root = '/home/alice/.claude/commands';
    const permission = makePorts({
      fileExists: (path) => path === root,
      listDir: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    });
    const permissionResult = await captureRun(
      request([], { scope: 'user' }),
      contextFor(permission.ports),
    );

    const projectRoot = '/repo/.claude/commands';
    const multiple = makePorts({
      fileExists: (path) => path === root || path === projectRoot,
      listDir: (path) => {
        if (path === root) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        throw Object.assign(new Error('ordinary inventory failure'), { code: 'EIO' });
      },
    });
    const multipleResult = await captureRun(request(), contextFor(multiple.ports));

    const controller = new AbortController();
    controller.abort();
    const cancelled = makePorts();
    const cancelledResult = await captureRun(
      request([], { scope: 'user' }),
      contextFor(cancelled.ports, projectContext('/repo', '/repo', '/repo'), controller.signal),
    );

    const clean = makePorts();
    const cleanResult = await captureRun(request([], { scope: 'user' }), contextFor(clean.ports));
    const unsupported = await captureRun(request([], { scope: 'managed' }), poisonedContext());

    expect({
      permission: semanticResult(permissionResult),
      multiple: semanticResult(multipleResult),
      multipleRootReads: multiple.counts.listDir,
      cancelled: semanticResult(cancelledResult),
      clean: semanticResult(cleanResult),
      unsupported: semanticResult(unsupported),
      writes:
        permission.counts.writes +
        multiple.counts.writes +
        cancelled.counts.writes +
        clean.counts.writes,
    }).toEqual({
      permission: {
        kind: 'outcome',
        exitClass: 'permission',
        diagnostic: 'permission-denied',
        entries: 0,
        selection: expect.any(Object),
        mutation: 'none',
      },
      multiple: {
        kind: 'outcome',
        exitClass: 'permission',
        diagnostic: 'permission-denied',
        entries: 0,
        selection: expect.any(Object),
        mutation: 'none',
      },
      multipleRootReads: 2,
      cancelled: {
        kind: 'outcome',
        exitClass: 'cancelled',
        diagnostic: 'cancelled',
        entries: 0,
        selection: expect.any(Object),
        mutation: 'none',
      },
      clean: expect.objectContaining({
        kind: 'outcome',
        exitClass: 'success',
        entries: 0,
        mutation: 'none',
      }),
      unsupported: expect.objectContaining({
        kind: 'outcome',
        exitClass: 'capability',
        entries: 0,
      }),
      writes: 0,
    });
  });
});

describe('EWP-CMD-COMMANDS-TS04', () => {
  test('family 39: plugin, standalone, local-project, alias, shared-target, and provenance conflicts', async () => {
    const installedPath = '/home/alice/.claude/plugins/installed_plugins.json';
    const settingsPath = '/home/alice/.claude/settings.json';
    const localSettingsPath = '/repo/.claude/settings.local.json';
    const standaloneRoot = '/home/alice/.claude/commands';
    const standalonePath = `${standaloneRoot}/release.md`;
    const pluginRoot = '/pkg/release/commands';
    const pluginPath = `${pluginRoot}/release.md`;
    const localRoot = '/pkg/local/commands';
    const localPath = `${localRoot}/review.md`;
    const installed = JSON.stringify({
      version: 2,
      plugins: {
        'release-kit@marketplace': [
          { scope: 'user', installPath: '/pkg/release', version: '3.1.0' },
          { scope: 'user', installPath: '/pkg/release', version: '3.1.0' },
        ],
        'local-tools@marketplace': [
          {
            scope: 'local',
            installPath: '/pkg/local',
            version: '1.0.0',
            projectPath: '/repo',
          },
        ],
      },
    });
    const files: Record<string, string> = {
      [installedPath]: installed,
      [settingsPath]: JSON.stringify({ enabledPlugins: { 'release-kit@marketplace': true } }),
      [localSettingsPath]: JSON.stringify({ enabledPlugins: { 'local-tools@marketplace': false } }),
      [standalonePath]: '---\ndescription: standalone release\n---\n',
      [pluginPath]: '---\ndescription: plugin release\nversion: 3.1.0\n---\n',
      [localPath]: '---\ndescription: local review\nversion: 1.0.0\n---\n',
    };
    const dirs: Record<string, readonly string[]> = {
      [standaloneRoot]: ['release.md'],
      [pluginRoot]: ['release.md'],
      [localRoot]: ['review.md'],
    };
    const provenance = makePorts({
      fileExists: (path) => path in files || path in dirs,
      listDir: (path) => dirs[path] ?? [],
      readText: (path) => files[path] ?? '',
      realpath: (path) =>
        path === standalonePath || path === pluginPath ? '/shared/release.md' : path,
    });
    const observed = await captureRun(request(), contextFor(provenance.ports));
    const observedOutcome =
      observed.kind === 'outcome' ? (observed.value as ReadonlyUnknownRecord) : null;
    const observedReport = observedOutcome?.report as ReadonlyUnknownRecord | undefined;
    const rows = (observedReport?.entries as readonly ReadonlyUnknownRecord[] | undefined) ?? [];

    const conflictInstalled = JSON.stringify({
      version: 2,
      plugins: {
        'release-kit@one': [{ scope: 'user', installPath: '/pkg/conflict', version: '1.0.0' }],
        'release-kit@two': [{ scope: 'user', installPath: '/pkg/conflict', version: '2.0.0' }],
      },
    });
    const conflictPath = '/pkg/conflict/commands/release.md';
    const conflict = makePorts({
      fileExists: (path) =>
        path === installedPath || path === '/pkg/conflict/commands' || path === conflictPath,
      listDir: (path) => (path === '/pkg/conflict/commands' ? ['release.md'] : []),
      readText: (path) =>
        path === installedPath
          ? conflictInstalled
          : '---\ndescription: conflicting release\nversion: 1.0.0\n---\n',
    });
    const conflicted = await captureRun(request([], { scope: 'user' }), contextFor(conflict.ports));

    expect({
      observed: semanticResult(observed),
      names: rows.map((row) => row.name),
      logicalPaths: rows.map((row) => row.path),
      origins: rows.map((row) => row.origin),
      conflict: semanticResult(conflicted),
      writes: provenance.counts.writes + conflict.counts.writes,
    }).toEqual({
      observed: expect.objectContaining({ kind: 'outcome', exitClass: 'success', entries: 3 }),
      names: ['release', 'release-kit:release', 'local-tools:review'],
      logicalPaths: [standalonePath, pluginPath, localPath],
      origins: [
        { kind: 'standalone' },
        {
          kind: 'plugin',
          pluginId: 'release-kit@marketplace',
          pluginVersion: '3.1.0',
          pluginScope: 'user',
        },
        {
          kind: 'plugin',
          pluginId: 'local-tools@marketplace',
          pluginVersion: '1.0.0',
          pluginScope: 'local',
        },
      ],
      conflict: expect.objectContaining({
        kind: 'outcome',
        exitClass: 'state',
        entries: 0,
      }),
      writes: 0,
    });
  });

  test('family 40: generated 4096-command completeness, compact bound, repeat identity, and linear reads', async () => {
    const root = '/home/alice/.claude/commands';
    const names = Object.freeze(
      Array.from({ length: 4096 }, (_, index) => `cmd-${index.toString().padStart(4, '0')}.md`),
    );
    const generated = makePorts({
      fileExists: (path) => path === root || path.startsWith(`${root}/cmd-`),
      listDir: (path) => (path === root ? names : []),
      readText: (path) => {
        const name = path.slice(path.lastIndexOf('/') + 1, -3);
        return `---\ndescription: generated ${name}\nversion: 1.0.0\n---\n`;
      },
    });
    const started = performance.now();
    const captured = await captureRun(request([], { scope: 'user' }), contextFor(generated.ports));
    const applicationMilliseconds = performance.now() - started;
    if (captured.kind !== 'outcome') throw new Error(String(captured.error));
    const applicationOutcome = captured.value as ReadonlyUnknownRecord;
    const report = applicationOutcome.report as ReadonlyUnknownRecord;
    const compactStarted = performance.now();
    const compact = textOf(
      commandRenderer.human({ ...applicationOutcome, report: { ...report, long: false } }),
    );
    const json = textOf(
      commandRenderer.json({ ...applicationOutcome, report: { ...report, long: false } }),
    );
    const repeated = textOf(
      commandRenderer.human({ ...applicationOutcome, report: { ...report, long: false } }),
    );
    const renderMilliseconds = performance.now() - compactStarted;
    const parsed = JSON.parse(json) as ReadonlyUnknownRecord;
    const completeRows = (parsed.entries as readonly unknown[] | undefined) ?? [];
    const compactLines = compact.trimEnd().split('\n');
    const totalReads =
      generated.counts.fileExists +
      generated.counts.listDir +
      generated.counts.readText +
      generated.counts.realpath;

    expect({
      application: semanticResult(captured),
      complete: completeRows.length,
      compactLines: compactLines.length,
      compactLabel: compactLines[0],
      compactTail: compactLines.at(-1),
      repeated,
      applicationUnderFiveSeconds: applicationMilliseconds < 5_000,
      renderUnderFiveSeconds: renderMilliseconds < 5_000,
      totalReads,
      writes: generated.counts.writes,
    }).toEqual({
      application: expect.objectContaining({
        kind: 'outcome',
        exitClass: 'success',
        entries: 4096,
      }),
      complete: 4096,
      compactLines: 104,
      compactLabel: 'Installed slash commands',
      compactTail: '... 3996 more entries; narrow with filters or use --long or --json.',
      repeated: compact,
      applicationUnderFiveSeconds: true,
      renderUnderFiveSeconds: true,
      totalReads: expect.any(Number),
      writes: 0,
    });
    expect(totalReads).toBeLessThanOrEqual(8 * 4096 + 128);
  });
});
