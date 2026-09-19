import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dir, '../../..');
const FIXTURES = join(import.meta.dir, '../fixtures/p2-ts05');
const INIT_PATH = join(ROOT, 'packages/core/src/artifacts/init.ts');
const MIGRATION_PATH = join(ROOT, 'packages/core/src/artifacts/legacy-migration.ts');
const HUMAN_TOML_PATH = join(ROOT, 'packages/core/src/artifacts/human-toml.ts');
const ARTIFACTS_PATH = join(ROOT, 'packages/core/src/artifacts/index.ts');
const CORE_PATH = join(ROOT, 'packages/core/src/index.ts');
const encoder = new TextEncoder();

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };

interface SkeletonCase {
  readonly id: string;
  readonly skeleton: Readonly<Record<string, unknown>>;
  readonly expected: string;
  readonly semanticJson?: string;
  readonly byteHash: string;
  readonly semanticHash: string;
}

interface MigrationCase {
  readonly id: string;
  readonly before: string;
  readonly after: string;
  readonly semanticJson?: string;
  readonly byteHash: string;
  readonly semanticHash: string;
}

interface MatrixCase {
  readonly id: string;
  readonly skeletonId: string;
  readonly current?: string | null;
  readonly currentMigrationId?: string;
  readonly currentUnsafeId?: string;
  readonly requireMatch: readonly string[];
  readonly force: boolean;
  readonly expected: Readonly<{
    readonly kind?: string;
    readonly reason?: string;
    readonly exitCode?: number;
    readonly shape?: string;
  }>;
}

interface InitFixture {
  readonly schemaVersion: number;
  readonly fixtureCanary: string;
  readonly skeletonCases: readonly SkeletonCase[];
  readonly requestRefusals: readonly Readonly<{ id: string; field: string }>[];
  readonly migrationCases: readonly MigrationCase[];
  readonly unsafeLegacyCases: readonly Readonly<{
    id: string;
    source: string;
    reason: 'invalid-input' | 'unsafe-range' | 'unsafe-content';
  }>[];
  readonly matrixCases: readonly MatrixCase[];
}

interface SignedManifestApi {
  classifyManifestSource(source: string): string;
  hashManifestBytes(source: string | Uint8Array): string;
  hashManifestSemantics(manifest: unknown): string;
  readManifestSource(source: string): Result<unknown>;
  normalizeManifestDocument(document: unknown): Result<Readonly<Record<string, unknown>>>;
}

interface InitApi {
  readonly INIT_MANIFEST_OPERATION_KINDS: readonly string[];
  planInitManifest(input: unknown): Result<Readonly<Record<string, unknown>>>;
}

interface MigrationApi {
  migrateLegacyManifestBytes(bytes: Uint8Array): Result<Readonly<Record<string, unknown>>>;
}

interface HumanTomlApi {
  scanHumanToml(bytes: Uint8Array): Result<Readonly<Record<string, unknown>>>;
}

const fixtureSource = readFileSync(join(FIXTURES, 'init-cases.json'), 'utf8');
const fixture = JSON.parse(fixtureSource) as InitFixture;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const digest = (domain: string, source: string): string =>
  `sha256:${createHash('sha256')
    .update(`skillsmith:${domain}:v1`)
    .update(Uint8Array.of(0))
    .update(source, 'utf8')
    .digest('hex')}`;

const unwrap = <T>(result: Result<T>, label: string): T => {
  expect(result.ok, result.ok ? label : `${label}: ${JSON.stringify(result.error)}`).toBeTrue();
  if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.value;
};

const recursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) recursivelyFrozen(descriptor.value, seen);
  }
};

const containsArrayBufferView = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  if (ArrayBuffer.isView(value)) return true;
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => 'value' in descriptor && containsArrayBufferView(descriptor.value, seen),
  );
};

const importPath = async (
  path: string,
): Promise<
  | { readonly api: Readonly<Record<string, unknown>>; readonly reason: null }
  | { readonly api: null; readonly reason: 'module-not-present' | 'module-load-failed' }
> => {
  if (!existsSync(path)) return { api: null, reason: 'module-not-present' };
  try {
    const specifier = pathToFileURL(path).href;
    return { api: (await import(specifier)) as Readonly<Record<string, unknown>>, reason: null };
  } catch {
    return { api: null, reason: 'module-load-failed' };
  }
};

const makeRequest = (
  skeleton: Readonly<Record<string, unknown>>,
  currentSource: string | null,
  requireMatch: readonly string[],
  force: boolean,
): Readonly<Record<string, unknown>> => ({
  skeleton,
  current:
    currentSource === null
      ? { state: 'absent' }
      : { state: 'present', bytes: encoder.encode(currentSource) },
  legacyIntent: { requireMatch },
  force,
});

