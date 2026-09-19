import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const FIXTURES = join(ROOT, 'tests/ergonomics/fixtures/p3a-ts01');
const CLI_ENTRYPOINT = join(ROOT, 'packages/cli/src/index.ts');
const PLANNED_INVENTORY_PATH = join(ROOT, 'packages/core/src/inventory/read.ts');

const EXPECTED_FIXTURES = Object.freeze({
  'inventory-cases.json': Object.freeze({
    bytes: 19_573,
    sha256: 'sha256:f7ef7f0ba3b82789cb1cdd2169978e9f732b0355ab0c7df866d4b282c24be40a',
  }),
  'list-compact.golden.txt': Object.freeze({
    bytes: 1_173,
    sha256: 'sha256:9337910c989e7e593ee7be505bed88a4219d9204e315a0f69972f54f0cbb53da',
  }),
  'list-long.golden.txt': Object.freeze({
    bytes: 6_101,
    sha256: 'sha256:a5f2f0dd2397fc8126ca586ddd72ea17330eb50cc6845ba1e4a6da82fe017a55',
  }),
  'list-v3.golden.json': Object.freeze({
    bytes: 21_894,
    sha256: 'sha256:fcef06d10f747f5ab4c6b02a1613206bb6148d4c4568b0dca59f7e40a5b6cec5',
  }),
});

const FAMILY_ALLOCATION = Object.freeze({
  'EWP-CMD-LIST-TS01': Object.freeze([
    'family 41: exact compact columns, empty state, enabled elision, and tool grouping',
    'family 42: registry, scope, name, and path order under input permutations',
  ]),
  'EWP-CMD-LIST-TS02': Object.freeze([
    'family 43: complete long fields for dev, pinned, store-link, and unmanaged rows',
    'family 44: null metadata, provenance, and strict status-fact exclusion',
  ]),
  'EWP-CMD-LIST-TS03': Object.freeze([
    'family 45: every filter and OR/AND combination',
    'family 46: conflicts, filter-noop, and project-root invariance',
  ]),
  'EWP-CMD-LIST-TS04': Object.freeze([
    'family 47: tool-qualified identity, member paths, and cross-tool non-duplicates',
    'family 48: adapter-owned precedence, ambiguity, namespace, and exact winners',
  ]),
  'EWP-CMD-LIST-TS05': Object.freeze([
    'family 49: on, off, and unset filters and display',
    'family 50: read-only enabled-state boundary and zero mutation effects',
  ]),
  'EWP-CMD-LIST-TS06': Object.freeze([
    'family 51: complete list@3 bytes independent of human verbosity',
    'family 52: strict future and unknown refusal, redaction, and internal exclusion',
  ]),
  'EWP-CMD-LIST-TS07': Object.freeze([
    'family 53: generated 10,000-skill fleet, complete JSON, and 100-row cap',
    'family 54: linear call bound, cancellation contract, and no context reread',
  ]),
});

type UnknownRecord = Record<string, unknown>;
type RenderListHuman = (
  entries: readonly UnknownRecord[],
  options: Readonly<{ readonly long: boolean }>,
) => string;
type RenderListJson = (entries: readonly UnknownRecord[]) => string;
type RunListApplication = (
  request: UnknownRecord,
  context: UnknownRecord,
) => Promise<UnknownRecord>;
type ReadSkillInventory = (
  ports: UnknownRecord,
  options: UnknownRecord,
) => Promise<
  | Readonly<{ readonly ok: true; readonly value: InventoryProjection | readonly UnknownRecord[] }>
  | Readonly<{ readonly ok: false; readonly error: unknown }>
>;
type ProjectSkillInventory = (
  entries: readonly UnknownRecord[],
  options: UnknownRecord,
) =>
  | InventoryProjection
  | Promise<InventoryProjection>
  | Readonly<{ readonly ok: true; readonly value: InventoryProjection }>
  | Promise<Readonly<{ readonly ok: true; readonly value: InventoryProjection }>>
  | Readonly<{ readonly ok: false; readonly error: unknown }>
  | Promise<Readonly<{ readonly ok: false; readonly error: unknown }>>;

interface FixtureDocument {
  readonly schemaVersion: number;
  readonly rows: readonly UnknownRecord[];
}

interface ListV3Golden extends UnknownRecord {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly selection: UnknownRecord;
  readonly summary: UnknownRecord;
  readonly entries: readonly UnknownRecord[];
  readonly collisionGroups: readonly UnknownRecord[];
}

interface InventoryProjection extends UnknownRecord {
  readonly entries: readonly UnknownRecord[];
  readonly collisionGroups: readonly UnknownRecord[];
  readonly selection?: UnknownRecord;
}

const bytesOf = (name: string): Uint8Array => readFileSync(join(FIXTURES, name));
const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const fixture = JSON.parse(
  readFileSync(join(FIXTURES, 'inventory-cases.json'), 'utf8'),
) as FixtureDocument;
const compactGolden = readFileSync(join(FIXTURES, 'list-compact.golden.txt'), 'utf8');
const longGolden = readFileSync(join(FIXTURES, 'list-long.golden.txt'), 'utf8');
const listV3Bytes = readFileSync(join(FIXTURES, 'list-v3.golden.json'), 'utf8');
const listV3Golden = JSON.parse(listV3Bytes) as ListV3Golden;

const rowName = (row: UnknownRecord): string => String(row.name);
const rowOrigin = (row: UnknownRecord): string =>
  String((row.origin as UnknownRecord | undefined)?.kind);
const stateFor = (row: UnknownRecord): string =>
  row.enabled === 'on' ? '' : row.enabled === 'off' ? 'disabled' : 'unconfigured';

const EXPECTED_TUPLES = Object.freeze([
  'c01 / claude-code / managed / unmanaged / policy / on / unrecorded',
  'c02 / claude-code / user / dev / standalone / on / unrecorded',
  'c03 / claude-code / project / unmanaged / standalone / off / unrecorded',
  'c04 / claude-code / user / pinned / plugin / unset / warned',
  'c05 / claude-code / project / pinned / standalone / on / passed',
  'c06 / claude-code / managed / unmanaged / policy / on / unrecorded',
  'x01 / codex / system / unmanaged / standalone / on / unrecorded',
  'x02 / codex / user / dev / standalone / off / unrecorded',
  'x03 / codex / project / unmanaged / standalone / unset / unrecorded',
  'x04 / codex / user / pinned / standalone / on / warned',
  'x05 / codex / project / pinned / plugin / off / skipped',
  'x06 / codex / user / unmanaged / plugin / on / unrecorded',
  'k01 / kilo-code / user / pinned / standalone / on / passed',
  'k02 / kilo-code / project / dev / standalone / unset / unrecorded',
  'k03 / kilo-code / user / unmanaged / plugin / off / unrecorded',
  'k04 / kilo-code / project / pinned / standalone / on / warned',
  'k05 / kilo-code / project / pinned / plugin / unset / skipped',
  'k06 / kilo-code / user / unmanaged / standalone / on / unrecorded',
  'o01 / opencode / user / pinned / standalone / on / passed',
  'o02 / opencode / project / dev / standalone / off / unrecorded',
  'o03 / opencode / user / unmanaged / plugin / unset / unrecorded',
  'o04 / opencode / project / pinned / standalone / on / warned',
  'o05 / opencode / user / pinned / plugin / off / skipped',
  'o06 / opencode / project / unmanaged / standalone / on / unrecorded',
]);

