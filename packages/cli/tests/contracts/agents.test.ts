import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const FIXTURE_ROOT = join(ROOT, 'tests/ergonomics/fixtures/g3a02-contracts');

const FAMILY_ALLOCATION = Object.freeze({
  'EWP-CMD-AGENTS-TS01': Object.freeze([27, 28]),
  'EWP-CMD-AGENTS-TS02': Object.freeze([29, 30]),
  'EWP-CMD-AGENTS-TS03': Object.freeze([31, 32]),
});

const FIXTURE_MANIFEST = Object.freeze({
  'agents-base-v2.golden.json': Object.freeze({
    bytes: 16_913,
    sha256: '3af110be1a7ac64003c161dd31f8f50f02971d76204bbf8e332d4ee67921f16b',
  }),
  'agents-capabilities-v2.golden.json': Object.freeze({
    bytes: 16_913,
    sha256: '3af110be1a7ac64003c161dd31f8f50f02971d76204bbf8e332d4ee67921f16b',
  }),
  'agents-capabilities.golden.txt': Object.freeze({
    bytes: 5_846,
    sha256: '987357768a7043b4f9f522a0a4909ee209c342b6638a35a1b4a07d2f45405731',
  }),
  'agents-default.golden.txt': Object.freeze({
    bytes: 558,
    sha256: '51ce7d774d17b8f3a234c5d103c1d047fc79751bc7b75edc818f5c4b73a990bb',
  }),
  'agents-detected-only.golden.txt': Object.freeze({
    bytes: 499,
    sha256: '904245c432c2c5f9ac9b694213ac212b9544b302de580cd7b27cb58f3f5eb4f1',
  }),
  'agents-fleet.json': Object.freeze({
    bytes: 14_675,
    sha256: 'c40e48b7de570b33d158468b5cba478888a0321d828c974408bd71caf75135ad',
  }),
});

type UnknownRecord = Record<string, unknown>;
type ReadonlyUnknownRecord = Readonly<Record<string, unknown>>;
type InstallRecord = Readonly<{
  readonly path: string;
  readonly version: string;
  readonly installMethod: string;
}>;
type FleetTool = Readonly<{
  readonly id: string;
  readonly installations: readonly InstallRecord[];
}>;
type AgentsReport = Readonly<{
  readonly detections: ReadonlyMap<string, readonly InstallRecord[]>;
  readonly format: 'markdown' | 'json';
  readonly detectedOnly: boolean;
  readonly capabilities?: ReadonlyUnknownRecord;
}>;
type RunAgentsApplication = (
  request: ReadonlyUnknownRecord,
  context: ReadonlyUnknownRecord,
) => Promise<ReadonlyUnknownRecord>;
type RenderAgentsMarkdown = (
  detections: ReadonlyMap<string, readonly InstallRecord[]>,
  options: ReadonlyUnknownRecord,
) => string;
type RenderAgentsJson = (detections: ReadonlyMap<string, readonly InstallRecord[]>) => string;
type CapabilityMapper = (source: ReadonlyUnknownRecord) => ReadonlyUnknownRecord;

const fixtureBytes = Object.fromEntries(
  Object.keys(FIXTURE_MANIFEST).map((name) => [name, readFileSync(join(FIXTURE_ROOT, name))]),
) as Readonly<Record<keyof typeof FIXTURE_MANIFEST, Buffer>>;
const fixtureText = (name: keyof typeof FIXTURE_MANIFEST): string =>
  fixtureBytes[name].toString('utf8');
const fleet = JSON.parse(fixtureText('agents-fleet.json')) as Readonly<{
  readonly tools: readonly FleetTool[];
  readonly capabilities: ReadonlyUnknownRecord;
}>;
const baseV2Golden = fixtureText('agents-base-v2.golden.json');
const capabilitiesV2Golden = fixtureText('agents-capabilities-v2.golden.json');
const defaultGolden = fixtureText('agents-default.golden.txt');
const detectedOnlyGolden = fixtureText('agents-detected-only.golden.txt');
const capabilitiesGolden = fixtureText('agents-capabilities.golden.txt');