const requestRefusalInput = (id: string): unknown => {
  const base = makeRequest({}, null, [], false);
  switch (id) {
    case 'missing-legacy-intent': {
      const { legacyIntent: _, ...input } = base;
      return input;
    }
    case 'missing-force': {
      const { force: _, ...input } = base;
      return input;
    }
    case 'present-undefined-defaults':
      return { ...base, skeleton: { defaults: undefined } };
    case 'duplicate-tools':
      return { ...base, skeleton: { defaults: { tools: ['codex', 'codex'] } } };
    case 'unknown-tool':
      return { ...base, skeleton: { defaults: { tools: ['not-a-tool'] } } };
    case 'path-without-scope':
      return { ...base, skeleton: { defaults: { path: './skills' } } };
    case 'nonportable-path':
      return { ...base, skeleton: { defaults: { scope: 'project', path: 'skills' } } };
    case 'legacy-registry-url':
      return { ...base, skeleton: { registry: { default: 'https://github.com/acme' } } };
    case 'duplicate-intent':
      return {
        ...base,
        skeleton: { defaults: { scope: 'project' } },
        legacyIntent: { requireMatch: ['defaults.scope', 'defaults.scope'] },
      };
    case 'out-of-order-intent':
      return {
        ...base,
        skeleton: { defaults: { tools: ['codex'], scope: 'project' } },
        legacyIntent: { requireMatch: ['defaults.scope', 'defaults.tools'] },
      };
    case 'intent-field-absent':
      return { ...base, legacyIntent: { requireMatch: ['defaults.scope'] } };
    case 'shared-buffer': {
      const bytes = new Uint8Array(new SharedArrayBuffer(16));
      return { ...base, current: { state: 'present', bytes } };
    }
    case 'shadowed-buffer': {
      const bytes = encoder.encode('version = 1\n');
      Object.defineProperty(bytes, 'buffer', { value: new ArrayBuffer(0) });
      return { ...base, current: { state: 'present', bytes } };
    }
    default:
      throw new Error(`unknown refusal fixture ${id}`);
  }
};

const requireAuthority = async (
  path: string,
  callable: string,
  family: string,
): Promise<Readonly<Record<string, unknown>> | null> => {
  const loaded = await importPath(path);
  const available = loaded.api !== null && typeof loaded.api[callable] === 'function';
  expect(
    available,
    `missing G2-04 ${family} authority (${loaded.reason ?? `missing ${callable} export`})`,
  ).toBeTrue();
  return available ? loaded.api : null;
};