const tupleOf = (row: UnknownRecord): string =>
  [row.name, row.tool, row.scope, row.mode, rowOrigin(row), row.enabled, row.verification].join(
    ' / ',
  );

const optionLongs = (spec: UnknownRecord): readonly string[] =>
  ((spec.options as readonly UnknownRecord[] | undefined) ?? []).map((option) =>
    String(option.long),
  );

const occurrenceCount = (text: string, needle: string): number => text.split(needle).length - 1;

const runCli = async (args: readonly string[]) => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd: '/tmp',
    env: hermeticGitEnv({
      CI: '1',
      NO_COLOR: '1',
      HOME: '/tmp/skillsmith-list-contract-home',
      XDG_CONFIG_HOME: '/tmp/skillsmith-list-contract-config',
      XDG_DATA_HOME: '/tmp/skillsmith-list-contract-data',
      XDG_CACHE_HOME: '/tmp/skillsmith-list-contract-cache',
    }),
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

const runtimeConfiguration = (): UnknownRecord =>
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

const invariantProjectRun = async (projectContext: UnknownRecord) => {
  const root = '/repo/.claude/skills';
  const skillPath = `${root}/rooted`;
  const markdownPath = `${skillPath}/SKILL.md`;
  const listDirs: string[] = [];
  const forbidden: string[] = [];
  const writeTrap = async (name: string): Promise<never> => {
    forbidden.push(name);
    throw new Error(`project-root inventory invoked ${name}`);
  };
  const ports: UnknownRecord = Object.freeze({
    homeDir: '/home/alice',
    executableSearchPath: Object.freeze([]),
    platform: 'linux',
    xdg: Object.freeze({
      config: '/home/alice/.config',
      data: '/home/alice/.local/share',
      cache: '/home/alice/.cache',
    }),
    fileExists: async (path: string) => path === root || path === markdownPath,
    listDir: async (path: string) => {
      listDirs.push(path);
      return path === root ? ['rooted'] : [];
    },
    readText: async (path: string) =>
      path === markdownPath ? '---\ndescription: rooted project skill\n---\n' : '',
    readBytes: async () => new Uint8Array(),
    realpath: async (path: string) => path,
    pathKind: async (path: string) =>
      path === markdownPath ? 'file' : path === root || path === skillPath ? 'dir' : 'absent',
    readFileMetadata: async (path: string) =>
      Object.freeze({
        kind:
          path === markdownPath ? 'file' : path === root || path === skillPath ? 'dir' : 'absent',
        mode: null,
        identity: path,
      }),
    readLink: async () => '',
    isExecutable: async () => false,
    modifiedAt: async () => null,
    writeText: async () => writeTrap('writeText'),
    writeTextFile: async () => writeTrap('writeTextFile'),
    makeDir: async () => writeTrap('makeDir'),
    makeSymlink: async () => writeTrap('makeSymlink'),
    rename: async () => writeTrap('rename'),
    copyTree: async () => writeTrap('copyTree'),
    removeTree: async () => writeTrap('removeTree'),
    fsyncFile: async () => writeTrap('fsyncFile'),
    fsyncDir: async () => writeTrap('fsyncDir'),
    withFileLock: async () => writeTrap('withFileLock'),
  });
  const observation = Object.freeze({
    context: Object.freeze({}),
    emitter: Object.freeze({
      begin: () => Object.freeze({}),
      complete: () => {},
    }),
  });
  const outcome = await runListApplication(
    Object.freeze({
      arguments: Object.freeze([Object.freeze([])]),
      options: Object.freeze({ tool: ['claude-code'], project: true }),
    }),
    Object.freeze({
      ports,
      configuration: runtimeConfiguration(),
      interaction: Object.freeze({
        mode: 'noninteractive',
        choose: async () => Object.freeze({ status: 'refused', reason: 'not used' }),
        confirm: async () => Object.freeze({ status: 'refused', reason: 'not used' }),
      }),
      invocationCwd: projectContext.invocationCwd,
      globalOptions: Object.freeze({}),
      projectContext,
      effectiveConfig: Object.freeze({
        value: Object.freeze({}),
        sources: Object.freeze({}),
        layers: Object.freeze({}),
        paths: Object.freeze({}),
      }),
      observation,
    }),
  );
  const report = outcome.report as UnknownRecord;
  return {
    exitClass: outcome.exitClass,
    names: ((report.entries as readonly UnknownRecord[] | undefined) ?? []).map(rowName),
    paths: ((report.entries as readonly UnknownRecord[] | undefined) ?? []).map((row) => row.path),
    listDirs: [...new Set(listDirs)],
    forbidden,
  };
};

let renderListHuman: RenderListHuman;
let renderListJson: RenderListJson;
let currentCommandSpecs: readonly UnknownRecord[];
let currentOptionRelations: readonly UnknownRecord[];
let currentWireCommandMappings: readonly UnknownRecord[];
let currentWireContractRegistry: Readonly<{
  forCommand(command: string):
    | Readonly<{
        readonly descriptor: UnknownRecord;
        validate(value: unknown): Readonly<{ readonly ok: boolean }>;
      }>
    | undefined;
}>;
let projectSkillInventory: ProjectSkillInventory;
let readSkillInventory: ReadSkillInventory;
let runListApplication: RunListApplication;
let hermeticGitEnv: (
  overrides?: Record<string, string | undefined>,
) => Record<string, string | undefined>;

const projectionOf = async (
  entries: readonly UnknownRecord[],
  options: UnknownRecord = {},
): Promise<
  | Readonly<{ readonly ok: true; readonly value: InventoryProjection }>
  | Readonly<{ readonly ok: false; readonly error: unknown }>
> => {
  try {
    const projected = await projectSkillInventory(entries, options);
    if (typeof (projected as Readonly<{ readonly ok?: unknown }>).ok === 'boolean') {
      return projected as
        | Readonly<{ readonly ok: true; readonly value: InventoryProjection }>
        | Readonly<{ readonly ok: false; readonly error: unknown }>;
    }
    return { ok: true, value: projected as InventoryProjection };
  } catch (error) {
    return { ok: false, error };
  }
};