let currentCommandSpecs: readonly ReadonlyUnknownRecord[];
let currentOptionRelations: readonly ReadonlyUnknownRecord[];
let runAgentsApplication: RunAgentsApplication;
let renderAgentsMarkdown: RenderAgentsMarkdown;
let renderAgentsJson: RenderAgentsJson;
let toolRegistry: ReadonlyUnknownRecord;
let toCapabilitySnapshotV1Dto: CapabilityMapper;
let currentWireCodecs: ReadonlyUnknownRecord;

const fixtureMap = (permuted = false): ReadonlyMap<string, readonly InstallRecord[]> => {
  const rows = (permuted ? [...fleet.tools].reverse() : fleet.tools).map(
    (tool) =>
      [tool.id, permuted ? [...tool.installations].reverse() : [...tool.installations]] as const,
  );
  return new Map(rows);
};

const observation = Object.freeze({
  context: Object.freeze({}),
  emitter: Object.freeze({
    begin: () => Object.freeze({}),
    complete: () => {},
  }),
});

const detectionContext = (overrides: ReadonlyUnknownRecord = {}): ReadonlyUnknownRecord =>
  Object.freeze({
    observation,
    signal: undefined,
    ports: Object.freeze({
      homeDir: '/home/fixture',
      executableSearchPath: Object.freeze([]),
      fileExists: async () => false,
      realpath: async (path: string) => path,
      runVersion: async () => 'fixture-version',
      ...overrides,
    }),
  });

const agentsRequest = (options: ReadonlyUnknownRecord = {}): ReadonlyUnknownRecord =>
  Object.freeze({
    arguments: Object.freeze([]),
    options: Object.freeze(options),
  });

const reportOf = (outcome: ReadonlyUnknownRecord): AgentsReport => outcome.report as AgentsReport;
const exitClassOf = (outcome: ReadonlyUnknownRecord): unknown => outcome.exitClass;
const keysOf = (outcome: ReadonlyUnknownRecord): readonly string[] => [
  ...reportOf(outcome).detections.keys(),
];
const operationCount = (snapshot: ReadonlyUnknownRecord): number =>
  (snapshot.tools as readonly ReadonlyUnknownRecord[]).reduce(
    (count, tool) => count + Object.keys(tool.operations as ReadonlyUnknownRecord).length,
    0,
  );

beforeAll(async () => {
  // Literal allocation, byte, and digest guards intentionally precede every production import.
  expect(FAMILY_ALLOCATION).toEqual({
    'EWP-CMD-AGENTS-TS01': [27, 28],
    'EWP-CMD-AGENTS-TS02': [29, 30],
    'EWP-CMD-AGENTS-TS03': [31, 32],
  });
  expect(Object.values(FAMILY_ALLOCATION).flat()).toEqual([27, 28, 29, 30, 31, 32]);
  expect(Object.keys(FIXTURE_MANIFEST)).toEqual([
    'agents-base-v2.golden.json',
    'agents-capabilities-v2.golden.json',
    'agents-capabilities.golden.txt',
    'agents-default.golden.txt',
    'agents-detected-only.golden.txt',
    'agents-fleet.json',
  ]);
  for (const [name, expected] of Object.entries(FIXTURE_MANIFEST)) {
    const bytes = fixtureBytes[name as keyof typeof FIXTURE_MANIFEST];
    expect(bytes.byteLength, `${name} literal byte length`).toBe(expected.bytes);
    expect(createHash('sha256').update(bytes).digest('hex'), `${name} literal SHA-256`).toBe(
      expected.sha256,
    );
    expect(bytes.at(-1), `${name} terminal LF`).toBe(0x0a);
    expect(bytes.at(-2), `${name} exactly one terminal LF`).not.toBe(0x0a);
  }
  expect(fleet.tools.map((tool) => tool.id)).toEqual([
    'claude-code',
    'codex',
    'kilo-code',
    'opencode',
    'muse',
  ]);
  expect(fleet.tools.flatMap((tool) => tool.installations)).toHaveLength(5);
  expect(operationCount(fleet.capabilities)).toBe(80);
  expect(baseV2Golden).toBe(capabilitiesV2Golden);
  expect(baseV2Golden).toBe(`${JSON.stringify(JSON.parse(baseV2Golden), null, 2)}\n`);
  expect(JSON.parse(baseV2Golden)).toMatchObject({
    schemaVersion: 2,
    kind: 'skillsmith.agents',
    capabilities: { schemaVersion: 1, kind: 'skillsmith.capabilities' },
  });

  const [
    specModule,
    applicationModule,
    markdownModule,
    jsonModule,
    registryModule,
    capabilityModule,
    wireModule,
  ] = await Promise.all([
    import('../../src/spec/registry.ts'),
    import('../../../core/src/application/read-services.ts'),
    import('../../src/output/agents-markdown.ts'),
    import('../../src/output/agents-json.ts'),
    import('../../../core/src/agents/registry.ts'),
    import('../../../core/src/contracts/v1/capability-snapshot.ts'),
    import('../../src/contracts/wire-contracts.ts'),
  ]);
  currentCommandSpecs =
    specModule.CURRENT_COMMAND_SPECS as unknown as readonly ReadonlyUnknownRecord[];
  currentOptionRelations =
    specModule.CURRENT_OPTION_RELATIONS as unknown as readonly ReadonlyUnknownRecord[];
  runAgentsApplication = applicationModule.runAgentsApplication as unknown as RunAgentsApplication;
  renderAgentsMarkdown = markdownModule.renderAgentsMarkdown as unknown as RenderAgentsMarkdown;
  renderAgentsJson = jsonModule.renderAgentsJson as unknown as RenderAgentsJson;
  toolRegistry = registryModule.toolRegistry as unknown as ReadonlyUnknownRecord;
  toCapabilitySnapshotV1Dto =
    capabilityModule.toCapabilitySnapshotV1Dto as unknown as CapabilityMapper;
  currentWireCodecs = wireModule.currentWireCodecs as unknown as ReadonlyUnknownRecord;
});

