import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    expect(api.redactSensitiveString('access_token=canary-canary')).toBe('access_token=[REDACTED]');
    expect(api.redactSensitiveString('Cookie: a=one; b=two')).toBe('Cookie: [REDACTED]');
    expect(api.containsSensitiveMaterial('[REDACTED]')).toBeTrue();

    const native = new Error('safe diagnostic');
    Object.defineProperties(native, {
      code: { value: 'EACCES', enumerable: true },
      exitCode: { value: 6, enumerable: true },
    });
    expect(api.redactSensitiveValue(native)).toMatchObject({ code: 'EACCES', exitCode: 6 });

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

  test('EWP-P2-TS07 sanitizes ordinary property names and fails closed on collisions', async () => {
    const core = await loadModule(CORE_MODULE);
    const api = requireFunctions<{
      redactSensitiveValue(input: unknown): unknown;
    }>(core, ['redactSensitiveValue'], 'G2-03 property-name redaction authority');
    const marker = 'P17_MARKER_F13_123456789';
    const assignmentKey = `password=${marker}`;
    const urlKey = `https://user:${marker}@example.test/acme/repo`;
    let getterReads = 0;
    const assignmentGetter = (): string => {
      getterReads++;
      return marker;
    };
    const input: Record<string, unknown> = { ordinary: { retained: true } };
    Object.defineProperty(input, assignmentKey, {
      enumerable: true,
      get: assignmentGetter,
    });
    Object.defineProperty(input, urlKey, {
      enumerable: true,
      value: { visible: 'diagnostic' },
    });
    const keysBefore = Reflect.ownKeys(input);
    const assignmentBefore = Object.getOwnPropertyDescriptor(input, assignmentKey);
    const urlBefore = Object.getOwnPropertyDescriptor(input, urlKey);

    const output = api.redactSensitiveValue(input) as Readonly<Record<string, unknown>>;
    expect(JSON.stringify(output)).not.toContain(marker);
    expect(Reflect.ownKeys(output)).toEqual([
      'ordinary',
      'password=[REDACTED]',
      'https://example.test/acme/repo',
    ]);
    expect(output.ordinary).toEqual({ retained: true });
    expect(output['password=[REDACTED]']).toBe('[REDACTED]');
    expect(output['https://example.test/acme/repo']).toEqual({ visible: 'diagnostic' });
    assertRecursivelyFrozen(output);
    expect(getterReads).toBe(0);
    expect(Reflect.ownKeys(input)).toEqual(keysBefore);
    expect(Object.getOwnPropertyDescriptor(input, assignmentKey)).toEqual(assignmentBefore);
    expect(Object.getOwnPropertyDescriptor(input, urlKey)).toEqual(urlBefore);

    const collision = {
      ordinary: 'not selected by insertion order',
      [`token=${marker}-one`]: 1,
      [`token=${marker}-two`]: 2,
    };
    const reverseCollision = {
      [`token=${marker}-two`]: 2,
      [`token=${marker}-one`]: 1,
      ordinary: 'not selected by insertion order',
    };
    const collisionBefore = JSON.stringify(collision);
    const reverseBefore = JSON.stringify(reverseCollision);
    expect(api.redactSensitiveValue(collision)).toBe('[KEY_COLLISION]');
    expect(api.redactSensitiveValue(reverseCollision)).toBe('[KEY_COLLISION]');
    expect(JSON.stringify(api.redactSensitiveValue(collision))).not.toContain(marker);
    expect(JSON.stringify(collision)).toBe(collisionBefore);
    expect(JSON.stringify(reverseCollision)).toBe(reverseBefore);
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
    for (const input of [
      'https://example.com/acme/./repo',
      'https://example.com/acme/../repo',
      'https://example.com:/acme/repo',
      'https://example.com:443/acme/repo',
      'ssh://git@example.com:/acme/repo',
      'ssh://git@example.com:22/acme/repo',
    ]) {
      const parsed = api.parseSource(input);
      expect(parsed.ok, `${input} must reject before URL normalization`).toBeFalse();
    }
  });

  test('EWP-P2-TS07 rejects recursively encoded credential sources and refs without mutation', async () => {
    const core = await loadModule(CORE_MODULE);
    const api = requireFunctions<{
      containsSensitiveMaterial(input: string): boolean;
      parseSource(
        input: string,
        options?: Readonly<{ overrideRef?: string }>,
      ): Result<SourceExpected>;
      redactSensitiveString(input: string): string;
      redactSensitiveValue(input: unknown): unknown;
      runInstall(
        env: unknown,
        options: Readonly<Record<string, unknown>>,
      ): Promise<
        Result<{
          readonly requested: {
            readonly sources: readonly string[];
            readonly ref: string | null;
          };
          readonly results: readonly { readonly source: string; readonly action: string }[];
        }>
      >;
    }>(
      core,
      [
        'containsSensitiveMaterial',
        'parseSource',
        'redactSensitiveString',
        'redactSensitiveValue',
        'runInstall',
      ],
      'G2-03 recursively encoded source and ref authority',
    );
    const canary = 'P17_SECRET_CANARY_ENCODED_123456789';
    const encodedCredential = (layers: number): string =>
      `%${'25'.repeat(layers - 1)}74oken=${canary}`;
    const cases = [
      { id: 'one-layer', input: encodedCredential(1), expected: 'token=[REDACTED]' },
      { id: 'five-layers', input: encodedCredential(5), expected: 'token=[REDACTED]' },
      { id: 'work-budget-exceeded', input: encodedCredential(33), expected: '[REDACTED]' },
    ] as const;
    const inertEnv = Object.freeze({
      xdg: Object.freeze({
        config: '/fixture/config',
        data: '/fixture/data',
        cache: '/fixture/cache',
      }),
    });
    const configuration = Object.freeze({
      configLayer: Object.freeze({}),
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
    });

    for (const fixture of cases) {
      const sourceInput = fixture.input;
      const overrideOptions = Object.freeze({ overrideRef: fixture.input });
      const boxedInput = Object.freeze({ source: fixture.input, ref: fixture.input });
      const before = JSON.stringify(boxedInput);

      expect(api.containsSensitiveMaterial(fixture.input), fixture.id).toBeTrue();
      expect(api.redactSensitiveString(fixture.input), fixture.id).toBe(fixture.expected);
      expect(JSON.stringify(api.redactSensitiveValue(boxedInput)), fixture.id).not.toContain(
        canary,
      );
      expect(JSON.stringify(boxedInput), `${fixture.id}: input mutation`).toBe(before);
      const parsedSource = api.parseSource(sourceInput);
      expect(parsedSource.ok, `${fixture.id}: source`).toBeFalse();
      expect(JSON.stringify(parsedSource), `${fixture.id}: source error`).not.toContain(canary);
      const parsedRef = api.parseSource('owner/repo', overrideOptions);
      expect(parsedRef.ok, `${fixture.id}: override ref`).toBeFalse();
      expect(JSON.stringify(parsedRef), `${fixture.id}: ref error`).not.toContain(canary);
      expect(sourceInput, `${fixture.id}: source input mutation`).toBe(fixture.input);
      expect(overrideOptions.overrideRef, `${fixture.id}: ref input mutation`).toBe(fixture.input);

      const directOptions = Object.freeze({
        sources: Object.freeze([fixture.input]),
        cwd: '/fixture/work',
        configuration,
      });
      const direct = unwrap(
        await api.runInstall(inertEnv, directOptions),
        `${fixture.id}: direct fail-fast report`,
      );
      expect(JSON.stringify(direct), fixture.id).not.toContain(canary);
      expect(direct.requested.sources).toEqual([fixture.expected]);
      expect(direct.results.map(({ source }) => source)).toEqual([fixture.expected]);
      expect(direct.results.map(({ action }) => action)).toEqual(['refused']);
      expect(directOptions.sources[0], `${fixture.id}: report source mutation`).toBe(fixture.input);

      const refOptions = Object.freeze({
        sources: Object.freeze(['owner/repo']),
        ref: fixture.input,
        cwd: '/fixture/work',
        configuration,
      });
      const override = unwrap(
        await api.runInstall(inertEnv, refOptions),
        `${fixture.id}: override fail-fast report`,
      );
      expect(JSON.stringify(override), fixture.id).not.toContain(canary);
      expect(override.requested.sources).toEqual(['github.com/owner/repo']);
      expect(override.requested.ref).toBe(fixture.expected);
      expect(override.results.map(({ action }) => action)).toEqual(['refused']);
      expect(refOptions.ref, `${fixture.id}: report ref mutation`).toBe(fixture.input);
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

  test('EWP-P2-TS07 fails closed on hostile trusted-transport return shapes', async () => {
    const core = await loadModule(CORE_MODULE);
    const api = requireFunctions<{
      runInstall(
        env: unknown,
        options: Readonly<Record<string, unknown>>,
        deps: Readonly<Record<string, unknown>>,
      ): Promise<
        Result<{
          readonly results: readonly { readonly action: string; readonly reason: string | null }[];
        }>
      >;
    }>(core, ['runInstall'], 'current install transport safety authority');
    const remoteModule = await import('../../../packages/core/tests/fixtures/acquire/remote.ts');
    const fleetModule = await import('../../../packages/core/tests/fixtures/place/fleet.ts');
    const remote = await remoteModule.buildRemoteFixture();
    const fleet = await fleetModule.buildFixtureFleet();
    const canary = 'ghp_P17_SECRET_CANARY_123456789';
    let getterReads = 0;
    let proxyReads = 0;
    let transaction = 0;
    const fetchValue: Record<string, unknown> = {};
    Object.defineProperty(fetchValue, 'sha', {
      enumerable: true,
      get: () => {
        getterReads++;
        return canary;
      },
    });
    const candidate: Record<string, unknown> = { name: 'review' };
    Object.defineProperty(candidate, 'path', {
      enumerable: true,
      get: () => {
        getterReads++;
        return `skills/${canary}`;
      },
    });
    const hostileEnvelope = new Proxy(
      { ok: true, value: { sha: canary } },
      {
        ownKeys: () => {
          proxyReads++;
          return ['ok', 'value'];
        },
      },
    );
    const cases: readonly Readonly<Record<string, unknown>>[] = [
      { fetchRepo: async () => ({ ok: true, value: fetchValue }) },
      { fetchRepo: async () => hostileEnvelope },
      {
        listSkills: async () => ({
          ok: true,
          value: { candidates: [candidate], scanned: 1 },
        }),
      },
      {
        listSkills: async () => ({
          ok: true,
          value: { candidates: [], scanned: `access_token=${canary}` },
        }),
      },
    ];
    try {
      for (const transportCase of cases) {
        const result = unwrap(
          await api.runInstall(
            fleet.env,
            {
              sources: [`${remote.multiSource}//plugins/fh/skills/factor-scan`],
              tools: ['claude-code'],
              scope: 'user',
              noVerify: true,
              cwd: fleet.base,
              configuration: fleet.configuration,
            },
            {
              detect: async () => ({
                ok: true,
                value: [
                  {
                    path: '/usr/local/bin/claude-code',
                    version: '1.0.0',
                    installMethod: 'unknown',
                  },
                ],
              }),
              verify: async () => {
                throw new Error('verification must not run under noVerify');
              },
              transport: { ...remote.transport, ...transportCase },
              now: () => '2026-07-13T00:00:00Z',
              newTxId: () => (0x70000000 + transaction++).toString(16).slice(-8),
            },
          ),
          'hostile transport result',
        );
        expect(result.results[0]?.action).toBe('failed');
        expect(JSON.stringify(result)).not.toContain(canary);
      }
      expect(getterReads).toBe(0);
      expect(proxyReads).toBe(0);
    } finally {
      await fleetModule.destroyFixtureFleet(fleet);
      await remoteModule.destroyRemoteFixture(remote);
    }
  });

  test('EWP-P2-TS07 sanitizes every public acquisition error path without changing successes', async () => {
    const core = await loadModule(CORE_MODULE);
    const api = requireFunctions<{
      runInstall(
        env: unknown,
        options: Readonly<Record<string, unknown>>,
        deps: Readonly<Record<string, unknown>>,
      ): Promise<
        Result<{
          readonly results: {
            readonly action: string;
            readonly reason: string | null;
          }[];
        }>
      >;
      runUninstall(
        env: unknown,
        options: Readonly<Record<string, unknown>>,
        deps?: Readonly<Record<string, unknown>>,
      ): Promise<Result<unknown>>;
    }>(core, ['runInstall', 'runUninstall'], 'G2-03 public acquisition error authority');
    const remoteModule = await import('../../../packages/core/tests/fixtures/acquire/remote.ts');
    const fleetModule = await import('../../../packages/core/tests/fixtures/place/fleet.ts');
    const ledgerModule = await import('../../../packages/core/src/place/ledger.ts');
    const pathsModule = await import('../../../packages/core/src/place/paths.ts');
    const remote = await remoteModule.buildRemoteFixture();
    const fleet = await fleetModule.buildFixtureFleet();
    const canary = 'ghp_P17_PUBLIC_BOUNDARY_123456789';
    const source = `${remote.multiSource}//plugins/fh/skills/factor-scan`;
    const baseInstallOptions = {
      sources: [source],
      tools: ['claude-code'],
      scope: 'user',
      cwd: fleet.base,
      configuration: fleet.configuration,
    } as const;
    const uninstallOptions = {
      targets: ['not-installed'],
      tools: ['claude-code'],
      cwd: fleet.base,
      configuration: fleet.configuration,
    } as const;
    let transaction = 0;
    const makeDeps = (
      overrides: Readonly<Record<string, unknown>> = {},
    ): Readonly<Record<string, unknown>> => ({
      detect: async () => ({
        ok: true,
        value: [
          {
            path: '/usr/local/bin/claude-code',
            version: '1.0.0',
            installMethod: 'unknown',
          },
        ],
      }),
      verify: async () => {
        throw new Error('verification must be explicitly supplied or skipped');
      },
      transport: remote.transport,
      now: () => '2026-07-13T00:00:00Z',
      newTxId: () => (0x72000000 + transaction++).toString(16).slice(-8),
      ...overrides,
    });
    const expectFailure = (
      result: Result<unknown>,
      code: string,
      label: string,
      marker: string,
    ): void => {
      expect(result.ok, label).toBeFalse();
      expect(JSON.stringify(result), label).not.toContain(canary);
      expect(JSON.stringify(result), label).toContain(marker);
      if (result.ok) throw new Error(`${label}: expected failure`);
      expect(result.error.code, label).toBe(code);
    };

    try {
      let detectorGetterReads = 0;
      const rejectedDetector: Record<string, unknown> = { code: 'permission-denied' };
      const detectorMessage = (): string => {
        detectorGetterReads++;
        return `password=${canary}`;
      };
      Object.defineProperty(rejectedDetector, 'message', {
        enumerable: true,
        get: detectorMessage,
      });
      const detectorFailure = await api.runInstall(
        fleet.env,
        { ...baseInstallOptions, noVerify: true },
        makeDeps({
          detect: async () => {
            throw rejectedDetector;
          },
        }),
      );
      expectFailure(detectorFailure, 'permission-denied', 'rejected detector', '[ACCESSOR]');
      expect(detectorGetterReads).toBe(0);
      expect(Object.getOwnPropertyDescriptor(rejectedDetector, 'message')?.get).toBe(
        detectorMessage,
      );

      let verifierGetterReads = 0;
      let verifierProxyReads = 0;
      let promiseAssimilationReads = 0;
      const accessorEnvelope: Record<string, unknown> = {};
      const okGetter = (): boolean => {
        verifierGetterReads++;
        return false;
      };
      const errorGetter = (): Readonly<Record<string, unknown>> => {
        verifierGetterReads++;
        return { code: 'source-unresolvable', message: `password=${canary}` };
      };
      Object.defineProperties(accessorEnvelope, {
        ok: { enumerable: true, get: okGetter },
        error: { enumerable: true, get: errorGetter },
      });
      const proxyEnvelopeTarget = {
        ok: false,
        error: { code: 'source-unresolvable', message: `password=${canary}` },
      };
      const proxyEnvelope = new Proxy(proxyEnvelopeTarget, {
        get: (target, key, receiver) => {
          if (key === 'then') {
            promiseAssimilationReads++;
            return Reflect.get(target, key, receiver);
          }
          verifierProxyReads++;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          verifierProxyReads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        ownKeys: (target) => {
          verifierProxyReads++;
          return Reflect.ownKeys(target);
        },
      });
      for (const [label, envelope] of [
        ['verifier accessor envelope', accessorEnvelope],
        ['verifier proxy envelope', proxyEnvelope],
      ] as const) {
        const result = unwrap(
          await api.runInstall(
            fleet.env,
            baseInstallOptions,
            makeDeps({ verify: async () => envelope }),
          ),
          label,
        );
        expect(result.results[0]?.action, label).toBe('failed');
        expect(result.results[0]?.reason, label).toContain('operation failed');
        expect(JSON.stringify(result), label).not.toContain(canary);
      }
      expect(verifierGetterReads).toBe(0);
      expect(verifierProxyReads).toBe(0);
      expect(promiseAssimilationReads).toBeGreaterThan(0);
      expect(Object.getOwnPropertyDescriptor(accessorEnvelope, 'ok')?.get).toBe(okGetter);
      expect(Object.getOwnPropertyDescriptor(accessorEnvelope, 'error')?.get).toBe(errorGetter);
      expect(proxyEnvelopeTarget.error.message).toContain(canary);

      let throwableTrapReads = 0;
      const hostileTarget = { code: 'EIO', message: `password=${canary}` };
      const hostileThrowable = new Proxy(hostileTarget, {
        get: () => {
          throwableTrapReads++;
          throw new Error('get trap fired');
        },
        getOwnPropertyDescriptor: () => {
          throwableTrapReads++;
          throw new Error('descriptor trap fired');
        },
        getPrototypeOf: () => {
          throwableTrapReads++;
          throw new Error('prototype trap fired');
        },
        has: () => {
          throwableTrapReads++;
          throw new Error('has trap fired');
        },
        ownKeys: () => {
          throwableTrapReads++;
          throw new Error('ownKeys trap fired');
        },
      });
      const ledgerPath = pathsModule.ledgerPathOf(fleet.data);
      const ledgerFailureEnv = {
        ...fleet.env,
        pathKind: async (path: string) => (path === ledgerPath ? 'file' : fleet.env.pathKind(path)),
        readBytes: async (path: string) => {
          if (path === ledgerPath) throw hostileThrowable;
          return fleet.env.readBytes(path);
        },
      };
      const outerLockFailureEnv = {
        ...fleet.env,
        withFileLock: async () => {
          throw hostileThrowable;
        },
      };
      const ledgerAndLockCases: readonly [string, Result<unknown>, string][] = [
        [
          'install dry ledger',
          await api.runInstall(
            ledgerFailureEnv,
            { ...baseInstallOptions, noVerify: true, dryRun: true },
            makeDeps(),
          ),
          'ledger-error',
        ],
        [
          'install locked ledger',
          await api.runInstall(
            ledgerFailureEnv,
            { ...baseInstallOptions, noVerify: true },
            makeDeps(),
          ),
          'ledger-error',
        ],
        [
          'install outer lock',
          await api.runInstall(
            outerLockFailureEnv,
            { ...baseInstallOptions, noVerify: true },
            makeDeps(),
          ),
          'flip-failed',
        ],
        [
          'uninstall dry ledger',
          await api.runUninstall(ledgerFailureEnv, { ...uninstallOptions, dryRun: true }),
          'ledger-error',
        ],
        [
          'uninstall locked ledger',
          await api.runUninstall(ledgerFailureEnv, uninstallOptions),
          'ledger-error',
        ],
        [
          'uninstall outer lock',
          await api.runUninstall(outerLockFailureEnv, uninstallOptions),
          'flip-failed',
        ],
      ];
      for (const [label, result, code] of ledgerAndLockCases) {
        expectFailure(result, code, label, '[PROXY]');
      }
      expect(throwableTrapReads).toBe(0);
      expect(hostileTarget.message).toContain(canary);

      let foreignGetterReads = 0;
      let foreignLockCalls = 0;
      const foreignError: Record<string, unknown> = { code: 'permission-denied' };
      const foreignMessage = (): string => {
        foreignGetterReads++;
        return `password=${canary}`;
      };
      Object.defineProperty(foreignError, 'message', {
        enumerable: true,
        get: foreignMessage,
      });
      const foreignNestedResult = { ok: false, error: foreignError };
      const foreignLockEnv = {
        ...fleet.env,
        withFileLock: async (_path: string, _callback: () => Promise<unknown>) => {
          foreignLockCalls++;
          return foreignNestedResult;
        },
      };
      const foreign = await api.runInstall(
        foreignLockEnv,
        { ...baseInstallOptions, noVerify: true },
        makeDeps(),
      );
      expect(foreign).toEqual({
        ok: false,
        error: { code: 'generic', message: 'operation failed' },
      });
      expect(JSON.stringify(foreign)).not.toContain(canary);
      expect(foreignLockCalls).toBe(1);
      expect(foreignGetterReads).toBe(0);
      expect(Object.getOwnPropertyDescriptor(foreignError, 'message')?.get).toBe(foreignMessage);

      const success = unwrap(
        await api.runInstall(fleet.env, { ...baseInstallOptions, noVerify: true }, makeDeps()),
        'locked install success',
      );
      expect(Object.getPrototypeOf(success)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(success.results)).toBe(Array.prototype);
      expect(Object.isFrozen(success)).toBeFalse();
      expect(Object.isFrozen(success.results)).toBeFalse();
      const first = success.results[0];
      if (first === undefined) throw new Error('locked install success: missing result');
      const resultCount = success.results.length;
      success.results.push(first);
      expect(success.results).toHaveLength(resultCount + 1);
      success.results.pop();

      const ledgerResult = await ledgerModule.readLedgerState(fleet.env, ledgerPath);
      if (!ledgerResult.ok) throw new Error(JSON.stringify(ledgerResult.error));
      if (ledgerResult.value.state !== 'present') {
        throw new Error('committed sweep: expected present canonical ledger');
      }
      const pair = ledgerModule.getLedgerPairAt(
        ledgerResult.value.model,
        null,
        'factor-scan',
        'claude-code',
      );
      if (!pair?.pinned) throw new Error('committed sweep: expected seeded pinned pair');
      const backupPath = join(
        fleet.home,
        '.claude',
        'skills',
        '.skillsmith-backup-factor-scan-deadbeef',
      );
      const seededLedger = ledgerModule.withLedgerPairAt(
        ledgerResult.value.model,
        null,
        'factor-scan',
        'claude-code',
        {
          ...pair,
          journal: {
            op: 'install',
            txId: 'deadbeef',
            phase: 'committed',
            startedAt: '2026-07-13T00:00:00Z',
            completedAt: '2026-07-13T00:00:00Z',
            before: {
              mode: 'pinned',
              storePath: pair.pinned.storePath,
              contentHash: pair.pinned.contentHash,
              liveKind: 'symlink',
            },
            stagingPath: join(
              fleet.home,
              '.claude',
              'skills',
              '.skillsmith-staging-factor-scan-deadbeef',
            ),
            backupPath,
          },
        },
      );
      if (!seededLedger.ok) throw new Error(JSON.stringify(seededLedger.error));
      const persisted = await ledgerModule.writeLedger(fleet.env, ledgerPath, seededLedger.value);
      if (!persisted.ok) throw new Error(JSON.stringify(persisted.error));
      const sweepFailureEnv = {
        ...fleet.env,
        pathKind: async (path: string) => {
          if (path === backupPath) throw hostileThrowable;
          return fleet.env.pathKind(path);
        },
      };
      const sweep = await api.runInstall(
        sweepFailureEnv,
        { ...baseInstallOptions, noVerify: true },
        makeDeps(),
      );
      expectFailure(sweep, 'flip-failed', 'committed non-ledger sweep', '[PROXY]');
      expect(throwableTrapReads).toBe(0);
      expect(hostileTarget.message).toContain(canary);
    } finally {
      await fleetModule.destroyFixtureFleet(fleet);
      await remoteModule.destroyRemoteFixture(remote);
    }
  }, 30_000);

  test('EWP-P2-TS07 executes candidate, backup, and recovery identity sink guards', async () => {
    const coordinator = await import('../../../packages/core/src/artifacts/coordinator.ts');
    const nodeCoordinator = await import(
      '../../../packages/core/src/artifacts/node-coordinator.ts'
    );
    const recovery = await import('../../../packages/core/src/artifacts/recovery-file.ts');
    const resultModule = await import('../../../packages/core/src/result.ts');
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-ts07-sinks-'));
    const canary = 'sk-P17_SECRET_CANARY_123456789';
    try {
      const ports = await nodeCoordinator.createTestNodeArtifactCoordinatorPorts(
        join(root, 'coordination'),
      );
      const candidatePath = join(root, 'candidate.toml');
      const candidate = await coordinator.updateCoordinatedHumanFile(ports, {
        path: candidatePath,
        edit: () =>
          resultModule.ok({
            bytes: new TextEncoder().encode(`access_token = "${canary}"\n`),
            changed: true,
            mode: 0o600,
          }),
      });
      expect(candidate).toMatchObject({ ok: false, error: { reason: 'unsafe-human-edit' } });
      expect(JSON.stringify(candidate)).not.toContain(canary);
      expect((await ports.observe(candidatePath)).kind).toBe('absent');

      const backupPath = join(root, 'backup.toml');
      await writeFile(backupPath, `access_token = "${canary}"\n`);
      const backup = await coordinator.updateCoordinatedHumanFile(ports, {
        path: backupPath,
        edit: () =>
          resultModule.ok({
            bytes: new TextEncoder().encode('schema_version = 1\n'),
            changed: true,
            mode: 0o600,
          }),
      });
      expect(backup).toMatchObject({ ok: false, error: { reason: 'unsafe-human-edit' } });
      expect(JSON.stringify(backup)).not.toContain(canary);

      const manifest = join(root, 'manifest.toml');
      const recoveryPort = recovery.createFileArtifactRecoveryPort(join(root, 'records'), {
        nextCasId: () => '0000000000000001',
      });
      const transactionId = '0000000000000001';
      const digest = `sha256:${'0'.repeat(64)}`;
      const transactionDirectory = {
        purpose: 'transaction',
        path: join(root, `.skillsmith-artifact-${transactionId}`),
        before: 'absent',
        ownershipToken: 'a'.repeat(64),
        identity: null,
      } as const;
      const stageObject = {
        role: 'manifest',
        slot: 'stage',
        path: join(transactionDirectory.path, 'manifest.stage'),
        expectedDigest: digest,
        expectedMode: 0o600,
        identity: null,
      } as const;
      const baseRecord = {
        kind: 'skillsmith-artifact-pair-recovery',
        version: 1,
        key: recovery.artifactRecoveryKey(manifest, null),
        transactionId,
        attempt: 1,
        disposition: 'forward',
        pair: { manifest, lock: null },
        memberTargets: [manifest],
        cursor: 'prepared',
        parents: { manifest: { path: root, identity: 'parent-1' }, lock: null },
        before: { manifest: { state: 'absent' }, lock: null },
        after: {
          manifest: { state: 'file', digest, mode: 0o600, identity: null },
          lock: null,
        },
        rollbackTarget: { manifest: { state: 'absent' }, lock: null },
        directories: [transactionDirectory],
        objects: [stageObject],
        collisionPaths: [join(root, '.skillsmith-artifact-deadbeefdeadbeef')],
      } as const;

      const created = await recoveryPort.create(baseRecord as never);
      expect(created.record).toEqual(baseRecord);
      expect(await recoveryPort.discover()).toEqual([created]);
      await recoveryPort.remove(created.record.key, created.revision);
      expect(await recoveryPort.discover()).toEqual([]);

      const sensitiveIdentity = `access_token=${canary}`;
      const hostileRecords = [
        [
          'parent identity',
          {
            ...baseRecord,
            parents: {
              ...baseRecord.parents,
              manifest: { ...baseRecord.parents.manifest, identity: sensitiveIdentity },
            },
          },
        ],
        [
          'recorded after identity',
          {
            ...baseRecord,
            after: {
              ...baseRecord.after,
              manifest: { ...baseRecord.after.manifest, identity: sensitiveIdentity },
            },
          },
        ],
        [
          'transaction directory identity',
          {
            ...baseRecord,
            directories: [{ ...transactionDirectory, identity: sensitiveIdentity }],
          },
        ],
        [
          'stage object identity',
          {
            ...baseRecord,
            objects: [{ ...stageObject, identity: sensitiveIdentity }],
          },
        ],
      ] as const;
      for (const [field, record] of hostileRecords) {
        let caught: unknown;
        try {
          await recoveryPort.create(record as never);
        } catch (error) {
          caught = error;
        }
        expect(caught, field).toMatchObject({ reason: 'recovery-record-invalid' });
        expect(JSON.stringify(caught), field).not.toContain(canary);
      }
      expect(await recoveryPort.discover()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