const projectedNames = async (
  options: UnknownRecord,
  entries: readonly UnknownRecord[] = fixture.rows,
): Promise<readonly string[]> => {
  const projected = await projectionOf(entries, options);
  if (!projected.ok) return [`error:${String(projected.error)}`];
  return projected.value.entries.map(rowName).sort();
};

beforeAll(async () => {
  // Literal fixture guards and dimensional facts intentionally execute before production imports.
  expect(Object.keys(FAMILY_ALLOCATION)).toEqual([
    'EWP-CMD-LIST-TS01',
    'EWP-CMD-LIST-TS02',
    'EWP-CMD-LIST-TS03',
    'EWP-CMD-LIST-TS04',
    'EWP-CMD-LIST-TS05',
    'EWP-CMD-LIST-TS06',
    'EWP-CMD-LIST-TS07',
  ]);
  expect(Object.values(FAMILY_ALLOCATION).flat()).toHaveLength(14);
  expect(new Set(Object.values(FAMILY_ALLOCATION).flat())).toHaveLength(14);
  for (const [name, expected] of Object.entries(EXPECTED_FIXTURES)) {
    const bytes = bytesOf(name);
    expect(bytes.byteLength, `${name} byte length`).toBe(expected.bytes);
    expect(sha256(bytes), `${name} SHA-256`).toBe(expected.sha256);
  }
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.rows).toHaveLength(24);
  expect(fixture.rows.map(tupleOf)).toEqual([...EXPECTED_TUPLES]);
  expect(new Set(fixture.rows.map(rowName))).toHaveLength(24);
  expect(listV3Golden).toMatchObject({
    schemaVersion: 3,
    kind: 'skillsmith.list',
    selection: { source: 'bounded-default', outcome: 'selected' },
    summary: { total: 24, collisionGroups: 0 },
  });
  expect(listV3Golden.entries).toHaveLength(24);
  expect(new Set(listV3Golden.entries.map(rowName))).toEqual(new Set(fixture.rows.map(rowName)));
  expect(compactGolden.endsWith('\n')).toBeTrue();
  expect(longGolden.endsWith('\n')).toBeTrue();
  expect(listV3Bytes.endsWith('\n')).toBeTrue();

  const [
    humanModule,
    jsonModule,
    specModule,
    wireModule,
    gitEnvModule,
    applicationModule,
    scannerModule,
  ] = await Promise.all([
    import('../../src/output/list-human.ts'),
    import('../../src/output/list-json.ts'),
    import('../../src/spec/registry.ts'),
    import('../../src/contracts/wire-contracts.ts'),
    import('../../../core/tests/fixtures/git-env.ts'),
    import('../../../core/src/application/read-services.ts'),
    import('../../../core/src/scan/list-skills.ts'),
  ]);
  expect(typeof humanModule.renderListHuman).toBe('function');
  expect(typeof jsonModule.renderListJson).toBe('function');
  renderListHuman = humanModule.renderListHuman as unknown as RenderListHuman;
  renderListJson = jsonModule.renderListJson as unknown as RenderListJson;
  currentCommandSpecs = specModule.CURRENT_COMMAND_SPECS as unknown as readonly UnknownRecord[];
  currentOptionRelations =
    specModule.CURRENT_OPTION_RELATIONS as unknown as readonly UnknownRecord[];
  currentWireCommandMappings =
    wireModule.currentWireCommandMappings as unknown as readonly UnknownRecord[];
  currentWireContractRegistry =
    wireModule.currentWireContractRegistry as unknown as typeof currentWireContractRegistry;
  hermeticGitEnv = gitEnvModule.hermeticGitEnv;
  runListApplication = applicationModule.runListApplication as unknown as RunListApplication;
  const currentListSkills = scannerModule.listSkills as unknown as ReadSkillInventory;
  readSkillInventory = async (ports, options) => {
    const current = await currentListSkills(ports, options);
    return current.ok
      ? {
          ok: true,
          value: Object.freeze({
            entries: current.value as readonly UnknownRecord[],
            collisionGroups: Object.freeze([]),
          }),
        }
      : current;
  };

  projectSkillInventory = async (entries) =>
    Object.freeze({
      entries,
      collisionGroups: Object.freeze([]),
      selection: Object.freeze({ outcome: 'selected' }),
    });
  if (await Bun.file(PLANNED_INVENTORY_PATH).exists()) {
    const planned = (await import(PLANNED_INVENTORY_PATH)) as UnknownRecord;
    if (typeof planned.projectSkillInventory === 'function') {
      projectSkillInventory = planned.projectSkillInventory as ProjectSkillInventory;
    }
    if (typeof planned.readSkillInventory === 'function') {
      readSkillInventory = planned.readSkillInventory as ReadSkillInventory;
    }
  }
});

describe('EWP-CMD-LIST-TS01', () => {
  test('family 41: compact golden fixes columns, grouping, enabled elision, and empty output', () => {
    const rendered = renderListHuman(listV3Golden.entries, { long: false });
    expect(rendered).toBe(compactGolden);
    expect(renderListHuman([], { long: false })).toBe('No skills installed.\n');
    expect(occurrenceCount(rendered, '| Tool | Scope | Mode | Name | State |')).toBe(1);
    for (const row of listV3Golden.entries) {
      const line = rendered
        .split('\n')
        .find((candidate) => candidate.includes(`| ${rowName(row)} |`));
      expect(line, rowName(row)).toContain(`| ${stateFor(row)} |`);
    }
  });

  test('family 42: canonical output is invariant to input permutations', () => {
    const reversed = [...fixture.rows].reverse();
    const interleaved = fixture.rows
      .filter((_, index) => index % 2 === 0)
      .concat(fixture.rows.filter((_, index) => index % 2 === 1));
    expect(renderListHuman(reversed, { long: false })).toBe(compactGolden);
    expect(renderListHuman(interleaved, { long: false })).toBe(compactGolden);
    expect(renderListHuman(fixture.rows, { long: false })).toBe(compactGolden);
  });
});

