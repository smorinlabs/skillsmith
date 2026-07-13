import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ARTIFACTS_MODULE = '../../../packages/core/src/artifacts/index.ts';
const CORE_MODULE = '../../../packages/core/src/index.ts';
const ROOT = join(import.meta.dir, '../../..');
const FIXTURES = join(import.meta.dir, '../fixtures/p2-ts03');
const encoder = new TextEncoder();

const DOMAINS = [
  'manifest-semantic',
  'manifest-bytes',
  'lock-canonical',
  'source-content',
  'resource',
  'selection-set',
  'capability',
] as const;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };

type ModuleLoad =
  | { readonly ok: true; readonly module: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly message: string };

const loadModule = async (specifier: string): Promise<ModuleLoad> => {
  try {
    return { ok: true, module: (await import(specifier)) as Readonly<Record<string, unknown>> };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

const requireFunctions = async <T>(names: readonly string[]): Promise<T> => {
  const loaded = await loadModule(ARTIFACTS_MODULE);
  expect(
    loaded.ok,
    loaded.ok ? undefined : `public artifact module failed to load: ${loaded.message}`,
  ).toBeTrue();
  if (!loaded.ok) throw new Error(loaded.message);
  const missing = names.filter((name) => typeof loaded.module[name] !== 'function');
  expect(missing, 'G2-02 public artifact authority is incomplete').toEqual([]);
  return loaded.module as unknown as T;
};

const unwrap = <T>(result: Result<T>): T => {
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const expectReason = <T>(result: Result<T>, reason: string): void => {
  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error(`expected ${reason}`);
  expect(result.error.reason).toBe(reason);
  expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
};

const framed = (domain: string, bytes: Uint8Array): Uint8Array =>
  Buffer.concat([Buffer.from(`skillsmith:${domain}:v1`, 'utf8'), Buffer.from([0]), bytes]);

const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const assertRecursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const child of Object.values(value as Record<string, unknown>))
    assertRecursivelyFrozen(child, seen);
};

interface HashGolden {
  readonly schemaVersion: number;
  readonly inputUtf8: string;
  readonly inputBase64: string;
  readonly vectors: readonly {
    readonly domain: string;
    readonly framedHex: string;
    readonly digest: string;
  }[];
}

interface PortableLockSkill {
  readonly name: string;
  readonly source: string;
  readonly requestedRef: string | null;
  readonly resolvedSha: string;
  readonly sourcePath: string;
  readonly contentHash: string;
}

interface PortableLock {
  readonly version: 1;
  readonly hashSchemaVersion: 1;
  readonly manifestHash: string;
  readonly skills: readonly PortableLockSkill[];
}

interface NormalizedManifest {
  readonly version: 1;
  readonly skills: readonly unknown[];
}

interface SourceProjection {
  readonly version: 1;
  readonly exclusionsVersion: 1;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
}

interface FileMetadata {
  readonly kind: 'dir' | 'file' | 'symlink' | 'other' | 'absent';
  readonly mode: number | null;
  readonly identity: string | null;
}

interface SourcePorts {
  listDir(path: string): Promise<readonly string[]>;
  readBytes(path: string): Promise<Uint8Array>;
  readLink(path: string): Promise<string>;
  readFileMetadata(path: string): Promise<FileMetadata>;
}

describe('EWP-P2-TS03', () => {
  test('publishes a closed v1 domain authority with hard-coded vectors and refusal', async () => {
    const golden = JSON.parse(
      readFileSync(join(FIXTURES, 'hash-v1.golden.json'), 'utf8'),
    ) as HashGolden;
    expect(golden.schemaVersion).toBe(1);
    expect(golden.inputUtf8).toBe('fixture');
    const input = Buffer.from(golden.inputBase64, 'base64');
    expect(input.toString('utf8')).toBe(golden.inputUtf8);
    expect(golden.vectors.map((item) => item.domain)).toEqual(DOMAINS);
    expect(new Set(golden.vectors.map((item) => item.digest)).size).toBe(DOMAINS.length);
    for (const vector of golden.vectors) {
      const exact = framed(vector.domain, input);
      expect(Buffer.from(exact).toString('hex'), vector.domain).toBe(vector.framedHex);
      expect(digest(exact), vector.domain).toBe(vector.digest);
    }

    const api = await requireFunctions<{
      readonly HASH_SCHEMA_VERSION: number;
      readonly HASH_DOMAINS: readonly string[];
      hashCanonicalInput(domain: string, version: number, bytes: Uint8Array): Result<string>;
      parseArtifactDigest(value: unknown): Result<string>;
    }>(['hashCanonicalInput', 'parseArtifactDigest']);
    const core = await loadModule(CORE_MODULE);
    expect(core.ok).toBeTrue();
    if (!core.ok) throw new Error(core.message);

    expect(api.HASH_SCHEMA_VERSION).toBe(1);
    expect(api.HASH_DOMAINS).toEqual(DOMAINS);
    expect(Object.isFrozen(api.HASH_DOMAINS)).toBeTrue();
    expect(core.module.HASH_DOMAINS).toBe(api.HASH_DOMAINS);
    for (const vector of golden.vectors) {
      expect(unwrap(api.hashCanonicalInput(vector.domain, 1, input))).toBe(vector.digest);
      expect(unwrap(api.parseArtifactDigest(vector.digest))).toBe(vector.digest);
    }
    expectReason(api.hashCanonicalInput('unknown', 1, input), 'unknown-domain');
    expectReason(api.hashCanonicalInput('manifest-semantic', 2, input), 'unsupported-hash-schema');
    expectReason(api.parseArtifactDigest('sha256:ABC'), 'invalid-digest');

    const typeFixture = join(FIXTURES, 'tsconfig.json');
    const compiled = Bun.spawnSync(
      [join(ROOT, 'node_modules/.bin/tsc'), '-p', typeFixture, '--noEmit'],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const output = `${compiled.stdout.toString()}${compiled.stderr.toString()}`;
    expect(compiled.exitCode, output).toBe(0);
  });

  test('owns exact canonical lock bytes, versions, and manifest relationships', async () => {
    const lockBytes = readFileSync(join(FIXTURES, 'lock-v1.golden.toml'));
    const lockSource = lockBytes.toString('utf8');
    expect(lockBytes.byteLength).toBe(654);
    expect(lockSource.endsWith('\n')).toBeTrue();
    expect(lockSource.endsWith('\n\n')).toBeFalse();
    expect(lockSource).not.toContain('\r');
    const parsedFixture = Bun.TOML.parse(lockSource) as {
      readonly version: number;
      readonly hash_schema_version: number;
      readonly skills: readonly Record<string, unknown>[];
    };
    expect(parsedFixture.version).toBe(1);
    expect(parsedFixture.hash_schema_version).toBe(1);
    expect(parsedFixture.skills.map((entry) => entry.name)).toEqual(['lint', 'review']);
    expect(parsedFixture.skills[0]?.source).toBe('git.example.com/acme/tools//skills/lint');
    expect(parsedFixture.skills[0]).not.toHaveProperty('requested_ref');
    expect(digest(framed('lock-canonical', lockBytes))).toBe(
      'sha256:54ceb53b4caacc1dcbc5faac4bd83eca31d33d98efdd0a4f9d420a774d6ffc84',
    );

    const api = await requireFunctions<{
      readonly LOCK_VERSION: number;
      readPortableLockSource(source: Uint8Array): Result<PortableLock>;
      serializePortableLock(lock: PortableLock): Result<string>;
      hashPortableLock(lock: PortableLock): Result<string>;
      correlatePortableLock(
        manifest: NormalizedManifest,
        lock: PortableLock | null,
      ): Readonly<Record<string, unknown>>;
      readManifestSource(source: string): Result<Readonly<Record<string, unknown>>>;
      normalizeManifestDocument(
        document: Readonly<Record<string, unknown>>,
      ): Result<NormalizedManifest>;
      hashManifestSemantics(manifest: NormalizedManifest): string;
    }>([
      'readPortableLockSource',
      'serializePortableLock',
      'hashPortableLock',
      'correlatePortableLock',
      'readManifestSource',
      'normalizeManifestDocument',
      'hashManifestSemantics',
    ]);

    expect(api.LOCK_VERSION).toBe(1);
    const lock = unwrap(api.readPortableLockSource(lockBytes));
    assertRecursivelyFrozen(lock);
    expect(unwrap(api.serializePortableLock(lock))).toBe(lockSource);
    expect(unwrap(api.hashPortableLock(lock))).toBe(
      'sha256:54ceb53b4caacc1dcbc5faac4bd83eca31d33d98efdd0a4f9d420a774d6ffc84',
    );
    expectReason(
      api.readPortableLockSource(encoder.encode(`# comment\n${lockSource}`)),
      'noncanonical-lock',
    );
    expectReason(
      api.readPortableLockSource(encoder.encode(lockSource.replaceAll('\n', '\r\n'))),
      'noncanonical-lock',
    );
    expectReason(
      api.readPortableLockSource(encoder.encode('version = 2\nfuture = true\n')),
      'unsupported-lock-version',
    );

    const manifestSource = `version = 1
[defaults]
tools = ["codex"]
scope = "project"

[[skills]]
name = "review"
source = "github.com/acme/tools//skills/review"
ref = "main"

[[skills]]
name = "lint"
source = "https://git.example.com/acme/tools//skills/lint"
`;
    const manifest = unwrap(
      api.normalizeManifestDocument(unwrap(api.readManifestSource(manifestSource))),
    );
    const currentCandidate: PortableLock = {
      ...lock,
      manifestHash: api.hashManifestSemantics(manifest),
    };
    const current = unwrap(
      api.readPortableLockSource(
        encoder.encode(unwrap(api.serializePortableLock(currentCandidate))),
      ),
    );
    expect(api.correlatePortableLock(manifest, null)).toEqual({ state: 'missing-lock' });
    expect(api.correlatePortableLock(manifest, current)).toEqual({ state: 'current' });
    const incompleteCandidate = { ...current, skills: current.skills.slice(1) };
    const incomplete = unwrap(
      api.readPortableLockSource(
        encoder.encode(unwrap(api.serializePortableLock(incompleteCandidate))),
      ),
    );
    expect(api.correlatePortableLock(manifest, incomplete)).toMatchObject({
      state: 'incomplete',
      missingNames: ['lint'],
      facts: [{ reason: 'missing-entry', name: 'lint', field: 'skills.name' }],
    });
    const staleCandidate = {
      ...current,
      manifestHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const stale = unwrap(
      api.readPortableLockSource(encoder.encode(unwrap(api.serializePortableLock(staleCandidate)))),
    );
    expect(api.correlatePortableLock(manifest, stale)).toMatchObject({
      state: 'stale',
      facts: [{ reason: 'manifest-hash-mismatch', field: 'manifest_hash' }],
    });
  });

  test('projects portable source trees and refuses unsafe or unstable observations', async () => {
    const sourceGolden = JSON.parse(
      readFileSync(join(FIXTURES, 'source-content-v1.golden.json'), 'utf8'),
    ) as { readonly canonicalJson: string; readonly digest: string };
    expect(sourceGolden.canonicalJson.endsWith('\n')).toBeFalse();
    const projection = JSON.parse(sourceGolden.canonicalJson) as SourceProjection;
    expect(JSON.stringify(projection)).toBe(sourceGolden.canonicalJson);
    expect(projection.entries).toHaveLength(3);
    expect(digest(framed('source-content', encoder.encode(sourceGolden.canonicalJson)))).toBe(
      sourceGolden.digest,
    );

    const api = await requireFunctions<{
      readonly SOURCE_CONTENT_EXCLUSIONS_VERSION: number;
      readonly SOURCE_CONTENT_EXCLUSIONS_V1: readonly string[];
      projectSourceContent(ports: SourcePorts, root: string): Promise<Result<SourceProjection>>;
      serializeSourceContentProjection(projection: SourceProjection): Result<string>;
      hashSourceContentV1(projection: SourceProjection): Result<string>;
    }>(['projectSourceContent', 'serializeSourceContentProjection', 'hashSourceContentV1']);

    expect(api.SOURCE_CONTENT_EXCLUSIONS_VERSION).toBe(1);
    expect(api.SOURCE_CONTENT_EXCLUSIONS_V1).toEqual(['.git']);
    expect(Object.isFrozen(api.SOURCE_CONTENT_EXCLUSIONS_V1)).toBeTrue();
    expect(unwrap(api.serializeSourceContentProjection(projection))).toBe(
      sourceGolden.canonicalJson,
    );
    expect(unwrap(api.hashSourceContentV1(projection))).toBe(sourceGolden.digest);

    const makePorts = (
      options: {
        readonly secondBytes?: Uint8Array;
        readonly target?: string;
        readonly special?: boolean;
      } = {},
    ): { readonly ports: SourcePorts; excludedReads(): number } => {
      let rootLists = 0;
      let fileReads = 0;
      let excluded = 0;
      const relative = (path: string): string =>
        path === '/fixture' ? '' : path.slice('/fixture/'.length);
      const access = (path: string): string => {
        const value = relative(path);
        if (value === '.git' || value.startsWith('.git/')) {
          excluded += 1;
          throw new Error('excluded path was accessed');
        }
        return value;
      };
      return {
        excludedReads: () => excluded,
        ports: {
          listDir: async (path) => {
            const key = access(path);
            if (key === 'empty') return [];
            if (key !== '') throw new Error('unexpected list');
            rootLists += 1;
            return rootLists === 1
              ? ['run.sh', '.git', 'link', 'empty']
              : ['empty', 'link', '.git', 'run.sh'];
          },
          readBytes: async (path) => {
            expect(access(path)).toBe('run.sh');
            fileReads += 1;
            return fileReads === 2 && options.secondBytes !== undefined
              ? options.secondBytes
              : new Uint8Array([0x78, 0x0a]);
          },
          readLink: async (path) => {
            expect(access(path)).toBe('link');
            return options.target ?? 'run.sh';
          },
          readFileMetadata: async (path) => {
            const key = access(path);
            if (key === '') return { kind: 'dir', mode: 0o755, identity: 'root' };
            if (key === 'empty') return { kind: 'dir', mode: 0o755, identity: 'empty' };
            if (key === 'link') return { kind: 'symlink', mode: 0o777, identity: 'link' };
            if (key === 'run.sh')
              return options.special
                ? { kind: 'other', mode: 0o644, identity: 'special' }
                : { kind: 'file', mode: 0o755, identity: 'file' };
            return { kind: 'absent', mode: null, identity: null };
          },
        },
      };
    };

    const stable = makePorts();
    expect(unwrap(await api.projectSourceContent(stable.ports, '/fixture'))).toEqual(projection);
    expect(stable.excludedReads()).toBe(0);
    const racing = makePorts({ secondBytes: new Uint8Array([0x79, 0x0a]) });
    expectReason(await api.projectSourceContent(racing.ports, '/fixture'), 'unstable-read');
    const unsafe = makePorts({ target: '../P17_SECRET_CANARY' });
    expectReason(await api.projectSourceContent(unsafe.ports, '/fixture'), 'unsafe-symlink');
    const special = makePorts({ special: true });
    expectReason(await api.projectSourceContent(special.ports, '/fixture'), 'unsupported-entry');
  });
});
