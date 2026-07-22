import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCompletion } from '../../../packages/cli/src/completion/run.ts';
import { buildProgram } from '../../../packages/cli/src/program.ts';
import { optionsForPath } from '../../../packages/cli/src/spec/options.ts';
import { TOOL_OPERATIONS } from '../../../packages/core/src/agents/adapter-types.ts';
import { verifyClaudeCode } from '../../../packages/core/src/agents/claude-code/verify.ts';
import { verifyCodex } from '../../../packages/core/src/agents/codex/verify.ts';
import { SUPPORTED_TOOLS } from '../../../packages/core/src/agents/types.ts';
import { resolveRuntimeConfiguration } from '../../../packages/core/src/config/runtime.ts';
import { parseConfig } from '../../../packages/core/src/config/schema.ts';
import { FLIP_TOOLS } from '../../../packages/core/src/place/types.ts';
import { VERIFIED_AGAINST, VERIFY_TOOLS } from '../../../packages/core/src/verify/types.ts';
import { readOnlyFixtureAdapter } from '../fixtures/p1-ts09/read-only-adapter.ts';
import { writeFixtureAdapter } from '../fixtures/p1-ts09/write-adapter.ts';

const BUILT_INS = ['claude-code', 'codex', 'kilo-code', 'opencode'] as const;
const FULL = ['claude-code', 'codex'] as const;
const READ_SCOPES = ['user', 'project', 'system', 'managed'] as const;
const WRITE_SCOPES = ['user', 'project', 'custom'] as const;
const OPERATIONS = [
  'detect',
  'inventory-skills',
  'inventory-commands',
  'diagnostics',
  'install',
  'uninstall',
  'dev',
  'promote',
  'undo',
  'verify-static',
  'verify-deep',
  'plan',
  'apply',
  'sync',
  'update',
  'adapt',
] as const;

type OperationFact = {
  supported: boolean;
  scopes: readonly string[];
  remediation: string | null;
};
type Adapter = {
  descriptor: {
    id: string;
    order: number;
    capabilityVersion: number;
    operations: Record<string, OperationFact>;
  };
  inventory: unknown;
  verification?: {
    verifiedAgainst: string;
    modes: readonly string[];
    verify: (...args: never[]) => unknown;
    gatePolicy: { installDeep: boolean; promote: string };
  };
  placement?: { roots: (...args: never[]) => unknown; list?: (...args: never[]) => unknown };
  adaptation?: unknown;
};
type Registry = {
  adapters: readonly Adapter[];
  ids: readonly string[];
  get(id: string): unknown;
  toolsFor(operation: string): readonly string[];
  capability(
    id: string,
    operation: string,
  ): OperationFact | { code: string; exitCode: number; remediation?: string };
};
type RegistryModule = {
  createToolRegistry?: (adapters: readonly unknown[]) => Registry;
  toolRegistry?: Registry;
  registry?: Readonly<Record<string, unknown>>;
};

const registryModule = async (): Promise<RegistryModule> =>
  (await import('../../../packages/core/src/agents/registry.ts')) as RegistryModule;

const requireRegistry = async (): Promise<Registry> => {
  const module = await registryModule();
  expect(module.toolRegistry, 'production toolRegistry is the executable authority').toBeDefined();
  if (!module.toolRegistry) throw new Error('missing planned production toolRegistry');
  return module.toolRegistry;
};

const requireBuilder = async (): Promise<NonNullable<RegistryModule['createToolRegistry']>> => {
  const module = await registryModule();
  expect(typeof module.createToolRegistry, 'validated createToolRegistry builder').toBe('function');
  if (!module.createToolRegistry) throw new Error('missing planned createToolRegistry');
  return module.createToolRegistry;
};

const expectedScopes = (tool: string, operation: string): readonly string[] => {
  if (operation === 'detect') return [];
  if (['inventory-skills', 'inventory-commands', 'diagnostics'].includes(operation)) {
    return READ_SCOPES;
  }
  if (operation === 'verify-static' || operation === 'verify-deep') {
    return FULL.includes(tool as (typeof FULL)[number]) ? ['artifact'] : [];
  }
  if (operation === 'adapt') return [];
  return FULL.includes(tool as (typeof FULL)[number]) ? WRITE_SCOPES : [];
};

