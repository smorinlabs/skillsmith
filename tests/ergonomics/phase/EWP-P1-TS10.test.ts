import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { renderCliError } from '../../../packages/cli/src/output/error-boundary.ts';
import type { RuntimeOutcome } from '../../../packages/cli/src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../../packages/cli/src/runtime/current-renderers.ts';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/registry.ts';
import { TOOL_OPERATIONS } from '../../../packages/core/src/agents/adapter-types.ts';
import { createToolRegistry, toolRegistry } from '../../../packages/core/src/agents/registry.ts';
import { SCOPES } from '../../../packages/core/src/config/types.ts';
import { createJsonWireCodec } from '../../../packages/core/src/contracts/codec.ts';
import {
  AlternativeVersion1Schema,
  BroadKindSchema,
  CatchallSchema,
  DriftedVersionAndKindSchema,
  FixtureVersion2Schema,
  InheritedArrayPrototypeSchema,
  MigratingVersion2Schema,
  MixedObjectUnionSchema,
  NestedDefaultPassthroughSchema,
  NestedPassthroughSchema,
  ObservableStateTransformSchema,
  OptionalInheritedSchema,
  OptionalVersionSchema,
  SignedZeroTransformSchema,
  StatefulBatchTransformSchema,
  StatefulSharedBatchTransformSchema,
  TransformedGetterSchema,
  TransformedIdentityDriftSchema,
  TransformedSecretSchema,
  readStatefulBatchTransformCalls,
  resetStatefulBatchTransformCalls,
  resetTransformedGetterReads,
  transformedGetterReads,
} from '../../../packages/core/tests/fixtures/wire-codec.ts';
import { writeFixtureAdapter } from '../fixtures/p1-ts09/write-adapter.ts';
import {
  APPLY_HUMAN_GOLDEN,
  CURRENT_JSON_GOLDENS,
  CURRENT_LIFECYCLE_V2_GOLDENS,
  CURRENT_RENDERER_REPORTS,
  GOLDEN_TERMINAL_LF,
  HISTORICAL_FLIP_V3_GOLDEN,
  HISTORICAL_JSON_GOLDENS,
  REPORT_FIXTURES,
} from '../fixtures/p1-ts10/reports.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const CONTRACTS_ROOT = join(ROOT, 'packages/core/src/contracts');
const CLI_AUTHORITY = join(ROOT, 'packages/cli/src/contracts/wire-contracts.ts');

const EXPECTED_PATHS = [
  'skillsmith agents',
  'skillsmith apply',
  'skillsmith check',
  'skillsmith commands',
  'skillsmith config get',
  'skillsmith config list',
  'skillsmith config set',
  'skillsmith config unset',
  'skillsmith cross-tool-names',
  'skillsmith dev',
  'skillsmith doctor',
  'skillsmith export',
  'skillsmith gc',
  'skillsmith init',
  'skillsmith install',
  'skillsmith list',
  'skillsmith plan',
  'skillsmith promote',
  'skillsmith status',
  'skillsmith sync',
  'skillsmith undo',
  'skillsmith uninstall',
  'skillsmith update',
  'skillsmith verify',
] as const;

const EXPECTED_MAPPINGS = [
  ['skillsmith agents', 'agents', 2],
  ['skillsmith apply', 'apply-report', 1],
  ['skillsmith check', 'health', 1],
  ['skillsmith commands', 'commands', 2],
  ['skillsmith config get', 'config-get', 1],
  ['skillsmith config list', 'config-list', 1],
  ['skillsmith config set', 'config-set', 1],
  ['skillsmith config unset', 'config-unset', 1],
  ['skillsmith cross-tool-names', 'cross-tool-names', 1],
  ['skillsmith dev', 'flip', 4],
  ['skillsmith doctor', 'health', 2],
  ['skillsmith export', 'export', 1],
  ['skillsmith gc', 'gc', 1],
  ['skillsmith init', 'init', 1],
  ['skillsmith install', 'install', 2],
  ['skillsmith list', 'list', 3],
  ['skillsmith plan', 'plan-report', 1],
  ['skillsmith promote', 'flip', 4],
  ['skillsmith status', 'status', 1],
  ['skillsmith sync', 'sync', 1],
  ['skillsmith undo', 'undo', 1],
  ['skillsmith uninstall', 'uninstall', 2],
  ['skillsmith update', 'update', 1],
  ['skillsmith verify', 'verify', 1],
] as const;

const EXPECTED_CODECS = [
  ['agents', 1],
  ['agents', 2],
  ['apply-report', 1],
  ['health', 1],
  ['health', 2],
  ['commands', 1],
  ['commands', 2],
  ['config-get', 1],
  ['config-list', 1],
  ['config-set', 1],
  ['config-unset', 1],
  ['cross-tool-names', 1],
  ['flip', 2],
  ['flip', 3],
  ['flip', 4],
  ['gc', 1],
  ['install', 1],
  ['init', 1],
  ['install', 2],
  ['list', 2],
  ['list', 3],
  ['plan-report', 1],
  ['status', 1],
  ['sync', 1],
  ['update', 1],
  ['uninstall', 1],
  ['uninstall', 2],
  ['undo', 1],
  ['verify', 1],
  ['error', 1],
  ['export', 1],
  ['capability-snapshot', 1],
] as const;

const EXPECTED_DESCRIPTOR_POLICY: Readonly<
  Record<
    string,
    {
      readonly wireKind: string | null;
      readonly embeddedVersion: 'schemaVersion' | null;
      readonly indent: 0 | 2;
      readonly terminalLf: boolean;
    }
  >
