import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');
const FIXTURES = join(import.meta.dir, '../fixtures/p2-ts04');
const ARTIFACTS_MODULE = '../../../packages/core/src/artifacts/index.ts';
const encoder = new TextEncoder();

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };

interface ManifestSuccessCase {
  readonly id: string;
  readonly newline: 'lf' | 'crlf' | 'mixed' | 'none-final';
  readonly mode: number;
  readonly before: string;
  readonly request: Readonly<{ readonly edits: readonly Readonly<Record<string, unknown>>[] }>;
  readonly after: string;
  readonly changed: boolean;
  readonly migrated: boolean;
  readonly touchedTargets: readonly Readonly<Record<string, unknown>>[];
}

interface ManifestUnsafeCase {
  readonly id: string;
  readonly shape: string;
  readonly source: string;
  readonly request: Readonly<{ readonly edits: readonly Readonly<Record<string, unknown>>[] }>;
  readonly reason: string;
}

interface ManifestFixture {
  readonly schemaVersion: number;
  readonly fixtureCanary: string;
  readonly successCases: readonly ManifestSuccessCase[];
  readonly unsafeCases: readonly ManifestUnsafeCase[];
  readonly requestRefusals: readonly string[];
}

interface RecoveryFixture {
  readonly schemaVersion: number;
  readonly fixtureCanary: string;
  readonly lockConstants: Readonly<{
    retryDelaysMs: readonly number[];
    centralStaleMs: number;
    centralHeartbeatMs: number;
    compatibilityStaleMs: number;
    compatibilityHeartbeatMs: number;
  }>;
  readonly modes: readonly number[];
  readonly topologies: readonly Readonly<{ id: string; expected: string }>[];
  readonly pairStates: readonly string[];
  readonly externalChanges: readonly Readonly<{ id: string; expected: string }>[];
  readonly forwardCursors: readonly string[];
  readonly rollbackCursors: readonly string[];
  readonly barrierGaps: readonly Readonly<Record<string, unknown>>[];
  readonly overlapFollowups: readonly Readonly<{
    crashed: readonly string[];
    requested: readonly string[];
  }>[];
  readonly cancellationStates: readonly Readonly<Record<string, unknown>>[];
  readonly idGrammars: Readonly<Record<string, string>>;
  readonly allowedResidue: readonly string[];
}

interface EditResult {
  readonly bytes: Uint8Array;
  readonly source: string;
  readonly changed: boolean;
  readonly migrated: boolean;
  readonly beforeSemanticHash: string;
  readonly afterSemanticHash: string;
  readonly touchedTargets: readonly Readonly<Record<string, unknown>>[];
}

interface ArtifactAuthority {
  readonly ARTIFACT_LOCK_RETRY_DELAYS_MS: readonly number[];
  readonly ARTIFACT_CENTRAL_LOCK_STALE_MS: number;
  readonly ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS: number;
  readonly ARTIFACT_COMPATIBILITY_LOCK_STALE_MS: number;
  readonly ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS: number;
  editManifestBytes(bytes: Uint8Array, request: unknown): Result<EditResult>;
  commitArtifactPair(...args: readonly unknown[]): Promise<Result<unknown>>;
  recoverArtifactPair(...args: readonly unknown[]): Promise<Result<unknown>>;
  readCoordinatedArtifactPair(...args: readonly unknown[]): Promise<Result<unknown>>;
  withArtifactGroupLock(...args: readonly unknown[]): Promise<unknown>;
  readManifestSource(source: string): Result<unknown>;
  normalizeManifestDocument(document: unknown): Result<unknown>;
  hashManifestSemantics(manifest: unknown): string;
}

const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const manifestFixture = (): ManifestFixture => readJson('manifest-cases.json');
const recoveryFixture = (): RecoveryFixture => readJson('recovery-cases.json');

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const recursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  // ECMAScript forbids freezing non-empty typed-array views. The contract requires copied bytes
  // and recursive freezing only where JavaScript permits; caller/result byte independence is
  // asserted separately around every edit.
  if (ArrayBuffer.isView(value) && value.byteLength > 0) return;
  expect(Object.isFrozen(value)).toBeTrue();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) recursivelyFrozen(descriptor.value, seen);
  }
};