describe('EWP-P1-TS09', () => {
  test('publishes the exact immutable four-tool operation, scope, and version matrix', async () => {
    const registry = await requireRegistry();
    expect(registry.ids).toEqual(BUILT_INS);
    expect(
      [...registry.adapters]
        .sort((left, right) => left.descriptor.order - right.descriptor.order)
        .map((adapter) => adapter.descriptor.id),
    ).toEqual(BUILT_INS);
    const orders = registry.adapters.map((adapter) => adapter.descriptor.order);
    expect(orders.every(Number.isSafeInteger)).toBeTrue();
    expect(new Set(orders).size).toBe(orders.length);
    expect(
      orders.every((order, index) => index === 0 || order > (orders[index - 1] ?? order)),
    ).toBe(true);
    for (const adapter of registry.adapters) {
      expect(adapter.descriptor.capabilityVersion).toBe(1);
      expect(Object.keys(adapter.descriptor.operations).sort()).toEqual([...OPERATIONS].sort());
      expect(typeof (adapter.inventory as { detect?: unknown }).detect).toBe('function');
      expect(typeof (adapter.inventory as { getSkillRoots?: unknown }).getSkillRoots).toBe(
        'function',
      );
      expect(typeof (adapter.inventory as { getCommandRoots?: unknown }).getCommandRoots).toBe(
        'function',
      );
      for (const operation of OPERATIONS) {
        const fact = adapter.descriptor.operations[operation];
        expect(fact).toBeDefined();
        if (!fact) continue;
        expect(fact.scopes).toEqual(expectedScopes(adapter.descriptor.id, operation));
        expect(fact.supported).toBe(fact.scopes.length > 0 || operation === 'detect');
        expect(fact.supported ? fact.remediation : Boolean(fact.remediation)).toBe(
          fact.supported ? null : true,
        );
        expect(Object.isFrozen(fact)).toBeTrue();
      }
      expect(Object.isFrozen(adapter.descriptor.operations)).toBeTrue();
      expect(Object.isFrozen(adapter.descriptor)).toBeTrue();
    }
    expect(Object.isFrozen(registry.adapters)).toBeTrue();
  });

  test('rejects duplicate/malformed identity and descriptor-bundle drift', async () => {
    const create = await requireBuilder();
    const copy = (): Adapter => ({
      descriptor: {
        ...readOnlyFixtureAdapter.descriptor,
        operations: Object.fromEntries(
          Object.entries(readOnlyFixtureAdapter.descriptor.operations).map(([id, fact]) => [
            id,
            { ...fact, scopes: [...fact.scopes] },
          ]),
        ),
      },
      inventory: readOnlyFixtureAdapter.inventory,
    });
    const base = copy();
    const operation = (
      adapter: Adapter,
      id: string,
      fact: OperationFact,
      extras: Partial<Adapter> = {},
    ): Adapter => ({
      ...adapter,
      descriptor: {
        ...adapter.descriptor,
        operations: { ...adapter.descriptor.operations, [id]: fact },
      },
      ...extras,
    });
    const other = copy();
    other.descriptor = { ...other.descriptor, id: 'fixture-other' };
    other.inventory = { ...readOnlyFixtureAdapter.inventory, tool: 'fixture-other' };
    const invalidCases: Array<{
      adapters: readonly unknown[];
      message: RegExp;
    }> = [
      {
        adapters: [base, { ...copy(), descriptor: { ...base.descriptor, order: 91 } }],
        message: /duplicate.*id|id.*duplicate/i,
      },
      { adapters: [base, other], message: /duplicate.*order|order.*duplicate/i },
      ...[0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1].map((capabilityVersion) => ({
        adapters: [{ ...copy(), descriptor: { ...base.descriptor, capabilityVersion } }],
        message: /capability.*version|version.*capability/i,
      })),
      {
        adapters: [
          operation(copy(), 'verify-static', {
            supported: true,
            scopes: ['artifact'],
            remediation: null,
          }),
        ],
        message: /verification|verifier/i,
      },
      {
        adapters: [
          operation(copy(), 'install', {
            supported: true,
            scopes: ['user'],
            remediation: null,
          }),
        ],
        message: /placement|mutation/i,
      },
      {
        adapters: [
          operation(
            copy(),
            'install',
            { supported: true, scopes: [], remediation: null },
            { placement: { roots: () => [] } },
          ),
        ],
        message: /scope/i,
      },
      {
        adapters: [
          operation(copy(), 'adapt', {
            supported: true,
            scopes: ['custom'],
            remediation: null,
          }),
        ],
        message: /adaptation|adapt/i,
      },
      {
        adapters: [{ ...copy(), verification: { verify: () => undefined } }],
        message: /verification|descriptor|undeclared/i,
      },
      {
        adapters: [{ ...copy(), placement: { roots: () => [] } }],
        message: /placement|read-only|mutation|descriptor/i,
      },
      { adapters: [{ descriptor: copy().descriptor }], message: /inventory/i },
      {
        adapters: [{ ...copy(), descriptor: { ...base.descriptor, id: 'fixture-drift' } }],
        message: /inventory|descriptor|drift/i,
      },
    ];
    for (const invalid of invalidCases) {
      expect(() => create(invalid.adapters)).toThrow(invalid.message);
    }
  });

  test('rejects invalid verification modes, gate policy, and required inventory gaps', async () => {
    const create = await requireBuilder();
    const verified = (): Adapter => ({
      ...writeFixtureAdapter,
      descriptor: {
        ...writeFixtureAdapter.descriptor,
        operations: Object.fromEntries(
          Object.entries(writeFixtureAdapter.descriptor.operations).map(([id, fact]) => [
            id,
            { ...fact, scopes: [...fact.scopes] },
          ]),
        ),
      },
      inventory: writeFixtureAdapter.inventory,
      verification: {
        ...writeFixtureAdapter.verification,
        modes: [...writeFixtureAdapter.verification.modes],
        gatePolicy: { ...writeFixtureAdapter.verification.gatePolicy },
      },
      placement: writeFixtureAdapter.placement,
    });

    for (const modes of [['static', 'deep', 'future'], ['static', 'static', 'deep'], ['future']]) {
      const adapter = verified();
      if (!adapter.verification) throw new Error('fixture verifier is missing');
      adapter.verification = { ...adapter.verification, modes };
      expect(() => create([adapter])).toThrow(/verification.*mode|mode.*verification/i);
    }

    for (const gatePolicy of [
      { installDeep: 'yes', promote: 'static', update: 'static' },
      { installDeep: true, promote: 'future', update: 'static' },
      { installDeep: true, promote: 'static', update: 'future' },
    ]) {
      const adapter = verified();
      if (!adapter.verification) throw new Error('fixture verifier is missing');
      adapter.verification = {
        ...adapter.verification,
        gatePolicy: gatePolicy as unknown as NonNullable<Adapter['verification']>['gatePolicy'],
      };
      expect(() => create([adapter])).toThrow(/gate.*policy|installDeep|promote|update/i);
    }

    const incoherent = verified();
    incoherent.descriptor.operations['verify-deep'] = {
      supported: false,
      scopes: [],
      remediation: 'deep verification is unavailable',
    };
    if (!incoherent.verification) throw new Error('fixture verifier is missing');
    incoherent.verification = {
      ...incoherent.verification,
      modes: ['static'],
      gatePolicy: { installDeep: true, promote: 'static+deep', update: 'static+deep' },
    };
    expect(() => create([incoherent])).toThrow(/gate.*policy|verify-deep|deep.*unsupported/i);

    for (const operation of ['detect', 'inventory-skills', 'inventory-commands', 'diagnostics']) {
      const adapter = verified();
      adapter.descriptor.operations[operation] = {
        supported: false,
        scopes: [],
        remediation: `${operation} is unavailable`,
      };
      expect(() => create([adapter])).toThrow(/inventory|required|operation/i);
    }
  });

  test('freezes registry-owned views without freezing or changing caller-owned adapters', async () => {
    const create = await requireBuilder();
    const input = [
      {
        descriptor: {
          ...readOnlyFixtureAdapter.descriptor,
          operations: Object.fromEntries(
            Object.entries(readOnlyFixtureAdapter.descriptor.operations).map(([id, fact]) => [
              id,
              { ...fact, scopes: [...fact.scopes] },
            ]),
          ),
        },
        inventory: { ...readOnlyFixtureAdapter.inventory },
      },
    ];
    const adapter = input[0];
    if (!adapter) throw new Error('caller adapter fixture is missing');
    const descriptor = adapter.descriptor;
    const inventory = adapter.inventory;
    const operations = descriptor.operations;
    const detect = operations.detect;
    const before = JSON.stringify(descriptor);

    const fixture = create(input);

    expect(fixture.ids).toEqual(['fixture-read']);
    expect(input[0]).toBe(adapter);
    expect(adapter.descriptor).toBe(descriptor);
    expect(adapter.inventory).toBe(inventory);
    expect(adapter.descriptor.operations).toBe(operations);
    expect(adapter.descriptor.operations.detect).toBe(detect);
    expect(JSON.stringify(adapter.descriptor)).toBe(before);
    expect(Object.isFrozen(input)).toBeFalse();
    expect(Object.isFrozen(adapter)).toBeFalse();
    expect(Object.isFrozen(descriptor)).toBeFalse();
    expect(Object.isFrozen(inventory)).toBeFalse();
    expect(Object.isFrozen(operations)).toBeFalse();
    expect(Object.isFrozen(detect)).toBeFalse();
  });

  test('publishes runtime-immutable operation and capability projections', async () => {
    const registry = await requireRegistry();
    const inventoryTools = registry.toolsFor('inventory-skills');
    const verifyTools = registry.toolsFor('verify-static');
    expect(Object.isFrozen(TOOL_OPERATIONS)).toBeTrue();
    expect(Object.isFrozen(VERIFY_TOOLS)).toBeTrue();
    expect(Object.isFrozen(FLIP_TOOLS)).toBeTrue();
    expect(Object.isFrozen(inventoryTools)).toBeTrue();
    expect(Object.isFrozen(verifyTools)).toBeTrue();
  });

  test('derives every current compatibility and CLI choice view from one registry order', async () => {
    const registry = await requireRegistry();
    const module = await registryModule();
    expect(SUPPORTED_TOOLS).toEqual(registry.ids);
    expect(VERIFY_TOOLS).toEqual(registry.toolsFor('verify-static'));
    expect(FLIP_TOOLS).toEqual(registry.toolsFor('install'));
    expect(VERIFIED_AGAINST).toEqual({ 'claude-code': '2.1.202', codex: '0.142.5' });
    expect(Object.keys(VERIFIED_AGAINST)).toEqual(registry.toolsFor('verify-static'));
    expect(Object.keys(module.registry ?? {})).toEqual(registry.ids);
    for (const adapter of registry.adapters) {
      expect(module.registry?.[adapter.descriptor.id]).toBe(adapter.inventory);
      expect(parseConfig(`tool = "${adapter.descriptor.id}"`)).toMatchObject({ ok: true });
      expect(
        resolveRuntimeConfiguration({ SKILLSMITH_TOOL: adapter.descriptor.id }).configLayer.tool,
      ).toBe(adapter.descriptor.id);
    }
    const toolOption = optionsForPath('skillsmith verify').find(
      (option) => option.long === '--tool',
    );
    expect(toolOption?.knownValues).toEqual(registry.ids);
    expect(toolOption?.allowedValues).toEqual(registry.ids);
    expect(toolOption?.parserValues).toEqual(registry.ids);
    expect(toolOption?.parserValues).toBe(registry.ids);
    const program = buildProgram();
    const verify = program.commands.find((command) => command.name() === 'verify');
    const liveTool = verify?.options.find((option) => option.long === '--tool');
    expect(liveTool?.argChoices).toEqual(registry.ids);
    expect(verify?.helpInformation()).toContain('--tool');
    const completion = runCompletion(program, 'fish');
    for (const id of registry.ids) expect(completion).toContain(id);
  });

  test('routes registered read-only and write fixture adapters without global mutation', async () => {
    const create = await requireBuilder();
    const production = await requireRegistry();
    const before = [...production.ids];
    const fixture = create([readOnlyFixtureAdapter, writeFixtureAdapter]);
    expect(fixture.ids).toEqual(['fixture-read', 'fixture-write']);
    expect(fixture.toolsFor('inventory-skills')).toEqual(['fixture-read', 'fixture-write']);
    expect(fixture.toolsFor('install')).toEqual(['fixture-write']);
    expect(fixture.toolsFor('verify-deep')).toEqual(['fixture-write']);
    const read = fixture.get('fixture-read') as typeof readOnlyFixtureAdapter;
    const write = fixture.get('fixture-write') as typeof writeFixtureAdapter;
    expect(read.inventory.getSkillRoots()).toEqual([]);
    expect(write.verification.modes).toEqual(['static', 'deep']);
    expect(await write.verification.verify()).toMatchObject({ ok: true });
    expect(write.placement.roots()).toEqual([]);
    expect(production.ids).toEqual(before);
  });

  test('distinguishes known unsupported capability exit 4 from unknown usage exit 2', async () => {
    const registry = await requireRegistry();
    for (const tool of ['kilo-code', 'opencode']) {
      expect(registry.capability(tool, 'install')).toMatchObject({
        code: 'capability',
        exitCode: 4,
        remediation: expect.any(String),
      });
      expect(registry.capability(tool, 'verify-deep')).toMatchObject({
        code: 'capability',
        exitCode: 4,
        remediation: expect.any(String),
      });
    }
    expect(registry.capability('unknown-fixture', 'install')).toMatchObject({
      code: 'usage',
      exitCode: 2,
    });
  });

  test('registers Claude/Codex verification and placement bundles only', async () => {
    const registry = await requireRegistry();
    for (const adapter of registry.adapters) {
      const full = FULL.includes(adapter.descriptor.id as (typeof FULL)[number]);
      expect(Boolean(adapter.verification)).toBe(full);
      expect(Boolean(adapter.placement)).toBe(full);
      expect(Boolean(adapter.adaptation)).toBeFalse();
      if (full) {
        expect(adapter.verification?.modes).toEqual(['static', 'deep']);
        expect(adapter.verification?.verifiedAgainst).toBe(
          VERIFIED_AGAINST[adapter.descriptor.id as keyof typeof VERIFIED_AGAINST],
        );
        expect(adapter.verification?.gatePolicy).toEqual(
          adapter.descriptor.id === 'codex'
            ? { installDeep: true, promote: 'static+deep', update: 'static+deep' }
            : { installDeep: false, promote: 'static', update: 'static' },
        );
        expect(typeof adapter.verification?.verify).toBe('function');
        expect(adapter.verification?.verify).toBe(
          adapter.descriptor.id === 'codex' ? verifyCodex : verifyClaudeCode,
        );
        expect(typeof adapter.placement?.list).toBe('function');
        expect(registry.toolsFor('verify-static')).toContain(adapter.descriptor.id);
        expect(registry.toolsFor('verify-deep')).toContain(adapter.descriptor.id);
      }
    }
  });

  test('contains no executable known-tool policy branches in generic modules', async () => {
    const files: string[] = [];
    const glob = new Bun.Glob('packages/{core,cli}/src/**/*.ts');
    for await (const path of glob.scan({ cwd: join(import.meta.dir, '..', '..', '..') })) {
      if (path.includes('/agents/claude-code/') || path.includes('/agents/codex/')) continue;
      if (path.includes('/agents/kilo-code/') || path.includes('/agents/opencode/')) continue;
      files.push(path);
    }
    const root = join(import.meta.dir, '..', '..', '..');
    const comparison =
      /(?:(?:===|!==)\s*['"](?:claude-code|codex|kilo-code|opencode)['"]|['"](?:claude-code|codex|kilo-code|opencode)['"]\s*(?:===|!==))/g;
    const independentTuple =
      /\[\s*['"]claude-code['"]\s*,\s*['"]codex['"](?:\s*,\s*['"]kilo-code['"]\s*,\s*['"]opencode['"])?\s*\]/g;
    const independentVersionMap =
      /VERIFIED_AGAINST\s*[^=]*=\s*\{[\s\S]*?['"]?claude-code['"]?\s*:[\s\S]*?codex\s*:/g;
    const knownIdPolicy =
      /(?:\.includes\(\s*['"](?:claude-code|codex|kilo-code|opencode)['"]|\bcase\s+['"](?:claude-code|codex|kilo-code|opencode)['"]|\btool\s*[:=]\s*['"](?:claude-code|codex|kilo-code|opencode)['"])/g;
    const directAdapterImport =
      /from\s+['"]\.\.\/agents\/(?:claude-code|codex|kilo-code|opencode)\//g;
    const genericKnownKey = /(?:^|[{,])\s*['"]?(?:claude-code|codex|kilo-code|opencode)['"]?\s*:/gm;
    const violations: string[] = [];
    for (const path of files) {
      const source = await Bun.file(join(root, path)).text();
      const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (
        comparison.test(executable) ||
        independentTuple.test(executable) ||
        independentVersionMap.test(executable) ||
        knownIdPolicy.test(executable) ||
        (!path.endsWith('/agents/registry.ts') &&
          (directAdapterImport.test(executable) || genericKnownKey.test(executable)))
      ) {
        violations.push(path);
      }
      comparison.lastIndex = 0;
      independentTuple.lastIndex = 0;
      independentVersionMap.lastIndex = 0;
      knownIdPolicy.lastIndex = 0;
      directAdapterImport.lastIndex = 0;
      genericKnownKey.lastIndex = 0;
    }
    expect(violations).toEqual([]);
  });
});