describe('EWP-P2-TS05', () => {
  test('EWP-P2-TS05 fixtures and signed reader/hash guards pass before new authority', async () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.fixtureCanary).toBe('p2-ts05-init-contract-canary');
    expect(fixture.skeletonCases).toHaveLength(6);
    expect(fixture.requestRefusals).toHaveLength(13);
    expect(fixture.migrationCases).toHaveLength(5);
    expect(fixture.unsafeLegacyCases).toHaveLength(5);
    expect(fixture.matrixCases).toHaveLength(24);
    expect(fixtureSource).not.toContain('P17_SECRET_CANARY');
    for (const family of [
      fixture.skeletonCases,
      fixture.requestRefusals,
      fixture.migrationCases,
      fixture.unsafeLegacyCases,
      fixture.matrixCases,
    ]) {
      expect(unique(family.map(({ id }) => id))).toBeTrue();
      expect(family.every(({ id }) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))).toBeTrue();
    }

    expect(fixture.skeletonCases.map(({ id }) => id)).toEqual([
      'empty',
      'empty-defaults',
      'tools-only-sorted',
      'defaults-only',
      'registry-only',
      'complete',
    ]);
    expect(fixture.skeletonCases[0]?.expected).toBe('version = 1\n');
    expect(fixture.skeletonCases[1]?.expected).toBe(fixture.skeletonCases[0]?.expected);
    expect(fixture.skeletonCases.at(-1)?.expected).toBe(
      'version = 1\n\n[defaults]\ntools = ["claude-code", "codex"]\nscope = "project"\npath = "./skills"\n\n[registry]\ndefault = "github.com/acme"\n',
    );
    expect(new Set(fixture.migrationCases.map(({ id }) => id))).toEqual(
      new Set([
        'lf-heading-attached-comments',
        'crlf-quoted-keys-spacing',
        'crlf-quoted-tool-key',
        'no-final-newline',
        'registry-only',
      ]),
    );
    expect(
      fixture.migrationCases.find(({ id }) => id === 'no-final-newline')?.after.endsWith('\n'),
    ).toBeFalse();
    expect(
      fixture.migrationCases.find(({ id }) => id === 'crlf-quoted-keys-spacing')?.after,
    ).toContain('\'tools\' = ["codex"]\r\n');
    for (const item of fixture.skeletonCases) {
      expect(item.expected).not.toContain('\r');
      expect(item.expected.endsWith('\n')).toBeTrue();
      expect(item.expected.endsWith('\n\n')).toBeFalse();
    }
    for (const item of fixture.migrationCases.filter(({ id }) => id.startsWith('crlf-'))) {
      expect(item.after).toContain('\r\n');
      expect(item.after.replaceAll('\r\n', '')).not.toContain('\r');
    }

    const artifactsLoad = await importPath(ARTIFACTS_PATH);
    expect(artifactsLoad.reason).toBeNull();
    if (artifactsLoad.api === null) throw new Error('signed artifacts module unavailable');
    const signedNames = [
      'classifyManifestSource',
      'hashManifestBytes',
      'hashManifestSemantics',
      'readManifestSource',
      'normalizeManifestDocument',
    ];
    expect(signedNames.filter((name) => typeof artifactsLoad.api?.[name] !== 'function')).toEqual(
      [],
    );
    const signed = artifactsLoad.api as unknown as SignedManifestApi;

    for (const item of [...fixture.skeletonCases, ...fixture.migrationCases]) {
      const source = 'expected' in item ? item.expected : item.after;
      expect(source.includes('\r') ? source.includes('\r\n') : !source.includes('\r')).toBeTrue();
      expect(digest('manifest-bytes', source), item.id).toBe(item.byteHash);
      expect(signed.hashManifestBytes(source), item.id).toBe(item.byteHash);
      const document = unwrap(signed.readManifestSource(source), item.id);
      const manifest = unwrap(signed.normalizeManifestDocument(document), item.id);
      expect(manifest.version, item.id).toBe(1);
      expect(manifest.skills, item.id).toEqual([]);
      expect(signed.hashManifestSemantics(manifest), item.id).toBe(item.semanticHash);
      if (item.semanticJson !== undefined) {
        expect(JSON.stringify(manifest), item.id).toBe(item.semanticJson);
        expect(digest('manifest-semantic', item.semanticJson), item.id).toBe(item.semanticHash);
      }
    }
  });

  test('EWP-P2-TS05 skeleton validation and canonical construction family', async () => {
    const loaded = await requireAuthority(INIT_PATH, 'planInitManifest', 'skeleton');
    if (loaded === null) return;
    const api = loaded as unknown as InitApi;
    const signedLoad = await importPath(ARTIFACTS_PATH);
    expect(signedLoad.api).not.toBeNull();
    if (signedLoad.api === null) return;
    const signed = signedLoad.api as unknown as SignedManifestApi;
    for (const item of fixture.skeletonCases) {
      const operation = unwrap(
        api.planInitManifest(makeRequest(item.skeleton, null, [], false)),
        item.id,
      );
      expect(operation.kind, item.id).toBe('create-manifest');
      expect(operation.before, item.id).toBeNull();
      const after = operation.after as Readonly<Record<string, unknown>>;
      expect(after.source, item.id).toBe(item.expected);
      expect(after.byteHash, item.id).toBe(item.byteHash);
      expect(after.semanticHash, item.id).toBe(item.semanticHash);
      const document = unwrap(signed.readManifestSource(after.source as string), item.id);
      const normalized = unwrap(signed.normalizeManifestDocument(document), item.id);
      expect(normalized.skills, item.id).toEqual([]);
      expect(signed.hashManifestSemantics(normalized), item.id).toBe(item.semanticHash);
    }
    for (const item of fixture.requestRefusals) {
      const result = api.planInitManifest(requestRefusalInput(item.id));
      expect(result.ok, item.id).toBeFalse();
      if (!result.ok) expect(result.error.field, item.id).toBe(item.field);
    }
  });

  test('EWP-P2-TS05 exact lossless legacy migration family', async () => {
    const loaded = await requireAuthority(
      MIGRATION_PATH,
      'migrateLegacyManifestBytes',
      'migration',
    );
    if (loaded === null) return;
    const api = loaded as unknown as MigrationApi;
    const signedLoad = await importPath(ARTIFACTS_PATH);
    expect(signedLoad.api).not.toBeNull();
    if (signedLoad.api === null) return;
    const signed = signedLoad.api as unknown as SignedManifestApi;
    for (const item of fixture.migrationCases) {
      const input = encoder.encode(item.before);
      const snapshot = new Uint8Array(input);
      const migrated = unwrap(api.migrateLegacyManifestBytes(input), item.id);
      expect(input, item.id).toEqual(snapshot);
      expect(migrated.source, item.id).toBe(item.after);
      expect(migrated.beforeSemanticHash, item.id).toBe(item.semanticHash);
      expect(migrated.afterSemanticHash, item.id).toBe(item.semanticHash);
      expect(signed.hashManifestBytes(migrated.source as string), item.id).toBe(item.byteHash);
      const document = unwrap(signed.readManifestSource(migrated.source as string), item.id);
      expect(
        signed.hashManifestSemantics(unwrap(signed.normalizeManifestDocument(document), item.id)),
        item.id,
      ).toBe(item.semanticHash);
    }
    for (const item of fixture.unsafeLegacyCases) {
      const result = api.migrateLegacyManifestBytes(encoder.encode(item.source));
      expect(result.ok, item.id).toBeFalse();
      if (!result.ok) expect(result.error.reason, item.id).toBe(item.reason);
    }
    for (const [id, before, after] of [
      ['empty-registry-final-newline', '[registry]\n', 'version = 1\n\n[registry]\n'],
      ['empty-registry-no-final-newline', '[registry]', 'version = 1\n\n[registry]'],
    ] as const) {
      expect(unwrap(api.migrateLegacyManifestBytes(encoder.encode(before)), id).source, id).toBe(
        after,
      );
    }

    const forgedView = new Uint8ClampedArray(encoder.encode('tool = "codex"\n'));
    Object.setPrototypeOf(forgedView, Uint8Array.prototype);
    expect(api.migrateLegacyManifestBytes(forgedView as unknown as Uint8Array).ok).toBeFalse();
    const disguisedSharedBuffer = new SharedArrayBuffer(32);
    const disguisedShared = new Uint8Array(disguisedSharedBuffer);
    disguisedShared.set(encoder.encode('tool = "codex"\n'));
    Object.setPrototypeOf(disguisedSharedBuffer, ArrayBuffer.prototype);
    expect(api.migrateLegacyManifestBytes(disguisedShared).ok).toBeFalse();

    for (const bytes of [
      Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode('tool = "codex"\n')]),
      Uint8Array.from([0xff, 0xfe, 0xfd]),
    ]) {
      expect(api.migrateLegacyManifestBytes(bytes).ok).toBeFalse();
    }
  });

  test('EWP-P2-TS05 ordered classification force future and noop family', async () => {
    const loaded = await requireAuthority(ARTIFACTS_PATH, 'planInitManifest', 'classification');
    if (loaded === null) return;
    const api = loaded as unknown as InitApi;
    const skeletons = new Map(fixture.skeletonCases.map((item) => [item.id, item]));
    const migrations = new Map(fixture.migrationCases.map((item) => [item.id, item]));
    const unsafe = new Map(fixture.unsafeLegacyCases.map((item) => [item.id, item]));
    for (const item of fixture.matrixCases) {
      const skeleton = skeletons.get(item.skeletonId);
      expect(skeleton, item.id).toBeDefined();
      if (skeleton === undefined) continue;
      const source = item.currentMigrationId
        ? migrations.get(item.currentMigrationId)?.before
        : item.currentUnsafeId
          ? unsafe.get(item.currentUnsafeId)?.source
          : (item.current ?? null);
      expect(source, item.id).not.toBeUndefined();
      if (source === undefined) continue;
      const result = api.planInitManifest(
        makeRequest(skeleton.skeleton, source, item.requireMatch, item.force),
      );
      if (item.expected.kind !== undefined) {
        expect(unwrap(result, item.id).kind, item.id).toBe(item.expected.kind);
      } else {
        expect(result.ok, item.id).toBeFalse();
        if (!result.ok) {
          expect(result.error.reason, item.id).toBe(item.expected.reason);
          expect(result.error.exitCode, item.id).toBe(item.expected.exitCode);
          expect(result.error.shape, item.id).toBe(item.expected.shape);
        }
      }
    }

    const emptyRegistry = unwrap(
      api.planInitManifest(makeRequest({}, '[registry]\n', [], false)),
      'empty registry legacy migration',
    );
    expect(emptyRegistry.kind).toBe('migrate-project-config');
    expect((emptyRegistry.after as Readonly<Record<string, unknown>>).source).toBe(
      'version = 1\n\n[registry]\n',
    );
  });

  test('EWP-P2-TS05 immutable total hostile-input and safe-error family', async () => {
    const loaded = await requireAuthority(INIT_PATH, 'planInitManifest', 'safety');
    if (loaded === null) return;
    const api = loaded as unknown as InitApi;
    const scannerLoad = await requireAuthority(HUMAN_TOML_PATH, 'scanHumanToml', 'scanner safety');
    if (scannerLoad === null) return;
    const scanner = scannerLoad as unknown as HumanTomlApi;
    const valid = makeRequest({}, null, [], false);
    const first = unwrap(api.planInitManifest(valid), 'deterministic create');
    const second = unwrap(api.planInitManifest(valid), 'deterministic create repeat');
    expect(first).toEqual(second);
    recursivelyFrozen(first);
    expect(containsArrayBufferView(first)).toBeFalse();

    for (const item of fixture.requestRefusals) {
      const result = api.planInitManifest(requestRefusalInput(item.id));
      expect(result.ok, item.id).toBeFalse();
      if (!result.ok) {
        expect(result.error.reason, item.id).toBe('invalid-request');
        expect(JSON.stringify(result.error), item.id).not.toContain('P17_SECRET_CANARY');
        recursivelyFrozen(result.error);
      }
    }

    const completeProxy = new Proxy(valid, {
      ownKeys: () => {
        throw new Error('proxy ownKeys trap must not run');
      },
      get: () => {
        throw new Error('proxy get trap must not run');
      },
      getPrototypeOf: () => {
        throw new Error('proxy getPrototypeOf trap must not run');
      },
      getOwnPropertyDescriptor: () => {
        throw new Error('proxy descriptor trap must not run');
      },
    });
    expect(api.planInitManifest(completeProxy).ok).toBeFalse();
    const completeAccessor = { ...valid };
    Object.defineProperty(completeAccessor, 'force', {
      enumerable: true,
      get: () => {
        throw new Error('top-level accessor must not run');
      },
    });
    expect(api.planInitManifest(completeAccessor).ok).toBeFalse();

    const nestedProxy = {
      ...valid,
      skeleton: new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('nested proxy trap must not run');
          },
        },
      ),
    };
    expect(api.planInitManifest(nestedProxy).ok).toBeFalse();

    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(inherited, valid);
    const toolsWithHole = Array(1) as unknown[];
    const toolsWithExtra = ['codex'] as unknown[] & { extra?: boolean };
    toolsWithExtra.extra = true;
    const intentWithHole = Array(1) as unknown[];
    const intentWithExtra = [] as unknown[] & { extra?: boolean };
    intentWithExtra.extra = true;
    const nestedAccessor = { ...valid, skeleton: {} };
    Object.defineProperty(nestedAccessor.skeleton, 'defaults', {
      enumerable: true,
      get: () => {
        throw new Error('nested accessor must not run');
      },
    });
    for (const [id, hostile] of [
      ['symbol', { ...valid, [Symbol('extra')]: true }],
      ['inherited', inherited],
      ['exotic', new Date()],
      ['unknown', { ...valid, unknown: true }],
      ['nested-accessor', nestedAccessor],
      ['tools-hole', { ...valid, skeleton: { defaults: { tools: toolsWithHole } } }],
      ['tools-extra', { ...valid, skeleton: { defaults: { tools: toolsWithExtra } } }],
      ['intent-hole', { ...valid, legacyIntent: { requireMatch: intentWithHole } }],
      ['intent-extra', { ...valid, legacyIntent: { requireMatch: intentWithExtra } }],
    ] as const) {
      expect(api.planInitManifest(hostile).ok, id).toBeFalse();
    }

    const detachedBuffer = new ArrayBuffer(8);
    const detached = new Uint8Array(detachedBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    expect(
      api.planInitManifest({
        ...valid,
        current: { state: 'present', bytes: detached },
      }).ok,
    ).toBeFalse();
    expect(
      api.planInitManifest({
        ...valid,
        current: { state: 'present', bytes: new Uint8Array(new SharedArrayBuffer(8)) },
      }).ok,
    ).toBeFalse();

    const forgedView = new Uint8ClampedArray(encoder.encode('version = 1\n'));
    Object.setPrototypeOf(forgedView, Uint8Array.prototype);
    expect(scanner.scanHumanToml(forgedView as unknown as Uint8Array).ok).toBeFalse();
    expect(
      api.planInitManifest({
        ...valid,
        current: { state: 'present', bytes: forgedView as unknown as Uint8Array },
      }).ok,
    ).toBeFalse();

    const disguisedSharedBuffer = new SharedArrayBuffer(16);
    const disguisedShared = new Uint8Array(disguisedSharedBuffer);
    disguisedShared.set(encoder.encode('version = 1\n'));
    Object.setPrototypeOf(disguisedSharedBuffer, ArrayBuffer.prototype);
    expect(scanner.scanHumanToml(disguisedShared).ok).toBeFalse();
    expect(
      api.planInitManifest({
        ...valid,
        current: { state: 'present', bytes: disguisedShared },
      }).ok,
    ).toBeFalse();

    for (const shadow of ['buffer', 'iterator', 'constructor', 'species'] as const) {
      const bytes = encoder.encode('version = 1\n');
      if (shadow === 'buffer')
        Object.defineProperty(bytes, 'buffer', { value: new ArrayBuffer(0) });
      if (shadow === 'iterator') Object.defineProperty(bytes, Symbol.iterator, { value: () => [] });
      if (shadow === 'constructor')
        Object.defineProperty(bytes, 'constructor', { value: Uint8Array });
      if (shadow === 'species') Object.defineProperty(bytes, Symbol.species, { value: Uint8Array });
      expect(
        api.planInitManifest({ ...valid, current: { state: 'present', bytes } }).ok,
        shadow,
      ).toBeFalse();
    }

    const marker = ['P17', 'SECRET', 'CANARY'].join('_');
    const sensitive = api.planInitManifest(
      makeRequest(
        { defaults: { scope: 'project', path: `./ghp_${marker}_123456789` } },
        null,
        [],
        false,
      ),
    );
    expect(sensitive.ok).toBeFalse();
    if (!sensitive.ok) expect(JSON.stringify(sensitive.error)).not.toContain(marker);
  });

  test('EWP-P2-TS05 public identity static purity types and complete cross-family acceptance', async () => {
    const [directInit, migration, artifacts, core] = await Promise.all([
      importPath(INIT_PATH),
      importPath(MIGRATION_PATH),
      importPath(ARTIFACTS_PATH),
      importPath(CORE_PATH),
    ]);
    const missing = [
      directInit.api === null || typeof directInit.api.planInitManifest !== 'function'
        ? `direct init authority (${directInit.reason ?? 'missing export'})`
        : null,
      migration.api === null || typeof migration.api.migrateLegacyManifestBytes !== 'function'
        ? `internal migration authority (${migration.reason ?? 'missing export'})`
        : null,
      artifacts.api === null || typeof artifacts.api.planInitManifest !== 'function'
        ? `artifact public authority (${artifacts.reason ?? 'missing export'})`
        : null,
      core.api === null || typeof core.api.planInitManifest !== 'function'
        ? `root public authority (${core.reason ?? 'missing export'})`
        : null,
    ].filter((value): value is string => value !== null);
    expect(
      missing,
      'missing G2-04 init/migration/public authority after fixture and signed-reader guards passed',
    ).toEqual([]);
    if (
      directInit.api === null ||
      migration.api === null ||
      artifacts.api === null ||
      core.api === null
    ) {
      return;
    }

    const api = artifacts.api as unknown as InitApi & SignedManifestApi;
    const migrationApi = migration.api as unknown as MigrationApi;
    expect(api.planInitManifest).toBe(directInit.api.planInitManifest);
    expect(core.api.planInitManifest).toBe(api.planInitManifest);
    expect(api.INIT_MANIFEST_OPERATION_KINDS).toBe(directInit.api.INIT_MANIFEST_OPERATION_KINDS);
    expect(core.api.INIT_MANIFEST_OPERATION_KINDS).toBe(api.INIT_MANIFEST_OPERATION_KINDS);
    expect(api.INIT_MANIFEST_OPERATION_KINDS).toEqual([
      'create-manifest',
      'replace-manifest',
      'migrate-project-config',
      'noop',
    ]);
    expect(Object.isFrozen(api.INIT_MANIFEST_OPERATION_KINDS)).toBeTrue();
    expect(core.api.migrateLegacyManifestBytes).toBeUndefined();
    expect(artifacts.api.migrateLegacyManifestBytes).toBeUndefined();

    for (const item of fixture.skeletonCases) {
      const first = unwrap(
        api.planInitManifest(makeRequest(item.skeleton, null, [], false)),
        item.id,
      );
      const second = unwrap(
        api.planInitManifest(makeRequest(item.skeleton, null, [], false)),
        item.id,
      );
      expect(first.kind, item.id).toBe('create-manifest');
      expect(first.before, item.id).toBeNull();
      const after = first.after as Readonly<Record<string, unknown>>;
      expect(after.source, item.id).toBe(item.expected);
      expect(after.byteHash, item.id).toBe(item.byteHash);
      expect(after.semanticHash, item.id).toBe(item.semanticHash);
      expect(after.shape, item.id).toBe('canonical');
      expect(Object.keys(after).sort(), item.id).toEqual([
        'byteHash',
        'semanticHash',
        'shape',
        'source',
      ]);
      expect(containsArrayBufferView(first), item.id).toBeFalse();
      expect(first, item.id).toEqual(second);
      recursivelyFrozen(first);
    }

    for (const item of fixture.migrationCases) {
      const input = encoder.encode(item.before);
      const inputSnapshot = new Uint8Array(input);
      const migrated = unwrap(migrationApi.migrateLegacyManifestBytes(input), item.id);
      expect(input, item.id).toEqual(inputSnapshot);
      expect(migrated.source, item.id).toBe(item.after);
      expect(migrated.beforeSemanticHash, item.id).toBe(item.semanticHash);
      expect(migrated.afterSemanticHash, item.id).toBe(item.semanticHash);
      expect(api.hashManifestBytes(migrated.source as string), item.id).toBe(item.byteHash);
      recursivelyFrozen(migrated);
      const reread = unwrap(api.readManifestSource(migrated.source as string), item.id);
      expect(
        api.hashManifestSemantics(unwrap(api.normalizeManifestDocument(reread), item.id)),
      ).toBe(item.semanticHash);
    }
    for (const item of fixture.unsafeLegacyCases) {
      const result = migrationApi.migrateLegacyManifestBytes(encoder.encode(item.source));
      expect(result.ok, item.id).toBeFalse();
      if (!result.ok) {
        expect(result.error.code, item.id).toBe('legacy-manifest-migration');
        expect(result.error.reason, item.id).toBe(item.reason);
        expect(typeof result.error.message, item.id).toBe('string');
      }
    }
    for (const [id, bytes] of [
      ['bom', Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode('tool = "codex"\n')])],
      ['invalid-utf8', Uint8Array.from([0xff, 0xfe, 0xfd])],
    ] as const) {
      const result = migrationApi.migrateLegacyManifestBytes(bytes);
      expect(result.ok, id).toBeFalse();
      if (!result.ok) {
        expect(result.error.code, id).toBe('legacy-manifest-migration');
        expect(result.error.reason, id).toBe('invalid-input');
      }
    }

    const skeletons = new Map(fixture.skeletonCases.map((item) => [item.id, item]));
    const migrations = new Map(fixture.migrationCases.map((item) => [item.id, item]));
    const unsafe = new Map(fixture.unsafeLegacyCases.map((item) => [item.id, item]));
    for (const item of fixture.matrixCases) {
      const skeleton = skeletons.get(item.skeletonId);
      expect(skeleton, item.id).toBeDefined();
      if (skeleton === undefined) continue;
      const currentSource = item.currentMigrationId
        ? migrations.get(item.currentMigrationId)?.before
        : item.currentUnsafeId
          ? unsafe.get(item.currentUnsafeId)?.source
          : (item.current ?? null);
      expect(currentSource, `${item.id} fixture reference`).not.toBeUndefined();
      if (currentSource === undefined) continue;
      const result = api.planInitManifest(
        makeRequest(skeleton.skeleton, currentSource, item.requireMatch, item.force),
      );
      if (item.expected.kind !== undefined) {
        const operation = unwrap(result, item.id);
        expect(operation.kind, item.id).toBe(item.expected.kind);
        recursivelyFrozen(operation);
        expect(containsArrayBufferView(operation), item.id).toBeFalse();
        if (item.expected.kind === 'noop') expect(operation.after, item.id).toBeNull();
        if (item.expected.kind === 'create-manifest') expect(operation.before, item.id).toBeNull();
        if (operation.before !== null) {
          const before = operation.before as Readonly<Record<string, unknown>>;
          expect(Object.keys(operation.before as object).sort(), item.id).toEqual([
            'byteHash',
            'semanticHash',
            'shape',
          ]);
          expect(operation.before, item.id).not.toHaveProperty('bytes');
          expect(operation.before, item.id).not.toHaveProperty('source');
          expect(before.byteHash, item.id).toBe(api.hashManifestBytes(currentSource));
          const readable = api.readManifestSource(currentSource);
          if (readable.ok) {
            const normalized = api.normalizeManifestDocument(readable.value);
            expect(before.semanticHash, item.id).toBe(
              normalized.ok ? api.hashManifestSemantics(normalized.value) : null,
            );
          } else {
            expect(before.semanticHash, item.id).toBeNull();
          }
        }
        if (operation.after !== null) {
          expect(Object.keys(operation.after as object).sort(), item.id).toEqual([
            'byteHash',
            'semanticHash',
            'shape',
            'source',
          ]);
          const after = operation.after as Readonly<Record<string, unknown>>;
          expect(api.hashManifestBytes(after.source as string), item.id).toBe(after.byteHash);
          const afterDocument = unwrap(api.readManifestSource(after.source as string), item.id);
          const afterManifest = unwrap(api.normalizeManifestDocument(afterDocument), item.id);
          expect(api.hashManifestSemantics(afterManifest), item.id).toBe(after.semanticHash);
          const expectedSource =
            item.expected.kind === 'migrate-project-config' && item.currentMigrationId
              ? migrations.get(item.currentMigrationId)?.after
              : skeleton.expected;
          expect(after.source, item.id).toBe(expectedSource);
        }
        if (
          item.force &&
          ['canonical-invalid', 'empty', 'malformed', 'mixed', 'unknown'].some((token) =>
            item.id.startsWith(token),
          )
        ) {
          expect(
            (operation.before as Readonly<Record<string, unknown>>).semanticHash,
            item.id,
          ).toBeNull();
        }
        if (item.expected.kind === 'noop') {
          const before = operation.before as Readonly<Record<string, unknown>>;
          expect(before.byteHash, item.id).toBe(api.hashManifestBytes(currentSource));
          const document = unwrap(api.readManifestSource(currentSource), item.id);
          const normalized = unwrap(api.normalizeManifestDocument(document), item.id);
          expect(before.semanticHash, item.id).toBe(api.hashManifestSemantics(normalized));
        }
        if (item.expected.kind === 'migrate-project-config' && item.currentMigrationId) {
          expect((operation.after as Readonly<Record<string, unknown>>).source, item.id).toBe(
            migrations.get(item.currentMigrationId)?.after,
          );
        }
      } else {
        expect(result.ok, item.id).toBeFalse();
        if (result.ok) continue;
        expect(result.error.code, item.id).toBe('init-manifest');
        expect(result.error.reason, item.id).toBe(item.expected.reason);
        expect(result.error.exitCode, item.id).toBe(item.expected.exitCode);
        expect(result.error.shape, item.id).toBe(item.expected.shape);
        const fixedMessages: Readonly<Record<string, string>> = {
          'invalid-request': 'init manifest request is invalid',
          'existing-manifest': 'init manifest already exists and requires force',
          'future-manifest': 'init manifest uses a newer unsupported schema',
          'legacy-intent-conflict':
            'legacy project configuration conflicts with requested init defaults',
          'unsafe-legacy-migration': 'legacy project configuration cannot be migrated safely',
        };
        expect(result.error.message, item.id).toBe(fixedMessages[item.expected.reason ?? '']);
        expect(JSON.stringify(result.error), item.id).not.toContain('P17_SECRET_CANARY');
        recursivelyFrozen(result.error);
      }
    }

    for (const item of fixture.requestRefusals) {
      const result = api.planInitManifest(requestRefusalInput(item.id));
      expect(result.ok, item.id).toBeFalse();
      if (result.ok) continue;
      expect(result.error).toMatchObject({
        code: 'init-manifest',
        exitCode: 2,
        reason: 'invalid-request',
        field: item.field,
        message: 'init manifest request is invalid',
      });
    }

    const completeRequest = makeRequest({}, null, [], false);
    const trap = new Proxy(completeRequest, {
      ownKeys: () => {
        throw new Error('proxy trap must not run');
      },
      get: () => {
        throw new Error('proxy get trap must not run');
      },
      getPrototypeOf: () => {
        throw new Error('proxy prototype trap must not run');
      },
      getOwnPropertyDescriptor: () => {
        throw new Error('proxy descriptor trap must not run');
      },
    });
    expect(api.planInitManifest(trap).ok).toBeFalse();
    const accessor = { ...completeRequest };
    Object.defineProperty(accessor, 'force', {
      enumerable: true,
      get: () => {
        throw new Error('accessor must not run');
      },
    });
    expect(api.planInitManifest(accessor).ok).toBeFalse();

    const symbolRequest = { ...makeRequest({}, null, [], false), [Symbol('extra')]: true };
    const inheritedRequest = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(inheritedRequest, makeRequest({}, null, [], false));
    const nestedAccessor = { ...makeRequest({}, null, [], false), skeleton: {} };
    Object.defineProperty(nestedAccessor.skeleton, 'defaults', {
      enumerable: true,
      get: () => {
        throw new Error('nested accessor must not run');
      },
    });
    const holeyTools = Array(2) as unknown[];
    const extraTools = ['codex'] as unknown[] & { extra?: boolean };
    extraTools.extra = true;
    const accessorTools: unknown[] = [];
    Object.defineProperty(accessorTools, '0', {
      enumerable: true,
      get: () => {
        throw new Error('array accessor must not run');
      },
    });
    accessorTools.length = 1;
    const nestedProxy = {
      ...makeRequest({}, null, [], false),
      skeleton: new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('nested proxy trap must not run');
          },
        },
      ),
    };
    const holeyIntent = Array(1) as unknown[];
    const extraIntent = [] as unknown[] & { extra?: boolean };
    extraIntent.extra = true;
    const hostileRequests: readonly unknown[] = [
      symbolRequest,
      inheritedRequest,
      new Date(),
      { ...makeRequest({}, null, [], false), unknown: true },
      nestedAccessor,
      nestedProxy,
      { ...makeRequest({}, null, [], false), skeleton: { defaults: { tools: holeyTools } } },
      { ...makeRequest({}, null, [], false), skeleton: { defaults: { tools: extraTools } } },
      { ...makeRequest({}, null, [], false), skeleton: { defaults: { tools: accessorTools } } },
      { ...makeRequest({}, null, [], false), skeleton: { registry: undefined } },
      { ...makeRequest({}, null, [], false), skeleton: { defaults: { tools: undefined } } },
      { ...makeRequest({}, null, [], false), skeleton: { defaults: { scope: undefined } } },
      { ...makeRequest({}, null, [], false), skeleton: { defaults: { path: undefined } } },
      { ...makeRequest({}, null, [], false), legacyIntent: { requireMatch: holeyIntent } },
      { ...makeRequest({}, null, [], false), legacyIntent: { requireMatch: extraIntent } },
    ];
    for (const [index, hostile] of hostileRequests.entries()) {
      expect(api.planInitManifest(hostile).ok, `hostile request ${index}`).toBeFalse();
    }

    for (const shadow of ['iterator', 'constructor', 'species'] as const) {
      const bytes = encoder.encode('version = 1\n');
      if (shadow === 'iterator') Object.defineProperty(bytes, Symbol.iterator, { value: () => [] });
      if (shadow === 'constructor')
        Object.defineProperty(bytes, 'constructor', { value: Uint8Array });
      if (shadow === 'species') Object.defineProperty(bytes, Symbol.species, { value: Uint8Array });
      const result = api.planInitManifest({
        skeleton: {},
        current: { state: 'present', bytes },
        legacyIntent: { requireMatch: [] },
        force: false,
      });
      expect(result.ok, `typed-array ${shadow} shadow`).toBeFalse();
    }

    const detachedBuffer = new ArrayBuffer(16);
    const detachedBytes = new Uint8Array(detachedBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    const detached = api.planInitManifest({
      skeleton: {},
      current: { state: 'present', bytes: detachedBytes },
      legacyIntent: { requireMatch: [] },
      force: false,
    });
    expect(detached.ok).toBeFalse();

    for (const [id, bytes] of [
      ['bom', Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode('version = 1\n')])],
      ['invalid-utf8', Uint8Array.from([0xff, 0xfe, 0xfd])],
    ] as const) {
      const result = unwrap(
        api.planInitManifest({
          skeleton: {},
          current: { state: 'present', bytes },
          legacyIntent: { requireMatch: [] },
          force: true,
        }),
        id,
      );
      expect(result.kind, id).toBe('replace-manifest');
      expect((result.before as Readonly<Record<string, unknown>>).shape, id).toBe('malformed');
      expect((result.before as Readonly<Record<string, unknown>>).semanticHash, id).toBeNull();
    }

    const sensitiveMarker = ['P17', 'SECRET', 'CANARY'].join('_');
    const sensitiveRequest = api.planInitManifest(
      makeRequest(
        { defaults: { scope: 'project', path: `./ghp_${sensitiveMarker}_123456789` } },
        null,
        [],
        false,
      ),
    );
    expect(sensitiveRequest.ok).toBeFalse();
    if (!sensitiveRequest.ok)
      expect(JSON.stringify(sensitiveRequest.error)).not.toContain(sensitiveMarker);
    const sensitiveLegacy = `# Authorization: Bearer ${sensitiveMarker}\ntool = "codex"\n`;
    const sensitiveMigration = migrationApi.migrateLegacyManifestBytes(
      encoder.encode(sensitiveLegacy),
    );
    expect(sensitiveMigration.ok).toBeFalse();
    if (!sensitiveMigration.ok)
      expect(JSON.stringify(sensitiveMigration.error)).not.toContain(sensitiveMarker);

    const initSource = readFileSync(INIT_PATH, 'utf8');
    const migrationSource = readFileSync(MIGRATION_PATH, 'utf8');
    const pureSources = `${initSource}\n${migrationSource}`;
    const importSpecifiers = [
      ...pureSources.matchAll(
        /(?:from\s+|import\s*\(|require\s*\(|import\s+|export\s+[^;]*?from\s+)['"]([^'"]+)['"]/gu,
      ),
    ].map((match) => match[1] ?? '');
    const forbiddenModule =
      /(?:^|[./-])(?:cli|git|xdg|interaction|coordinator|lock|ledger|live|store|planner|clock)(?:[./-]|$)|(?:^|:)fs(?:\/|$)|child_process|(?:^|:)process(?:\/|$)/u;
    expect(
      importSpecifiers.filter((specifier) => forbiddenModule.test(specifier)),
      'pure init/migration modules acquired forbidden effect authority',
    ).toEqual([]);
    expect(pureSources).not.toMatch(/\b(?:process|Bun)\s*\./u);
    expect(pureSources).not.toMatch(/\b(?:readFile|writeFile|spawn|exec|fetch)\s*\(/u);

    const ts = await import('typescript');
    const configPath = join(FIXTURES, 'tsconfig.json');
    const loadedConfig = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(loadedConfig.error).toBeUndefined();
    const parsedConfig = ts.parseJsonConfigFileContent(
      loadedConfig.config,
      ts.sys,
      dirname(configPath),
    );
    const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(
      diagnostics,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => '\n',
      }),
    ).toEqual([]);
  }, 30_000);
});