const unwrap = <T>(result: Result<T>): T => {
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const semanticHash = (api: ArtifactAuthority, source: string): string => {
  const document = unwrap(api.readManifestSource(source));
  return api.hashManifestSemantics(unwrap(api.normalizeManifestDocument(document)));
};

const guardManifestFixture = (fixture: ManifestFixture): void => {
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.fixtureCanary).toBe('p2-ts04-fixture-canary');
  expect(fixture.successCases).toHaveLength(11);
  expect(fixture.unsafeCases).toHaveLength(9);
  expect(fixture.requestRefusals).toHaveLength(10);
  expect(unique(fixture.successCases.map((item) => item.id))).toBeTrue();
  expect(unique(fixture.unsafeCases.map((item) => item.id))).toBeTrue();
  expect(new Set(fixture.successCases.map((item) => item.newline))).toEqual(
    new Set(['lf', 'crlf', 'mixed', 'none-final']),
  );
  expect(new Set(fixture.successCases.map((item) => item.mode))).toEqual(
    new Set([0o600, 0o640, 0o644]),
  );

  const touchedDefaults = new Set<string>();
  const touchedSkillFields = new Set<string>();
  const touchedKinds = new Set<string>();
  for (const item of fixture.successCases) {
    expect(item.id.length).toBeGreaterThan(4);
    expect(item.request.edits.length).toBeGreaterThan(0);
    expect(item.after === item.before).toBe(!item.changed);
    expect(item.touchedTargets).toHaveLength(item.request.edits.length);
    expect(() => Bun.TOML.parse(item.before), item.id).not.toThrow();
    expect(() => Bun.TOML.parse(item.after), item.id).not.toThrow();
    for (const target of item.touchedTargets) {
      const kind = target.kind;
      expect(typeof kind, item.id).toBe('string');
      touchedKinds.add(kind as string);
      if (kind === 'default') touchedDefaults.add(target.field as string);
      if (kind === 'skill-field') touchedSkillFields.add(target.field as string);
    }
  }
  expect(touchedDefaults).toEqual(new Set(['tools', 'scope', 'path']));
  expect(touchedSkillFields).toEqual(
    new Set(['source', 'ref', 'tools', 'scope', 'placement', 'path']),
  );
  expect(touchedKinds).toEqual(
    new Set(['default', 'registry-default', 'skill-field', 'skill-declaration']),
  );
  expect(fixture.successCases.some((item) => item.id.includes('rename'))).toBeTrue();
  expect(fixture.successCases.some((item) => item.id.includes('add-declaration'))).toBeTrue();
  expect(fixture.successCases.some((item) => item.id.includes('remove'))).toBeTrue();

  expect(fixture.unsafeCases.map((item) => item.shape)).toEqual([
    'inline-comment',
    'leading-comment',
    'dotted-key',
    'reopened-table',
    'duplicate-key',
    'multiline-array',
    'inline-table',
    'deceptive-string',
    'mixed-insertion',
  ]);
  expect(fixture.requestRefusals).toEqual([
    'array-hole',
    'array-accessor',
    'symbol-key',
    'extra-key',
    'exotic-prototype',
    'duplicate-target',
    'remove-update-conflict',
    'duplicate-final-name',
    'migration-not-first',
    'migration-duplicate',
  ]);
  expect(JSON.stringify(fixture)).not.toContain('P17_SECRET_CANARY');
};

const guardRecoveryFixture = (fixture: RecoveryFixture): void => {
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.fixtureCanary).toBe('p2-ts04-recovery-canary');
  expect(fixture.lockConstants).toEqual({
    retryDelaysMs: [0, 100, 200, 400, 800, 800],
    centralStaleMs: 2_000,
    centralHeartbeatMs: 1_000,
    compatibilityStaleMs: 30_000,
    compatibilityHeartbeatMs: 5_000,
  });
  expect(fixture.modes).toEqual([0o600, 0o640, 0o644]);
  expect(fixture.topologies).toHaveLength(9);
  expect(fixture.topologies.map((item) => item.id)).toEqual([
    'absent',
    'regular',
    'symlink',
    'dangling-symlink',
    'directory',
    'special',
    'multi-link',
    'leaf-alias',
    'ancestor-retarget',
  ]);
  expect(fixture.pairStates).toEqual([
    'absent-absent',
    'present-absent',
    'absent-present',
    'present-present',
  ]);
  expect(fixture.externalChanges).toHaveLength(11);
  expect(fixture.forwardCursors).toHaveLength(10);
  expect(fixture.rollbackCursors).toHaveLength(6);
  expect(fixture.barrierGaps).toHaveLength(16);
  expect(fixture.overlapFollowups).toEqual([
    { crashed: ['A', 'B'], requested: ['C', 'B'] },
    { crashed: ['A', 'B'], requested: ['B', 'C'] },
    { crashed: ['A', 'B'], requested: ['A', 'C'] },
  ]);
  expect(fixture.cancellationStates).toHaveLength(4);
  expect(fixture.idGrammars).toEqual({
    'artifact-transaction': '^[0-9a-f]{16}$',
    'artifact-operation': '^[0-9a-f]{16}$',
    'artifact-cas': '^[0-9a-f]{16}$',
    'artifact-ownership': '^[0-9a-f]{64}$',
  });
  expect(fixture.allowedResidue).toHaveLength(10);
  expect(unique(fixture.allowedResidue)).toBeTrue();
  expect(JSON.stringify(fixture)).not.toContain('P17_SECRET_CANARY');
};