> = {
  'agents@1': { wireKind: null, embeddedVersion: 'schemaVersion', indent: 2, terminalLf: true },
  'agents@2': {
    wireKind: 'skillsmith.agents',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'apply-report@1': {
    wireKind: 'skillsmith.apply-report',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'health@1': { wireKind: null, embeddedVersion: 'schemaVersion', indent: 2, terminalLf: false },
  'health@2': { wireKind: null, embeddedVersion: 'schemaVersion', indent: 2, terminalLf: false },
  'commands@1': {
    wireKind: null,
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'commands@2': {
    wireKind: 'skillsmith.commands',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'config-get@1': { wireKind: null, embeddedVersion: null, indent: 2, terminalLf: true },
  'config-list@1': { wireKind: null, embeddedVersion: null, indent: 2, terminalLf: false },
  'config-set@1': { wireKind: null, embeddedVersion: null, indent: 0, terminalLf: true },
  'config-unset@1': { wireKind: null, embeddedVersion: null, indent: 0, terminalLf: true },
  'cross-tool-names@1': {
    wireKind: 'skillsmith.cross-tool-names',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'flip@2': {
    wireKind: 'skillsmith.flip',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'flip@3': {
    wireKind: 'skillsmith.flip',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'flip@4': {
    wireKind: 'skillsmith.flip',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'gc@1': {
    wireKind: 'skillsmith.gc',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'install@1': {
    wireKind: 'skillsmith.install',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'init@1': {
    wireKind: 'skillsmith.init',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'install@2': {
    wireKind: 'skillsmith.install',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'list@2': { wireKind: null, embeddedVersion: 'schemaVersion', indent: 2, terminalLf: false },
  'list@3': {
    wireKind: 'skillsmith.list',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'plan-report@1': {
    wireKind: 'skillsmith.plan-report',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'status@1': {
    wireKind: 'skillsmith.status',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'sync@1': {
    wireKind: 'skillsmith.sync',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'update@1': {
    wireKind: 'skillsmith.update',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'uninstall@1': {
    wireKind: 'skillsmith.uninstall',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'uninstall@2': {
    wireKind: 'skillsmith.uninstall',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'undo@1': {
    wireKind: 'skillsmith.undo',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'verify@1': {
    wireKind: 'skillsmith.verify',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  'error@1': { wireKind: 'error', embeddedVersion: 'schemaVersion', indent: 0, terminalLf: true },
  'export@1': {
    wireKind: 'skillsmith.export',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: true,
  },
  'capability-snapshot@1': {
    wireKind: 'skillsmith.capabilities',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
};

const GOLDEN_FILES = {
  agents: 'agents.stdout',
  apply: 'apply.stdout',
  health: 'health.stdout',
  commands: 'commands.stdout',
  doctor: 'doctor.stdout',
  configGetUnscoped: 'config-get-unscoped.stdout',
  configGetScoped: 'config-get-scoped.stdout',
  configListUnscoped: 'config-list-unscoped.stdout',
  configListScoped: 'config-list-scoped.stdout',
  configSet: 'config-set.stdout',
  configUnset: 'config-unset.stdout',
  flip: 'flip.stdout',
  install: 'install.stdout',
  list: 'list.stdout',
  plan: 'plan.stdout',
  status: 'status.stdout',
  sync: 'sync.stdout',
  undo: 'undo.stdout',
  update: 'update.stdout',
  uninstall: 'uninstall.stdout',
  verify: 'verify.stdout',
  error: 'error.stdout',
  export: 'export.stdout',
  init: 'init.stdout',
  gc: 'gc.stdout',
} as const;

const DESCRIPTOR_KEYS = [
  'id',
  'version',
  'wireKind',
  'embeddedVersion',
  'unknownFields',
  'formatting',
  'migrations',
  'compatibility',
] as const;
const MAPPING_KEYS = ['commandPath', 'contractId', 'version'] as const;
const CONTRACT_RUNTIME_EXPORTS = ['createWireContractRegistry'] as const;
const V1_RUNTIME_EXPORTS = [
  'agentsV1Codec',
  'applyV1Codec',
  'capabilitySnapshotV1Codec',
  'commandsV1Codec',
  'configGetV1Codec',
  'configListV1Codec',
  'configSetV1Codec',
  'configUnsetV1Codec',
  'createVerifyV1Codec',
  'crossToolNamesV1Codec',
  'errorV1Codec',
  'exportV1Codec',
  'gcV1Codec',
  'healthV1Codec',
  'initV1Codec',
  'installV1Codec',
  'planV1Codec',
  'syncV1Codec',
  'updateV1Codec',
  'toAgentsV1Dto',
  'toCapabilitySnapshotV1Dto',
  'toCommandsV1Dto',
  'toConfigGetV1Dto',
  'toConfigListV1Dto',
  'toConfigSetV1Dto',
  'toConfigUnsetV1Dto',
  'toCrossToolNamesV1Dto',
  'toErrorV1Dto',
  'toExportV1Dto',
  'toHealthV1Dto',
  'toInitV1Dto',
  'toInstallV1Dto',
  'statusV1Codec',
  'toStatusV1Dto',
  'toUninstallV1Dto',
  'toUndoV1Dto',
  'toVerifyV1Dto',
  'uninstallV1Codec',
  'undoV1Codec',
  'verifyV1Codec',
  'manifestV1Codec',
  'toManifestV1Dto',
  'fromManifestV1Dto',
  'lockV1Codec',
  'toLockV1Dto',
  'fromLockV1Dto',
  'savedPlanV1Codec',
  'toSavedPlanV1Dto',
  'fromSavedPlanV1Dto',
  'ledgerV1Codec',
  'toLedgerV1Dto',
  'fromLedgerV1Dto',
  'journalV1Codec',
  'toJournalV1Dto',
  'fromJournalV1Dto',
] as const;
const V2_RUNTIME_EXPORTS = [
  'agentsV2Codec',
  'commandsV2Codec',
  'flipV2Codec',
  'healthV2Codec',
  'installV2Codec',
  'listV2Codec',
  'uninstallV2Codec',
  'toAgentsV2Dto',
  'toCommandsV2Dto',
  'toFlipV2Dto',
  'toHealthV2Dto',
  'toInstallV2Dto',
  'toListV2Dto',
  'toUninstallV2Dto',
  'ledgerV2Codec',
  'toLedgerV2Dto',
  'fromLedgerV2Dto',
  'migrateLedgerV1DtoToV2Dto',
] as const;
const V3_RUNTIME_EXPORTS = ['flipV3Codec', 'toFlipV3Dto', 'listV3Codec', 'toListV3Dto'] as const;
const V4_RUNTIME_EXPORTS = ['flipV4Codec', 'toFlipV4Dto'] as const;

type UnknownRecord = Record<PropertyKey, unknown>;
type WireResult = { readonly ok: boolean; readonly value?: unknown; readonly error?: unknown };
type WireCodec = {
  readonly descriptor: UnknownRecord;
  validate(input: unknown): WireResult;
  decode(text: string): WireResult;
  encode(dto: unknown): WireResult;
};
type WireMapping = {
  readonly commandPath: string;
  readonly contractId: string;
  readonly version: number;
};
type WireRegistry = {
  readonly codecs: readonly WireCodec[];
  readonly commandMappings: readonly WireMapping[];
  get(id: string, version: number): WireCodec | undefined;
  latest(id: string): WireCodec | undefined;
  forCommand(commandPath: string): WireCodec | undefined;
};
type AuthorityModule = {
  readonly currentWireContractRegistry?: WireRegistry;
  readonly currentWireCommandMappings?: readonly WireMapping[];
  readonly currentWireCodecs?: Readonly<Record<string, WireCodec>>;
  readonly assertCurrentWireContractClosure?: (mappings: readonly WireMapping[]) => void;
};
type BuilderModule = {
  readonly createWireContractRegistry?: (
    codecs: readonly WireCodec[],
    mappings: readonly WireMapping[],
  ) => WireRegistry;
};
type WireBuilder = NonNullable<BuilderModule['createWireContractRegistry']>;
type CurrentBytes = { readonly [Key in keyof typeof CURRENT_JSON_GOLDENS]: string };

const record = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const importMaybe = async (path: string): Promise<UnknownRecord | null> => {
  try {
    await readFile(path, 'utf8');
    return (await import(`${pathToFileURL(path).href}?ewp-p1-ts10`)) as UnknownRecord;
  } catch {
    return null;
  }
};

const authority = async (): Promise<AuthorityModule | null> => {
  const loaded = (await importMaybe(CLI_AUTHORITY)) as AuthorityModule | null;
  expect(loaded, 'missing CLI-owned current wire-contract authority').not.toBeNull();
  return loaded;
};

const builder = async (): Promise<WireBuilder | null> => {
  const loaded = (await importMaybe(join(CONTRACTS_ROOT, 'registry.ts'))) as BuilderModule | null;
  expect(loaded, 'missing generic wire-contract registry module').not.toBeNull();
  expect(typeof loaded?.createWireContractRegistry, 'missing createWireContractRegistry').toBe(
    'function',
  );
  return loaded?.createWireContractRegistry ?? null;
};

const descriptorIdentity = (codec: WireCodec): readonly [unknown, unknown] => [
  codec.descriptor.id,
  codec.descriptor.version,
];

const resultValue = (result: WireResult): unknown => {
  expect(
    result.ok,
    record(result.error) ? JSON.stringify(result.error) : String(result.error),
  ).toBe(true);
  return result.value;
};

const callable = (value: unknown): ((...args: unknown[]) => unknown) | null =>
  typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;

const codecValue = (value: unknown, label: string): WireCodec | null => {
  expect(record(value), `missing ${label}`).toBeTrue();
  if (!record(value)) return null;
  expect(typeof value.validate, `${label}.validate`).toBe('function');
  expect(typeof value.decode, `${label}.decode`).toBe('function');
  expect(typeof value.encode, `${label}.encode`).toBe('function');
  return value as WireCodec;
};

const expectWireFailure = (
  result: WireResult,
  code: string,
  contractId: string,
  requestedVersion: number,
  path?: readonly (string | number)[],
): UnknownRecord => {
  expect(result.ok).toBeFalse();
  expect(record(result.error)).toBeTrue();
  const error = record(result.error) ? result.error : {};
  expect(Object.keys(error).sort()).toEqual(
    ['code', 'contractId', 'requestedVersion', 'path', 'message'].sort(),
  );
  expect(error).toMatchObject({ code, contractId, requestedVersion });
  if (path !== undefined) expect(error.path).toEqual([...path]);
  expect(typeof error.message).toBe('string');
  expect(Object.isFrozen(error)).toBeTrue();
  expect(Object.isFrozen(error.path)).toBeTrue();
  expect(error).not.toHaveProperty('cause');
  expect(error).not.toHaveProperty('stack');
  return error;
};

const verifyDtoFor = (tool: string): UnknownRecord => {
  const dto = JSON.parse(CURRENT_JSON_GOLDENS.verify) as UnknownRecord;
  dto.requested = { ...(dto.requested as UnknownRecord), tools: [tool] };
  dto.verifiedAgainst = { [tool]: '9.9.9' };
  dto.summary = {
    ...(dto.summary as UnknownRecord),
    verified: [tool],
    failed: [],
    skipped: [],
  };
  dto.tools = [{ ...((dto.tools as readonly UnknownRecord[])[0] ?? {}), tool }];
  return dto;
};

const mutableCodec = (codec: WireCodec, descriptorOverrides: UnknownRecord = {}): WireCodec => ({
  ...codec,
  descriptor: {
    ...codec.descriptor,
    formatting: record(codec.descriptor.formatting)
      ? { ...codec.descriptor.formatting }
      : codec.descriptor.formatting,
    migrations: Array.isArray(codec.descriptor.migrations)
      ? [...codec.descriptor.migrations]
      : codec.descriptor.migrations,
    ...descriptorOverrides,
  },
});

const successOutcome = (report: unknown): RuntimeOutcome => ({
  report,
  diagnostics: [],
  exitClass: 'success',
  mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
  deprecations: [],
});

const stdout = (rendered: string | { readonly stdout?: string }): string =>
  typeof rendered === 'string' ? rendered : (rendered.stdout ?? '');

const renderedCurrentBytes = (): CurrentBytes => {
  const root = {} as Parameters<typeof createCurrentRendererRegistry>[0];
  const renderers = createCurrentRendererRegistry(root);
  const render = (name: string, report: unknown) => {
    const selected = renderers[name];
    expect(selected, `missing current renderer ${name}`).toBeDefined();
    return selected === undefined ? '' : stdout(selected.json(successOutcome(report)));
  };
  const health = render('check', CURRENT_RENDERER_REPORTS.health);
  const flip = render('dev', CURRENT_RENDERER_REPORTS.flip);
  const doctorHealth = render('doctor', CURRENT_RENDERER_REPORTS.health);
  expect(doctorHealth, 'doctor must publish health@2').not.toBe(health);
  const decodedDoctor = JSON.parse(doctorHealth) as UnknownRecord;
  expect(decodedDoctor).toEqual({
    schemaVersion: 2,
    experimental: true,
    findings: [
      {
        ...(CURRENT_RENDERER_REPORTS.health.result?.findings[0] ?? {}),
        findingId: expect.stringMatching(/^finding:v1:[0-9a-f]{64}$/u),
      },
    ],
    counts: CURRENT_RENDERER_REPORTS.health.result?.counts,
    repair: { mode: 'not-requested', operations: [], results: [] },
    mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
  });
  expect(render('promote', CURRENT_RENDERER_REPORTS.flip), 'promote renderer drift').toBe(flip);
  return {
    agents: render('agents', CURRENT_RENDERER_REPORTS.agents),
    apply: render('apply', CURRENT_RENDERER_REPORTS.apply),
    health,
    commands: render('commands', CURRENT_RENDERER_REPORTS.commands),
    doctor: doctorHealth,
    configGetUnscoped: render('configGet', CURRENT_RENDERER_REPORTS.configGetUnscoped),
    configGetScoped: render('configGet', CURRENT_RENDERER_REPORTS.configGetScoped),
    configListUnscoped: render('configList', CURRENT_RENDERER_REPORTS.configListUnscoped),
    configListScoped: render('configList', CURRENT_RENDERER_REPORTS.configListScoped),
    configSet: render('configSet', CURRENT_RENDERER_REPORTS.configSet),
    configUnset: render('configUnset', CURRENT_RENDERER_REPORTS.configUnset),
    flip,
    install: render('install', CURRENT_RENDERER_REPORTS.install),
    list: render('list', CURRENT_RENDERER_REPORTS.list),
    plan: render('plan', CURRENT_RENDERER_REPORTS.plan),
    status: render('status', CURRENT_RENDERER_REPORTS.status),
    sync: render('sync', CURRENT_RENDERER_REPORTS.sync),
    undo: render('undo', CURRENT_RENDERER_REPORTS.undo),
    update: render('update', CURRENT_RENDERER_REPORTS.update),
    uninstall: render('uninstall', CURRENT_RENDERER_REPORTS.uninstall),
    verify: render('verify', CURRENT_RENDERER_REPORTS.verify),
    export: render('export', CURRENT_RENDERER_REPORTS.export),
    init: render('init', CURRENT_RENDERER_REPORTS.init),
    gc: render('gc', CURRENT_RENDERER_REPORTS.gc),
    error: renderCliError(REPORT_FIXTURES.error, 'json'),
  };
};

const addHostileFields = (value: UnknownRecord): UnknownRecord => {
  const copy = { ...value };
  for (const key of ['error', 'secret'])
    Object.defineProperty(copy, key, {
      enumerable: true,
      get: () => {
        throw new Error(`mapper read excluded ${key}`);
      },
    });
  return copy;
};

const hostileLifecycleReport = (
  value: UnknownRecord & { readonly results: readonly UnknownRecord[] },
) =>
  addHostileFields({
    ...value,
    results: value.results.map((item) => addHostileFields(item)),
  });

const expectedCapabilitySnapshot = (): UnknownRecord => ({
  schemaVersion: 1,
  kind: 'skillsmith.capabilities',
  tools: toolRegistry.adapters.map((adapter) => ({
    id: adapter.descriptor.id,
    order: adapter.descriptor.order,
    capabilityVersion: adapter.descriptor.capabilityVersion,
    operations: Object.fromEntries(
      TOOL_OPERATIONS.map((operation) => {
        const fact = adapter.descriptor.operations[operation];
        return [
          operation,
          {
            supported: fact.supported,
            scopes: [...fact.scopes],
            remediation: fact.remediation,
          },
        ];
      }),
    ),
  })),
});

const typescriptFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat().sort();
};

describe('EWP-P1-TS10', () => {
  test('family 1: characterizes exactly the twenty-four live JSON-selectable command paths', () => {
    const paths = CURRENT_COMMAND_SPECS.filter((spec) =>
      spec.options.some(
        (option) =>
          option.long === '--json' ||
          (option.long === '--format' && option.allowedValues.includes('json')),
      ),
    ).map((spec) => spec.path);
    expect(paths).toEqual([...EXPECTED_PATHS]);
    expect(new Set(paths).size).toBe(24);
    for (const excluded of ['skillsmith version', 'skillsmith completion', 'skillsmith help'])
      expect(paths).not.toContain(excluded);
  });

  test('family 2: makes the validated immutable registry and CLI mapping inventory authoritative', async () => {
    const loaded = await authority();
    const create = await builder();
    if (loaded === null || create === null) return;
    const registry = loaded.currentWireContractRegistry;
    const mappings = loaded.currentWireCommandMappings;
    expect(registry, 'missing currentWireContractRegistry').toBeDefined();
    expect(mappings, 'missing currentWireCommandMappings').toBeDefined();
    expect(loaded.currentWireCodecs, 'missing typed current renderer bindings').toBeDefined();
    expect(typeof loaded.assertCurrentWireContractClosure).toBe('function');
    if (registry === undefined || mappings === undefined) return;

    expect(registry.codecs.map(descriptorIdentity)).toEqual([...EXPECTED_CODECS]);
    expect(mappings.map((row) => [row.commandPath, row.contractId, row.version])).toEqual(
      EXPECTED_MAPPINGS.map((row) => [...row]),
    );
    expect(registry.commandMappings).toEqual(mappings);
    const bindingRows = [
      ['agents', 'skillsmith agents'],
      ['apply', 'skillsmith apply'],
      ['check', 'skillsmith check'],
      ['commands', 'skillsmith commands'],
      ['configGet', 'skillsmith config get'],
      ['configList', 'skillsmith config list'],
      ['configSet', 'skillsmith config set'],
      ['configUnset', 'skillsmith config unset'],
      ['crossToolNames', 'skillsmith cross-tool-names'],
      ['dev', 'skillsmith dev'],
      ['doctor', 'skillsmith doctor'],
      ['export', 'skillsmith export'],
      ['gc', 'skillsmith gc'],
      ['install', 'skillsmith install'],
      ['init', 'skillsmith init'],
      ['list', 'skillsmith list'],
      ['plan', 'skillsmith plan'],
      ['promote', 'skillsmith promote'],
      ['status', 'skillsmith status'],
      ['sync', 'skillsmith sync'],
      ['undo', 'skillsmith undo'],
      ['update', 'skillsmith update'],
      ['uninstall', 'skillsmith uninstall'],
      ['verify', 'skillsmith verify'],
    ] as const;
    expect(Object.keys(loaded.currentWireCodecs ?? {})).toEqual(bindingRows.map(([key]) => key));
    for (const [key, commandPath] of bindingRows) {
      expect(
        loaded.currentWireCodecs?.[key],
        `${commandPath} renderer does not use its mapped codec`,
      ).toBe(registry.forCommand(commandPath));
    }
    expect(registry.latest('install')?.descriptor.version).toBe(2);
    expect(registry.latest('uninstall')?.descriptor.version).toBe(2);
    expect(registry.forCommand('skillsmith install')?.descriptor.version).toBe(2);
    expect(registry.forCommand('skillsmith uninstall')?.descriptor.version).toBe(2);
    expect(Object.isFrozen(registry.codecs)).toBeTrue();
    expect(Object.isFrozen(registry.commandMappings)).toBeTrue();
    for (const mapping of registry.commandMappings) {
      expect(Object.keys(mapping)).toEqual([...MAPPING_KEYS]);
      expect(Object.isFrozen(mapping)).toBeTrue();
    }
    for (const codec of registry.codecs) {
      expect(Object.isFrozen(codec)).toBeTrue();
      expect(Object.isFrozen(codec.descriptor)).toBeTrue();
      expect(Object.keys(codec.descriptor)).toEqual([...DESCRIPTOR_KEYS]);
      expect(Object.isFrozen(codec.descriptor.formatting)).toBeTrue();
      expect(Object.isFrozen(codec.descriptor.migrations)).toBeTrue();
      const identity = `${String(codec.descriptor.id)}@${String(codec.descriptor.version)}`;
      const policy = EXPECTED_DESCRIPTOR_POLICY[identity];
      expect(policy, `missing expected descriptor policy for ${identity}`).toBeDefined();
      expect(codec.descriptor).toMatchObject({
        wireKind: policy?.wireKind,
        embeddedVersion: policy?.embeddedVersion,
        unknownFields: 'reject-recursive',
        formatting: { indent: policy?.indent, terminalLf: policy?.terminalLf },
        migrations: [],
        compatibility: 'conservative',
      });
    }
    const architecture = await readFile(join(ROOT, 'docs/architecture.md'), 'utf8');
    const coreReadme = await readFile(join(ROOT, 'packages/core/README.md'), 'utf8');
    for (const [id] of EXPECTED_CODECS)
      expect(`${architecture}\n${coreReadme}`, `documentation omits ${id}`).toContain(id);
    expect(() => loaded.assertCurrentWireContractClosure?.(mappings)).not.toThrow();
    expect(() => loaded.assertCurrentWireContractClosure?.(mappings.slice(1))).toThrow();
    expect(() =>
      loaded.assertCurrentWireContractClosure?.([
        ...mappings,
        { commandPath: 'skillsmith fixture', contractId: 'agents', version: 1 },
      ]),
    ).toThrow();

    const base = registry.get('agents', 1);
    expect(base).toBeDefined();
    if (base === undefined) return;
    const mutable = mutableCodec(base);
    const mutableDescriptor = mutable.descriptor;
    const v2 = createJsonWireCodec(
      {
        ...base.descriptor,
        version: 2,
      },
      FixtureVersion2Schema,
    );
    expect(() =>
      createJsonWireCodec(
        {
          id: 'fixture-drifted',
          version: 2,
          wireKind: 'fixture.expected',
          embeddedVersion: 'schemaVersion',
          unknownFields: 'reject-recursive',
          formatting: { indent: 0, terminalLf: false },
          migrations: [],
          compatibility: 'conservative',
        },
        DriftedVersionAndKindSchema,
      ),
    ).toThrow(/drift|version|kind/i);
    expect(() =>
      createJsonWireCodec(
        {
          id: 'fixture-broad-kind',
          version: 2,
          wireKind: 'fixture.expected',
          embeddedVersion: 'schemaVersion',
          unknownFields: 'reject-recursive',
          formatting: { indent: 0, terminalLf: false },
          migrations: [],
          compatibility: 'conservative',
        },
        BroadKindSchema,
      ),
    ).toThrow(/drift|kind|literal/i);
    expect(() =>
      createJsonWireCodec(
        {
          id: 'fixture-passthrough',
          version: 2,
          wireKind: null,
          embeddedVersion: 'schemaVersion',
          unknownFields: 'reject-recursive',
          formatting: { indent: 0, terminalLf: false },
          migrations: [],
          compatibility: 'conservative',
        },
        NestedPassthroughSchema,
      ),
    ).toThrow(/unknown|strict|reject/i);
    for (const [id, schema] of [
      ['fixture-default-passthrough', NestedDefaultPassthroughSchema],
      ['fixture-catchall', CatchallSchema],
    ] as const) {
      expect(() =>
        createJsonWireCodec(
          {
            id,
            version: 2,
            wireKind: null,
            embeddedVersion: 'schemaVersion',
            unknownFields: 'reject-recursive',
            formatting: { indent: 0, terminalLf: false },
            migrations: [],
            compatibility: 'conservative',
          },
          schema,
        ),
      ).toThrow(/unknown|strict|reject/i);
    }
    expect(() =>
      createJsonWireCodec(
        {
          id: 'fixture-nonobject-union',
          version: 2,
          wireKind: null,
          embeddedVersion: 'schemaVersion',
          unknownFields: 'reject-recursive',
          formatting: { indent: 0, terminalLf: false },
          migrations: [],
          compatibility: 'conservative',
        },
        MixedObjectUnionSchema,
      ),
    ).toThrow(/object|shape|schema/i);
    const transformedDescriptor = {
      id: 'fixture-transformed',
      version: 1,
      wireKind: 'fixture.expected',
      embeddedVersion: 'schemaVersion',
      unknownFields: 'reject-recursive',
      formatting: { indent: 0, terminalLf: false },
      migrations: [],
      compatibility: 'conservative',
    } as const;
    const transformedInput = {
      schemaVersion: 1 as const,
      kind: 'fixture.expected' as const,
      value: 'stable',
    };
    const identityDriftCodec = createJsonWireCodec(
      transformedDescriptor,
      TransformedIdentityDriftSchema,
    );
    expectWireFailure(
      identityDriftCodec.validate(transformedInput),
      'invalid-shape',
      'fixture-transformed',
      1,
      ['schemaVersion'],
    );
    expectWireFailure(
      identityDriftCodec.encode(transformedInput),
      'invalid-shape',
      'fixture-transformed',
      1,
      ['schemaVersion'],
    );
    const transformedSecretCodec = createJsonWireCodec(
      { ...transformedDescriptor, id: 'fixture-transformed-secret' },
      TransformedSecretSchema,
    );
    expectWireFailure(
      transformedSecretCodec.validate(transformedInput),
      'invalid-shape',
      'fixture-transformed-secret',
      1,
      ['secret'],
    );
    resetTransformedGetterReads();
    const transformedGetterCodec = createJsonWireCodec(
      { ...transformedDescriptor, id: 'fixture-transformed-getter' },
      TransformedGetterSchema,
    );
    expectWireFailure(
      transformedGetterCodec.encode(transformedInput),
      'invalid-shape',
      'fixture-transformed-getter',
      1,
      ['derived'],
    );
    expect(transformedGetterReads()).toBe(0);
    resetStatefulBatchTransformCalls();
    const statefulBatchCodec = createJsonWireCodec(
      { ...transformedDescriptor, id: 'fixture-stateful-batch' },
      StatefulBatchTransformSchema,
    );
    const firstStatefulEncoding = resultValue(statefulBatchCodec.encode(transformedInput));
    expect(firstStatefulEncoding).toBe(resultValue(statefulBatchCodec.encode(transformedInput)));
    expect(firstStatefulEncoding).toBe(
      '{"schemaVersion":1,"kind":"fixture.expected","value":"batch-0"}',
    );
    expect(readStatefulBatchTransformCalls()).toBe(2);
    const signedZeroCodec = createJsonWireCodec(
      { ...transformedDescriptor, id: 'fixture-signed-zero' },
      SignedZeroTransformSchema,
    );
    const signedZeroInput = { ...transformedInput, source: -0 };
    expect(resultValue(signedZeroCodec.encode(signedZeroInput))).toContain(
      '"value":"negative-zero"',
    );
    signedZeroInput.source = 0;
    expect(resultValue(signedZeroCodec.encode(signedZeroInput))).toContain(
      '"value":"positive-zero"',
    );
    const observableStateCodec = createJsonWireCodec(
      { ...transformedDescriptor, id: 'fixture-observable-state' },
      ObservableStateTransformSchema,
    );
    const observablePayload = Object.create(null) as UnknownRecord;
    Object.defineProperty(observablePayload, 'marker', {
      configurable: true,
      enumerable: true,
      value: 'stable',
      writable: true,
    });
    const observableStateInput = { ...transformedInput, payload: observablePayload };
    expect(resultValue(observableStateCodec.encode(observableStateInput))).toContain(
      '"value":"null-proto:extensible:writable:configurable"',
    );
    Object.setPrototypeOf(observablePayload, Object.prototype);
    expect(resultValue(observableStateCodec.encode(observableStateInput))).toContain(
      '"value":"object-proto:extensible:writable:configurable"',
    );
    Object.defineProperty(observablePayload, 'marker', { writable: false });
    expect(resultValue(observableStateCodec.encode(observableStateInput))).toContain(
      '"value":"object-proto:extensible:readonly:configurable"',
    );
    Object.preventExtensions(observablePayload);
    expect(resultValue(observableStateCodec.encode(observableStateInput))).toContain(
      '"value":"object-proto:fixed:readonly:configurable"',
    );
    const optionalInheritedCodec = createJsonWireCodec(
      { ...transformedDescriptor, id: 'fixture-optional-inherited' },
      OptionalInheritedSchema,
    );
    let inheritedOptionalReads = 0;
    const inheritedOptionalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'optional',
    );
    let inheritedOptionalResult: WireResult | undefined;
    try {
      Object.defineProperty(Object.prototype, 'optional', {
        configurable: true,
        get() {
          inheritedOptionalReads++;
          return `inherited-${inheritedOptionalReads}`;
        },
      });
      inheritedOptionalResult = optionalInheritedCodec.encode(transformedInput);
    } finally {
      if (inheritedOptionalDescriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, 'optional');
      } else {
        Object.defineProperty(Object.prototype, 'optional', inheritedOptionalDescriptor);
      }
    }
    expectWireFailure(
      inheritedOptionalResult ?? { ok: true },
      'invalid-shape',
      'fixture-optional-inherited',
      1,
      [],
    );
    expect(inheritedOptionalReads).toBe(0);
    const inheritedArrayPrototypeCodec = createJsonWireCodec(
      { ...transformedDescriptor, id: 'fixture-inherited-array-prototype' },
      InheritedArrayPrototypeSchema,
    );
    const originalArrayPrototypeParent = Object.getPrototypeOf(Array.prototype);
    let inheritedArrayPrototypeReads = 0;
    const hostileArrayPrototypeParent = Object.create(originalArrayPrototypeParent, {
      optional: {
        configurable: true,
        get() {
          inheritedArrayPrototypeReads++;
          return `inherited-${inheritedArrayPrototypeReads}`;
        },
      },
    });
    const inheritedArrayPrototypeInput = { ...transformedInput, payload: [] };
    let inheritedArrayPrototypeResult: WireResult | undefined;
    try {
      Object.setPrototypeOf(Array.prototype, hostileArrayPrototypeParent);
      inheritedArrayPrototypeResult = inheritedArrayPrototypeCodec.encode(
        inheritedArrayPrototypeInput,
      );
    } finally {
      Object.setPrototypeOf(Array.prototype, originalArrayPrototypeParent);
    }
    expectWireFailure(
      inheritedArrayPrototypeResult ?? { ok: true },
      'invalid-shape',
      'fixture-inherited-array-prototype',
      1,
      [],
    );
    expect(inheritedArrayPrototypeReads).toBe(0);
    resetStatefulBatchTransformCalls();
    const statefulSharedBatchCodec = createJsonWireCodec(
      { ...transformedDescriptor, id: 'fixture-stateful-shared-batch' },
      StatefulSharedBatchTransformSchema,
    );
    const sharedNestedValue = { marker: 'shared' };
    const sharedStatefulInput = {
      ...transformedInput,
      left: sharedNestedValue,
      right: sharedNestedValue,
    };
    const firstSharedStatefulEncoding = resultValue(
      statefulSharedBatchCodec.encode(sharedStatefulInput),
    );
    expect(firstSharedStatefulEncoding).toBe(
      resultValue(statefulSharedBatchCodec.encode(sharedStatefulInput)),
    );
    expect(readStatefulBatchTransformCalls()).toBe(2);
    expect(() =>
      createJsonWireCodec(
        {
          id: 'fixture-optional-version',
          version: 1,
          wireKind: null,
          embeddedVersion: null,
          unknownFields: 'reject-recursive',
          formatting: { indent: 0, terminalLf: false },
          migrations: [],
          compatibility: 'conservative',
        },
        OptionalVersionSchema,
      ),
    ).toThrow(/schemaVersion|descriptor|omit/i);
    let factoryDescriptorVersionReads = 0;
    const accessorFactoryDescriptor = {
      id: 'fixture-accessor-descriptor',
      get version() {
        factoryDescriptorVersionReads++;
        return factoryDescriptorVersionReads === 1 ? 2 : 0;
      },
      wireKind: null,
      embeddedVersion: 'schemaVersion',
      unknownFields: 'reject-recursive',
      formatting: { indent: 0, terminalLf: false },
      migrations: [],
      compatibility: 'conservative',
    } as const;
    const accessorFactoryCodec = createJsonWireCodec(
      accessorFactoryDescriptor,
      FixtureVersion2Schema,
    );
    expect(accessorFactoryCodec.descriptor.version).toBe(2);
    expect(factoryDescriptorVersionReads).toBe(1);
    const migrationCapable = createJsonWireCodec(
      {
        ...v2.descriptor,
        id: 'fixture-migration-capable',
        migrations: [1],
      },
      MigratingVersion2Schema,
      {
        1: (input) => ({
          schemaVersion: 2,
          value: record(input) && typeof input.legacy === 'string' ? input.legacy : '',
        }),
      },
    );
    expect(() => create([migrationCapable], [])).not.toThrow();
    const alternativeSameIdentity = createJsonWireCodec(base.descriptor, AlternativeVersion1Schema);
    expect(() =>
      create(
        [
          {
            descriptor: base.descriptor,
            validate: base.validate,
            decode: alternativeSameIdentity.decode,
            encode: alternativeSameIdentity.encode,
          },
        ],
        [],
      ),
    ).toThrow(/factory|private|identity|share/i);
    const structuralMissingMigration = {
      descriptor: { ...migrationCapable.descriptor },
      validate: (input: unknown) => migrationCapable.validate(input),
      decode: () => ({
        ok: false as const,
        error: {
          code: 'unsupported-version' as const,
          contractId: migrationCapable.descriptor.id,
          requestedVersion: 1,
          path: ['schemaVersion'],
          message: 'unsupported fixture wire version',
        },
      }),
      encode: (dto: Parameters<typeof migrationCapable.encode>[0]) => migrationCapable.encode(dto),
    };
    expect(() => create([structuralMissingMigration], [])).toThrow(/migration|declared/i);
    const fixtureMapping = { commandPath: 'skillsmith fixture', contractId: 'agents', version: 2 };
    const future = create([v2, mutable], [fixtureMapping]);
    expect(future.get('agents', 1)).toBeDefined();
    expect(future.latest('agents')?.descriptor.version).toBe(2);
    expect(future.forCommand('skillsmith fixture')?.descriptor.version).toBe(2);
    expect(Object.isFrozen(mutable)).toBeFalse();
    expect(Object.isFrozen(mutableDescriptor)).toBeFalse();
    expect(Object.isFrozen(future.codecs[0]?.descriptor)).toBeTrue();
    expect(Object.isFrozen(future.codecs[0]?.descriptor.formatting)).toBeTrue();
    expect(Object.isFrozen(future.codecs[0]?.descriptor.migrations)).toBeTrue();
    expect(() => create([mutable, mutable], [])).toThrow(/duplicate|identity/i);
    expect(() => create([mutableCodec(base, { version: 2 })], [])).toThrow(/drift|identity/i);
    expect(() => create([mutableCodec(base, { id: 'agents-drift' })], [])).toThrow(
      /drift|identity/i,
    );
    for (const version of [
      -1,
      0,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(
        () => create([mutableCodec(base, { version })], []),
        `accepted invalid codec version ${String(version)}`,
      ).toThrow(/version|safe|positive|integer/i);

    const without = (key: string): UnknownRecord => {
      const descriptor = { ...mutableDescriptor };
      Reflect.deleteProperty(descriptor, key);
      return descriptor;
    };
    const malformedDescriptors: readonly UnknownRecord[] = [
      { ...mutableDescriptor, extra: true },
      { ...mutableDescriptor, id: '' },
      { ...mutableDescriptor, wireKind: '' },
      { ...mutableDescriptor, wireKind: 1 },
      { ...mutableDescriptor, embeddedVersion: 'version' },
      { ...mutableDescriptor, unknownFields: 'strip' },
      { ...mutableDescriptor, formatting: { indent: 4, terminalLf: true } },
      { ...mutableDescriptor, formatting: { indent: 2 } },
      { ...mutableDescriptor, formatting: { indent: 2, terminalLf: 'yes' } },
      { ...mutableDescriptor, migrations: 'none' },
      { ...mutableDescriptor, migrations: [0] },
      { ...mutableDescriptor, migrations: [1] },
      { ...mutableDescriptor, migrations: [1.5] },
      { ...mutableDescriptor, compatibility: 'additive' },
      ...DESCRIPTOR_KEYS.map((key) => without(key)),
    ];
    for (const descriptor of malformedDescriptors)
      expect(
        () => create([{ ...mutable, descriptor } as WireCodec], []),
        `accepted malformed descriptor ${JSON.stringify(descriptor)}`,
      ).toThrow();
    const shadowedMigrationIterator = [0];
    Object.defineProperty(shadowedMigrationIterator, Symbol.iterator, {
      value: function* () {
        yield* [];
      },
    });
    expect(() =>
      create([mutableCodec(base, { migrations: shadowedMigrationIterator })], []),
    ).toThrow(/migration|version|positive/i);

    for (const method of ['validate', 'decode', 'encode'] as const) {
      const missing = { ...mutable } as UnknownRecord;
      Reflect.deleteProperty(missing, method);
      expect(() => create([missing as WireCodec], [])).toThrow(/method|function|codec/i);
      expect(() => create([{ ...mutable, [method]: true } as unknown as WireCodec], [])).toThrow(
        /method|function|codec/i,
      );
    }
    expect(() => create([{ ...mutable, extra: true } as unknown as WireCodec], [])).toThrow(
      /codec|exact|descriptor/i,
    );
    expect(() =>
      create(
        [
          {
            ...mutable,
            decode: (text: string) => mutable.decode(text),
          },
        ],
        [],
      ),
    ).toThrow(/complete|identity|attestation/i);
    const receiverSensitive = {
      descriptor: mutableDescriptor,
      validate(this: unknown, input: unknown) {
        if (this !== receiverSensitive) {
          return { ok: true as const, value: { schemaVersion: 99, leaked: true } };
        }
        return mutable.validate(input);
      },
      decode(this: unknown, text: string) {
        if (this !== receiverSensitive) {
          return { ok: true as const, value: { schemaVersion: 99, leaked: true } };
        }
        return mutable.decode(text);
      },
      encode(this: unknown, dto: unknown) {
        if (this !== receiverSensitive) return { ok: true as const, value: '{"leaked":true}' };
        return mutable.encode(dto);
      },
    } as WireCodec;
    expect(() => create([receiverSensitive], [])).toThrow(/validate|identity|drift/i);
    const formattingDriftCodec = {
      descriptor: {
        id: 'fixture-formatting-drift',
        version: 1,
        wireKind: null,
        embeddedVersion: null,
        unknownFields: 'reject-recursive',
        formatting: { indent: 2, terminalLf: true },
        migrations: [],
        compatibility: 'conservative',
      },
      validate(input: unknown) {
        return record(input) && typeof input.value === 'string'
          ? { ok: true as const, value: { value: input.value } }
          : {
              ok: false as const,
              error: {
                code: 'invalid-shape' as const,
                contractId: 'fixture-formatting-drift',
                requestedVersion: 1,
                path: [],
                message: 'invalid fixture value',
              },
            };
      },
      decode(text: string) {
        try {
          return this.validate(JSON.parse(text));
        } catch {
          return {
            ok: false as const,
            error: {
              code: 'malformed-json' as const,
              contractId: 'fixture-formatting-drift',
              requestedVersion: 1,
              path: [],
              message: 'invalid fixture JSON',
            },
          };
        }
      },
      encode(dto: unknown) {
        const validated = this.validate(dto);
        return validated.ok
          ? { ok: true as const, value: JSON.stringify(validated.value) }
          : validated;
      },
    } satisfies WireCodec;
    const formattingDriftRegistry = create([formattingDriftCodec], []);
    expectWireFailure(
      formattingDriftRegistry.get('fixture-formatting-drift', 1)?.encode({ value: 'probe' }) ?? {
        ok: true,
      },
      'migration-failed',
      'fixture-formatting-drift',
      1,
      [],
    );
    let statefulEncodeCalls = 0;
    const statefulCodec = {
      ...formattingDriftCodec,
      descriptor: {
        ...formattingDriftCodec.descriptor,
        id: 'fixture-stateful',
        formatting: { indent: 0 as const, terminalLf: false },
      },
      validate(input: unknown) {
        const result = formattingDriftCodec.validate(input);
        if (result.ok) return result;
        return {
          ...result,
          error: { ...result.error, contractId: 'fixture-stateful' },
        };
      },
      decode(text: string) {
        try {
          return this.validate(JSON.parse(text));
        } catch {
          return {
            ok: false as const,
            error: {
              code: 'malformed-json' as const,
              contractId: 'fixture-stateful',
              requestedVersion: 1,
              path: [],
              message: 'invalid fixture JSON',
            },
          };
        }
      },
      encode(dto: unknown) {
        statefulEncodeCalls++;
        return statefulEncodeCalls === 1
          ? { ok: true as const, value: JSON.stringify(dto) }
          : { ok: true as const, value: '{"secret":"LEAK"}' };
      },
    } satisfies WireCodec;
    const statefulRegistry = create([statefulCodec], []);
    const statefulOwned = statefulRegistry.get('fixture-stateful', 1);
    expect(statefulOwned).toBeDefined();
    if (statefulOwned === undefined) return;
    expect(resultValue(statefulOwned.encode({ value: 'stable' }))).toBe('{"value":"stable"}');
    expectWireFailure(
      statefulOwned.encode({ value: 'stable' }),
      'migration-failed',
      'fixture-stateful',
      1,
      [],
    );
    const throwingStructuralCodec = {
      ...formattingDriftCodec,
      descriptor: {
        ...formattingDriftCodec.descriptor,
        id: 'fixture-throwing-structural',
        formatting: { indent: 0 as const, terminalLf: false },
      },
      validate(input: unknown) {
        if (record(input) && input.value === 'validate-throw') {
          throw new Error('RAW VALIDATE THROW');
        }
        const result = formattingDriftCodec.validate(input);
        if (result.ok) return result;
        return {
          ...result,
          error: { ...result.error, contractId: 'fixture-throwing-structural' },
        };
      },
      decode(text: string) {
        if (text === 'decode-throw') throw new Error('RAW DECODE THROW');
        return this.validate(JSON.parse(text));
      },
      encode(dto: unknown) {
        if (record(dto) && dto.value === 'encode-throw') {
          throw new Error('RAW ENCODE THROW');
        }
        return { ok: true as const, value: JSON.stringify(dto) };
      },
    } satisfies WireCodec;
    const throwingStructuralRegistry = create([throwingStructuralCodec], []);
    const throwingStructuralOwned = throwingStructuralRegistry.get(
      'fixture-throwing-structural',
      1,
    );
    expect(throwingStructuralOwned).toBeDefined();
    if (throwingStructuralOwned === undefined) return;
    for (const result of [
      throwingStructuralOwned.validate({ value: 'validate-throw' }),
      throwingStructuralOwned.decode('decode-throw'),
      throwingStructuralOwned.encode({ value: 'encode-throw' }),
    ]) {
      expectWireFailure(result, 'migration-failed', 'fixture-throwing-structural', 1, []);
    }
    const fooCodec = {
      ...formattingDriftCodec,
      descriptor: {
        ...formattingDriftCodec.descriptor,
        id: 'fixture-foo',
        formatting: { indent: 0 as const, terminalLf: false },
      },
      validate(input: unknown) {
        if (record(input) && Object.keys(input).length === 1 && typeof input.foo === 'string') {
          return { ok: true as const, value: { foo: input.foo } };
        }
        return {
          ok: false as const,
          error: {
            code: 'invalid-shape' as const,
            contractId: 'fixture-foo',
            requestedVersion: 1,
            path: [],
            message: 'invalid foo fixture',
          },
        };
      },
      decode(text: string) {
        try {
          return this.validate(JSON.parse(text));
        } catch {
          return {
            ok: false as const,
            error: {
              code: 'malformed-json' as const,
              contractId: 'fixture-foo',
              requestedVersion: 1,
              path: [],
              message: 'invalid foo JSON',
            },
          };
        }
      },
      encode(dto: unknown) {
        const validated = this.validate(dto);
        return validated.ok
          ? { ok: true as const, value: JSON.stringify(validated.value) }
          : validated;
      },
    } satisfies WireCodec;
    const fooRegistry = create([fooCodec], []);
    const fooOwned = fooRegistry.get('fixture-foo', 1);
    expect(fooOwned).toBeDefined();
    if (fooOwned === undefined) return;
    expect(resultValue(fooOwned.encode({ foo: 'works' }))).toBe('{"foo":"works"}');
    const proxyMethodCodec = {
      ...mutable,
      validate: new Proxy(mutable.validate, {
        get(target, key, receiver) {
          if (typeof key === 'symbol') return {};
          return Reflect.get(target, key, receiver);
        },
      }),
    };
    expect(() => create([proxyMethodCodec], [])).toThrow(/proxy|function|codec/i);
    const structuralKindDrift = {
      descriptor: {
        id: 'fixture-structural-kind',
        version: 1,
        wireKind: 'fixture.expected',
        embeddedVersion: 'schemaVersion',
        unknownFields: 'reject-recursive',
        formatting: { indent: 0 as const, terminalLf: false },
        migrations: [],
        compatibility: 'conservative',
      },
      validate(input: unknown) {
        if (
          record(input) &&
          input.schemaVersion === 1 &&
          input.kind === 'fixture.actual' &&
          typeof input.requiredFirst === 'string'
        ) {
          return { ok: true as const, value: { ...input } };
        }
        return {
          ok: false as const,
          error: {
            code: 'invalid-shape' as const,
            contractId: 'fixture-structural-kind',
            requestedVersion: 1,
            path: ['requiredFirst'],
            message: 'missing required fixture field',
          },
        };
      },
      decode(text: string) {
        try {
          return this.validate(JSON.parse(text));
        } catch {
          return {
            ok: false as const,
            error: {
              code: 'malformed-json' as const,
              contractId: 'fixture-structural-kind',
              requestedVersion: 1,
              path: [],
              message: 'invalid fixture JSON',
            },
          };
        }
      },
      encode(dto: unknown) {
        const validated = this.validate(dto);
        return validated.ok
          ? { ok: true as const, value: JSON.stringify(validated.value) }
          : validated;
      },
    } satisfies WireCodec;
    const structuralKindRegistry = create([structuralKindDrift], []);
    const structuralKindOwned = structuralKindRegistry.get('fixture-structural-kind', 1);
    expect(structuralKindOwned).toBeDefined();
    if (structuralKindOwned === undefined) return;
    expectWireFailure(
      structuralKindOwned.validate({
        schemaVersion: 1,
        kind: 'fixture.actual',
        requiredFirst: 'present',
      }),
      'invalid-shape',
      'fixture-structural-kind',
      1,
      ['kind'],
    );
    expect(() => create([mutable], [fixtureMapping])).toThrow(/unknown|version|contract/i);
    expect(() =>
      create(
        [mutable],
        [
          { ...fixtureMapping, version: 1 },
          { ...fixtureMapping, version: 1 },
        ],
      ),
    ).toThrow(/duplicate|command/i);

    const validMapping = { commandPath: 'skillsmith fixture', contractId: 'agents', version: 1 };
    const malformedMappings: readonly unknown[] = [
      null,
      {},
      { ...validMapping, extra: true },
      { ...validMapping, commandPath: '' },
      { ...validMapping, contractId: '' },
      ...[-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(
        (version) => ({ ...validMapping, version }),
      ),
      ...MAPPING_KEYS.map((key) => {
        const mapping: UnknownRecord = { ...validMapping };
        Reflect.deleteProperty(mapping, key);
        return mapping;
      }),
    ];
    for (const mapping of malformedMappings)
      expect(
        () => create([mutable], [mapping as WireMapping]),
        `accepted malformed mapping ${String(mapping)}`,
      ).toThrow();

    const shadowedCodecMap = [mutableCodec(base, { version: 0 })];
    Object.defineProperty(shadowedCodecMap, 'map', { value: () => [] });
    expect(() => create(shadowedCodecMap, [])).toThrow(/version|safe|positive|integer/i);
    const shadowedMappingMap = [{ ...validMapping, version: 0 }];
    Object.defineProperty(shadowedMappingMap, 'map', { value: () => [] });
    expect(() => create([mutable], shadowedMappingMap as WireMapping[])).toThrow(
      /version|safe|positive|integer/i,
    );

    const ownedCodec = mutableCodec(base);
    const ownedDescriptor = ownedCodec.descriptor;
    const ownedFormatting = ownedDescriptor.formatting as UnknownRecord;
    const ownedMigrations = ownedDescriptor.migrations as number[];
    const ownedMapping = { ...validMapping };
    const callerCodecs = [ownedCodec];
    const callerMappings = [ownedMapping];
    const owned = create(callerCodecs, callerMappings);
    ownedDescriptor.id = 'mutated-after-build';
    ownedFormatting.indent = 0;
    ownedMigrations.push(99);
    ownedMapping.commandPath = 'skillsmith mutated';
    callerCodecs.length = 0;
    callerMappings.length = 0;
    expect(owned.get('agents', 1)?.descriptor).toMatchObject({
      id: 'agents',
      formatting: { indent: 2 },
      migrations: [],
    });
    expect(owned.forCommand('skillsmith fixture')?.descriptor.id).toBe('agents');
    expect(owned.forCommand('skillsmith mutated')).toBeUndefined();

    let descriptorVersionReads = 0;
    const accessorDescriptor = { ...mutableDescriptor };
    Object.defineProperty(accessorDescriptor, 'version', {
      enumerable: true,
      get: () => (++descriptorVersionReads === 1 ? 1 : 0),
    });
    let validateReads = 0;
    const accessorCodec = {
      descriptor: accessorDescriptor,
      get validate() {
        validateReads++;
        return validateReads === 1 ? mutable.validate : true;
      },
      decode: mutable.decode,
      encode: mutable.encode,
    } as unknown as WireCodec;
    let mappingPathReads = 0;
    const accessorMapping = {
      get commandPath() {
        mappingPathReads++;
        return mappingPathReads === 1 ? 'skillsmith accessor' : '';
      },
      contractId: 'agents',
      version: 1,
    } as WireMapping;
    const accessorOwned = create([accessorCodec], [accessorMapping]);
    expect(accessorOwned.get('agents', 1)?.descriptor.version).toBe(1);
    expect(typeof accessorOwned.get('agents', 1)?.validate).toBe('function');
    expect(accessorOwned.forCommand('skillsmith accessor')?.descriptor.id).toBe('agents');
    expect(descriptorVersionReads).toBe(1);
    expect(validateReads).toBe(1);
    expect(mappingPathReads).toBe(1);
  });

  test('family 3: strictly decodes malformed, unknown, wrong-version, and deterministic values', async () => {
    const loaded = await authority();
    const registry = loaded?.currentWireContractRegistry;
    expect(registry, 'missing production registry for strict decode').toBeDefined();
    if (registry === undefined) return;
    const install = registry.get('install', 1);
    const flip = registry.get('flip', 2);
    const agents = registry.get('agents', 1);
    const configGet = registry.get('config-get', 1);
    const configList = registry.get('config-list', 1);
    const uninstall = registry.get('uninstall', 1);
    const errorCodec = registry.get('error', 1);
    expect(install).toBeDefined();
    expect(flip).toBeDefined();
    expect(agents).toBeDefined();
    expect(configGet).toBeDefined();
    expect(configList).toBeDefined();
    expect(uninstall).toBeDefined();
    expect(errorCodec).toBeDefined();
    if (
      install === undefined ||
      flip === undefined ||
      agents === undefined ||
      configGet === undefined ||
      configList === undefined ||
      uninstall === undefined ||
      errorCodec === undefined
    )
      return;

    const malformedText = '{"do-not-leak":"raw-secret"';
    let malformed: WireResult | undefined;
    expect(() => {
      malformed = install.decode(malformedText);
    }).not.toThrow();
    const malformedError = expectWireFailure(
      malformed ?? { ok: true },
      'malformed-json',
      'install',
      1,
      [],
    );
    expect(String(malformedError.message)).not.toContain('raw-secret');

    const unknownCases: Array<{
      readonly value: UnknownRecord;
      readonly path: readonly (string | number)[];
    }> = [];
    const top = JSON.parse(HISTORICAL_JSON_GOLDENS.install) as UnknownRecord;
    top.unexpected = true;
    unknownCases.push({ value: top, path: ['unexpected'] });
    const nested = JSON.parse(HISTORICAL_JSON_GOLDENS.install) as UnknownRecord;
    (nested.requested as UnknownRecord).unexpected = true;
    unknownCases.push({ value: nested, path: ['requested', 'unexpected'] });
    const deep = JSON.parse(HISTORICAL_JSON_GOLDENS.install) as UnknownRecord;
    const firstResult = (deep.results as UnknownRecord[])[0];
    if (firstResult !== undefined) (firstResult.store as UnknownRecord).unexpected = true;
    unknownCases.push({ value: deep, path: ['results', 0, 'store', 'unexpected'] });
    for (const fixture of unknownCases) {
      const result = install.decode(JSON.stringify(fixture.value));
      expectWireFailure(result, 'invalid-shape', 'install', 1, fixture.path);
    }

    const wrongKind = JSON.parse(HISTORICAL_JSON_GOLDENS.install) as UnknownRecord;
    wrongKind.kind = 'skillsmith.other';
    expectWireFailure(install.decode(JSON.stringify(wrongKind)), 'invalid-shape', 'install', 1, [
      'kind',
    ]);
    const wrongInstallVersion = JSON.parse(HISTORICAL_JSON_GOLDENS.install) as UnknownRecord;
    for (const version of [0, 2]) {
      wrongInstallVersion.schemaVersion = version;
      expectWireFailure(
        install.decode(JSON.stringify(wrongInstallVersion)),
        'unsupported-version',
        'install',
        version,
        ['schemaVersion'],
      );
    }
    const wrongFlipVersion = JSON.parse(HISTORICAL_JSON_GOLDENS.flip) as UnknownRecord;
    for (const version of [1, 99]) {
      wrongFlipVersion.schemaVersion = version;
      expectWireFailure(
        flip.decode(JSON.stringify(wrongFlipVersion)),
        'unsupported-version',
        'flip',
        version,
        ['schemaVersion'],
      );
    }

    for (const [codec, bytes] of [
      [configGet, CURRENT_JSON_GOLDENS.configGetUnscoped],
      [configGet, CURRENT_JSON_GOLDENS.configGetScoped],
      [configList, CURRENT_JSON_GOLDENS.configListUnscoped],
      [configList, CURRENT_JSON_GOLDENS.configListScoped],
    ] as const) {
      const dto = resultValue(codec.decode(bytes));
      expect(resultValue(codec.encode(dto))).toBe(bytes);
    }

    const migratingV2 = createJsonWireCodec(
      {
        id: 'fixture-migrating',
        version: 2,
        wireKind: null,
        embeddedVersion: 'schemaVersion',
        unknownFields: 'reject-recursive',
        formatting: { indent: 0, terminalLf: false },
        migrations: [1],
        compatibility: 'conservative',
      },
      MigratingVersion2Schema,
      {
        1: (input) => ({
          schemaVersion: 2,
          value: record(input) && typeof input.legacy === 'string' ? input.legacy : '',
        }),
      },
    );
    const migrated = resultValue(migratingV2.decode('{"schemaVersion":1,"legacy":"kept"}'));
    expect(migrated).toEqual({ schemaVersion: 2, value: 'kept' });
    expect(resultValue(migratingV2.encode(migrated))).toBe('{"schemaVersion":2,"value":"kept"}');
    expectWireFailure(
      migratingV2.decode('{"schemaVersion":0,"legacy":"old"}'),
      'unsupported-version',
      'fixture-migrating',
      0,
      ['schemaVersion'],
    );
    expect(() =>
      createJsonWireCodec({ ...migratingV2.descriptor, migrations: [1] }, MigratingVersion2Schema),
    ).toThrow(/migration|handler/i);
    for (const migrations of [[0], [2], [3], [1, 1], [1.5]]) {
      expect(() =>
        createJsonWireCodec({ ...migratingV2.descriptor, migrations }, MigratingVersion2Schema),
      ).toThrow(/migration|version|older|integer/i);
    }
    const brokenMigration = createJsonWireCodec(migratingV2.descriptor, MigratingVersion2Schema, {
      1: () => ({ schemaVersion: 2, value: 1 }),
    });
    expectWireFailure(
      brokenMigration.decode('{"schemaVersion":1,"legacy":"broken"}'),
      'migration-failed',
      'fixture-migrating',
      1,
      ['value'],
    );

    const currentConfigTools = ['claude-code', 'codex', 'kilo-code', 'opencode', 'muse'] as const;
    const currentLifecycleTools = ['claude-code', 'codex'] as const;
    expect(toolRegistry.ids).toEqual([...currentConfigTools]);
    expect(toolRegistry.toolsFor('install')).toEqual([...currentLifecycleTools]);
    expect(SCOPES).toEqual(['system', 'user', 'project', 'managed']);
    for (const tool of currentConfigTools) {
      expect(configList.validate({ tool }).ok, `config-list@1 lost ${tool}`).toBeTrue();
    }
    for (const scope of ['system', 'user', 'project', 'managed']) {
      expect(configList.validate({ scope }).ok, `config-list@1 lost ${scope}`).toBeTrue();
    }
    expect(configList.validate({ tool: 'fixture-write' }).ok).toBeFalse();
    expect(configList.validate({ scope: 'custom' }).ok).toBeFalse();

    const lifecycleCases = [
      [install, HISTORICAL_JSON_GOLDENS.install],
      [uninstall, HISTORICAL_JSON_GOLDENS.uninstall],
      [flip, HISTORICAL_JSON_GOLDENS.flip],
    ] as const;
    for (const [codec, bytes] of lifecycleCases) {
      const baseDto = JSON.parse(bytes) as UnknownRecord;
      const resultRows = baseDto.results as UnknownRecord[];
      for (const tool of currentLifecycleTools) {
        const candidate = {
          ...baseDto,
          requested: { ...(baseDto.requested as UnknownRecord), tools: [tool] },
          results: resultRows.map((row) => ({ ...row, tool })),
        };
        expect(
          codec.validate(candidate).ok,
          `${String(codec.descriptor.id)} lost ${tool}`,
        ).toBeTrue();
      }
      for (const tool of ['kilo-code', 'opencode', 'fixture-write']) {
        const candidate = {
          ...baseDto,
          requested: { ...(baseDto.requested as UnknownRecord), tools: [tool] },
          results: resultRows.map((row) => ({ ...row, tool })),
        };
        expect(
          codec.validate(candidate).ok,
          `${String(codec.descriptor.id)}@${String(codec.descriptor.version)} accepted ${tool}`,
        ).toBeFalse();
      }
    }
    for (const [codec, bytes] of [
      [install, HISTORICAL_JSON_GOLDENS.install],
      [uninstall, HISTORICAL_JSON_GOLDENS.uninstall],
    ] as const) {
      const baseDto = JSON.parse(bytes) as UnknownRecord;
      const resultRows = baseDto.results as UnknownRecord[];
      for (const scope of ['user', 'project']) {
        const candidate = {
          ...baseDto,
          requested: { ...(baseDto.requested as UnknownRecord), scope },
          results: resultRows.map((row) => ({ ...row, scope })),
        };
        expect(
          codec.validate(candidate).ok,
          `${String(codec.descriptor.id)} lost ${scope}`,
        ).toBeTrue();
      }
      for (const scope of ['system', 'managed', 'custom']) {
        const candidate = {
          ...baseDto,
          requested: { ...(baseDto.requested as UnknownRecord), scope },
          results: resultRows.map((row) => ({ ...row, scope })),
        };
        expect(
          codec.validate(candidate).ok,
          `${String(codec.descriptor.id)}@${String(codec.descriptor.version)} accepted ${scope}`,
        ).toBeFalse();
      }
    }

    const dynamicAgents = JSON.parse(HISTORICAL_JSON_GOLDENS.agents) as UnknownRecord;
    const tools = dynamicAgents.tools as UnknownRecord;
    tools['fixture-dynamic-tool'] = [
      { path: '/fixture/bin/dynamic', version: '1.0.0', installMethod: 'unknown' },
    ];
    expect(agents.decode(JSON.stringify(dynamicAgents)).ok).toBeTrue();
    const agentsUnknown = { ...dynamicAgents, unexpected: true };
    expectWireFailure(agents.decode(JSON.stringify(agentsUnknown)), 'invalid-shape', 'agents', 1, [
      'unexpected',
    ]);

    const hostileDynamicKeys =
      '{"schemaVersion":1,"experimental":true,"tools":{"__proto__":[],"constructor":[]}}';
    const hostileDynamicDto = resultValue(agents.decode(hostileDynamicKeys)) as UnknownRecord;
    expect(Object.keys(hostileDynamicDto.tools as UnknownRecord)).toEqual([
      '__proto__',
      'constructor',
    ]);
    expect(Object.getPrototypeOf(hostileDynamicDto.tools as UnknownRecord)).toBeNull();
    expect(resultValue(agents.encode(hostileDynamicDto))).toBe(
      '{\n  "schemaVersion": 1,\n  "experimental": true,\n  "tools": {\n    "__proto__": [],\n    "constructor": []\n  }\n}\n',
    );
    for (const exoticTools of [new Date(0), new Map([['codex', []]]), /codex/]) {
      const exoticDto = { schemaVersion: 1, experimental: true, tools: exoticTools };
      expectWireFailure(agents.validate(exoticDto), 'invalid-shape', 'agents', 1, ['tools']);
      expectWireFailure(agents.encode(exoticDto), 'invalid-shape', 'agents', 1, ['tools']);
    }
    let dynamicPathReads = 0;
    const getterRecord = {
      get path() {
        dynamicPathReads++;
        return `/read-${dynamicPathReads}`;
      },
      version: '1.0.0',
      installMethod: 'unknown',
    };
    const getterDto = {
      schemaVersion: 1,
      experimental: true,
      tools: { fixture: [getterRecord] },
    };
    expectWireFailure(agents.encode(getterDto), 'invalid-shape', 'agents', 1, [
      'tools',
      'fixture',
      0,
      'path',
    ]);
    expectWireFailure(agents.encode(getterDto), 'invalid-shape', 'agents', 1, [
      'tools',
      'fixture',
      0,
      'path',
    ]);
    expect(dynamicPathReads).toBe(0);
    let inheritedPathReads = 0;
    const inheritedArrayPrototype = Object.create(Array.prototype, {
      0: {
        configurable: true,
        get() {
          inheritedPathReads++;
          return {
            path: `/inherited-${inheritedPathReads}`,
            version: '1.0.0',
            installMethod: 'unknown',
          };
        },
      },
    });
    const sparseRecords = new Array(1);
    Object.setPrototypeOf(sparseRecords, inheritedArrayPrototype);
    const inheritedGetterDto = {
      schemaVersion: 1,
      experimental: true,
      tools: { fixture: sparseRecords },
    };
    expectWireFailure(agents.encode(inheritedGetterDto), 'invalid-shape', 'agents', 1, [
      'tools',
      'fixture',
    ]);
    expectWireFailure(agents.encode(inheritedGetterDto), 'invalid-shape', 'agents', 1, [
      'tools',
      'fixture',
    ]);
    expect(inheritedPathReads).toBe(0);
    let arrayPrototypeReads = 0;
    const prototypeIndexDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, '3');
    const prototypeLengthDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'length');
    const prototypeGetterRecords = [
      { path: '/zero', version: '1.0.0', installMethod: 'unknown' },
      { path: '/one', version: '1.0.0', installMethod: 'unknown' },
      { path: '/two', version: '1.0.0', installMethod: 'unknown' },
    ];
    prototypeGetterRecords.length = 4;
    const prototypeGetterDto = {
      schemaVersion: 1,
      experimental: true,
      tools: { fixture: prototypeGetterRecords },
    };
    let prototypeGetterResult: WireResult | undefined;
    try {
      Object.defineProperty(Array.prototype, '3', {
        configurable: true,
        get() {
          arrayPrototypeReads++;
          return {
            path: `/prototype-${arrayPrototypeReads}`,
            version: '1.0.0',
            installMethod: 'unknown',
          };
        },
      });
      prototypeGetterResult = agents.encode(prototypeGetterDto);
    } finally {
      if (prototypeIndexDescriptor === undefined) {
        Reflect.deleteProperty(Array.prototype, '3');
      } else {
        Object.defineProperty(Array.prototype, '3', prototypeIndexDescriptor);
      }
      if (prototypeLengthDescriptor !== undefined) {
        Object.defineProperty(Array.prototype, 'length', prototypeLengthDescriptor);
      }
    }
    expectWireFailure(prototypeGetterResult ?? { ok: true }, 'invalid-shape', 'agents', 1, []);
    expect(arrayPrototypeReads).toBe(0);
    const sparseMutationRecords: unknown[] = [];
    const sparseMutationDto = {
      schemaVersion: 1,
      experimental: true,
      tools: { fixture: sparseMutationRecords },
    };
    expect(agents.encode(sparseMutationDto).ok).toBeTrue();
    sparseMutationRecords.length = 1;
    expectWireFailure(agents.encode(sparseMutationDto), 'invalid-shape', 'agents', 1, [
      'tools',
      'fixture',
      0,
    ]);

    let proxyMessageReads = 0;
    const proxyErrorDto = new Proxy(JSON.parse(CURRENT_JSON_GOLDENS.error) as UnknownRecord, {
      get(target, key, receiver) {
        if (key === 'message') return `dynamic-${++proxyMessageReads}`;
        return Reflect.get(target, key, receiver);
      },
    });
    expectWireFailure(errorCodec.encode(proxyErrorDto), 'invalid-shape', 'error', 1, []);
    expectWireFailure(errorCodec.encode(proxyErrorDto), 'invalid-shape', 'error', 1, []);
    expect(proxyMessageReads).toBe(0);
    let hiddenMessageReads = 0;
    const hiddenGetterDto = JSON.parse(CURRENT_JSON_GOLDENS.error) as UnknownRecord;
    Object.defineProperty(hiddenGetterDto, 'message', {
      enumerable: false,
      get() {
        hiddenMessageReads++;
        return `hidden-${hiddenMessageReads}`;
      },
    });
    expectWireFailure(errorCodec.encode(hiddenGetterDto), 'invalid-shape', 'error', 1, ['message']);
    expectWireFailure(errorCodec.encode(hiddenGetterDto), 'invalid-shape', 'error', 1, ['message']);
    expect(hiddenMessageReads).toBe(0);

    expect(registry.get('config-get', 99)).toBeUndefined();
    expect(registry.latest('config-get')?.descriptor.version).toBe(1);
    const dto = resultValue(install.decode(HISTORICAL_JSON_GOLDENS.install));
    const invalidDto = { ...(dto as UnknownRecord), unexpected: true };
    let invalidEncode: WireResult | undefined;
    expect(() => {
      invalidEncode = install.encode(invalidDto);
    }).not.toThrow();
    expectWireFailure(invalidEncode ?? { ok: true }, 'invalid-shape', 'install', 1, ['unexpected']);
    const encoded = resultValue(install.encode(dto));
    expect(encoded).toBe(resultValue(install.encode(dto)));
    expect(encoded).toBe(HISTORICAL_JSON_GOLDENS.install);
    (dto as UnknownRecord).unexpectedAfterFirstEncode = true;
    expectWireFailure(install.encode(dto), 'invalid-shape', 'install', 1, [
      'unexpectedAfterFirstEncode',
    ]);
  });

  test('family 4: compiles public codec-derived DTOs and compile-negative internal fields', async () => {
    const fixture = join(ROOT, 'tests/ergonomics/fixtures/p1-ts10/tsconfig.json');
    const child = Bun.spawn([join(ROOT, 'node_modules/.bin/tsc'), '-p', fixture, '--noEmit'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
    expect(exitCode, output).toBe(0);
  }, 30_000);

  test('family 5: exposes explicit named mappers that never read excluded lifecycle internals', async () => {
    const [v1, v2, v3, v4] = await Promise.all([
      importMaybe(join(CONTRACTS_ROOT, 'v1/index.ts')),
      importMaybe(join(CONTRACTS_ROOT, 'v2/index.ts')),
      importMaybe(join(CONTRACTS_ROOT, 'v3/index.ts')),
      importMaybe(join(CONTRACTS_ROOT, 'v4/index.ts')),
    ]);
    expect(v1, 'missing v1 codecs and mappers').not.toBeNull();
    expect(v2, 'missing v2 codecs and mappers').not.toBeNull();
    expect(v3, 'missing v3 codecs and mappers').not.toBeNull();
    expect(v4, 'missing v4 codecs and mappers').not.toBeNull();
    if (v1 === null || v2 === null || v3 === null || v4 === null) return;
    const hostileInstall = hostileLifecycleReport(REPORT_FIXTURES.install);
    const hostileCurrentInstall = hostileLifecycleReport(REPORT_FIXTURES.currentInstall);
    const hostileStatus = addHostileFields(REPORT_FIXTURES.status);
    const hostileUninstall = hostileLifecycleReport(REPORT_FIXTURES.uninstall);
    const hostileCurrentUninstall = hostileLifecycleReport(REPORT_FIXTURES.currentUninstall);
    const hostileFlip = hostileLifecycleReport(REPORT_FIXTURES.flip);
    const hostileInit = addHostileFields(REPORT_FIXTURES.init);
    const hostileUndo = addHostileFields(REPORT_FIXTURES.undo);
    const capabilityBytes = JSON.stringify(expectedCapabilitySnapshot(), null, 2);
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly mapper: unknown;
      readonly codec: unknown;
      readonly args: readonly unknown[];
      readonly bytes: string;
    }> = [
      {
        name: 'agents@1',
        mapper: v1.toAgentsV1Dto,
        codec: v1.agentsV1Codec,
        args: [REPORT_FIXTURES.agents],
        bytes: HISTORICAL_JSON_GOLDENS.agents,
      },
      {
        name: 'health@1',
        mapper: v1.toHealthV1Dto,
        codec: v1.healthV1Codec,
        args: [REPORT_FIXTURES.health.result, []],
        bytes: CURRENT_JSON_GOLDENS.health,
      },
      {
        name: 'commands@1',
        mapper: v1.toCommandsV1Dto,
        codec: v1.commandsV1Codec,
        args: [REPORT_FIXTURES.commands],
        bytes: HISTORICAL_JSON_GOLDENS.commands,
      },
      {
        name: 'config-get@1 unscoped',
        mapper: v1.toConfigGetV1Dto,
        codec: v1.configGetV1Codec,
        args: [REPORT_FIXTURES.configGetUnscoped],
        bytes: CURRENT_JSON_GOLDENS.configGetUnscoped,
      },
      {
        name: 'config-get@1 scoped',
        mapper: v1.toConfigGetV1Dto,
        codec: v1.configGetV1Codec,
        args: [REPORT_FIXTURES.configGetScoped],
        bytes: CURRENT_JSON_GOLDENS.configGetScoped,
      },
      {
        name: 'config-list@1 unscoped',
        mapper: v1.toConfigListV1Dto,
        codec: v1.configListV1Codec,
        args: [REPORT_FIXTURES.configListUnscoped],
        bytes: CURRENT_JSON_GOLDENS.configListUnscoped,
      },
      {
        name: 'config-list@1 scoped',
        mapper: v1.toConfigListV1Dto,
        codec: v1.configListV1Codec,
        args: [REPORT_FIXTURES.configListScoped],
        bytes: CURRENT_JSON_GOLDENS.configListScoped,
      },
      {
        name: 'config-set@1',
        mapper: v1.toConfigSetV1Dto,
        codec: v1.configSetV1Codec,
        args: [REPORT_FIXTURES.configSet],
        bytes: CURRENT_JSON_GOLDENS.configSet,
      },
      {
        name: 'config-unset@1',
        mapper: v1.toConfigUnsetV1Dto,
        codec: v1.configUnsetV1Codec,
        args: [REPORT_FIXTURES.configUnset],
        bytes: CURRENT_JSON_GOLDENS.configUnset,
      },
      {
        name: 'install@1',
        mapper: v1.toInstallV1Dto,
        codec: v1.installV1Codec,
        args: [hostileInstall],
        bytes: HISTORICAL_JSON_GOLDENS.install,
      },
      {
        name: 'install@2',
        mapper: v2.toInstallV2Dto,
        codec: v2.installV2Codec,
        args: [hostileCurrentInstall],
        bytes: CURRENT_LIFECYCLE_V2_GOLDENS.install,
      },
      {
        name: 'status@1',
        mapper: v1.toStatusV1Dto,
        codec: v1.statusV1Codec,
        args: [hostileStatus],
        bytes: CURRENT_JSON_GOLDENS.status,
      },
      {
        name: 'undo@1',
        mapper: v1.toUndoV1Dto,
        codec: v1.undoV1Codec,
        args: [hostileUndo],
        bytes: CURRENT_JSON_GOLDENS.undo,
      },
      {
        name: 'uninstall@1',
        mapper: v1.toUninstallV1Dto,
        codec: v1.uninstallV1Codec,
        args: [hostileUninstall],
        bytes: HISTORICAL_JSON_GOLDENS.uninstall,
      },
      {
        name: 'uninstall@2',
        mapper: v2.toUninstallV2Dto,
        codec: v2.uninstallV2Codec,
        args: [hostileCurrentUninstall],
        bytes: CURRENT_LIFECYCLE_V2_GOLDENS.uninstall,
      },
      {
        name: 'verify@1',
        mapper: v1.toVerifyV1Dto,
        codec: v1.verifyV1Codec,
        args: [REPORT_FIXTURES.verify],
        bytes: CURRENT_JSON_GOLDENS.verify,
      },
      {
        name: 'error@1',
        mapper: v1.toErrorV1Dto,
        codec: v1.errorV1Codec,
        args: [REPORT_FIXTURES.error],
        bytes: CURRENT_JSON_GOLDENS.error,
      },
      {
        name: 'export@1',
        mapper: v1.toExportV1Dto,
        codec: v1.exportV1Codec,
        args: [REPORT_FIXTURES.export],
        bytes: CURRENT_JSON_GOLDENS.export,
      },
      {
        name: 'init@1',
        mapper: v1.toInitV1Dto,
        codec: v1.initV1Codec,
        args: [hostileInit],
        bytes: CURRENT_JSON_GOLDENS.init,
      },
      {
        name: 'capability-snapshot@1',
        mapper: v1.toCapabilitySnapshotV1Dto,
        codec: v1.capabilitySnapshotV1Codec,
        args: [toolRegistry],
        bytes: capabilityBytes,
      },
      {
        name: 'agents@2',
        mapper: v2.toAgentsV2Dto,
        codec: v2.agentsV2Codec,
        args: [REPORT_FIXTURES.agents],
        bytes: CURRENT_JSON_GOLDENS.agents,
      },
      {
        name: 'commands@2',
        mapper: v2.toCommandsV2Dto,
        codec: v2.commandsV2Codec,
        args: [REPORT_FIXTURES.commands],
        bytes: CURRENT_JSON_GOLDENS.commands,
      },
      {
        name: 'flip@2',
        mapper: v2.toFlipV2Dto,
        codec: v2.flipV2Codec,
        args: [hostileFlip],
        bytes: HISTORICAL_JSON_GOLDENS.flip,
      },
      {
        name: 'flip@3',
        mapper: v3.toFlipV3Dto,
        codec: v3.flipV3Codec,
        args: [hostileFlip],
        bytes: HISTORICAL_FLIP_V3_GOLDEN,
      },
      {
        name: 'flip@4',
        mapper: v4.toFlipV4Dto,
        codec: v4.flipV4Codec,
        args: [hostileFlip],
        bytes: CURRENT_JSON_GOLDENS.flip,
      },
      {
        name: 'list@2',
        mapper: v2.toListV2Dto,
        codec: v2.listV2Codec,
        args: [REPORT_FIXTURES.list],
        bytes: HISTORICAL_JSON_GOLDENS.list,
      },
      {
        name: 'list@3',
        mapper: v3.toListV3Dto,
        codec: v3.listV3Codec,
        args: [REPORT_FIXTURES.list],
        bytes: CURRENT_JSON_GOLDENS.list,
      },
    ];

    for (const fixture of cases) {
      const mapper = callable(fixture.mapper);
      const codec = codecValue(fixture.codec, `${fixture.name} codec`);
      expect(mapper, `missing ${fixture.name} mapper`).not.toBeNull();
      if (mapper === null || codec === null) continue;
      let dto: unknown;
      expect(() => {
        dto = mapper(...fixture.args);
      }, `${fixture.name} mapper threw`).not.toThrow();
      expect(codec.validate(dto).ok, `${fixture.name} mapper produced invalid DTO`).toBeTrue();
      expect(resultValue(codec.encode(dto)), `${fixture.name} mapper/codec byte drift`).toBe(
        fixture.bytes,
      );
      const serializedDto = JSON.stringify(dto);
      expect(serializedDto, `${fixture.name} leaked hostile secret`).not.toMatch(/"secret"\s*:/);
      if (
        fixture.name === 'install@1' ||
        fixture.name === 'install@2' ||
        fixture.name === 'uninstall@1' ||
        fixture.name === 'uninstall@2' ||
        fixture.name === 'flip@2'
      ) {
        expect(serializedDto, `${fixture.name} leaked lifecycle error`).not.toMatch(/"error"\s*:/);
      }
      if (fixture.name === 'install@2' || fixture.name === 'uninstall@2') {
        expect(dto, `${fixture.name} leaked domain report version`).not.toHaveProperty(
          'reportVersion',
        );
        expect(dto, `${fixture.name} leaked operation plan`).not.toHaveProperty('plan');
      }
      if (fixture.name === 'flip@3' || fixture.name === 'flip@4') {
        expect(
          (dto as { readonly results: readonly [{ readonly error: unknown }] }).results[0].error,
        ).toBeNull();
      }
    }

    const agentsMapper = callable(v1.toAgentsV1Dto);
    expect(agentsMapper).not.toBeNull();
    if (agentsMapper !== null) {
      const hostileToolsDto = agentsMapper({
        detections: new Map([
          ['__proto__', []],
          ['constructor', []],
        ]),
        format: 'json',
        detectedOnly: false,
      }) as UnknownRecord;
      expect(Object.keys(hostileToolsDto.tools as UnknownRecord)).toEqual([
        '__proto__',
        'constructor',
      ]);
      expect(Object.getPrototypeOf(hostileToolsDto.tools as UnknownRecord)).toBeNull();
    }
  });

  test('family 6: preserves exact current renderer bytes and terminal framing for every path', async () => {
    const actual = renderedCurrentBytes();
    expect(actual).toEqual(CURRENT_JSON_GOLDENS);
    const applyRenderer = createCurrentRendererRegistry(
      {} as Parameters<typeof createCurrentRendererRegistry>[0],
    ).apply;
    expect(applyRenderer, 'missing current apply human renderer').toBeDefined();
    expect(
      applyRenderer === undefined
        ? ''
        : stdout(applyRenderer.human(successOutcome(CURRENT_RENDERER_REPORTS.apply))),
      'apply human renderer drift',
    ).toBe(APPLY_HUMAN_GOLDEN);
    const encoder = new TextEncoder();
    for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
      const committed = await readFile(
        join(ROOT, 'tests/ergonomics/fixtures/p1-ts10/goldens', GOLDEN_FILES[key]),
        'utf8',
      );
      expect(String(CURRENT_JSON_GOLDENS[key]), `${key} fixture constant drift`).toBe(committed);
      expect(encoder.encode(actual[key])).toEqual(encoder.encode(committed));
      expect(actual[key].endsWith('\n'), `${key} terminal LF`).toBe(GOLDEN_TERMINAL_LF[key]);
      expect(actual[key].endsWith('\n\n'), `${key} double terminal LF`).toBeFalse();
    }
  });

  test('family 7: round-trips exact bytes and derives verify/capability facts from tool authority', async () => {
    const loaded = await authority();
    const registry = loaded?.currentWireContractRegistry;
    const v1 = await importMaybe(join(CONTRACTS_ROOT, 'v1/index.ts'));
    expect(registry, 'missing production registry for round trips').toBeDefined();
    expect(v1, 'missing v1 contract exports').not.toBeNull();
    if (registry === undefined || v1 === null) return;
    const fixtures = [
      ['agents', 1, HISTORICAL_JSON_GOLDENS.agents],
      ['agents', 2, CURRENT_JSON_GOLDENS.agents],
      ['apply-report', 1, CURRENT_JSON_GOLDENS.apply],
      ['health', 1, CURRENT_JSON_GOLDENS.health],
      ['health', 2, CURRENT_JSON_GOLDENS.doctor],
      ['commands', 1, HISTORICAL_JSON_GOLDENS.commands],
      ['commands', 2, CURRENT_JSON_GOLDENS.commands],
      ['config-get', 1, CURRENT_JSON_GOLDENS.configGetUnscoped],
      ['config-get', 1, CURRENT_JSON_GOLDENS.configGetScoped],
      ['config-list', 1, CURRENT_JSON_GOLDENS.configListUnscoped],
      ['config-list', 1, CURRENT_JSON_GOLDENS.configListScoped],
      ['flip', 2, HISTORICAL_JSON_GOLDENS.flip],
      ['flip', 3, HISTORICAL_FLIP_V3_GOLDEN],
      ['flip', 4, CURRENT_JSON_GOLDENS.flip],
      ['install', 1, HISTORICAL_JSON_GOLDENS.install],
      ['install', 2, CURRENT_JSON_GOLDENS.install],
      ['list', 2, HISTORICAL_JSON_GOLDENS.list],
      ['list', 3, CURRENT_JSON_GOLDENS.list],
      ['plan-report', 1, CURRENT_JSON_GOLDENS.plan],
      ['status', 1, CURRENT_JSON_GOLDENS.status],
      ['sync', 1, CURRENT_JSON_GOLDENS.sync],
      ['undo', 1, CURRENT_JSON_GOLDENS.undo],
      ['update', 1, CURRENT_JSON_GOLDENS.update],
      ['uninstall', 1, HISTORICAL_JSON_GOLDENS.uninstall],
      ['uninstall', 2, CURRENT_JSON_GOLDENS.uninstall],
      ['verify', 1, CURRENT_JSON_GOLDENS.verify],
      ['error', 1, CURRENT_JSON_GOLDENS.error],
      ['export', 1, CURRENT_JSON_GOLDENS.export],
      ['init', 1, CURRENT_JSON_GOLDENS.init],
      ['gc', 1, CURRENT_JSON_GOLDENS.gc],
    ] as const;
    for (const [id, version, bytes] of fixtures) {
      const codec = registry.get(id, version);
      expect(codec, `missing ${id}@${version}`).toBeDefined();
      if (codec === undefined) continue;
      const dto = resultValue(codec.decode(bytes));
      expect(resultValue(codec.encode(dto)), `${id}@${version} byte parity`).toBe(bytes);
      expect(codec.validate(dto).ok).toBeTrue();
    }

    const createVerify = v1.createVerifyV1Codec;
    expect(typeof createVerify).toBe('function');
    if (typeof createVerify === 'function') {
      const productionCodec = codecValue(createVerify(toolRegistry), 'production verify factory');
      const injectedRegistry = createToolRegistry([writeFixtureAdapter]);
      const injectedCodec = codecValue(
        createVerify(injectedRegistry),
        'injected fixture verify factory',
      );
      expect(injectedRegistry.toolsFor('verify-static')).toEqual(['fixture-write']);
      const fixtureDto = verifyDtoFor('fixture-write');
      const unknownProductionDto = verifyDtoFor('fixture-write');
      const productionDto = JSON.parse(CURRENT_JSON_GOLDENS.verify);
      expect(productionCodec?.validate(productionDto).ok).toBeTrue();
      expect(productionCodec?.validate(unknownProductionDto).ok).toBeFalse();
      expect(injectedCodec?.validate(fixtureDto).ok).toBeTrue();
      expect(injectedCodec?.validate(productionDto).ok).toBeFalse();
    }

    const capabilityMapper = v1.toCapabilitySnapshotV1Dto;
    expect(typeof capabilityMapper).toBe('function');
    if (typeof capabilityMapper !== 'function') return;
    const hostileAdapters = toolRegistry.adapters.map(
      (adapter) =>
        new Proxy(adapter, {
          get(target, key, receiver) {
            if (['inventory', 'verification', 'placement', 'adaptation'].includes(String(key)))
              throw new Error(`capability mapper read implementation bundle ${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
        }),
    );
    const descriptorOnlyRegistry = new Proxy(
      { adapters: hostileAdapters },
      {
        get(target, key, receiver) {
          if (key !== 'adapters')
            throw new Error(`capability mapper read registry member ${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    let snapshot: UnknownRecord | undefined;
    expect(() => {
      snapshot = capabilityMapper(descriptorOnlyRegistry) as UnknownRecord;
    }).not.toThrow();
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    const expectedSnapshot = expectedCapabilitySnapshot();
    expect(snapshot).toEqual(expectedSnapshot);
    const tools = snapshot.tools as readonly UnknownRecord[];
    expect(tools).toHaveLength(toolRegistry.adapters.length);
    for (const [index, item] of tools.entries()) {
      expect(Object.keys(item)).toEqual(['id', 'order', 'capabilityVersion', 'operations']);
      expect(item.id).toBe(toolRegistry.adapters[index]?.descriptor.id);
      expect(item.order).toBe(toolRegistry.adapters[index]?.descriptor.order);
      expect(item.capabilityVersion).toBe(
        toolRegistry.adapters[index]?.descriptor.capabilityVersion,
      );
      expect(Object.keys(item.operations as UnknownRecord)).toEqual([...TOOL_OPERATIONS]);
      for (const operation of TOOL_OPERATIONS) {
        const fact = (item.operations as UnknownRecord)[operation];
        const expected = toolRegistry.adapters[index]?.descriptor.operations[operation];
        expect(fact).toEqual({
          supported: expected?.supported,
          scopes: expected === undefined ? undefined : [...expected.scopes],
          remediation: expected?.remediation,
        });
      }
      expect(JSON.stringify(item)).not.toMatch(
        /"(?:inventory|verification|placement|adaptation|function)"\s*:/,
      );
    }
    const capabilityCodec = codecValue(v1.capabilitySnapshotV1Codec, 'capability-snapshot@1 codec');
    if (capabilityCodec === null) return;
    expect(capabilityCodec.validate(snapshot).ok).toBeTrue();
    const expectedBytes = JSON.stringify(expectedSnapshot, null, 2);
    const encoded = resultValue(capabilityCodec.encode(snapshot));
    expect(encoded).toBe(expectedBytes);
    expect(resultValue(capabilityCodec.encode(snapshot))).toBe(encoded);
    const decoded = resultValue(capabilityCodec.decode(encoded as string));
    expect(decoded).toEqual(expectedSnapshot);
    expect(capabilityCodec.validate(decoded).ok).toBeTrue();
  });

  test('family 8: publishes closed contracts and v1/v2/v3/v4 package subpaths without Zod', async () => {
    const packageJson = JSON.parse(
      await readFile(join(ROOT, 'packages/core/package.json'), 'utf8'),
    ) as { exports?: UnknownRecord };
    for (const subpath of [
      './contracts',
      './contracts/v1',
      './contracts/v2',
      './contracts/v3',
      './contracts/v4',
    ])
      expect(packageJson.exports?.[subpath], `missing package export ${subpath}`).toBeDefined();
    expect(packageJson.exports?.['./contracts/v4']).toEqual({
      types: './src/contracts/v4/index.d.ts',
      default: './src/contracts/v4/index.ts',
    });
    const publicSubpaths = [
      '@skillsmith/core/contracts',
      '@skillsmith/core/contracts/v1',
      '@skillsmith/core/contracts/v2',
      '@skillsmith/core/contracts/v3',
      '@skillsmith/core/contracts/v4',
    ] as const;
    const [contracts, v1, v2, v3, v4] = await Promise.all(
      publicSubpaths.map((subpath) => import(subpath).catch(() => null)),
    );
    expect(contracts, 'public contracts subpath does not load').not.toBeNull();
    expect(v1, 'public contracts/v1 subpath does not load').not.toBeNull();
    expect(v2, 'public contracts/v2 subpath does not load').not.toBeNull();
    expect(v3, 'public contracts/v3 subpath does not load').not.toBeNull();
    expect(v4, 'public contracts/v4 subpath does not load').not.toBeNull();
    expect(Object.keys(contracts ?? {}).sort()).toEqual([...CONTRACT_RUNTIME_EXPORTS].sort());
    expect(Object.keys(v1 ?? {}).sort()).toEqual([...V1_RUNTIME_EXPORTS].sort());
    expect(Object.keys(v2 ?? {}).sort()).toEqual([...V2_RUNTIME_EXPORTS].sort());
    expect(Object.keys(v3 ?? {}).sort()).toEqual([...V3_RUNTIME_EXPORTS].sort());
    expect(Object.keys(v4 ?? {}).sort()).toEqual([...V4_RUNTIME_EXPORTS].sort());
    expect(typeof contracts?.createWireContractRegistry).toBe('function');
    for (const name of Object.keys(v1 ?? {})) expect(name).not.toMatch(/V2|zod|schema/);
    for (const name of Object.keys(v2 ?? {})) {
      if (name !== 'migrateLedgerV1DtoToV2Dto') expect(name).not.toMatch(/V1|zod|schema/);
    }
    for (const name of Object.keys(v3 ?? {})) expect(name).not.toMatch(/V[12]|zod|schema/);
    for (const name of Object.keys(v4 ?? {})) expect(name).not.toMatch(/V[123]|zod|schema/);
    for (const declaration of [
      'packages/core/src/contracts/index.d.ts',
      'packages/core/src/contracts/v1/index.d.ts',
      'packages/core/src/contracts/v2/index.d.ts',
      'packages/core/src/contracts/v3/index.d.ts',
      'packages/core/src/contracts/v4/index.d.ts',
    ]) {
      const source = await readFile(join(ROOT, declaration), 'utf8').catch(() => null);
      expect(source, `missing declaration facade ${declaration}`).not.toBeNull();
      if (source === null) continue;
      expect(source, `${declaration} leaks Zod`).not.toMatch(/\b(?:zod|Zod\w*|z\.infer)\b/);
      expect(source, `${declaration} leaks a deep source import`).not.toMatch(
        /from\s+['"](?:\.\.\/|packages\/core\/src)/,
      );
      if (declaration.endsWith('/v4/index.d.ts')) {
        const declaredRuntime = [...source.matchAll(/export\s+declare\s+const\s+(\w+)/gu)]
          .map((match) => match[1])
          .sort();
        expect(declaredRuntime).toEqual([...V4_RUNTIME_EXPORTS].sort());
        expect(Object.keys(v4 ?? {}).sort()).toEqual(declaredRuntime);
        expect(source).toMatch(/export\s+interface\s+FlipV4Dto\b/u);
        expect(source).toMatch(/WireCodec\s*<\s*['"]flip['"]\s*,\s*4\s*,\s*FlipV4Dto\s*>/u);
        expect(source).toMatch(/toFlipV4Dto\s*:\s*\(report:\s*FlipReport\)\s*=>\s*FlipV4Dto/u);
      }
    }
  });

  test('family 9: gives codecs sole AST ownership of public JSON construction and parsing', async () => {
    const files = [
      ...new Set([
        ...(await typescriptFiles(join(ROOT, 'packages/cli/src/output'))),
        join(ROOT, 'packages/cli/src/runtime/current-renderers.ts'),
        ...(await typescriptFiles(join(ROOT, 'packages/cli/src/runtime/current'))),
        ...(await typescriptFiles(join(ROOT, 'packages/core/src/application'))),
        join(ROOT, 'packages/core/src/place/plan.ts'),
        ...(await typescriptFiles(join(ROOT, 'packages/core/src/planner'))),
      ]),
    ];
    for (const exempt of [
      'packages/core/src/place/ledger.ts',
      'packages/core/src/agents',
      'packages/core/src/plugins',
      'packages/cli/src/contracts',
    ])
      expect(files.some((path) => relative(ROOT, path).startsWith(exempt))).toBeFalse();
    const findings: string[] = [];
    const allowed = {
      configListHuman: 0,
      metadataRenderer: 0,
      version: 0,
      configSet: 0,
      configUnset: 0,
    };
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const jsonAliases = new Set(['JSON']);
      const methodAliases = new Map<string, 'parse' | 'stringify'>();
      const jsonMethod = (expression: ts.Expression): 'parse' | 'stringify' | 'computed' | null => {
        if (ts.isIdentifier(expression)) return methodAliases.get(expression.text) ?? null;
        if (
          ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          jsonAliases.has(expression.expression.text) &&
          (expression.name.text === 'parse' || expression.name.text === 'stringify')
        )
          return expression.name.text;
        if (
          ts.isElementAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          jsonAliases.has(expression.expression.text)
        ) {
          const argument = expression.argumentExpression;
          if (
            ts.isStringLiteral(argument) &&
            (argument.text === 'parse' || argument.text === 'stringify')
          )
            return argument.text;
          return 'computed';
        }
        return null;
      };
      const collectAliases = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
          if (
            ts.isIdentifier(node.name) &&
            ts.isIdentifier(node.initializer) &&
            jsonAliases.has(node.initializer.text)
          )
            jsonAliases.add(node.name.text);
          if (ts.isIdentifier(node.name)) {
            const method = jsonMethod(node.initializer);
            if (method === 'parse' || method === 'stringify')
              methodAliases.set(node.name.text, method);
          }
          if (
            ts.isObjectBindingPattern(node.name) &&
            ts.isIdentifier(node.initializer) &&
            jsonAliases.has(node.initializer.text)
          )
            for (const element of node.name.elements) {
              const method = (element.propertyName ?? element.name).getText(tree);
              if (ts.isIdentifier(element.name) && (method === 'parse' || method === 'stringify'))
                methodAliases.set(element.name.text, method);
            }
        }
        ts.forEachChild(node, collectAliases);
      };
      collectAliases(tree);
      const visit = (node: ts.Node, ancestors: readonly ts.Node[]): void => {
        const functionExemption = ancestors
          .filter((parent) => ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent))
          .map((parent) => parent.name?.getText(tree) ?? '')
          .find((name) => name === 'configListHuman' || name === 'metadataRenderer');
        const propertyExemption = ancestors
          .filter(ts.isPropertyAssignment)
          .map((parent) => parent.name.getText(tree))
          .find((name) => name === 'version' || name === 'configSet' || name === 'configUnset');
        if (ts.isImportDeclaration(node) && node.moduleSpecifier.getText(tree) === "'zod'")
          findings.push(`${relative(ROOT, path)}: renderer-owned Zod schema`);
        if (ts.isCallExpression(node)) {
          const method = jsonMethod(node.expression);
          if (method !== null) {
            const exemption = functionExemption ?? propertyExemption;
            if (method === 'stringify' && exemption !== undefined) {
              allowed[exemption]++;
            } else {
              findings.push(`${relative(ROOT, path)}: JSON.${method}`);
            }
          }
        }
        if (
          ts.isBindingElement(node) &&
          node.dotDotDotToken !== undefined &&
          ts.isObjectBindingPattern(node.parent) &&
          node.parent.elements.some(
            (element) => (element.propertyName ?? element.name).getText(tree) === 'error',
          )
        )
          findings.push(`${relative(ROOT, path)}: rest-based error stripping`);
        if (
          ts.isDeleteExpression(node) &&
          /(?:\.|\[['"]?)error(?:['"]?\])?$/.test(node.expression.getText(tree))
        )
          findings.push(`${relative(ROOT, path)}: delete error stripping`);
        ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
      };
      visit(tree, []);
    }
    expect(allowed).toEqual({
      configListHuman: 6,
      metadataRenderer: 1,
      version: 1,
      configSet: 0,
      configUnset: 0,
    });
    expect(findings).toEqual([]);
  });

  test('family 10: extends a fixture registry without generic edits or production mutation', async () => {
    const create = await builder();
    const loaded = await authority();
    const fixture = await importMaybe(
      join(ROOT, 'tests/ergonomics/fixtures/p1-ts10/fixture-codec.ts'),
    );
    expect(fixture, 'missing executable fixture codec').not.toBeNull();
    if (create === null || loaded?.currentWireContractRegistry === undefined || fixture === null)
      return;
    const codec = fixture.fixtureCodec as WireCodec;
    const mapping = fixture.fixtureCommandMapping as WireMapping;
    expect(codec).toBeDefined();
    expect(mapping).toEqual({
      commandPath: 'skillsmith fixture',
      contractId: 'fixture',
      version: 1,
    });
    const production = loaded.currentWireContractRegistry;
    const before = production.codecs.map(descriptorIdentity);
    const beforeMappings = production.commandMappings.map((row) => ({ ...row }));
    const extended = create(
      [...production.codecs, codec],
      [...production.commandMappings, mapping],
    );
    expect(extended.get('fixture', 1)).toBeDefined();
    expect(extended.forCommand('skillsmith fixture')).toBe(extended.get('fixture', 1));
    expect(extended.get('agents', 1)?.descriptor.id).toBe('agents');
    expect(extended.forCommand('skillsmith agents')?.descriptor.id).toBe('agents');
    expect(extended.codecs.map(descriptorIdentity)).toEqual([...before, ['fixture', 1]]);
    expect(extended.commandMappings).toHaveLength(production.commandMappings.length + 1);
    expect(
      resultValue(codec.decode(resultValue(codec.encode({ value: 'extension' })) as string)),
    ).toEqual({ value: 'extension' });
    expect(production.get('fixture', 1)).toBeUndefined();
    expect(production.forCommand('skillsmith fixture')).toBeUndefined();
    expect(production.codecs.map(descriptorIdentity)).toEqual(before);
    expect(production.commandMappings).toEqual(beforeMappings);
    const genericSource = await readFile(join(CONTRACTS_ROOT, 'registry.ts'), 'utf8');
    expect(genericSource).not.toContain('skillsmith fixture');
    expect(genericSource).not.toContain('CURRENT_COMMAND_SPECS');
  });
});
