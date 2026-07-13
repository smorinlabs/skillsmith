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
import { toolRegistry } from '../../../packages/core/src/agents/registry.ts';
import {
  CURRENT_JSON_GOLDENS,
  CURRENT_RENDERER_REPORTS,
  GOLDEN_TERMINAL_LF,
  REPORT_FIXTURES,
} from '../fixtures/p1-ts10/reports.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const CONTRACTS_ROOT = join(ROOT, 'packages/core/src/contracts');
const CLI_AUTHORITY = join(ROOT, 'packages/cli/src/contracts/wire-contracts.ts');

const EXPECTED_PATHS = [
  'skillsmith agents',
  'skillsmith check',
  'skillsmith commands',
  'skillsmith config get',
  'skillsmith config list',
  'skillsmith dev',
  'skillsmith doctor',
  'skillsmith install',
  'skillsmith list',
  'skillsmith promote',
  'skillsmith uninstall',
  'skillsmith verify',
] as const;

const EXPECTED_MAPPINGS = [
  ['skillsmith agents', 'agents', 1],
  ['skillsmith check', 'health', 1],
  ['skillsmith commands', 'commands', 1],
  ['skillsmith config get', 'config-get', 1],
  ['skillsmith config list', 'config-list', 1],
  ['skillsmith dev', 'flip', 2],
  ['skillsmith doctor', 'health', 1],
  ['skillsmith install', 'install', 1],
  ['skillsmith list', 'list', 2],
  ['skillsmith promote', 'flip', 2],
  ['skillsmith uninstall', 'uninstall', 1],
  ['skillsmith verify', 'verify', 1],
] as const;