describe('EWP-CMD-LIST-TS02', () => {
  test('family 43: long golden is complete for dev, pinned, store-link, and unmanaged rows', () => {
    const rendered = renderListHuman(listV3Golden.entries, { long: true });
    expect(rendered).toBe(longGolden);
    for (const heading of [
      'Placement',
      'Path',
      'Real path',
      'Root',
      'Origin',
      'Source',
      'Revision',
      'Store',
      'Verification',
      'Description',
      'Visibility',
    ]) {
      expect(rendered).toContain(`| ${heading} `);
    }
    expect(rendered).toContain('| kilo-code | project | pinned | k04 |');
    expect(rendered).toContain('/data/skillsmith/store/k04');
  });

  test('family 44: null metadata and provenance render without importing status facts', () => {
    const rendered = renderListHuman(listV3Golden.entries, { long: true });
    expect(rendered).toContain('| claude-code | project | unmanaged | c03 | disabled |');
    expect(rendered).toContain('| — | — | — | unrecorded | — | unique |');
    expect(rendered).toContain('plugin:quality@official@4.0.0(user)');
    for (const forbidden of [
      'desired',
      'lock state',
      'drift',
      'journal',
      'recovery',
      'convergence',
    ]) {
      expect(rendered.toLowerCase()).not.toContain(forbidden);
      expect(listV3Bytes.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('EWP-CMD-LIST-TS03', () => {
  test('family 45: every filter executes with OR-within and AND-across semantics', async () => {
    const filterCases: readonly (readonly [string, UnknownRecord])[] = [
      ['names-or', { names: ['c01', 'x01'] }],
      ['tools-or', { tools: ['claude-code', 'codex'] }],
      ['scope', { scopes: ['project'] }],
      ['mode', { mode: 'dev' }],
      ['source', { source: 'github.com/acme/*' }],
      ['revision', { revision: 'rev-*' }],
      ['description', { description: '*project*' }],
      ['verified', { verification: 'verified' }],
      ['unverified', { verification: 'unverified' }],
      ['enabled', { enabled: 'on' }],
      ['disabled', { enabled: 'off' }],
      ['unconfigured', { enabled: 'unset' }],
      [
        'and-across',
        {
          names: ['c02', 'x04', 'o01'],
          tools: ['claude-code', 'codex'],
          scopes: ['user'],
          mode: 'dev',
          enabled: 'on',
        },
      ],
    ];
    const matrix = Object.fromEntries(
      await Promise.all(
        filterCases.map(
          async ([label, options]) => [label, await projectedNames(options)] as const,
        ),
      ),
    );
    matrix.duplicates = await projectedNames({ duplicatesOnly: true }, collisionCandidates());
    const spec = currentCommandSpecs.find((candidate) => candidate.path === 'skillsmith list');
    const optionNames = new Set(spec === undefined ? [] : optionLongs(spec));
    const requiredOptions = [
      '--tool',
      '--scope',
      '--system',
      '--user',
      '--project',
      '--managed',
      '--mode',
      '--source',
      '--revision',
      '--description',
      '--verified',
      '--unverified',
      '--enabled',
      '--disabled',
      '--unconfigured',
      '--duplicates',
      '--long',
      '--json',
    ];
    const argument = ((spec?.arguments as readonly UnknownRecord[] | undefined) ?? [])[0];
    const relations = currentOptionRelations.filter(
      (relation) => relation.command === 'skillsmith list',
    );
    const verifiedExclusive = relations.some(
      (relation) =>
        relation.kind === 'exclusive-group' &&
        JSON.stringify(relation.options) === JSON.stringify(['--verified', '--unverified']),
    );
    const enabledExclusive = relations.some(
      (relation) =>
        relation.kind === 'exclusive-group' &&
        JSON.stringify(relation.options) ===
          JSON.stringify(['--enabled', '--disabled', '--unconfigured']),
    );

    expect({
      matrix,
      missingOptions: requiredOptions.filter((option) => !optionNames.has(option)),
      argument,
      verifiedExclusive,
      enabledExclusive,
    }).toEqual({
      matrix: {
        'names-or': ['c01', 'x01'],
        'tools-or': [
          'c01',
          'c02',
          'c03',
          'c04',
          'c05',
          'c06',
          'x01',
          'x02',
          'x03',
          'x04',
          'x05',
          'x06',
        ],
        scope: ['c03', 'c05', 'k02', 'k04', 'k05', 'o02', 'o04', 'o06', 'x03', 'x05'],
        mode: ['c02', 'k02', 'o02', 'x02'],
        source: ['c04', 'c05', 'k01', 'k04', 'k05', 'o01', 'o04', 'o05', 'x04', 'x05'],
        revision: ['c04', 'c05', 'k01', 'k04', 'k05', 'o01', 'o04', 'o05', 'x04', 'x05'],
        description: ['c05', 'k02', 'k04', 'o02', 'o04', 'x05'],
        verified: ['c05', 'k01', 'o01'],
        unverified: [
          'c01',
          'c02',
          'c03',
          'c04',
          'c06',
          'k02',
          'k03',
          'k04',
          'k05',
          'k06',
          'o02',
          'o03',
          'o04',
          'o05',
          'o06',
          'x01',
          'x02',
          'x03',
          'x04',
          'x05',
          'x06',
        ],
        enabled: [
          'c01',
          'c02',
          'c05',
          'c06',
          'k01',
          'k04',
          'k06',
          'o01',
          'o04',
          'o06',
          'x01',
          'x04',
          'x06',
        ],
        disabled: ['c03', 'k03', 'o02', 'o05', 'x02', 'x05'],
        unconfigured: ['c04', 'k02', 'k05', 'o03', 'x03'],
        duplicates: [
          'ambiguous',
          'ambiguous',
          'kilo-compat',
          'kilo-compat',
          'kilo-native',
          'kilo-native',
          'open-ambiguous',
          'open-ambiguous',
          'shared',
          'shared',
          'shared',
        ],
        'and-across': ['c02'],
      },
      missingOptions: [],
      argument: expect.objectContaining({ name: 'glob', variadic: true }),
      verifiedExclusive: true,
      enabledExclusive: true,
    });
  });

  test('family 46: invalid filters and conflicts win before context while zero results are success', async () => {
    const invariantContexts = [
      {
        invocationCwd: '/repo',
        effectiveCwd: '/repo',
        projectRoot: '/repo',
        projectIdentity: '/repo',
        projectKind: 'git',
      },
      {
        invocationCwd: '/repo/nested/deep',
        effectiveCwd: '/repo/nested/deep',
        projectRoot: '/repo',
        projectIdentity: '/repo',
        projectKind: 'git',
      },
      {
        invocationCwd: '/worktree/nested',
        effectiveCwd: '/worktree/nested',
        projectRoot: '/repo',
        projectIdentity: '/repo',
        projectKind: 'git',
      },
      {
        invocationCwd: '/repo-link',
        effectiveCwd: '/repo',
        projectRoot: '/repo',
        projectIdentity: '/repo',
        projectKind: 'git',
      },
    ];
    const invariants = await Promise.all(invariantContexts.map(invariantProjectRun));
    const zeroProjection = await projectionOf(fixture.rows, { names: ['missing-*'] });
    const invalid = await runCli([
      '-C',
      '/definitely/missing',
      'list',
      '--mode',
      'future-mode',
      '--json',
    ]);

    const conflict = await runCli(['list', '--verified', '--unverified', '--json']);

    const zero = await runCli(['list', 'no-synthetic-skill-matches-*', '--json']);
    const dto = zero.stdout.length > 0 ? (JSON.parse(zero.stdout) as UnknownRecord) : {};
    expect({
      invariants,
      zeroProjection: zeroProjection.ok
        ? {
            entries: zeroProjection.value.entries,
            outcome: (zeroProjection.value.selection as UnknownRecord | undefined)?.outcome,
          }
        : { error: String(zeroProjection.error) },
      invalid: {
        exitCode: invalid.exitCode,
        mentionsValue: `${invalid.stdout}${invalid.stderr}`.includes('future-mode'),
        touchedMissingCwd: `${invalid.stdout}${invalid.stderr}`.includes('/definitely/missing'),
      },
      conflict: {
        exitCode: conflict.exitCode,
        verified: `${conflict.stdout}${conflict.stderr}`.includes('--verified'),
        unverified: `${conflict.stdout}${conflict.stderr}`.includes('--unverified'),
      },
      zero: { exitCode: zero.exitCode, dto },
    }).toEqual({
      invariants: Array.from({ length: 4 }, () => ({
        exitClass: 'success',
        names: ['rooted'],
        paths: ['/repo/.claude/skills/rooted'],
        listDirs: ['/repo/.claude/skills'],
        forbidden: [],
      })),
      zeroProjection: { entries: [], outcome: 'filter-noop' },
      invalid: { exitCode: 2, mentionsValue: true, touchedMissingCwd: false },
      conflict: { exitCode: 2, verified: true, unverified: true },
      zero: {
        exitCode: 0,
        dto: expect.objectContaining({
          schemaVersion: 3,
          selection: expect.objectContaining({
            source: 'bounded-default',
            outcome: 'filter-noop',
          }),
          summary: expect.objectContaining({ total: 0 }),
          entries: [],
        }),
      },
    });
  });
});

const collisionRows = (): readonly UnknownRecord[] => {
  const claudeManaged = structuredClone(
    fixture.rows.find((row) => row.name === 'c01') as UnknownRecord,
  );
  const claudeUser = structuredClone(
    fixture.rows.find((row) => row.name === 'c02') as UnknownRecord,
  );
  claudeManaged.name = 'shared';
  claudeUser.name = 'shared';
  claudeManaged.visibility = {
    state: 'winner',
    winner: String(claudeManaged.path),
    members: [
      { scope: 'user', path: claudeUser.path },
      { scope: 'managed', path: claudeManaged.path },
    ],
  };
  claudeUser.visibility = {
    state: 'shadowed',
    winner: String(claudeManaged.path),
    members: [
      { scope: 'user', path: claudeUser.path },
      { scope: 'managed', path: claudeManaged.path },
    ],
  };
  const codexUser = structuredClone(
    fixture.rows.find((row) => row.name === 'x02') as UnknownRecord,
  );
  const codexProject = structuredClone(
    fixture.rows.find((row) => row.name === 'x03') as UnknownRecord,
  );
  codexUser.name = 'ambiguous';
  codexProject.name = 'ambiguous';
  for (const row of [codexUser, codexProject]) {
    row.visibility = {
      state: 'duplicate',
      winner: null,
      members: [
        { scope: 'user', path: codexUser.path },
        { scope: 'project', path: codexProject.path },
      ],
    };
  }
  const crossClaude = structuredClone(claudeUser);
  const crossCodex = structuredClone(codexUser);
  crossClaude.name = 'portable';
  crossCodex.name = 'portable';
  crossClaude.visibility = { state: 'unique', winner: null, members: [] };
  crossCodex.visibility = { state: 'unique', winner: null, members: [] };
  return [claudeManaged, claudeUser, codexUser, codexProject, crossClaude, crossCodex];
};

const collisionCandidates = (): readonly UnknownRecord[] => {
  const candidate = (
    sourceName: string,
    values: Readonly<Record<string, unknown>>,
  ): UnknownRecord => {
    const row = structuredClone(
      fixture.rows.find((entry) => entry.name === sourceName) as UnknownRecord,
    );
    const raw = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'visibility'));
    return Object.assign(raw, values);
  };
  return [
    candidate('c01', { name: 'shared' }),
    candidate('c02', { name: 'shared' }),
    candidate('c03', { name: 'shared' }),
    candidate('x02', { name: 'ambiguous' }),
    candidate('x03', { name: 'ambiguous' }),
    candidate('k01', { name: 'kilo-native' }),
    candidate('k02', { name: 'kilo-native' }),
    candidate('k04', { name: 'kilo-compat' }),
    candidate('k05', {
      name: 'kilo-compat',
      root: '/repo/.claude/skills',
      path: '/repo/.claude/skills/kilo-compat',
      realpath: '/repo/.claude/skills/kilo-compat',
    }),
    candidate('o01', { name: 'open-ambiguous' }),
    candidate('o02', { name: 'open-ambiguous' }),
    candidate('c02', {
      name: 'lint',
      path: '/home/alice/.claude/skills/lint',
      realpath: '/home/alice/.claude/skills/lint',
    }),
    candidate('c04', {
      name: 'lint',
      path: '/home/alice/.claude/plugins/quality/lint',
      realpath: '/home/alice/.claude/plugins/quality/lint',
      origin: {
        kind: 'plugin',
        pluginId: 'quality@official',
        pluginVersion: '4.0.0',
        pluginScope: 'user',
      },
    }),
  ];
};

const visibilitySummary = (rows: readonly UnknownRecord[], tool: string, name: string) => {
  const selected = rows.filter((row) => row.tool === tool && row.name === name);
  return {
    paths: selected.map((row) => String(row.path)).sort(),
    states: selected
      .map((row) => String((row.visibility as UnknownRecord | undefined)?.state))
      .sort(),
    winners: [
      ...new Set(
        selected.map((row) =>
          String((row.visibility as UnknownRecord | undefined)?.winner ?? 'ambiguous'),
        ),
      ),
    ].sort(),
    members: selected.map((row) =>
      (
        (row.visibility as UnknownRecord | undefined)?.members as
          | readonly UnknownRecord[]
          | undefined
      )
        ?.map((member) => String(member.path))
        .sort(),
    ),
  };
};

describe('EWP-CMD-LIST-TS04', () => {
  test('family 47: duplicate presentation retains member paths and never merges tools', () => {
    const rendered = renderListHuman(collisionRows(), { long: true });
    expect({
      portableRows: occurrenceCount(rendered, '| portable |'),
      claudeManaged: rendered.includes('/managed/claude/skills/c01'),
      claudeUser: rendered.includes('/home/alice/.claude/skills/c02'),
      codexUser: rendered.includes('/home/alice/.agents/skills/x02'),
      codexProject: rendered.includes('/repo/.agents/skills/x03'),
      winner: rendered.includes('winner:/managed/claude/skills/c01'),
      ambiguous: rendered.includes('ambiguous'),
    }).toEqual({
      portableRows: 2,
      claudeManaged: true,
      claudeUser: true,
      codexUser: true,
      codexProject: true,
      winner: true,
      ambiguous: true,
    });
  });

  test('family 48: every built-in precedence and plugin namespace is projected before rendering', async () => {
    const projected = await projectionOf(collisionCandidates(), {});
    const rows = projected.ok ? projected.value.entries : [];
    const rendered = renderListHuman(rows, { long: true });
    expect({
      error: projected.ok ? null : String(projected.error),
      claude: visibilitySummary(rows, 'claude-code', 'shared'),
      codex: visibilitySummary(rows, 'codex', 'ambiguous'),
      kiloNative: visibilitySummary(rows, 'kilo-code', 'kilo-native'),
      kiloCompat: visibilitySummary(rows, 'kilo-code', 'kilo-compat'),
      opencode: visibilitySummary(rows, 'opencode', 'open-ambiguous'),
      pluginNames: rows
        .filter((row) => row.tool === 'claude-code' && String(row.name).includes('lint'))
        .map(rowName)
        .sort(),
      pluginStates: rows
        .filter((row) => row.tool === 'claude-code' && String(row.name).includes('lint'))
        .map((row) => (row.visibility as UnknownRecord | undefined)?.state),
      rendered: {
        claudeWinner: rendered.includes('winner:/managed/claude/skills/c01'),
        codexAmbiguous: rendered.includes('ambiguous'),
        kiloWinner: rendered.includes('/repo/.kilo/skills/k02'),
        opencode: rendered.includes('open-ambiguous'),
        pluginNamespace: rendered.includes('quality:lint'),
      },
    }).toEqual({
      error: null,
      claude: {
        paths: [
          '/home/alice/.claude/skills/c02',
          '/managed/claude/skills/c01',
          '/repo/.claude/skills/c03',
        ],
        states: ['shadowed', 'shadowed', 'winner'],
        winners: ['/managed/claude/skills/c01'],
        members: Array.from({ length: 3 }, () => [
          '/home/alice/.claude/skills/c02',
          '/managed/claude/skills/c01',
          '/repo/.claude/skills/c03',
        ]),
      },
      codex: {
        paths: ['/home/alice/.agents/skills/x02', '/repo/.agents/skills/x03'],
        states: ['duplicate', 'duplicate'],
        winners: ['ambiguous'],
        members: Array.from({ length: 2 }, () => [
          '/home/alice/.agents/skills/x02',
          '/repo/.agents/skills/x03',
        ]),
      },
      kiloNative: {
        paths: ['/home/alice/.kilo/skills/k01', '/repo/.kilo/skills/k02'],
        states: ['shadowed', 'winner'],
        winners: ['/repo/.kilo/skills/k02'],
        members: Array.from({ length: 2 }, () => [
          '/home/alice/.kilo/skills/k01',
          '/repo/.kilo/skills/k02',
        ]),
      },
      kiloCompat: {
        paths: ['/repo/.claude/skills/kilo-compat', '/repo/.kilo/skills/k04'],
        states: ['duplicate', 'duplicate'],
        winners: ['ambiguous'],
        members: Array.from({ length: 2 }, () => [
          '/repo/.claude/skills/kilo-compat',
          '/repo/.kilo/skills/k04',
        ]),
      },
      opencode: {
        paths: ['/home/alice/.config/opencode/skills/o01', '/repo/.opencode/skills/o02'],
        states: ['duplicate', 'duplicate'],
        winners: ['ambiguous'],
        members: Array.from({ length: 2 }, () => [
          '/home/alice/.config/opencode/skills/o01',
          '/repo/.opencode/skills/o02',
        ]),
      },
      pluginNames: ['lint', 'quality:lint'],
      pluginStates: ['unique', 'unique'],
      rendered: {
        claudeWinner: true,
        codexAmbiguous: true,
        kiloWinner: true,
        opencode: true,
        pluginNamespace: true,
      },
    });
  });
});

describe('EWP-CMD-LIST-TS05', () => {
  test('family 49: on, off, and unset filters execute across standalone and plugin rows', async () => {
    const [enabledRows, disabledRows, unconfiguredRows] = await Promise.all([
      projectedNames({ enabled: 'on' }),
      projectedNames({ enabled: 'off' }),
      projectedNames({ enabled: 'unset' }),
    ]);
    const rendered = renderListHuman(listV3Golden.entries, { long: false });
    expect({
      enabledRows,
      disabledRows,
      unconfiguredRows,
      rendered,
      disabledDisplay: occurrenceCount(rendered, '| disabled |'),
      unconfiguredDisplay: occurrenceCount(rendered, '| unconfigured |'),
      disabledOrigins: fixture.rows
        .filter((row) => row.enabled === 'off')
        .map(rowOrigin)
        .sort(),
      unconfiguredOrigins: fixture.rows
        .filter((row) => row.enabled === 'unset')
        .map(rowOrigin)
        .sort(),
    }).toEqual({
      enabledRows: [
        'c01',
        'c02',
        'c05',
        'c06',
        'k01',
        'k04',
        'k06',
        'o01',
        'o04',
        'o06',
        'x01',
        'x04',
        'x06',
      ],
      disabledRows: ['c03', 'k03', 'o02', 'o05', 'x02', 'x05'],
      unconfiguredRows: ['c04', 'k02', 'k05', 'o03', 'x03'],
      rendered: compactGolden,
      disabledDisplay: 6,
      unconfiguredDisplay: 5,
      disabledOrigins: ['plugin', 'plugin', 'plugin', 'standalone', 'standalone', 'standalone'],
      unconfiguredOrigins: ['plugin', 'plugin', 'plugin', 'standalone', 'standalone'],
    });
  });

  test('family 50: rendering is deeply read-only and creates no enabled-state mutation product', () => {
    const before = structuredClone(listV3Golden.entries);
    const frozen = Object.freeze(
      listV3Golden.entries.map((row) => Object.freeze(structuredClone(row))),
    );
    const rendered = renderListHuman(frozen, { long: true });
    expect({
      rendered,
      unchanged: frozen,
      mutation: listV3Golden.mutation,
      settingsWrites: listV3Golden.settingsWrites,
    }).toEqual({
      rendered: longGolden,
      unchanged: before,
      mutation: undefined,
      settingsWrites: undefined,
    });
  });
});

describe('EWP-CMD-LIST-TS06', () => {
  test('family 51: list@3 is complete and human verbosity cannot change its bytes', () => {
    const normal = renderListJson(listV3Golden.entries);
    const afterHumanLong = (() => {
      renderListHuman(listV3Golden.entries, { long: true });
      return renderListJson(listV3Golden.entries);
    })();
    expect(normal).toBe(listV3Bytes);
    expect(afterHumanLong).toBe(listV3Bytes);
    expect(JSON.parse(normal)).toEqual(listV3Golden);
  });

  test('family 52: strict list@3, mapper canaries, redaction, and internal exclusion are total', () => {
    const mapping = currentWireCommandMappings.find(
      (candidate) => candidate.commandPath === 'skillsmith list',
    );
    const selected = currentWireContractRegistry.forCommand('skillsmith list');
    const topLevelUnknown = { ...listV3Golden, future: true };
    const nestedUnknown = structuredClone(listV3Golden);
    const nestedEntries = nestedUnknown.entries as UnknownRecord[];
    nestedEntries[0] = { ...nestedEntries[0], future: true };
    const futureVersion = { ...listV3Golden, schemaVersion: 4 };

    const getterReads = new Set<string>();
    const forbiddenGetterReads: string[] = [];
    const forbiddenFields = new Set([
      'rootOrdinal',
      'ledgerRecord',
      'mutableMap',
      'ports',
      'rawSensitiveValue',
      'status',
    ]);
    const getterCanary = new Proxy(structuredClone(listV3Golden.entries[0] as UnknownRecord), {
      get(target, property, receiver) {
        const name = String(property);
        if (forbiddenFields.has(name)) {
          forbiddenGetterReads.push(name);
          throw new Error(`list DTO mapper read forbidden field ${name}`);
        }
        getterReads.add(name);
        return Reflect.get(target, property, receiver);
      },
    });
    const canaryEncoded = renderListJson([getterCanary]);

    const sensitive = structuredClone(listV3Golden.entries[0] as UnknownRecord);
    sensitive.description = 'api_key=super-secret-list-canary';
    sensitive.source = 'https://example.test/repo?access_token=super-secret-list-canary';
    sensitive.frontmatter = {
      ...(sensitive.frontmatter as UnknownRecord),
      description: 'password: super-secret-list-canary',
    };
    const redacted = renderListJson([sensitive]);
    const encoded = renderListJson(listV3Golden.entries);
    expect({
      mapping,
      descriptor: selected?.descriptor,
      strict: {
        current: selected?.validate(listV3Golden).ok,
        topLevelUnknown: selected?.validate(topLevelUnknown).ok,
        nestedUnknown: selected?.validate(nestedUnknown).ok,
        futureVersion: selected?.validate(futureVersion).ok,
      },
      encoded,
      getterReads: [...getterReads].filter((name) => !/^\d+$/.test(name)).sort(),
      forbiddenGetterReads,
      canarySchema: (JSON.parse(canaryEncoded) as UnknownRecord).schemaVersion,
      redaction: {
        containsSecret: redacted.includes('super-secret-list-canary'),
        containsMarker: redacted.includes('[REDACTED]'),
      },
      internalLeaks: [...forbiddenFields].filter((field) => encoded.includes(`"${field}"`)),
    }).toEqual({
      mapping: { commandPath: 'skillsmith list', contractId: 'list', version: 3 },
      descriptor: expect.objectContaining({
        id: 'list',
        version: 3,
        wireKind: 'skillsmith.list',
        unknownFields: 'reject-recursive',
      }),
      strict: {
        current: true,
        topLevelUnknown: false,
        nestedUnknown: false,
        futureVersion: false,
      },
      encoded: listV3Bytes,
      getterReads: [
        'description',
        'enabled',
        'frontmatter',
        'mode',
        'name',
        'origin',
        'path',
        'placement',
        'realpath',
        'revision',
        'root',
        'scope',
        'source',
        'store',
        'tool',
        'verification',
        'visibility',
      ],
      forbiddenGetterReads: [],
      canarySchema: 3,
      redaction: { containsSecret: false, containsMarker: true },
      internalLeaks: [],
    });
  });
});

const largeFleet = (): readonly UnknownRecord[] =>
  Array.from({ length: 10_000 }, (_, index) => {
    const value = index.toString().padStart(5, '0');
    const row: UnknownRecord = {
      name: `generated-${value}`,
      tool: index % 2 === 0 ? 'codex' : 'opencode',
      scope: index % 3 === 0 ? 'project' : 'user',
      mode: 'unmanaged',
      placement: 'copy',
      path: `/generated/${value}`,
      realpath: `/generated/${value}`,
      root: '/generated',
      frontmatter: null,
      origin: { kind: 'standalone' },
      enabled: 'on',
      source: null,
      revision: null,
      store: null,
      verification: 'unrecorded',
      description: null,
      visibility: { state: 'unique', winner: null, members: [] },
    };
    return row;
  });

const readFleet = async (size: number, reverse = false, signal?: AbortSignal) => {
  const root = '/home/alice/.claude/skills';
  const names = Array.from(
    { length: size },
    (_, index) => `generated-${index.toString().padStart(5, '0')}`,
  );
  const calls: Record<string, number> = {};
  const outsidePaths: string[] = [];
  const listDirs: string[] = [];
  const forbidden: string[] = [];
  const observations: string[] = [];
  const configurationReads: string[] = [];
  const track = <T>(name: string, path: string | null, operation: () => T): T => {
    calls[name] = (calls[name] ?? 0) + 1;
    if (path !== null && !path.startsWith(root)) outsidePaths.push(path);
    return operation();
  };
  const writeTrap = (name: string): never => {
    forbidden.push(name);
    throw new Error(`large inventory invoked ${name}`);
  };
  const isMarkdown = (path: string): boolean =>
    path.startsWith(`${root}/generated-`) && path.endsWith('/SKILL.md');
  const isSkill = (path: string): boolean =>
    path.startsWith(`${root}/generated-`) && !path.endsWith('/SKILL.md');
  const ports: UnknownRecord = Object.freeze({
    homeDir: '/home/alice',
    executableSearchPath: Object.freeze([]),
    platform: 'linux',
    xdg: Object.freeze({
      config: '/home/alice/.config',
      data: '/home/alice/.local/share',
      cache: '/home/alice/.cache',
    }),
    fileExists: async (path: string) =>
      track('fileExists', path, () => path === root || isMarkdown(path)),
    listDir: async (path: string) =>
      track('listDir', path, () => {
        listDirs.push(path);
        return path === root ? (reverse ? [...names].reverse() : names) : [];
      }),
    readText: async (path: string) =>
      track('readText', path, () =>
        isMarkdown(path) ? '---\ndescription: generated inventory row\n---\n' : '',
      ),
    readBytes: async (path: string) => track('readBytes', path, () => new Uint8Array()),
    realpath: async (path: string) => track('realpath', path, () => path),
    pathKind: async (path: string) =>
      track('pathKind', path, () =>
        isMarkdown(path) ? 'file' : path === root || isSkill(path) ? 'dir' : 'absent',
      ),
    readFileMetadata: async (path: string) =>
      track('readFileMetadata', path, () =>
        Object.freeze({
          kind: isMarkdown(path) ? 'file' : path === root || isSkill(path) ? 'dir' : 'absent',
          mode: null,
          identity: path,
        }),
      ),
    readLink: async (path: string) => track('readLink', path, () => ''),
    isExecutable: async (path: string) => track('isExecutable', path, () => false),
    modifiedAt: async (path: string) => track('modifiedAt', path, () => null),
    writeText: async () => writeTrap('writeText'),
    writeTextFile: async () => writeTrap('writeTextFile'),
    makeDir: async () => writeTrap('makeDir'),
    makeSymlink: async () => writeTrap('makeSymlink'),
    rename: async () => writeTrap('rename'),
    copyTree: async () => writeTrap('copyTree'),
    removeTree: async () => writeTrap('removeTree'),
    fsyncFile: async () => writeTrap('fsyncFile'),
    fsyncDir: async () => writeTrap('fsyncDir'),
    withFileLock: async () => writeTrap('withFileLock'),
  });
  const observation = Object.freeze({
    context: Object.freeze({}),
    emitter: Object.freeze({
      begin: () => {
        observations.push('begin');
        return Object.freeze({});
      },
      complete: () => {
        observations.push('complete');
      },
    }),
  });
  try {
    const configuration = new Proxy(runtimeConfiguration(), {
      get(target, property, receiver) {
        configurationReads.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await readSkillInventory(ports, {
      tools: ['claude-code'],
      scopes: ['user'],
      cwd: '/repo',
      configuration,
      observation,
      ...(signal === undefined ? {} : { signal }),
    });
    const value = result.ok
      ? Array.isArray(result.value)
        ? Object.freeze({ entries: result.value, collisionGroups: Object.freeze([]) })
        : (result.value as InventoryProjection)
      : Object.freeze({ entries: Object.freeze([]), collisionGroups: Object.freeze([]) });
    return {
      ok: result.ok,
      value,
      error: result.ok ? null : result.error,
      calls,
      totalCalls: Object.values(calls).reduce((total, count) => total + count, 0),
      outsidePaths,
      listDirs,
      forbidden,
      observations,
      configurationReads,
    };
  } catch (error) {
    return {
      ok: false,
      value: Object.freeze({ entries: Object.freeze([]), collisionGroups: Object.freeze([]) }),
      error,
      calls,
      totalCalls: Object.values(calls).reduce((total, count) => total + count, 0),
      outsidePaths,
      listDirs,
      forbidden,
      observations,
      configurationReads,
    };
  }
};

describe('EWP-CMD-LIST-TS07', () => {
  test('family 53: a generated 10,000-row fleet renders under five seconds with a 100-row cap', () => {
    const fleet = largeFleet();
    const started = performance.now();
    const rendered = renderListHuman(fleet, { long: false });
    const json = renderListJson(fleet);
    const elapsed = performance.now() - started;
    const dto = JSON.parse(json) as UnknownRecord;
    expect({
      underFiveSeconds: elapsed < 5_000,
      compactBytes: Buffer.byteLength(rendered),
      compactBound: Buffer.byteLength(rendered) < 64 * 1024,
      compactRows: occurrenceCount(rendered, '| generated-'),
      compactTail: rendered.endsWith(
        '... 9900 more entries; narrow with filters or use --long or --json.\n',
      ),
      json: {
        schemaVersion: dto.schemaVersion,
        rows: Array.isArray(dto.entries) ? dto.entries.length : -1,
        containsFirst: json.includes('generated-00000'),
        containsLast: json.includes('generated-09999'),
        terminalLf: json.endsWith('\n'),
      },
    }).toEqual({
      underFiveSeconds: true,
      compactBytes: expect.any(Number),
      compactBound: true,
      compactRows: 100,
      compactTail: true,
      json: {
        schemaVersion: 3,
        rows: 10_000,
        containsFirst: true,
        containsLast: true,
        terminalLf: true,
      },
    });
  });

  test('family 54: read-port observation is linear, cancellable, and context-bounded', async () => {
    const projected = await readFleet(10_000, true);
    const controller = new AbortController();
    controller.abort(new Error('contract cancellation'));
    const cancellation = await readFleet(0, false, controller.signal);
    const begins = projected.observations.filter((event) => event === 'begin').length;
    const completes = projected.observations.filter((event) => event === 'complete').length;
    expect({
      projection: {
        ok: projected.ok,
        error: projected.error === null ? null : String(projected.error),
        rows: projected.value.entries.length,
        collisionGroups: projected.value.collisionGroups.length,
        totalReadPortCalls: projected.totalCalls,
        linear: projected.totalCalls <= 8 * 10_000 + 128,
        outsideInventoryReads: projected.outsidePaths.length,
        contextBounded: projected.outsidePaths.length <= 128,
        configurationReads: projected.configurationReads.length,
        configurationBounded: projected.configurationReads.length <= 32,
        rootListCalls: projected.listDirs.filter((path) => path === '/home/alice/.claude/skills')
          .length,
        first: projected.value.entries[0]?.name,
        last: projected.value.entries.at(-1)?.name,
        forbidden: projected.forbidden,
        observationEvents: projected.observations.length,
        observationsBalanced: begins > 0 && begins === completes,
        observationsBounded: projected.observations.length <= 10,
      },
      cancellation: {
        code: cancellation.ok
          ? 'success'
          : ((cancellation.error as UnknownRecord | undefined)?.code ?? String(cancellation.error)),
        readPortCalls: cancellation.totalCalls,
        configurationReads: cancellation.configurationReads.length,
        observationEvents: cancellation.observations.length,
        observationsBounded: cancellation.observations.length <= 2,
        forbidden: cancellation.forbidden,
      },
    }).toEqual({
      projection: {
        ok: true,
        error: null,
        rows: 10_000,
        collisionGroups: 0,
        totalReadPortCalls: expect.any(Number),
        linear: true,
        outsideInventoryReads: expect.any(Number),
        contextBounded: true,
        configurationReads: expect.any(Number),
        configurationBounded: true,
        rootListCalls: 1,
        first: 'generated-00000',
        last: 'generated-09999',
        forbidden: [],
        observationEvents: expect.any(Number),
        observationsBalanced: true,
        observationsBounded: true,
      },
      cancellation: {
        code: 'cancelled',
        readPortCalls: 0,
        configurationReads: 0,
        observationEvents: expect.any(Number),
        observationsBounded: true,
        forbidden: [],
      },
    });
  });
});