describe('EWP-CMD-AGENTS-TS01', () => {
  test('family 27: exact grammar, aliases, capabilities, and registry-order normalization', async () => {
    const spec = currentCommandSpecs.find((candidate) => candidate.path === 'skillsmith agents');
    expect(spec, 'agents command spec').toBeDefined();
    if (spec === undefined) throw new Error('missing agents command spec');
    const options = spec.options as readonly ReadonlyUnknownRecord[];
    const option = (long: string): ReadonlyUnknownRecord | undefined =>
      options.find((candidate) => candidate.long === long);
    const relations = currentOptionRelations.filter(
      (candidate) => candidate.command === 'skillsmith agents',
    );

    const reverse = await runAgentsApplication(
      agentsRequest({ tool: ['opencode', 'codex', 'opencode'] }),
      detectionContext(),
    );
    const jsonAlias = await runAgentsApplication(agentsRequest({ json: true }), detectionContext());
    const explicitJson = await runAgentsApplication(
      agentsRequest({ json: true, format: 'json' }),
      detectionContext(),
    );
    const conflictDetectionTouches: string[] = [];
    const markdownConflict = await runAgentsApplication(
      agentsRequest({ json: true, format: 'markdown' }),
      detectionContext({
        fileExists: async (path: string) => {
          conflictDetectionTouches.push(path);
          return false;
        },
      }),
    );

    expect({
      optionNames: options.map((candidate) => candidate.long).sort(),
      tool: option('--tool'),
      json: option('--json'),
      capabilities: option('--capabilities'),
      format: option('--format'),
      relations,
      normalizedTools: keysOf(reverse),
      jsonAliasFormat: reportOf(jsonAlias).format,
      explicitJsonFormat: reportOf(explicitJson).format,
      markdownConflict: {
        exit: exitClassOf(markdownConflict),
        detectionTouches: conflictDetectionTouches.length,
      },
    }).toEqual({
      optionNames: ['--capabilities', '--detected-only', '--format', '--help', '--json', '--tool'],
      tool: expect.objectContaining({
        short: '-t',
        repeatable: true,
        allowedValues: ['claude-code', 'codex', 'kilo-code', 'opencode', 'muse'],
      }),
      json: expect.objectContaining({
        valueShape: 'boolean',
        repeatable: false,
      }),
      capabilities: expect.objectContaining({
        valueShape: 'boolean',
        repeatable: false,
      }),
      format: expect.objectContaining({
        flags: '--format <markdown|json>',
        allowedValues: ['json', 'markdown'],
      }),
      relations: [],
      normalizedTools: ['codex', 'opencode'],
      jsonAliasFormat: 'json',
      explicitJsonFormat: 'json',
      markdownConflict: { exit: 'usage', detectionTouches: 0 },
    });
  });

  test('family 28: selection and success, usage, failure, and cancellation exits are total', async () => {
    const touched: string[] = [];
    const unknown = await runAgentsApplication(
      agentsRequest({ tool: ['future-tool'] }),
      new Proxy({} as ReadonlyUnknownRecord, {
        get: (_target, property) => {
          touched.push(String(property));
          throw new Error(`unknown selection touched detection context: ${String(property)}`);
        },
      }),
    );
    const all = await runAgentsApplication(agentsRequest(), detectionContext());
    const subset = await runAgentsApplication(
      agentsRequest({ tool: ['kilo-code', 'claude-code', 'kilo-code'] }),
      detectionContext(),
    );
    const failed = await runAgentsApplication(
      agentsRequest({ tool: ['codex'] }),
      detectionContext({
        fileExists: async () => {
          throw new Error('fixture detection failed');
        },
      }),
    );
    const cancelled = await runAgentsApplication(
      agentsRequest({ tool: ['codex'] }),
      detectionContext({
        fileExists: async () => {
          throw { code: 'ABORT_ERR' };
        },
      }),
    );

    expect({
      all: { exit: exitClassOf(all), tools: keysOf(all) },
      subset: { exit: exitClassOf(subset), tools: keysOf(subset) },
      unknown: { exit: exitClassOf(unknown), touched },
      failed: exitClassOf(failed),
      cancelled: exitClassOf(cancelled),
    }).toEqual({
      all: {
        exit: 'success',
        tools: ['claude-code', 'codex', 'kilo-code', 'opencode', 'muse'],
      },
      subset: { exit: 'success', tools: ['claude-code', 'kilo-code'] },
      unknown: { exit: 'usage', touched: [] },
      failed: 'failure',
      cancelled: 'cancelled',
    });
  });
});

