import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');
const FIXTURES = join(import.meta.dir, '../fixtures/p2-ts07');
const CORE_MODULE = '../../../packages/core/src/index.ts';
const ARTIFACTS_MODULE = '../../../packages/core/src/artifacts/index.ts';
const SECRET_CANARY = 'P17_SECRET_CANARY';

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };

interface SourceExpected {
  readonly identity: {
    readonly host: string;
    readonly repository: string;
    readonly path: string | null;
  };
  readonly canonicalSource: string;
  readonly canonicalInvocation: string;
  readonly originSource: string;
  readonly cloneUrl: string;
  readonly selector:
    | { readonly kind: 'whole-repo' }
    | { readonly kind: 'name'; readonly name: string }
    | { readonly kind: 'path'; readonly path: string };
  readonly ref: string | null;
}

interface SourceCase {
  readonly id: string;
  readonly input: string;
  readonly options?: Readonly<{ overrideRef: string }>;
  readonly expected: SourceExpected;
}

interface RejectedSourceCase {
  readonly id: string;
  readonly input: string;
  readonly options?: Readonly<{ overrideRef: string }>;
}

interface SourcePathGoldens {
  readonly schemaVersion: number;
  readonly acceptedSources: readonly SourceCase[];
  readonly rejectedSources: readonly RejectedSourceCase[];
  readonly registry: {
    readonly accepted: readonly {
      readonly input: string;
      readonly expected: string;
      readonly legacy: boolean;
    }[];
    readonly rejected: readonly { readonly input: string; readonly legacy: boolean }[];
  };
  readonly portablePaths: {
    readonly accepted: readonly { readonly input: string; readonly scope: 'project' | 'user' }[];
    readonly rejected: readonly { readonly input: string; readonly scope: 'project' | 'user' }[];
  };
  readonly artifactSelectors: readonly {
    readonly input: string;
    readonly posix: 'portable' | 'machine-bound' | 'invalid' | 'nonportable';
    readonly windows: 'portable' | 'machine-bound' | 'invalid' | 'nonportable';
  }[];
}

interface RedactionGoldens {
  readonly schemaVersion: number;
  readonly stringCases: readonly {
    readonly id: string;
    readonly input: string;
    readonly expected: string;
    readonly sensitive: boolean;
  }[];
  readonly objectCases: readonly {
    readonly id: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly expected: Readonly<Record<string, unknown>>;
  }[];
}

const sourceGoldens = JSON.parse(
  readFileSync(join(FIXTURES, 'source-path-goldens.json'), 'utf8'),
) as SourcePathGoldens;
const redactionGoldens = JSON.parse(
  readFileSync(join(FIXTURES, 'redaction-goldens.json'), 'utf8'),
) as RedactionGoldens;

const expectUniqueIds = (cases: readonly { readonly id: string }[], label: string): void => {
  const ids = cases.map(({ id }) => id);
  expect(
    ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)),
    label,
  ).toBeTrue();
  expect(new Set(ids).size, label).toBe(ids.length);
};

const loadModule = async (specifier: string): Promise<Readonly<Record<string, unknown>>> =>
  (await import(specifier)) as Readonly<Record<string, unknown>>;

const requireFunctions = <T>(
  module: Readonly<Record<string, unknown>>,
  names: readonly string[],
  authority: string,
): T => {
  const missing = names.filter((name) => typeof module[name] !== 'function');
  expect(missing, `${authority} is absent or incomplete`).toEqual([]);
  if (missing.length > 0) throw new Error(`${authority}: missing ${missing.join(', ')}`);
  return module as unknown as T;
};

const unwrap = <T>(result: Result<T>, label: string): T => {
  expect(result.ok, result.ok ? label : `${label}: ${JSON.stringify(result.error)}`).toBeTrue();
  if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.value;
};

const assertRecursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const child of Object.values(value as Readonly<Record<string, unknown>>))
    assertRecursivelyFrozen(child, seen);
};