const loadAuthority = async (): Promise<ArtifactAuthority> => {
  const loaded = (await import(ARTIFACTS_MODULE)) as Partial<ArtifactAuthority>;
  const functionNames = [
    'editManifestBytes',
    'commitArtifactPair',
    'recoverArtifactPair',
    'readCoordinatedArtifactPair',
    'withArtifactGroupLock',
  ] as const;
  const missing = functionNames.filter((name) => typeof loaded[name] !== 'function');
  expect(missing, 'G2-03 artifact mutation authority is incomplete').toEqual([]);
  return loaded as ArtifactAuthority;
};

describe('EWP-P2-TS04 — lossless human artifacts and recoverable pair mutation', () => {
  test('fixtures are counted, independent, hostile, and canonically shaped', () => {
    guardManifestFixture(manifestFixture());
    guardRecoveryFixture(recoveryFixture());
  });

  test('spawn fixtures expose only bounded IPC protocols and no production bypass', () => {
    const crashSource = readFileSync(join(FIXTURES, 'crash-child.ts'), 'utf8');
    const lockSource = readFileSync(join(FIXTURES, 'lock-child.ts'), 'utf8');
    expect(crashSource).toContain("kind: 'arm'");
    expect(crashSource).toContain("kind: 'reached'");
    expect(crashSource).toContain('JSON.stringify(message.barrier)');
    expect(lockSource).toContain("'central' | 'compatibility'");
    expect(lockSource).toContain("kind: 'hold' | 'contend'");
    for (const source of [crashSource, lockSource]) {
      expect(source).not.toContain('process.env');
      expect(source).not.toContain('SKILLSMITH_');
      expect(source).not.toContain('--test-');
      expect(source).not.toContain('P17_SECRET_CANARY');
    }
  });

  test('publishes the closed types, editor, lock constants, and pair authority', async () => {
    const manifests = manifestFixture();
    const recovery = recoveryFixture();
    guardManifestFixture(manifests);
    guardRecoveryFixture(recovery);

    const compiled = Bun.spawnSync(
      [join(ROOT, 'node_modules/.bin/tsc'), '-p', join(FIXTURES, 'tsconfig.json'), '--noEmit'],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const compileOutput = `${compiled.stdout.toString()}${compiled.stderr.toString()}`;
    expect(compiled.exitCode, `G2-03 public type authority is incomplete:\n${compileOutput}`).toBe(
      0,
    );

    const api = await loadAuthority();
    expect(api.ARTIFACT_LOCK_RETRY_DELAYS_MS).toEqual(recovery.lockConstants.retryDelaysMs);
    expect(Object.isFrozen(api.ARTIFACT_LOCK_RETRY_DELAYS_MS)).toBeTrue();
    expect(api.ARTIFACT_CENTRAL_LOCK_STALE_MS).toBe(recovery.lockConstants.centralStaleMs);
    expect(api.ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS).toBe(recovery.lockConstants.centralHeartbeatMs);
    expect(api.ARTIFACT_COMPATIBILITY_LOCK_STALE_MS).toBe(
      recovery.lockConstants.compatibilityStaleMs,
    );
    expect(api.ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS).toBe(
      recovery.lockConstants.compatibilityHeartbeatMs,
    );

    for (const item of manifests.successCases) {
      const input = encoder.encode(item.before);
      const original = new Uint8Array(input);
      const result = unwrap(api.editManifestBytes(input, item.request));
      expect(input, `${item.id}: caller bytes mutated`).toEqual(original);
      expect(result.source, item.id).toBe(item.after);
      expect(result.bytes, item.id).toEqual(encoder.encode(item.after));
      expect(result.changed, item.id).toBe(item.changed);
      expect(result.migrated, item.id).toBe(item.migrated);
      expect(result.touchedTargets, item.id).toEqual(item.touchedTargets);
      expect(result.beforeSemanticHash, item.id).toBe(semanticHash(api, item.before));
      expect(result.afterSemanticHash, item.id).toBe(semanticHash(api, item.after));
      recursivelyFrozen(result);
    }

    for (const item of manifests.unsafeCases) {
      const input = encoder.encode(item.source);
      const original = new Uint8Array(input);
      const result = api.editManifestBytes(input, item.request);
      expect(result.ok, item.id).toBeFalse();
      if (result.ok) throw new Error(`${item.id}: expected refusal`);
      expect(result.error.reason, item.id).toBe(item.reason);
      expect(input, `${item.id}: refusal mutated caller bytes`).toEqual(original);
      expect(JSON.stringify(result.error), item.id).not.toContain('P17_SECRET_CANARY');
      recursivelyFrozen(result.error);
    }
  }, 20_000);
});