describe('EWP-CMD-AGENTS-TS02', () => {
  test('family 29: zero, single, multiple, and detected-only output match human goldens', () => {
    const detections = fixtureMap();
    const renderedDefault = renderAgentsMarkdown(detections, {
      detectedOnly: false,
    });
    const renderedDetectedOnly = renderAgentsMarkdown(detections, {
      detectedOnly: true,
    });

    expect({
      default: renderedDefault,
      detectedOnly: renderedDetectedOnly,
      labels: {
        zero: renderedDefault.includes('claude-code — not detected'),
        single: renderedDefault.includes('codex — one installation'),
        multiple: renderedDefault.includes('kilo-code — multiple installations (2)'),
        omitted: !renderedDetectedOnly.includes('claude-code'),
      },
    }).toEqual({
      default: defaultGolden,
      detectedOnly: detectedOnlyGolden,
      labels: { zero: true, single: true, multiple: true, omitted: true },
    });
  });

  test('family 30: canonical installation sort, escaping, classification, and repeat bytes', () => {
    const first = renderAgentsMarkdown(fixtureMap(true), {
      detectedOnly: false,
    });
    const second = renderAgentsMarkdown(fixtureMap(true), {
      detectedOnly: false,
    });

    expect({
      canonical: first,
      repeated: second === first,
      escapedPath: first.includes('/opt/codex\\|stable'),
      escapedVersion: first.includes('1.2\\|3'),
      flattenedControls: first.includes('/opt/opencode nightly') && first.includes('0.2 next'),
      sortedKilo: first.indexOf('/opt/kilo/a') < first.indexOf('/opt/kilo/z'),
    }).toEqual({
      canonical: defaultGolden,
      repeated: true,
      escapedPath: true,
      escapedVersion: true,
      flattenedControls: true,
      sortedKilo: true,
    });
  });
});