const EXPECTED_CODECS = [
  ['agents', 1],
  ['health', 1],
  ['commands', 1],
  ['config-get', 1],
  ['config-list', 1],
  ['flip', 2],
  ['install', 1],
  ['list', 2],
  ['uninstall', 1],
  ['verify', 1],
  ['error', 1],
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
  agents: { wireKind: null, embeddedVersion: 'schemaVersion', indent: 2, terminalLf: true },
  health: { wireKind: null, embeddedVersion: 'schemaVersion', indent: 2, terminalLf: false },
  commands: { wireKind: null, embeddedVersion: 'schemaVersion', indent: 2, terminalLf: false },
  'config-get': { wireKind: null, embeddedVersion: null, indent: 2, terminalLf: true },
  'config-list': { wireKind: null, embeddedVersion: null, indent: 2, terminalLf: false },
  flip: {
    wireKind: 'skillsmith.flip',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  install: {
    wireKind: 'skillsmith.install',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  list: { wireKind: null, embeddedVersion: 'schemaVersion', indent: 2, terminalLf: false },
  uninstall: {
    wireKind: 'skillsmith.uninstall',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  verify: {
    wireKind: 'skillsmith.verify',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
  error: { wireKind: 'error', embeddedVersion: 'schemaVersion', indent: 0, terminalLf: true },
  'capability-snapshot': {
    wireKind: 'skillsmith.capabilities',
    embeddedVersion: 'schemaVersion',
    indent: 2,
    terminalLf: false,
  },
};

const GOLDEN_FILES = {
  agents: 'agents.stdout',
  health: 'health.stdout',
  commands: 'commands.stdout',
  configGetUnscoped: 'config-get-unscoped.stdout',
  configGetScoped: 'config-get-scoped.stdout',
  configListUnscoped: 'config-list-unscoped.stdout',
  configListScoped: 'config-list-scoped.stdout',
  flip: 'flip.stdout',
  install: 'install.stdout',
  list: 'list.stdout',
  uninstall: 'uninstall.stdout',
  verify: 'verify.stdout',
  error: 'error.stdout',
} as const;

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
  return {
    agents: render('agents', CURRENT_RENDERER_REPORTS.agents),
    health: render('check', CURRENT_RENDERER_REPORTS.health),
    commands: render('commands', CURRENT_RENDERER_REPORTS.commands),
    configGetUnscoped: render('configGet', CURRENT_RENDERER_REPORTS.configGetUnscoped),
    configGetScoped: render('configGet', CURRENT_RENDERER_REPORTS.configGetScoped),
    configListUnscoped: render('configList', CURRENT_RENDERER_REPORTS.configListUnscoped),
    configListScoped: render('configList', CURRENT_RENDERER_REPORTS.configListScoped),
    flip: render('dev', CURRENT_RENDERER_REPORTS.flip),
    install: render('install', CURRENT_RENDERER_REPORTS.install),
    list: render('list', CURRENT_RENDERER_REPORTS.list),
    uninstall: render('uninstall', CURRENT_RENDERER_REPORTS.uninstall),
    verify: render('verify', CURRENT_RENDERER_REPORTS.verify),
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
  test('family 1: characterizes exactly the twelve live JSON-selectable command paths', () => {
    const paths = CURRENT_COMMAND_SPECS.filter((spec) =>
      spec.options.some(
        (option) =>
          option.long === '--json' ||
          (option.long === '--format' && option.allowedValues.includes('json')),
      ),
    ).map((spec) => spec.path);
    expect(paths).toEqual([...EXPECTED_PATHS]);
    expect(new Set(paths).size).toBe(12);
    for (const excluded of [
      'skillsmith config set',
      'skillsmith config unset',
      'skillsmith version',
      'skillsmith completion',
      'skillsmith help',
    ])
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
    expect(typeof loaded.assertCurrentWireContractClosure).toBe('function');
    if (registry === undefined || mappings === undefined) return;

    expect(registry.codecs.map(descriptorIdentity)).toEqual([...EXPECTED_CODECS]);
    expect(mappings.map((row) => [row.commandPath, row.contractId, row.version])).toEqual(
      EXPECTED_MAPPINGS.map((row) => [...row]),
    );
    expect(registry.commandMappings).toEqual(mappings);
    expect(Object.isFrozen(registry.codecs)).toBeTrue();
    expect(Object.isFrozen(registry.commandMappings)).toBeTrue();
    for (const codec of registry.codecs) {
      expect(Object.isFrozen(codec)).toBeTrue();
      expect(Object.isFrozen(codec.descriptor)).toBeTrue();
      const policy = EXPECTED_DESCRIPTOR_POLICY[String(codec.descriptor.id)];
      expect(
        policy,
        `missing expected descriptor policy for ${String(codec.descriptor.id)}`,
      ).toBeDefined();
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
    const mutableDescriptor = {
      ...base.descriptor,
      formatting: record(base.descriptor.formatting)
        ? { ...base.descriptor.formatting }
        : base.descriptor.formatting,
      migrations: Array.isArray(base.descriptor.migrations)
        ? [...base.descriptor.migrations]
        : base.descriptor.migrations,
    };
    const mutable = { ...base, descriptor: mutableDescriptor };
    const v2 = { ...mutable, descriptor: { ...mutableDescriptor, version: 2 } };
    const fixtureMapping = { commandPath: 'skillsmith fixture', contractId: 'agents', version: 2 };
    const future = create([mutable, v2], [fixtureMapping]);
    expect(future.get('agents', 1)).toBeDefined();
    expect(future.latest('agents')?.descriptor.version).toBe(2);
    expect(future.forCommand('skillsmith fixture')?.descriptor.version).toBe(2);
    expect(Object.isFrozen(mutable)).toBeFalse();
    expect(Object.isFrozen(mutableDescriptor)).toBeFalse();
    expect(Object.isFrozen(future.codecs[0]?.descriptor)).toBeTrue();
    expect(Object.isFrozen(future.codecs[0]?.descriptor.formatting)).toBeTrue();
    expect(() => create([mutable, mutable], [])).toThrow(/duplicate|identity/i);
    expect(() =>
      create([{ ...mutable, descriptor: { ...mutableDescriptor, version: 0 } }], []),
    ).toThrow(/version|safe|positive/i);
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
  });

  test('family 3: strictly decodes malformed, unknown, wrong-version, and deterministic values', async () => {
    const loaded = await authority();
    const registry = loaded?.currentWireContractRegistry;
    expect(registry, 'missing production registry for strict decode').toBeDefined();
    if (registry === undefined) return;
    const install = registry.get('install', 1);
    const flip = registry.get('flip', 2);
    expect(install).toBeDefined();
    expect(flip).toBeDefined();
    if (install === undefined || flip === undefined) return;

    expect(install.decode('{"truncated":').ok).toBeFalse();
    expect(install.decode('not json').error).toMatchObject({ code: 'malformed-json' });
    const unknown = JSON.parse(CURRENT_JSON_GOLDENS.install) as UnknownRecord;
    (unknown.requested as UnknownRecord).unexpected = true;
    expect(install.decode(JSON.stringify(unknown)).error).toMatchObject({ code: 'invalid-shape' });
    const wrong = JSON.parse(CURRENT_JSON_GOLDENS.flip) as UnknownRecord;
    wrong.schemaVersion = 1;
    expect(flip.decode(JSON.stringify(wrong)).error).toMatchObject({
      code: 'unsupported-version',
    });
    wrong.schemaVersion = 99;
    expect(flip.decode(JSON.stringify(wrong)).error).toMatchObject({
      code: 'unsupported-version',
    });
    expect(registry.get('config-get', 99)).toBeUndefined();
    expect(registry.latest('config-get')?.descriptor.version).toBe(1);
    const dto = resultValue(install.decode(CURRENT_JSON_GOLDENS.install));
    expect(resultValue(install.encode(dto))).toBe(resultValue(install.encode(dto)));
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
  }, 15_000);

  test('family 5: exposes explicit named mappers that never read excluded lifecycle internals', async () => {
    const [v1, v2] = await Promise.all([
      importMaybe(join(CONTRACTS_ROOT, 'v1/index.ts')),
      importMaybe(join(CONTRACTS_ROOT, 'v2/index.ts')),
    ]);
    expect(v1, 'missing v1 codecs and mappers').not.toBeNull();
    expect(v2, 'missing v2 codecs and mappers').not.toBeNull();
    if (v1 === null || v2 === null) return;
    for (const name of [
      'toAgentsV1Dto',
      'toHealthV1Dto',
      'toCommandsV1Dto',
      'toConfigGetV1Dto',
      'toConfigListV1Dto',
      'toInstallV1Dto',
      'toUninstallV1Dto',
      'toVerifyV1Dto',
      'toErrorV1Dto',
      'toCapabilitySnapshotV1Dto',
    ])
      expect(typeof v1[name], `missing ${name}`).toBe('function');
    for (const name of ['toFlipV2Dto', 'toListV2Dto'])
      expect(typeof v2[name], `missing ${name}`).toBe('function');

    const cases = [
      [v1.toInstallV1Dto, REPORT_FIXTURES.install],
      [v1.toUninstallV1Dto, REPORT_FIXTURES.uninstall],
      [v2.toFlipV2Dto, REPORT_FIXTURES.flip],
    ] as const;
    for (const [mapper, report] of cases) {
      if (typeof mapper !== 'function') continue;
      const hostile = {
        ...report,
        results: report.results.map((item) => addHostileFields(item)),
      };
      let dto: unknown;
      expect(() => {
        dto = mapper(hostile);
      }).not.toThrow();
      expect(JSON.stringify(dto)).not.toContain('"error"');
      expect(JSON.stringify(dto)).not.toContain('"secret"');
    }
  });

  test('family 6: preserves exact current renderer bytes and terminal framing for every path', async () => {
    const actual = renderedCurrentBytes();
    expect(actual).toEqual(CURRENT_JSON_GOLDENS);
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
      ['agents', 1, CURRENT_JSON_GOLDENS.agents],
      ['health', 1, CURRENT_JSON_GOLDENS.health],
      ['commands', 1, CURRENT_JSON_GOLDENS.commands],
      ['config-get', 1, CURRENT_JSON_GOLDENS.configGetUnscoped],
      ['config-list', 1, CURRENT_JSON_GOLDENS.configListUnscoped],
      ['flip', 2, CURRENT_JSON_GOLDENS.flip],
      ['install', 1, CURRENT_JSON_GOLDENS.install],
      ['list', 2, CURRENT_JSON_GOLDENS.list],
      ['uninstall', 1, CURRENT_JSON_GOLDENS.uninstall],
      ['verify', 1, CURRENT_JSON_GOLDENS.verify],
      ['error', 1, CURRENT_JSON_GOLDENS.error],
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
      const fixtureCodec = createVerify({ toolsFor: () => ['fixture-verify'] });
      const dto = JSON.parse(CURRENT_JSON_GOLDENS.verify) as UnknownRecord;
      dto.requested = { ...(dto.requested as UnknownRecord), tools: ['fixture-verify'] };
      dto.verifiedAgainst = { 'fixture-verify': '9.9.9' };
      dto.summary = {
        ...(dto.summary as UnknownRecord),
        verified: ['fixture-verify'],
        failed: [],
        skipped: [],
      };
      dto.tools = [
        { ...((dto.tools as readonly UnknownRecord[])[0] ?? {}), tool: 'fixture-verify' },
      ];
      expect(fixtureCodec.validate(dto).ok).toBeTrue();
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
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.kind).toBe('skillsmith.capabilities');
    const tools = snapshot.tools as readonly UnknownRecord[];
    expect(tools).toHaveLength(toolRegistry.adapters.length);
    for (const [index, item] of tools.entries()) {
      expect(Object.keys(item)).toEqual(['id', 'order', 'capabilityVersion', 'operations']);
      expect(item.id).toBe(toolRegistry.adapters[index]?.descriptor.id);
      expect(Object.keys(item.operations as UnknownRecord)).toEqual([...TOOL_OPERATIONS]);
      expect(JSON.stringify(item)).not.toMatch(
        /inventory|verification|placement|adaptation|function/,
      );
    }
  });

  test('family 8: publishes closed contracts, v1, and v2 package subpaths without Zod', async () => {
    const packageJson = JSON.parse(
      await readFile(join(ROOT, 'packages/core/package.json'), 'utf8'),
    ) as { exports?: UnknownRecord };
    for (const subpath of ['./contracts', './contracts/v1', './contracts/v2'])
      expect(packageJson.exports?.[subpath], `missing package export ${subpath}`).toBeDefined();
    const publicSubpaths = [
      '@skillsmith/core/contracts',
      '@skillsmith/core/contracts/v1',
      '@skillsmith/core/contracts/v2',
    ] as const;
    const [contracts, v1, v2] = await Promise.all(
      publicSubpaths.map((subpath) => import(subpath).catch(() => null)),
    );
    expect(contracts, 'public contracts subpath does not load').not.toBeNull();
    expect(v1, 'public contracts/v1 subpath does not load').not.toBeNull();
    expect(v2, 'public contracts/v2 subpath does not load').not.toBeNull();
    expect(typeof contracts?.createWireContractRegistry).toBe('function');
    expect(v1).toHaveProperty('agentsV1Codec');
    expect(v1).toHaveProperty('capabilitySnapshotV1Codec');
    expect(v2).toHaveProperty('flipV2Codec');
    expect(v2).toHaveProperty('listV2Codec');
    expect(Object.keys(contracts ?? {})).not.toContain('z');
  });

  test('family 9: gives codecs sole AST ownership of public JSON construction and parsing', async () => {
    const files = [
      ...(await typescriptFiles(join(ROOT, 'packages/cli/src/output'))),
      join(ROOT, 'packages/cli/src/runtime/current-renderers.ts'),
      ...(await typescriptFiles(join(ROOT, 'packages/core/src/application'))),
    ];
    const findings: string[] = [];
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node, ancestors: readonly ts.Node[]): void => {
        const exemptFunction = ancestors.some(
          (parent) =>
            (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
            ['configListHuman', 'metadataRenderer'].includes(parent.name?.getText(tree) ?? ''),
        );
        const exemptProperty = ancestors.some(
          (parent) =>
            ts.isPropertyAssignment(parent) &&
            ['version', 'configSet', 'configUnset'].includes(parent.name.getText(tree)),
        );
        if (ts.isImportDeclaration(node) && node.moduleSpecifier.getText(tree) === "'zod'")
          findings.push(`${relative(ROOT, path)}: renderer-owned Zod schema`);
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(tree) === 'JSON'
        ) {
          const method = node.expression.name.text;
          if (method === 'parse' || (method === 'stringify' && !exemptFunction && !exemptProperty))
            findings.push(`${relative(ROOT, path)}: JSON.${method}`);
        }
        if (ts.isBindingElement(node) && node.dotDotDotToken !== undefined)
          findings.push(`${relative(ROOT, path)}: rest-based field stripping`);
        if (ts.isDeleteExpression(node)) findings.push(`${relative(ROOT, path)}: delete stripping`);
        ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
      };
      visit(tree, []);
    }
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
    const before = loaded.currentWireContractRegistry.codecs.map(descriptorIdentity);
    const extended = create([codec], [mapping]);
    expect(extended.get('fixture', 1)).toBeDefined();
    expect(extended.forCommand('skillsmith fixture')).toBe(extended.get('fixture', 1));
    expect(
      resultValue(codec.decode(resultValue(codec.encode({ value: 'extension' })) as string)),
    ).toEqual({ value: 'extension' });
    expect(loaded.currentWireContractRegistry.get('fixture', 1)).toBeUndefined();
    expect(loaded.currentWireContractRegistry.codecs.map(descriptorIdentity)).toEqual(before);
    const genericSource = await readFile(join(CONTRACTS_ROOT, 'registry.ts'), 'utf8');
    expect(genericSource).not.toContain('skillsmith fixture');
    expect(genericSource).not.toContain('CURRENT_COMMAND_SPECS');
  });
});