describe('EWP-P2-TS07', () => {
  test('EWP-P2-TS07 fixture/count/shape/canary preguards load before production authority', () => {
    expect(sourceGoldens.schemaVersion).toBe(1);
    expect(redactionGoldens.schemaVersion).toBe(1);
    expect(sourceGoldens.acceptedSources).toHaveLength(9);
    expect(sourceGoldens.rejectedSources).toHaveLength(31);
    expect(sourceGoldens.registry.accepted).toHaveLength(3);
    expect(sourceGoldens.registry.rejected).toHaveLength(5);
    expect(sourceGoldens.portablePaths.accepted).toHaveLength(4);
    expect(sourceGoldens.portablePaths.rejected).toHaveLength(12);
    expect(sourceGoldens.artifactSelectors).toHaveLength(7);
    expect(redactionGoldens.stringCases).toHaveLength(13);
    expect(redactionGoldens.objectCases).toHaveLength(2);
    expectUniqueIds(sourceGoldens.acceptedSources, 'accepted source ids');
    expectUniqueIds(sourceGoldens.rejectedSources, 'rejected source ids');
    expectUniqueIds(redactionGoldens.stringCases, 'redaction string ids');
    expectUniqueIds(redactionGoldens.objectCases, 'redaction object ids');

    const expectedSourceKeys = [
      'canonicalInvocation',
      'canonicalSource',
      'cloneUrl',
      'identity',
      'originSource',
      'ref',
      'selector',
    ];
    for (const fixture of sourceGoldens.acceptedSources) {
      expect(Object.keys(fixture.expected).sort(), fixture.id).toEqual(expectedSourceKeys);
      expect(fixture.expected.originSource, fixture.id).toBe(fixture.expected.canonicalSource);
      expect(fixture.expected.cloneUrl, fixture.id).not.toContain(SECRET_CANARY);
      expect(fixture.expected, fixture.id).not.toHaveProperty('raw');
      expect(fixture.expected, fixture.id).not.toHaveProperty('host');
      expect(fixture.expected, fixture.id).not.toHaveProperty('repoPath');
    }
    for (const fixture of redactionGoldens.stringCases) {
      expect(fixture.expected, fixture.id).not.toContain(SECRET_CANARY);
      expect(
        fixture.sensitive ? fixture.expected !== fixture.input : fixture.expected === fixture.input,
      ).toBeTrue();
    }
    expect(
      JSON.stringify(redactionGoldens.objectCases.map(({ expected }) => expected)),
    ).not.toContain(SECRET_CANARY);
  });

  test('EWP-P2-TS07 keeps signed source, registry, placement, and selector grammars distinct', async () => {
    const artifacts = await loadModule(ARTIFACTS_MODULE);
    const api = requireFunctions<{
      normalizeSourceIdentity(input: string): Result<SourceExpected['identity']>;
      normalizeRegistryIdentity(
        input: string,
        options?: Readonly<{ legacy?: boolean }>,
      ): Result<string>;
      normalizePortablePath(input: string, scope: 'project' | 'user'): Result<string>;
      classifyArtifactSelectorToken(
        input: string,
        host: 'posix' | 'windows',
      ): 'portable' | 'machine-bound' | 'invalid' | 'nonportable';
    }>(
      artifacts,
      [
        'normalizeSourceIdentity',
        'normalizeRegistryIdentity',
        'normalizePortablePath',
        'classifyArtifactSelectorToken',
      ],
      'signed G2-01 portability authority',
    );

    for (const fixture of sourceGoldens.acceptedSources) {
      const normalized = unwrap(
        api.normalizeSourceIdentity(fixture.expected.canonicalSource),
        fixture.id,
      );
      expect(normalized, fixture.id).toEqual(fixture.expected.identity);
      expect(Object.isFrozen(normalized), fixture.id).toBeTrue();
    }
    for (const fixture of sourceGoldens.registry.accepted) {
      expect(
        unwrap(
          api.normalizeRegistryIdentity(fixture.input, { legacy: fixture.legacy }),
          fixture.input,
        ),
      ).toBe(fixture.expected);
    }
    for (const fixture of sourceGoldens.registry.rejected) {
      expect(
        api.normalizeRegistryIdentity(fixture.input, { legacy: fixture.legacy }).ok,
        fixture.input,
      ).toBeFalse();
    }
    for (const fixture of sourceGoldens.portablePaths.accepted) {
      expect(unwrap(api.normalizePortablePath(fixture.input, fixture.scope), fixture.input)).toBe(
        fixture.input,
      );
    }
    for (const fixture of sourceGoldens.portablePaths.rejected) {
      expect(api.normalizePortablePath(fixture.input, fixture.scope).ok, fixture.input).toBeFalse();
    }
    for (const fixture of sourceGoldens.artifactSelectors) {
      expect(api.classifyArtifactSelectorToken(fixture.input, 'posix'), fixture.input).toBe(
        fixture.posix,
      );
      expect(api.classifyArtifactSelectorToken(fixture.input, 'windows'), fixture.input).toBe(
        fixture.windows,
      );
    }
  });

  test('EWP-P2-TS07 publishes one recursive redactor and sensitivity predicate', async () => {
    const core = await loadModule(CORE_MODULE);
    const api = requireFunctions<{
      containsSensitiveMaterial(input: string): boolean;
      redactSensitiveString(input: string): string;
      redactSensitiveValue(input: unknown): unknown;
      redactObservationValue(input: unknown): unknown;
    }>(
      core,
      [
        'containsSensitiveMaterial',
        'redactSensitiveString',
        'redactSensitiveValue',
        'redactObservationValue',
      ],
      'G2-03 shared safety authority',
    );
    expect(api.redactObservationValue).toBe(api.redactSensitiveValue);

    for (const fixture of redactionGoldens.stringCases) {
      expect(api.containsSensitiveMaterial(fixture.input), fixture.id).toBe(fixture.sensitive);
      expect(api.redactSensitiveString(fixture.input), fixture.id).toBe(fixture.expected);
    }
    for (const fixture of redactionGoldens.objectCases) {
      const before = JSON.stringify(fixture.input);
      const output = api.redactSensitiveValue(fixture.input);
      expect(output, fixture.id).toEqual(fixture.expected);
      expect(JSON.stringify(fixture.input), fixture.id).toBe(before);
      assertRecursivelyFrozen(output);
    }

    let getterReads = 0;
    let proxyReads = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterReads++;
        return SECRET_CANARY;
      },
    });
    const proxy = new Proxy(
      { value: SECRET_CANARY },
      {
        ownKeys: () => {
          proxyReads++;
          return ['value'];
        },
      },
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    class Exotic {
      readonly value = SECRET_CANARY;
    }
    const hostile = api.redactSensitiveValue({ accessor, proxy, cycle, exotic: new Exotic() });
    expect(JSON.stringify(hostile)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(hostile)).toContain('[ACCESSOR]');
    expect(JSON.stringify(hostile)).toContain('[PROXY]');
    expect(JSON.stringify(hostile)).toContain('[CIRCULAR]');
    expect(JSON.stringify(hostile)).toContain('[EXOTIC]');
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);

    let deep: unknown = 'leaf';
    for (let index = 0; index < 34; index++) deep = { child: deep };
    expect(JSON.stringify(api.redactSensitiveValue(deep))).toContain('[MAX_DEPTH]');
    expect(
      JSON.stringify(api.redactSensitiveValue(Array.from({ length: 4_097 }, (_, index) => index))),
    ).toContain('[MAX_NODES]');
  });

  test('EWP-P2-TS07 canonical acquisition DTO round-trips every accepted transport projection', async () => {
    const core = await loadModule(CORE_MODULE);
    const api = requireFunctions<{
      parseSource(
        input: string,
        options?: Readonly<{ overrideRef?: string }>,
      ): Result<SourceExpected>;
      normalizeSourceIdentity(input: string): Result<SourceExpected['identity']>;
    }>(core, ['parseSource', 'normalizeSourceIdentity'], 'G2-03 acquisition source boundary');

    for (const fixture of sourceGoldens.acceptedSources) {
      const parsed = unwrap(api.parseSource(fixture.input, fixture.options), fixture.id);
      expect(parsed, `${fixture.id}: canonical DTO drift`).toEqual(fixture.expected);
      expect(Object.isFrozen(parsed), `${fixture.id}: DTO`).toBeTrue();
      expect(Object.isFrozen(parsed.identity), `${fixture.id}: identity`).toBeTrue();
      expect(Object.isFrozen(parsed.selector), `${fixture.id}: selector`).toBeTrue();
      const projection = `https://${parsed.identity.host}/${parsed.identity.repository}${
        parsed.identity.path === null ? '' : `//${parsed.identity.path}`
      }`;
      expect(unwrap(api.normalizeSourceIdentity(projection), fixture.id)).toEqual(parsed.identity);
    }
  });

  test('EWP-P2-TS07 rejects hostile transports, refs, authorities, and foreign paths', async () => {
    const core = await loadModule(CORE_MODULE);
    const api = requireFunctions<{
      parseSource(
        input: string,
        options?: Readonly<{ overrideRef?: string }>,
      ): Result<SourceExpected>;
    }>(core, ['parseSource'], 'G2-03 acquisition source boundary');

    for (const fixture of sourceGoldens.rejectedSources) {
      const parsed = api.parseSource(fixture.input, fixture.options);
      expect(parsed.ok, `${fixture.id} must refuse before acquisition`).toBeFalse();
      if (!parsed.ok) {
        expect(parsed.error.code, fixture.id).toBe('flip-refused');
        expect(JSON.stringify(parsed.error), fixture.id).not.toContain(SECRET_CANARY);
      }
    }
  });

  test('EWP-P2-TS07 fail-fast reports use safe labels and numeric request identity', async () => {
    const core = await loadModule(CORE_MODULE);
    const api = requireFunctions<{
      runInstall(
        env: unknown,
        options: Readonly<Record<string, unknown>>,
      ): Promise<
        Result<{
          readonly requested: { readonly sources: readonly string[] };
          readonly results: readonly {
            readonly source: string;
            readonly action: string;
            readonly requestIndex?: number;
          }[];
        }>
      >;
    }>(core, ['runInstall'], 'current install report authority');
    const invalid = 'ftp://example.com/acme/repo';
    const valid = 'owner/repo';
    const report = unwrap(
      await api.runInstall(
        { xdg: { config: '/fixture/config', data: '/fixture/data', cache: '/fixture/cache' } },
        {
          sources: [invalid, valid, invalid],
          cwd: '/fixture/work',
          configuration: {
            configLayer: {},
            explicitConfigPath: undefined,
            skillsmithHome: '/fixture/data',
            claudeConfigDir: undefined,
            claudePolicySkillsDisabled: false,
            claudeManagedSettingsPath: undefined,
            codexHome: undefined,
            kiloExternalSkillsDisabled: false,
            opencodeConfigDir: undefined,
            opencodeClaudeSkillsDisabled: false,
            forceColor: false,
            noColor: false,
            journalPause: undefined,
          },
        },
      ),
      'fail-fast report',
    );
    expect(report.requested.sources).toEqual([
      '[REJECTED_SOURCE]',
      'github.com/owner/repo',
      '[REJECTED_SOURCE]',
    ]);
    expect(report.results.map(({ source }) => source)).toEqual(report.requested.sources);
    expect(report.results.map(({ requestIndex }) => requestIndex)).toEqual([0, 1, 2]);
    expect(report.results.map(({ action }) => action)).toEqual(['refused', 'skipped', 'refused']);
  });

  test('EWP-P2-TS07 uses the shared authority at observation and public type boundaries', () => {
    const safetyPath = join(ROOT, 'packages/core/src/safety/redaction.ts');
    const observationPath = join(ROOT, 'packages/core/src/observation/redaction.ts');
    expect(existsSync(safetyPath), 'missing G2-03 safety/redaction.ts authority').toBeTrue();
    if (!existsSync(safetyPath)) return;
    const safetySource = readFileSync(safetyPath, 'utf8');
    const observationSource = readFileSync(observationPath, 'utf8');
    for (const name of [
      'containsSensitiveMaterial',
      'redactSensitiveString',
      'redactSensitiveValue',
      'redactObservationValue',
    ]) {
      expect(safetySource, name).toContain(name);
    }
    expect(observationSource).toContain('../safety/redaction.ts');
    expect(observationSource).not.toMatch(/Bearer|gh\[pousr\]|sk-/u);

    const compiled = Bun.spawnSync(
      [join(ROOT, 'node_modules/.bin/tsc'), '-p', join(FIXTURES, 'tsconfig.json'), '--noEmit'],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const output = `${compiled.stdout.toString()}${compiled.stderr.toString()}`;
    expect(compiled.exitCode, output).toBe(0);
  }, 15_000);
});