describe('EWP-CMD-AGENTS-TS03', () => {
  test('family 31: JSON aliases share strict agents@2 bytes and remain human-flag independent', async () => {
    const detections = fixtureMap();
    const fleetBytes = renderAgentsJson(detections);
    const codec = currentWireCodecs.agents as ReadonlyUnknownRecord;
    const descriptor = codec.descriptor as ReadonlyUnknownRecord;
    const validate = codec.validate as (value: unknown) => Readonly<{ readonly ok: boolean }>;
    const dto = JSON.parse(baseV2Golden) as UnknownRecord;
    const firstDetection = (dto.detections as UnknownRecord[])[0];
    expect(firstDetection, 'first agents@2 detection row').toBeDefined();
    if (firstDetection === undefined) throw new Error('missing first agents@2 detection row');
    const alias = await runAgentsApplication(agentsRequest({ json: true }), detectionContext());
    const format = await runAgentsApplication(
      agentsRequest({ format: 'json' }),
      detectionContext(),
    );
    const humanFlags = await runAgentsApplication(
      agentsRequest({ format: 'json', detectedOnly: true, capabilities: true }),
      detectionContext(),
    );
    const aliasBytes = renderAgentsJson(reportOf(alias).detections);
    const formatBytes = renderAgentsJson(reportOf(format).detections);
    const humanFlagBytes = renderAgentsJson(reportOf(humanFlags).detections);

    expect({
      descriptor: {
        id: descriptor.id,
        version: descriptor.version,
        unknownFields: descriptor.unknownFields,
      },
      strict: {
        acceptsV2: validate(dto).ok,
        rejectsFuture: !validate({ ...dto, schemaVersion: 3 }).ok,
        rejectsTopLevelUnknown: !validate({ ...dto, future: true }).ok,
        rejectsNestedUnknown: !validate({
          ...dto,
          detections: [
            { ...firstDetection, future: true },
            ...(dto.detections as UnknownRecord[]).slice(1),
          ],
        }).ok,
      },
      fleetBytes,
      embeddedVersion: (JSON.parse(fleetBytes) as UnknownRecord).schemaVersion,
      aliasFormat: reportOf(alias).format,
      explicitFormat: reportOf(format).format,
      aliasBytes,
      formatBytes,
      humanFlagBytes,
      goldensEqual: baseV2Golden === capabilitiesV2Golden,
    }).toEqual({
      descriptor: {
        id: 'agents',
        version: 2,
        unknownFields: 'reject-recursive',
      },
      strict: {
        acceptsV2: true,
        rejectsFuture: true,
        rejectsTopLevelUnknown: true,
        rejectsNestedUnknown: true,
      },
      fleetBytes: baseV2Golden,
      embeddedVersion: 2,
      aliasFormat: 'json',
      explicitFormat: 'json',
      aliasBytes: formatBytes,
      formatBytes,
      humanFlagBytes: formatBytes,
      goldensEqual: true,
    });
  });

  test('family 32: all 80 capability facts derive from registry scopes and remediation', () => {
    const adapters = toolRegistry.adapters as readonly ReadonlyUnknownRecord[];
    const snapshot = toCapabilitySnapshotV1Dto({ adapters });
    const tools = snapshot.tools as readonly ReadonlyUnknownRecord[];
    const kilo = tools.find((tool) => tool.id === 'kilo-code');
    const opencode = tools.find((tool) => tool.id === 'opencode');
    const kiloOperations = kilo?.operations as ReadonlyUnknownRecord;
    const opencodeOperations = opencode?.operations as ReadonlyUnknownRecord;
    const human = renderAgentsMarkdown(fixtureMap(), {
      detectedOnly: false,
      capabilities: true,
      capabilitySnapshot: snapshot,
    });

    expect({
      snapshot,
      order: tools.map((tool) => tool.id),
      operationCount: operationCount(snapshot),
      kiloInstall: kiloOperations.install,
      opencodeApply: opencodeOperations.apply,
      human,
      json: renderAgentsJson(fixtureMap()),
    }).toEqual({
      snapshot: fleet.capabilities,
      order: ['claude-code', 'codex', 'kilo-code', 'opencode', 'muse'],
      operationCount: 80,
      kiloInstall: {
        supported: false,
        scopes: [],
        remediation: 'kilo-code is read-only; choose claude-code or codex',
      },
      opencodeApply: {
        supported: false,
        scopes: [],
        remediation: 'opencode cannot participate in desired-state mutations',
      },
      human: capabilitiesGolden,
      json: capabilitiesV2Golden,
    });
  });
});
