import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  ArtifactCoordinatorPorts,
  ArtifactPairBarrier,
  ArtifactPairMutationRequest,
  ArtifactPathObservation,
} from '../../../packages/core/src/artifacts/coordinator-types.ts';
import {
  commitArtifactPair,
  readCoordinatedArtifactPair,
  recoverArtifactPair,
  withArtifactGroupLock,
} from '../../../packages/core/src/artifacts/coordinator.ts';
import {
  hashCanonicalInput,
  hashManifestSemantics,
} from '../../../packages/core/src/artifacts/hash.ts';
import { serializePortableLock } from '../../../packages/core/src/artifacts/lock.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../packages/core/src/artifacts/manifest.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../packages/core/src/artifacts/node-coordinator.ts';

const ROOT = join(import.meta.dir, '../../..');
const FIXTURES = join(import.meta.dir, '../fixtures/p2-ts04');
const ARTIFACTS_MODULE = '../../../packages/core/src/artifacts/index.ts';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

type ResidueStatesFixture = Readonly<Record<string, string>>;
type ResidueSelectorsFixture = Readonly<Record<string, string>>;

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
  readonly faultPoints: readonly string[];
  readonly capabilitySignatures: Readonly<{
    commit: Readonly<Record<string, number>>;
    resume: Readonly<Record<string, number>>;
    rollback: Readonly<Record<string, number>>;
    cleanup: Readonly<Record<string, number>>;
  }>;
  readonly externalChanges: readonly Readonly<{ id: string; expected: string }>[];
  readonly forwardCursors: readonly string[];
  readonly rollbackCursors: readonly string[];
  readonly structuredBarrierTuples: Readonly<{
    commit: readonly string[];
    resume: readonly string[];
    rollback: readonly string[];
    cleanup: readonly string[];
  }>;
  readonly physicalGaps: Readonly<{
    commit: readonly string[];
    resume: readonly string[];
    rollback: readonly string[];
    cleanup: readonly string[];
    partialFailure: readonly string[];
  }>;
  readonly physicalCommitResidueStates: ResidueStatesFixture;
  readonly physicalCommitResidueBySelector: ResidueSelectorsFixture;
  readonly physicalResumeResidueStates: ResidueStatesFixture;
  readonly physicalResumeResidueBySelector: ResidueSelectorsFixture;
  readonly physicalRollbackResidueStates: ResidueStatesFixture;
  readonly physicalRollbackResidueBySelector: ResidueSelectorsFixture;
  readonly physicalCleanupResidueStates: ResidueStatesFixture;
  readonly physicalCleanupResidueBySelector: ResidueSelectorsFixture;
  readonly physicalPartialFailureResidueStates: ResidueStatesFixture;
  readonly physicalPartialFailureResidueBySelector: ResidueSelectorsFixture;
  readonly structuredCommitResidueStates: ResidueStatesFixture;
  readonly structuredCommitResidueBySelector: ResidueSelectorsFixture;
  readonly structuredResumeResidueStates: ResidueStatesFixture;
  readonly structuredResumeResidueBySelector: ResidueSelectorsFixture;
  readonly structuredRollbackResidueStates: ResidueStatesFixture;
  readonly structuredRollbackResidueBySelector: ResidueSelectorsFixture;
  readonly structuredCleanupResidueStates: ResidueStatesFixture;
  readonly structuredCleanupResidueBySelector: ResidueSelectorsFixture;
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

const guardResidueFixture = (
  states: ResidueStatesFixture,
  selectors: ResidueSelectorsFixture,
  expectedSelectors: readonly string[],
  label: string,
): void => {
  expect(Object.keys(selectors).sort(), `${label}: residue selector drift`).toEqual(
    [...expectedSelectors].sort(),
  );
  expect(Object.keys(states).length, `${label}: empty residue state dictionary`).toBeGreaterThan(0);
  const referenced = new Set(Object.values(selectors));
  expect([...referenced].sort(), `${label}: orphan residue state`).toEqual(
    Object.keys(states).sort(),
  );
  for (const [selector, state] of Object.entries(selectors)) {
    expect(states[state], `${label}:${selector}: missing residue state`).toBeDefined();
    expect(states[state]?.length, `${label}:${selector}: empty residue state`).toBeGreaterThan(2);
  }
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
  expect(fixture.faultPoints).toHaveLength(31);
  expect(unique(fixture.faultPoints)).toBeTrue();
  expect(
    Object.fromEntries(
      Object.entries(fixture.capabilitySignatures).map(([name, signatures]) => [
        name,
        Object.values(signatures).reduce((sum, count) => sum + count, 0),
      ]),
    ),
  ).toEqual({ commit: 156, resume: 120, rollback: 162, cleanup: 77 });
  for (const [name, signatures] of Object.entries(fixture.capabilitySignatures)) {
    expect(Object.keys(signatures).length, `${name}: empty capability signatures`).toBeGreaterThan(
      0,
    );
    for (const [signature, count] of Object.entries(signatures)) {
      expect(
        signature.includes('|'),
        `${name}: capability signature contains tuple delimiter`,
      ).toBe(false);
      expect(
        Number.isSafeInteger(count) && count > 0,
        `${name}:${signature}: invalid count`,
      ).toBeTrue();
    }
  }
  expect(fixture.externalChanges).toHaveLength(11);
  expect(fixture.forwardCursors).toHaveLength(10);
  expect(fixture.rollbackCursors).toHaveLength(6);
  expect(
    Object.fromEntries(
      Object.entries(fixture.structuredBarrierTuples).map(([name, tuples]) => [
        name,
        tuples.length,
      ]),
    ),
  ).toEqual({ commit: 66, resume: 29, rollback: 41, cleanup: 13 });
  for (const [name, tuples] of Object.entries(fixture.structuredBarrierTuples)) {
    expect(unique(tuples), `${name}: duplicate structured barrier tuple`).toBeTrue();
    for (const tuple of tuples) {
      expect(barrierTupleKey(barrierSelectorFromKey(tuple)), `${name}: non-canonical tuple`).toBe(
        tuple,
      );
    }
  }
  expect(
    Object.fromEntries(
      Object.entries(fixture.physicalGaps).map(([name, tuples]) => [name, tuples.length]),
    ),
  ).toEqual({ commit: 80, resume: 28, rollback: 44, cleanup: 7, partialFailure: 56 });
  for (const [name, tuples] of Object.entries(fixture.physicalGaps)) {
    expect(unique(tuples), `${name}: duplicate physical tuple`).toBeTrue();
    for (const tuple of tuples) {
      expect(tuple.split('|'), `${name}: malformed physical tuple ${tuple}`).toHaveLength(3);
    }
  }
  const physicalResidue = {
    commit: [fixture.physicalCommitResidueStates, fixture.physicalCommitResidueBySelector],
    resume: [fixture.physicalResumeResidueStates, fixture.physicalResumeResidueBySelector],
    rollback: [fixture.physicalRollbackResidueStates, fixture.physicalRollbackResidueBySelector],
    cleanup: [fixture.physicalCleanupResidueStates, fixture.physicalCleanupResidueBySelector],
    partialFailure: [
      fixture.physicalPartialFailureResidueStates,
      fixture.physicalPartialFailureResidueBySelector,
    ],
  } as const;
  for (const path of ['commit', 'resume', 'rollback', 'cleanup', 'partialFailure'] as const) {
    const [states, selectors] = physicalResidue[path];
    guardResidueFixture(
      states,
      selectors,
      fixture.physicalGaps[path].map((key) => `physical|${path}|${key}`),
      `physical:${path}`,
    );
  }
  const structuredResidue = {
    commit: [fixture.structuredCommitResidueStates, fixture.structuredCommitResidueBySelector],
    resume: [fixture.structuredResumeResidueStates, fixture.structuredResumeResidueBySelector],
    rollback: [
      fixture.structuredRollbackResidueStates,
      fixture.structuredRollbackResidueBySelector,
    ],
    cleanup: [fixture.structuredCleanupResidueStates, fixture.structuredCleanupResidueBySelector],
  } as const;
  for (const path of ['commit', 'resume', 'rollback', 'cleanup'] as const) {
    const [states, selectors] = structuredResidue[path];
    guardResidueFixture(
      states,
      selectors,
      fixture.structuredBarrierTuples[path]
        .filter((key) => /^(?:mutation-returned|object-verified|record-durable)\|/u.test(key))
        .map((key) => `structured|${path}|${key}`),
      `structured:${path}`,
    );
  }
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
  expect(fixture.allowedResidue).toEqual([
    'recovery-record',
    'recovery-cas-temp',
    'transaction-directory',
    'collision-directory',
    'member-owner-marker',
    'member-lock-sidecar',
    'stage',
    'backup',
    'discard',
    'temporary-hard-link-set',
  ]);
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

const EMPTY_SOURCE = 'version = 1\nskills = []\n';
const EDIT_BEFORE =
  'version = 1\nskills = []\n\n[defaults]\ntools = ["codex"]\nscope = "project"\n';
const EDIT_AFTER = 'version = 1\nskills = []\n\n[defaults]\ntools = ["codex"]\nscope = "user"\n';
const EDIT_REQUESTED =
  'version = 1\nskills = []\n\n[defaults]\ntools = ["codex", "claude-code"]\nscope = "user"\n';
const SAFE_CANARY = 'P17 ordinary diagnostic';
const SECRET_CANARY = 'P17_SECRET_CANARY';

const normalizeSource = (source: string) => {
  const read = readManifestSource(source);
  if (!read.ok) throw new Error(`invalid test manifest: ${source}`);
  const normalized = normalizeManifestDocument(read.value);
  if (!normalized.ok) throw new Error(`invalid normalized test manifest: ${source}`);
  return normalized.value;
};

const lockFor = (source: string) =>
  Object.freeze({
    version: 1 as const,
    hashSchemaVersion: 1 as const,
    manifestHash: hashManifestSemantics(normalizeSource(source)),
    skills: Object.freeze([]),
  });

const lockBytesFor = (source: string): Uint8Array => {
  const serialized = serializePortableLock(lockFor(source));
  if (!serialized.ok) throw new Error('invalid test lock');
  return encoder.encode(serialized.value);
};

const pairFor = (manifestPath: string, lockPath: string) =>
  Object.freeze({
    file: Object.freeze({
      token: null,
      path: manifestPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfile: Object.freeze({
      token: null,
      path: lockPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfileSource: 'sibling' as const,
  });

const makeRoot = async (label: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-p2-ts04-${label}-`));
  roots.push(root);
  return root;
};

const pathsFor = (root: string, split = false) => {
  const manifestDirectory = split ? join(root, 'manifest') : root;
  const lockDirectory = split ? join(root, 'lock') : root;
  return Object.freeze({
    manifestDirectory,
    lockDirectory,
    manifestPath: join(manifestDirectory, 'skillsmith.toml'),
    lockPath: join(lockDirectory, 'skillsmith.lock'),
  });
};

type PairState = 'absent-absent' | 'present-absent' | 'absent-present' | 'present-present';

const pairScenario = async (
  root: string,
  state: PairState,
  split = false,
): Promise<{
  readonly pair: ReturnType<typeof pairFor>;
  readonly request: ArtifactPairMutationRequest;
  readonly beforeManifest: Uint8Array | null;
  readonly beforeLock: Uint8Array | null;
  readonly afterManifest: Uint8Array;
  readonly afterLock: Uint8Array;
}> => {
  const paths = pathsFor(root, split);
  await mkdir(paths.manifestDirectory, { recursive: true });
  await mkdir(paths.lockDirectory, { recursive: true });
  const manifestPresent = state === 'present-absent' || state === 'present-present';
  const lockPresent = state === 'absent-present' || state === 'present-present';
  const beforeManifest = manifestPresent ? encoder.encode(EDIT_BEFORE) : null;
  const beforeLock = lockPresent ? lockBytesFor(EDIT_BEFORE) : null;
  if (beforeManifest !== null) {
    await writeFile(paths.manifestPath, beforeManifest, { mode: 0o640 });
    await chmod(paths.manifestPath, 0o640);
  }
  if (beforeLock !== null) {
    await writeFile(paths.lockPath, beforeLock, { mode: 0o644 });
    await chmod(paths.lockPath, 0o644);
  }
  const afterManifest = manifestPresent ? encoder.encode(EDIT_AFTER) : encoder.encode(EDIT_AFTER);
  const afterLock = lockBytesFor(EDIT_AFTER);
  return Object.freeze({
    pair: pairFor(paths.manifestPath, paths.lockPath),
    request: Object.freeze({
      pair: pairFor(paths.manifestPath, paths.lockPath),
      manifest: manifestPresent
        ? Object.freeze({
            kind: 'edit' as const,
            request: Object.freeze({
              edits: Object.freeze([
                Object.freeze({
                  kind: 'set-default' as const,
                  field: 'scope' as const,
                  value: 'user' as const,
                }),
              ]),
            }),
          })
        : Object.freeze({ kind: 'replace' as const, bytes: afterManifest }),
      lock: Object.freeze({ kind: 'replace' as const, lock: lockFor(EDIT_AFTER) }),
    }),
    beforeManifest,
    beforeLock,
    afterManifest,
    afterLock,
  });
};

const listTree = async (root: string): Promise<readonly string[]> => {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      entries.push(path.slice(root.length + 1));
      if ((await lstat(path)).isDirectory()) await visit(path);
    }
  };
  await visit(root);
  return Object.freeze(entries);
};

const assertNoInternalResidue = async (
  ports: ArtifactCoordinatorPorts,
  root: string,
): Promise<void> => {
  expect(await ports.recovery.discover()).toEqual([]);
  const entries = await listTree(root);
  expect(entries.filter((path) => path.includes('.skillsmith-artifact-'))).toEqual([]);
  const lockDirectories: string[] = [];
  for (const path of entries.filter((entry) => entry.endsWith('.lock'))) {
    if ((await lstat(join(root, path))).isDirectory()) lockDirectories.push(path);
  }
  expect(lockDirectories).toEqual([]);
  expect(entries.filter((path) => path.includes('member-owners/v1-'))).toEqual([]);
  for (const relative of entries) {
    const path = join(root, relative);
    const stat = await lstat(path);
    if (!stat.isFile()) continue;
    expect(decoder.decode(new Uint8Array(await readFile(path))), relative).not.toContain(
      SECRET_CANARY,
    );
  }
};

const bytesAt = async (path: string): Promise<Uint8Array | null> => {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const containsBytes = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0) return true;
  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) return true;
  }
  return false;
};

const normalizeResiduePath = (relative: string): string =>
  relative
    .replace(/\.skillsmith-artifact-[0-9a-f]{16}/gu, '.skillsmith-artifact-<tx>')
    .replace(/v1-[0-9a-f]{64}\.json/gu, 'v1-<key>.json')
    .replace(
      /\.v1-[0-9a-f]{64}\.cas-[0-9a-f]{64}-[0-9a-f]{16}\.tmp/gu,
      '.v1-<key>.cas-<revision>-<id>.tmp',
    );

interface CrashResidueSnapshot {
  readonly categories: Readonly<Record<string, number>>;
  readonly files: readonly Readonly<Record<string, unknown>>[];
  readonly directories: readonly Readonly<Record<string, unknown>>[];
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly inodeGroups: readonly (readonly string[])[];
}

const serializeCrashResidueSnapshot = (snapshot: CrashResidueSnapshot): string =>
  JSON.stringify([
    recoveryFixture().allowedResidue.map((category) => snapshot.categories[category]),
    snapshot.files
      .filter(
        (file) => file.category !== 'member-owner-marker' && !String(file.path).endsWith('/owner'),
      )
      .map((file) => [file.path, file.category, file.content, file.mode, file.nlink]),
    snapshot.directories
      .filter(
        (directory) =>
          directory.kind === 'owned-transaction' || directory.kind === 'collision-transaction',
      )
      .map((directory) => [directory.path, directory.kind, directory.mode, directory.nlink]),
    snapshot.records.map((record) => [
      record.state,
      record.disposition ?? null,
      record.cursor ?? null,
      record.attempt ?? null,
      record.directoryIdentities ?? null,
      record.objectIdentities ?? null,
      record.collisionCount ?? null,
    ]),
    snapshot.inodeGroups,
  ]);

const crashResidueSnapshot = async (
  root: string,
  paths: Awaited<ReturnType<typeof prepareCrashPair>>,
  operationId: unknown,
): Promise<CrashResidueSnapshot> => {
  // Proper-lockfile's process-exit cleanup can finish just after the killed worker reports its exit.
  // Observe the stable post-exit filesystem rather than that transient central lease directory.
  await Bun.sleep(100);
  const entries = await listTree(root);
  const canary = encoder.encode(SECRET_CANARY);
  const categories: Record<string, number> = Object.fromEntries(
    recoveryFixture().allowedResidue.map((category) => [category, 0]),
  );
  const files: Readonly<Record<string, unknown>>[] = [];
  const directories: Readonly<Record<string, unknown>>[] = [];
  const records: Readonly<Record<string, unknown>>[] = [];
  const inodeMembers = new Map<string, string[]>();
  const stats = new Map<string, Awaited<ReturnType<typeof lstat>>>();
  const rawFiles = new Map<string, Uint8Array>();
  const compatibilityLockDirectories = new Set(
    [paths.manifestPath, paths.lockPath].map((path) => `${path.slice(root.length + 1)}.lock`),
  );
  for (const relative of entries) {
    expect(relative, 'secret leaked in residue path').not.toContain(SECRET_CANARY);
    const path = join(root, relative);
    const stat = await lstat(path);
    stats.set(relative, stat);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      expect(target, `secret leaked in symlink ${relative}`).not.toContain(SECRET_CANARY);
    }
    if (stat.isFile()) {
      const bytes = new Uint8Array(await readFile(path));
      rawFiles.set(relative, bytes);
      expect(containsBytes(bytes, canary), `secret leaked in ${relative}`).toBeFalse();
      const identity = `${stat.dev}:${stat.ino}`;
      const members = inodeMembers.get(identity) ?? [];
      members.push(normalizeResiduePath(relative));
      inodeMembers.set(identity, members);
    }
  }

  const classifyKnownBytes = (relative: string, bytes: Uint8Array): string => {
    if (bytesEqual(bytes, encoder.encode(EDIT_BEFORE))) return 'manifest-before';
    if (bytesEqual(bytes, encoder.encode(EDIT_AFTER))) return 'manifest-after';
    if (bytesEqual(bytes, lockBytesFor(EDIT_BEFORE))) return 'lock-before';
    if (bytesEqual(bytes, lockBytesFor(EDIT_AFTER))) return 'lock-after';
    if (bytes.length === 0) return 'empty';
    if (basename(relative) === 'owner' && /^[0-9a-f]{64}\n$/u.test(decoder.decode(bytes))) {
      return 'owner-token';
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const value = parsed as Readonly<Record<string, unknown>>;
        if (value.kind === 'skillsmith-artifact-member-owner') return 'member-owner';
        if (value.kind === 'skillsmith-artifact-pair-recovery') {
          return `recovery:${String(value.disposition)}:${String(value.cursor)}`;
        }
      }
      return 'json-other';
    } catch {
      return 'opaque';
    }
  };

  for (const relative of entries) {
    const stat = stats.get(relative) as Awaited<ReturnType<typeof lstat>>;
    const normalized = normalizeResiduePath(relative);
    const name = basename(relative);
    if (stat.isDirectory()) {
      let kind = 'infrastructure';
      if (/^\.skillsmith-artifact-[0-9a-f]{16}$/u.test(name)) {
        const owner = rawFiles.get(join(relative, 'owner'));
        kind =
          owner !== undefined && /^[0-9a-f]{64}\n$/u.test(decoder.decode(owner))
            ? 'owned-transaction'
            : 'collision-transaction';
        categories[
          kind === 'owned-transaction' ? 'transaction-directory' : 'collision-directory'
        ] += 1;
      } else if (name.endsWith('.lock')) {
        kind = compatibilityLockDirectories.has(relative) ? 'lock-sidecar' : 'central-lock-sidecar';
        if (kind === 'lock-sidecar') categories['member-lock-sidecar'] += 1;
        expect(stat.mode & 0o777, `${relative}: lock directory mode drift`).toBe(0o700);
      }
      directories.push(
        Object.freeze({ path: normalized, kind, mode: stat.mode & 0o777, nlink: stat.nlink }),
      );
      continue;
    }
    if (!stat.isFile()) continue;
    const bytes = rawFiles.get(relative) as Uint8Array;
    let category: string | null = null;
    if (
      relative.startsWith('.p2-ts04-coordination/recovery/') &&
      /^v1-[0-9a-f]{64}\.json$/u.test(name)
    ) {
      category = 'recovery-record';
    } else if (
      relative.startsWith('.p2-ts04-coordination/recovery/') &&
      /^\.v1-[0-9a-f]{64}\.cas-[0-9a-f]{64}-[0-9a-f]{16}\.tmp$/u.test(name)
    ) {
      category = 'recovery-cas-temp';
    } else if (
      relative.startsWith('.p2-ts04-coordination/member-owners/') &&
      /^v1-[0-9a-f]{64}\.json$/u.test(name)
    ) {
      category = 'member-owner-marker';
    } else if (relative.includes('.skillsmith-artifact-')) {
      if (name.endsWith('.stage')) category = 'stage';
      else if (name.endsWith('.backup')) category = 'backup';
      else if (name.endsWith('.discard')) category = 'discard';
    }
    if (category !== null) categories[category] += 1;
    if (
      category === 'member-owner-marker' ||
      category === 'recovery-record' ||
      category === 'recovery-cas-temp' ||
      (name === 'owner' && relative.includes('.skillsmith-artifact-'))
    ) {
      expect(stat.mode & 0o777, `${relative}: private artifact mode drift`).toBe(0o600);
      expect(stat.nlink, `${relative}: private artifact link-count drift`).toBe(1);
    }
    files.push(
      Object.freeze({
        path: normalized,
        category: category ?? 'infrastructure',
        content: classifyKnownBytes(relative, bytes),
        mode: stat.mode & 0o777,
        nlink: stat.nlink,
      }),
    );
  }

  for (const relative of entries.filter(
    (entry) =>
      entry.startsWith('.p2-ts04-coordination/recovery/') &&
      /^v1-[0-9a-f]{64}\.json$/u.test(basename(entry)),
  )) {
    const bytes = rawFiles.get(relative) as Uint8Array;
    let summary: Readonly<Record<string, unknown>> = Object.freeze({ state: 'invalid' });
    let parsed: Readonly<Record<string, unknown>> | null = null;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as Readonly<Record<string, unknown>>;
    } catch {
      parsed = null;
    }
    if (parsed?.kind === 'skillsmith-artifact-pair-recovery') {
      const directoriesValue = Array.isArray(parsed.directories) ? parsed.directories : [];
      const objectsValue = Array.isArray(parsed.objects) ? parsed.objects : [];
      const key = basename(relative).slice(0, -'.json'.length);
      expect(parsed.key, `${relative}: filename/key mismatch`).toBe(key);
      expect((parsed.pair as Readonly<Record<string, unknown>>).manifest).toBe(paths.manifestPath);
      expect((parsed.pair as Readonly<Record<string, unknown>>).lock).toBe(paths.lockPath);
      const objectIdentities: Record<string, string> = {};
      for (const candidate of objectsValue) {
        const object = candidate as Readonly<Record<string, unknown>>;
        const slot = `${String(object.role)}.${String(object.slot)}`;
        expect(Object.hasOwn(objectIdentities, slot), `${relative}: duplicate ${slot}`).toBeFalse();
        objectIdentities[slot] = object.identity === null ? 'null' : 'set';
        expect(
          typeof object.path === 'string' &&
            object.path.startsWith(`${root}/.skillsmith-artifact-`),
          `${relative}: object escaped transaction directory`,
        ).toBeTrue();
        const objectRelative = (object.path as string).slice(root.length + 1);
        const objectStat = stats.get(objectRelative);
        if (objectStat?.isFile() && object.identity !== null) {
          expect(`${objectStat.dev}:${objectStat.ino}`, `${relative}:${slot}: identity drift`).toBe(
            object.identity,
          );
          expect(objectStat.mode & 0o777, `${relative}:${slot}: mode drift`).toBe(
            object.expectedMode,
          );
        }
      }
      const directoryIdentities: string[] = [];
      for (const candidate of directoriesValue) {
        const directory = candidate as Readonly<Record<string, unknown>>;
        directoryIdentities.push(directory.identity === null ? 'null' : 'set');
        expect(
          typeof directory.path === 'string' && directory.path.startsWith(root),
          `${relative}: directory escaped root`,
        ).toBeTrue();
        const directoryRelative = (directory.path as string).slice(root.length + 1);
        const directoryStat = stats.get(directoryRelative);
        if (directoryStat?.isDirectory() && directory.identity !== null) {
          expect(
            `${directoryStat.dev}:${directoryStat.ino}`,
            `${relative}: directory identity drift`,
          ).toBe(directory.identity);
          const owner = rawFiles.get(join(directoryRelative, 'owner'));
          if (owner === undefined) {
            expect(parsed.cursor, `${relative}: owner missing before cleanup`).toBe('cleanup');
          } else {
            expect(decoder.decode(owner), `${relative}: owner token drift`).toBe(
              `${String(directory.ownershipToken)}\n`,
            );
          }
        }
      }
      const digest = hashCanonicalInput('resource', 1, bytes);
      expect(digest.ok, `${relative}: raw revision hash failed`).toBeTrue();
      summary = Object.freeze({
        state: 'valid',
        disposition: parsed.disposition,
        cursor: parsed.cursor,
        attempt: parsed.attempt,
        directoryIdentities,
        objectIdentities,
        collisionCount: Array.isArray(parsed.collisionPaths) ? parsed.collisionPaths.length : -1,
      });
    }
    records.push(summary);
  }

  for (const relative of entries.filter((entry) =>
    entry.startsWith('.p2-ts04-coordination/member-owners/'),
  )) {
    const bytes = rawFiles.get(relative);
    if (bytes === undefined) continue;
    const marker = JSON.parse(new TextDecoder().decode(bytes)) as Readonly<Record<string, unknown>>;
    const member = marker.member as Readonly<Record<string, unknown>>;
    expect(marker.kind, `${relative}: invalid marker kind`).toBe(
      'skillsmith-artifact-member-owner',
    );
    expect(marker.centralOperationId, `${relative}: marker operation mismatch`).toBe(operationId);
    expect(
      [paths.manifestPath, paths.lockPath],
      `${relative}: marker target escaped pair`,
    ).toContain(member.target);
    const lockRelative = `${(member.target as string).slice(root.length + 1)}.lock`;
    const lockStat = stats.get(lockRelative);
    expect(lockStat?.isDirectory(), `${relative}: marker lock directory missing`).toBeTrue();
    if (lockStat !== undefined) {
      expect(`${lockStat.dev}:${lockStat.ino}`, `${relative}: marker lock identity mismatch`).toBe(
        marker.lockDirectoryIdentity,
      );
    }
  }

  const inodeGroups = [...inodeMembers.entries()]
    .map(([, members]) => [...members].sort())
    .filter((members) => {
      const firstRelative = entries.find(
        (entry) => normalizeResiduePath(entry) === (members[0] as string),
      );
      const stat = firstRelative === undefined ? undefined : stats.get(firstRelative);
      return members.length > 1 || (stat?.nlink ?? 1) > 1;
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (const members of inodeGroups) {
    expect(members.length, `untracked hard link: ${JSON.stringify(members)}`).toBe(2);
    categories['temporary-hard-link-set'] += 1;
  }
  files.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  directories.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  records.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return Object.freeze({
    categories: Object.freeze(categories),
    files,
    directories,
    records,
    inodeGroups,
  });
};

const assertExactCrashResidue = async (
  root: string,
  paths: Awaited<ReturnType<typeof prepareCrashPair>>,
  outcome: CrashWorkerOutcome,
  selector: string,
  states: ResidueStatesFixture,
  selectors: ResidueSelectorsFixture,
): Promise<void> => {
  const state = selectors[selector];
  expect(state, `${selector}: missing exact residue selector`).toBeDefined();
  const expected = state === undefined ? undefined : states[state];
  expect(expected, `${selector}: missing exact residue state`).toBeDefined();
  const snapshot = await crashResidueSnapshot(root, paths, outcome.barriers[0]?.operationId);
  expect(serializeCrashResidueSnapshot(snapshot), `${selector}: exact residue drift`).toBe(
    expected,
  );
};

interface ForeignCollisionSnapshot {
  readonly path: string;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
}

const snapshotForeignCollision = async (path: string): Promise<ForeignCollisionSnapshot> => {
  const rootStat = await lstat(path);
  const entries: Readonly<Record<string, unknown>>[] = [
    Object.freeze({
      path: '.',
      kind: 'directory',
      dev: rootStat.dev,
      ino: rootStat.ino,
      mode: rootStat.mode & 0o777,
      nlink: rootStat.nlink,
    }),
  ];
  for (const relative of await listTree(path)) {
    const entryPath = join(path, relative);
    const stat = await lstat(entryPath);
    entries.push(
      Object.freeze({
        path: relative,
        kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode & 0o777,
        nlink: stat.nlink,
        content: stat.isFile()
          ? Buffer.from(new Uint8Array(await readFile(entryPath))).toString('hex')
          : null,
      }),
    );
  }
  return Object.freeze({ path, entries: Object.freeze(entries) });
};

const addForeignCollisionSentinel = async (root: string): Promise<ForeignCollisionSnapshot> => {
  const candidates: string[] = [];
  for (const name of await readdir(root)) {
    if (!/^\.skillsmith-artifact-[0-9a-f]{16}$/u.test(name)) continue;
    const path = join(root, name);
    if ((await lstat(path)).isDirectory()) candidates.push(path);
  }
  expect(candidates, 'expected exactly one unowned collision directory').toHaveLength(1);
  const path = candidates[0] as string;
  await writeFile(join(path, 'foreign-sentinel'), 'foreign-owned-by-another-writer\n', {
    flag: 'wx',
    mode: 0o640,
  });
  return snapshotForeignCollision(path);
};

const assertForeignCollisionUnchanged = async (
  ports: ArtifactCoordinatorPorts,
  root: string,
  expected: ForeignCollisionSnapshot,
): Promise<void> => {
  expect(
    await snapshotForeignCollision(expected.path),
    'foreign collision identity/content drift',
  ).toEqual(expected);
  expect(await ports.recovery.discover()).toEqual([]);
  const relativeCollision = expected.path.slice(root.length + 1);
  const allowedInfrastructure = new Set([
    '.p2-ts04-coordination',
    '.p2-ts04-coordination/recovery',
    '.p2-ts04-coordination/member-owners',
    'manifest.toml',
    'manifest.lock',
  ]);
  for (const relative of await listTree(root)) {
    expect(
      allowedInfrastructure.has(relative) ||
        relative === relativeCollision ||
        relative.startsWith(`${relativeCollision}/`),
      `unexpected residue beside foreign collision: ${relative}`,
    ).toBeTrue();
  }
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const forEachBounded = async <T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T, index: number) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) return;
      await visit(value, index);
    }
  });
  await Promise.all(workers);
};

interface PortTrace {
  readonly events: string[];
  readonly ports: ArtifactCoordinatorPorts;
}

const tracePorts = (
  base: ArtifactCoordinatorPorts,
  root: string,
  options: Readonly<{
    failEvent?: string;
    failOccurrence?: number;
    failCode?: 'EACCES' | 'EPERM' | 'EIO';
    once?: boolean;
  }> = {},
): PortTrace => {
  const events: string[] = [];
  const eventOccurrences = new Map<string, number>();
  let failed = false;
  const short = (path: string): string =>
    path.startsWith(root) ? `<root>/${path.slice(root.length + 1)}` : path;
  const event = (value: string): void => {
    events.push(value);
    const comparable = value.replace(
      /\.skillsmith-artifact-[0-9a-f]{16}/gu,
      '.skillsmith-artifact-<tx>',
    );
    const occurrence = eventOccurrences.get(comparable) ?? 0;
    eventOccurrences.set(comparable, occurrence + 1);
    const expected = options.failEvent;
    const matches =
      expected !== undefined &&
      occurrence === (options.failOccurrence ?? 0) &&
      (expected.endsWith('*')
        ? comparable.startsWith(expected.slice(0, -1))
        : comparable === expected);
    if (matches && (!options.once || !failed)) {
      failed = true;
      throw Object.assign(new Error(`access_token=${SECRET_CANARY}`), {
        code: options.failCode ?? 'EIO',
      });
    }
  };
  const recovery = Object.freeze({
    discover: async () => {
      event('recovery.discover');
      return base.recovery.discover();
    },
    create: async (record: Parameters<ArtifactCoordinatorPorts['recovery']['create']>[0]) => {
      event(`recovery.create:${record.cursor}`);
      return base.recovery.create(record);
    },
    replace: async (
      record: Parameters<ArtifactCoordinatorPorts['recovery']['replace']>[0],
      revision: string,
    ) => {
      event(`recovery.replace:${record.disposition}:${record.cursor}`);
      return base.recovery.replace(record, revision);
    },
    remove: async (key: string, revision: string) => {
      event('recovery.remove');
      return base.recovery.remove(key, revision);
    },
  });
  const ports: ArtifactCoordinatorPorts = Object.freeze({
    ...base,
    observe: async (path) => {
      event(`observe:${short(path)}`);
      return base.observe(path);
    },
    readBytes: async (path) => {
      event(`read:${short(path)}`);
      return base.readBytes(path);
    },
    makeDirectoryExclusive: async (path, mode) => {
      event(`mkdir:${short(path)}:${mode.toString(8)}`);
      return base.makeDirectoryExclusive(path, mode);
    },
    createTransactionDirectoryExclusive: async (path, token) => {
      event(`transaction:${short(path)}`);
      return base.createTransactionDirectoryExclusive(path, token);
    },
    writeBytesExclusive: async (path, bytes, mode) => {
      event(`write:${short(path)}:${mode.toString(8)}`);
      return base.writeBytesExclusive(path, bytes, mode);
    },
    setFileMode: async (path, mode) => {
      event(`chmod:${short(path)}:${mode.toString(8)}`);
      return base.setFileMode(path, mode);
    },
    moveIntoOwnedTransaction: async (source, destination) => {
      event(`move:${short(source)}->${short(destination)}`);
      return base.moveIntoOwnedTransaction(source, destination);
    },
    linkFileNoReplace: async (source, destination) => {
      event(`link:${short(source)}->${short(destination)}`);
      return base.linkFileNoReplace(source, destination);
    },
    removeFile: async (path) => {
      event(`unlink:${short(path)}`);
      return base.removeFile(path);
    },
    removeEmptyDirectory: async (path) => {
      event(`rmdir:${short(path)}`);
      return base.removeEmptyDirectory(path);
    },
    fsyncFile: async (path) => {
      event(`fsync-file:${short(path)}`);
      return base.fsyncFile(path);
    },
    fsyncDirectory: async (path) => {
      event(`fsync-directory:${short(path)}`);
      return base.fsyncDirectory(path);
    },
    withFileLock: async (target, lockOptions, operation) => {
      event(`lock-enter:${lockOptions.policy}:${short(target)}`);
      const value = await base.withFileLock(target, lockOptions, operation);
      event(`lock-exit:${lockOptions.policy}:${short(target)}`);
      return value;
    },
    recovery,
    nextId: (purpose) => {
      event(`id:${purpose}`);
      return base.nextId(purpose);
    },
  });
  return { events, ports };
};

const normalizedMutationTranscript = (events: readonly string[]): readonly string[] =>
  events
    .filter((event) =>
      /^(?:recovery\.(?:create|replace|remove)|transaction:|write:|chmod:|fsync-file:|move:|link:|unlink:|fsync-directory:|rmdir:)/u.test(
        event,
      ),
    )
    .map((event) =>
      event.replace(/\.skillsmith-artifact-[0-9a-f]{16}/gu, '.skillsmith-artifact-<tx>'),
    );

const capabilityTupleTranscript = (events: readonly string[]): readonly string[] => {
  const occurrences = new Map<string, number>();
  return events
    .filter((event) => !event.startsWith('id:'))
    .map((event) =>
      event.replace(/\.skillsmith-artifact-[0-9a-f]{16}/gu, '.skillsmith-artifact-<tx>'),
    )
    .map((event) => {
      const occurrence = occurrences.get(event) ?? 0;
      occurrences.set(event, occurrence + 1);
      return `${event}|${occurrence}`;
    });
};

const expandCapabilitySignatures = (
  signatures: Readonly<Record<string, number>>,
): readonly string[] =>
  Object.entries(signatures).flatMap(([signature, count]) =>
    Array.from({ length: count }, (_, occurrence) => `${signature}|${occurrence}`),
  );

const eventMatches = (event: string, pattern: string): boolean => {
  const comparable = event.replace(
    /\.skillsmith-artifact-[0-9a-f]{16}/gu,
    '.skillsmith-artifact-<tx>',
  );
  return pattern.endsWith('*')
    ? comparable.startsWith(pattern.slice(0, -1))
    : comparable === pattern;
};

const sameOptionalBytes = (left: Uint8Array | null, right: Uint8Array | null): boolean =>
  left === null || right === null
    ? left === right
    : left.length === right.length && left.every((byte, index) => byte === right[index]);

const partialMatch = (
  value: Readonly<Record<string, unknown>>,
  selector: Readonly<Record<string, unknown>>,
): boolean =>
  Object.entries(selector).every(([key, expected]) =>
    expected === null ? value[key] === undefined || value[key] === null : value[key] === expected,
  );

const BARRIER_TUPLE_FIELDS = Object.freeze([
  'kind',
  'targetClass',
  'cursor',
  'operation',
  'role',
  'object',
  'occurrence',
] as const);

const barrierTupleKey = (barrier: Readonly<Record<string, unknown>>): string =>
  BARRIER_TUPLE_FIELDS.map((field) => String(barrier[field] ?? '-')).join('|');

const tupleSet = (barriers: readonly Readonly<Record<string, unknown>>[]): ReadonlySet<string> =>
  new Set(barriers.map(barrierTupleKey));

const barrierSelectorFromKey = (key: string): Readonly<Record<string, unknown>> => {
  const values = key.split('|');
  expect(values).toHaveLength(BARRIER_TUPLE_FIELDS.length);
  const selector: Record<string, unknown> = {};
  for (let index = 0; index < BARRIER_TUPLE_FIELDS.length; index += 1) {
    const value = values[index] as string;
    if (value === '-') continue;
    const field = BARRIER_TUPLE_FIELDS[index] as (typeof BARRIER_TUPLE_FIELDS)[number];
    selector[field] = field === 'occurrence' ? Number(value) : value;
  }
  return Object.freeze(selector);
};

const assertExactTupleSet = (
  actual: readonly Readonly<Record<string, unknown>>[],
  expected: readonly string[],
  label: string,
): void => {
  const actualSet = tupleSet(actual);
  const expectedSet = new Set(expected);
  expect(actualSet.size, `${label}: duplicate actual structured tuple`).toBe(actual.length);
  expect(expectedSet.size, `${label}: duplicate fixture structured tuple`).toBe(expected.length);
  expect([...actualSet].sort(), `${label}: structured transcript drift`).toEqual(
    [...expectedSet].sort(),
  );
};

const physicalTupleKey = (point: Readonly<Record<string, unknown>>): string =>
  `${String(point.area)}|${String(point.step)}|${String(point.occurrence)}`;

const physicalSelectorFromKey = (key: string): Readonly<Record<string, unknown>> => {
  const [area, step, occurrence, ...extra] = key.split('|');
  expect(extra, `malformed physical tuple ${key}`).toHaveLength(0);
  expect(area, `missing physical area ${key}`).toBeDefined();
  expect(step, `missing physical step ${key}`).toBeDefined();
  expect(occurrence, `missing physical occurrence ${key}`).toBeDefined();
  return Object.freeze({ kind: 'physical-step', area, step, occurrence: Number(occurrence) });
};

const assertExactPhysicalSet = (
  actual: readonly Readonly<Record<string, unknown>>[],
  expected: readonly string[],
  label: string,
): void => {
  const actualKeys = actual.map(physicalTupleKey);
  expect(new Set(actualKeys).size, `${label}: duplicate live physical tuple`).toBe(actual.length);
  expect([...actualKeys].sort(), `${label}: physical transcript drift`).toEqual(
    [...expected].sort(),
  );
};

const assertBarrierIdentities = (
  barriers: readonly Readonly<Record<string, unknown>>[],
  label: string,
): void => {
  expect(barriers.length, `${label}: empty barrier transcript`).toBeGreaterThan(0);
  const operationIds = new Set(barriers.map((barrier) => barrier.operationId));
  expect(operationIds.size, `${label}: more than one operationId`).toBe(1);
  const [operationId] = operationIds;
  expect(operationId, `${label}: malformed operationId`).toMatch(/^[0-9a-f]{16}$/u);
  let currentRevision: unknown = null;
  for (const barrier of barriers) {
    const revision = barrier.recordRevision;
    expect(
      revision === null ||
        (typeof revision === 'string' && /^sha256:[0-9a-f]{64}$/u.test(revision)),
      `${label}: malformed recordRevision ${String(revision)}`,
    ).toBeTrue();
    if (revision !== currentRevision) {
      expect(barrier.kind, `${label}: revision changed outside mutation-returned`).toBe(
        'mutation-returned',
      );
      expect(
        barrier.operation === 'create-file-exclusive' ||
          barrier.operation === 'replace-recovery-record' ||
          (barrier.operation === 'remove-file' && barrier.object === 'recovery-record'),
        `${label}: arbitrary recordRevision transition`,
      ).toBeTrue();
      if (barrier.operation === 'remove-file') expect(revision).toBeNull();
      else expect(revision).not.toBeNull();
      currentRevision = revision;
    }
  }
};

interface CrashWorkerOutcome {
  readonly reached: Readonly<Record<string, unknown>> | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly exitCode: number;
  readonly barriers: readonly Readonly<Record<string, unknown>>[];
  readonly physicalPoints: readonly Readonly<Record<string, unknown>>[];
}

interface LockWorker {
  readonly acquired: Promise<Readonly<Record<string, unknown>>>;
  readonly finished: () => Promise<Readonly<Record<string, unknown>>>;
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

const spawnLockWorker = (
  root: string,
  request: Readonly<{
    kind: 'hold' | 'contend';
    policy: 'central' | 'compatibility' | 'legacy-compatibility' | 'group';
    target: string;
    holdMs: number;
  }>,
  options: Readonly<{ command?: readonly string[]; timeoutMs?: number }> = {},
): LockWorker => {
  const acquired = deferred<Readonly<Record<string, unknown>>>();
  const result = deferred<Readonly<Record<string, unknown>>>();
  let acquiredSettled = false;
  let resultSettled = false;
  const rejectAll = (error: Error): void => {
    if (!acquiredSettled) {
      acquiredSettled = true;
      acquired.reject(error);
    }
    if (!resultSettled) {
      resultSettled = true;
      result.reject(error);
    }
  };
  const child = Bun.spawn(options.command ?? [process.execPath, join(FIXTURES, 'lock-child.ts')], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
    ipc(message, subprocess) {
      if (typeof message !== 'object' || message === null) return;
      const record = message as Readonly<Record<string, unknown>>;
      if (record.kind === 'fixture-ready') {
        subprocess.send(request);
        return;
      }
      if (record.kind === 'acquired' && !acquiredSettled) {
        acquiredSettled = true;
        acquired.resolve(record);
      }
      if (record.kind === 'result' && !resultSettled) {
        resultSettled = true;
        result.resolve(record);
      }
      if (record.kind === 'fixture-error') {
        rejectAll(new Error(`lock fixture error: ${String(record.reason)}`));
      }
    },
  });
  // Some callers only await `finished`; suppress an unhandled-rejection report while retaining the
  // original rejected promise for callers that explicitly await acquisition.
  void acquired.promise.catch(() => undefined);
  void result.promise.catch(() => undefined);
  const exited = child.exited.then((exitCode) => {
    if (!resultSettled) rejectAll(new Error(`lock fixture exited ${exitCode} before result`));
    return exitCode;
  });
  const timeout = setTimeout(() => {
    rejectAll(new Error('lock fixture timeout'));
    child.kill('SIGKILL');
  }, options.timeoutMs ?? 20_000);
  return Object.freeze({
    acquired: acquired.promise,
    finished: async () => {
      try {
        const value = await result.promise;
        const exitCode = await exited;
        if (exitCode !== 0) throw new Error(`lock fixture failed ${exitCode}`);
        return value;
      } finally {
        clearTimeout(timeout);
        child.unref();
      }
    },
    kill: () => child.kill('SIGKILL'),
    exited,
  });
};

const runCrashWorker = async (
  root: string,
  selector: Readonly<Record<string, unknown>>,
  mode: 'SIGKILL' | 'SIGINT' | 'TRACE',
  start: Readonly<Record<string, unknown>>,
): Promise<CrashWorkerOutcome> => {
  const ready = deferred<void>();
  const reached = deferred<Readonly<Record<string, unknown>>>();
  const result = deferred<Readonly<Record<string, unknown>>>();
  const signalAcknowledged = deferred<void>();
  const failed = deferred<never>();
  let armed = false;
  let signalArmed = false;
  let signalAcked = false;
  let selectedPoint: Readonly<Record<string, unknown>> | null = null;
  let targetObserved = false;
  const barriers: Readonly<Record<string, unknown>>[] = [];
  const physicalPoints: Readonly<Record<string, unknown>>[] = [];
  const child = Bun.spawn([process.execPath, join(FIXTURES, 'crash-child.ts')], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
    ipc(message, subprocess) {
      if (typeof message !== 'object' || message === null) return;
      const record = message as Readonly<Record<string, unknown>>;
      if (record.kind === 'fixture-ready') {
        subprocess.send(start);
        ready.resolve();
        return;
      }
      if (record.kind === 'barrier-candidate' || record.kind === 'physical-candidate') {
        const barrier = record.barrier;
        if (typeof barrier !== 'object' || barrier === null) return;
        const point = barrier as Readonly<Record<string, unknown>>;
        if (point.kind !== 'before-acquisition') {
          (record.kind === 'barrier-candidate' ? barriers : physicalPoints).push(point);
        }
        if (mode === 'TRACE') {
          subprocess.send({ kind: 'continue', barrier: point });
          return;
        }
        if (!armed && partialMatch(point, selector)) {
          armed = true;
          selectedPoint = point;
          subprocess.send({ kind: mode === 'SIGINT' ? 'signal-arm' : 'arm', barrier: point });
        } else {
          subprocess.send({ kind: 'continue', barrier: point });
        }
        return;
      }
      if (record.kind === 'signal-armed') {
        if (
          mode !== 'SIGINT' ||
          !armed ||
          signalArmed ||
          selectedPoint === null ||
          JSON.stringify(record.barrier) !== JSON.stringify(selectedPoint)
        ) {
          failed.reject(new Error(`invalid SIGINT arm acknowledgement: ${JSON.stringify(record)}`));
          return;
        }
        signalArmed = true;
        subprocess.kill('SIGINT');
        return;
      }
      if (record.kind === 'signal-ack') {
        if (
          mode !== 'SIGINT' ||
          !armed ||
          !signalArmed ||
          signalAcked ||
          record.signal !== 'SIGINT' ||
          record.aborted !== true ||
          selectedPoint === null ||
          JSON.stringify(record.barrier) !== JSON.stringify(selectedPoint)
        ) {
          failed.reject(new Error(`invalid SIGINT acknowledgement: ${JSON.stringify(record)}`));
          return;
        }
        signalAcked = true;
        signalAcknowledged.resolve();
        return;
      }
      if (record.kind === 'reached') {
        targetObserved = true;
        reached.resolve(record.barrier as Readonly<Record<string, unknown>>);
        subprocess.kill('SIGKILL');
        return;
      }
      if (record.kind === 'result') {
        if (mode === 'SIGINT') {
          if (!armed) {
            failed.reject(
              new Error(`SIGINT fixture completed without observing ${JSON.stringify(selector)}`),
            );
            return;
          }
          if (!signalAcked) {
            failed.reject(
              new Error('SIGINT fixture returned a result before signal acknowledgement'),
            );
            return;
          }
          targetObserved = true;
          result.resolve(record);
        } else if (mode === 'TRACE') {
          targetObserved = true;
          result.resolve(record);
        } else {
          failed.reject(
            new Error(
              `crash fixture completed before selector ${JSON.stringify(selector)}: ${JSON.stringify(record.result)}`,
            ),
          );
        }
      }
      if (record.kind === 'fixture-error') {
        failed.reject(new Error(`crash fixture error: ${String(record.reason)}`));
      }
    },
  });
  const exited = child.exited.then((exitCode) => {
    if (!targetObserved) {
      failed.reject(
        new Error(`crash fixture exited ${exitCode} before selector ${JSON.stringify(selector)}`),
      );
    }
    return exitCode;
  });
  const timeout = setTimeout(() => {
    failed.reject(new Error(`crash fixture timeout at selector ${JSON.stringify(selector)}`));
    child.kill('SIGKILL');
  }, 20_000);
  try {
    await Promise.race([ready.promise, failed.promise]);
    let reachedValue: Readonly<Record<string, unknown>> | null = null;
    let resultValue: Readonly<Record<string, unknown>> | null = null;
    if (mode === 'SIGKILL') reachedValue = await Promise.race([reached.promise, failed.promise]);
    else {
      resultValue = await Promise.race([result.promise, failed.promise]);
      if (mode === 'SIGINT') {
        await Promise.race([signalAcknowledged.promise, failed.promise]);
      }
    }
    const exitCode = await exited;
    if (exitCode !== 0 && mode === 'SIGINT') throw new Error(`SIGINT child failed ${exitCode}`);
    return {
      reached: reachedValue,
      result: resultValue,
      exitCode,
      barriers: Object.freeze([...barriers]),
      physicalPoints: Object.freeze([...physicalPoints]),
    };
  } catch (error) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    child.unref();
  }
};

const commitStart = Object.freeze({
  kind: 'start',
  operation: 'commit',
  manifest: Object.freeze({
    kind: 'edit',
    request: Object.freeze({
      edits: Object.freeze([Object.freeze({ kind: 'set-default', field: 'scope', value: 'user' })]),
    }),
  }),
  lock: Object.freeze({ kind: 'replace' }),
});

const crashCommitStart = () =>
  Object.freeze({
    ...commitStart,
    lock: Object.freeze({ kind: 'replace', lock: lockFor(EDIT_AFTER) }),
  });

const MIXED_RECOVERY_SEED = Object.freeze({
  kind: 'object-verified',
  cursor: 'lock-install',
  role: 'lock',
  object: 'live',
  occurrence: 0,
});

const ROLLBACK_RECOVERY_SEED = Object.freeze({
  kind: 'object-verified',
  cursor: 'manifest-install',
  role: 'manifest',
  object: 'live',
  occurrence: 0,
});

const COMMITTED_RECOVERY_SEED = Object.freeze({
  kind: 'record-durable',
  cursor: 'committed',
  occurrence: 0,
});

const prepareCrashPair = async (root: string) => {
  const manifestPath = join(root, 'manifest.toml');
  const lockPath = join(root, 'manifest.lock');
  await writeFile(manifestPath, EDIT_BEFORE, { mode: 0o640 });
  await chmod(manifestPath, 0o640);
  await writeFile(lockPath, lockBytesFor(EDIT_BEFORE), { mode: 0o644 });
  await chmod(lockPath, 0o644);
  return Object.freeze({ manifestPath, lockPath, pair: pairFor(manifestPath, lockPath) });
};

const expireKilledCentralLock = async (root: string): Promise<void> => {
  const lockDirectory = join(root, '.p2-ts04-coordination', 'global.lock');
  try {
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, stale, stale);
  } catch (error) {
    if (
      error === null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
};

const traceRecoveryPath = async (
  label: string,
  seed: Readonly<Record<string, unknown>>,
  direction: 'resume' | 'rollback',
): Promise<CrashWorkerOutcome> => {
  const root = await makeRoot(`trace-${label}`);
  await prepareCrashPair(root);
  const seeded = await runCrashWorker(root, seed, 'SIGKILL', crashCommitStart());
  expect(seeded.reached, `${label}: failed to seed recovery record`).not.toBeNull();
  await expireKilledCentralLock(root);
  const traced = await runCrashWorker(root, {}, 'TRACE', {
    kind: 'start',
    operation: 'recover',
    direction,
  });
  expect(traced.result, `${label}: missing recovery trace result`).toMatchObject({
    kind: 'result',
    operation: 'recover',
    result: { ok: true },
  });
  return traced;
};

const runSeededRecoveryWorker = async (
  label: string,
  seed: Readonly<Record<string, unknown>>,
  direction: 'resume' | 'rollback',
  selector: Readonly<Record<string, unknown>>,
  mode: 'SIGINT' | 'SIGKILL' | 'TRACE',
): Promise<{
  readonly root: string;
  readonly paths: Awaited<ReturnType<typeof prepareCrashPair>>;
  readonly outcome: CrashWorkerOutcome;
}> => {
  const root = await makeRoot(label);
  const paths = await prepareCrashPair(root);
  const seeded = await runCrashWorker(root, seed, 'SIGKILL', crashCommitStart());
  expect(seeded.reached, `${label}: failed to seed recovery state`).not.toBeNull();
  await expireKilledCentralLock(root);
  const outcome = await runCrashWorker(root, selector, mode, {
    kind: 'start',
    operation: 'recover',
    direction,
  });
  return { root, paths, outcome };
};

const traceCapabilityPath = async (
  label: 'commit' | 'resume' | 'rollback' | 'cleanup',
): Promise<readonly string[]> => {
  const root = await makeRoot(`capability-trace-${label}`);
  const paths = await prepareCrashPair(root);
  if (label !== 'commit') {
    const seed =
      label === 'cleanup'
        ? COMMITTED_RECOVERY_SEED
        : label === 'rollback'
          ? ROLLBACK_RECOVERY_SEED
          : MIXED_RECOVERY_SEED;
    const seeded = await runCrashWorker(root, seed, 'SIGKILL', crashCommitStart());
    expect(seeded.reached, `${label}: failed capability seed`).not.toBeNull();
    await expireKilledCentralLock(root);
  }
  const base = await createTestNodeArtifactCoordinatorPorts(join(root, '.p2-ts04-coordination'));
  const traced = tracePorts(base, root);
  const result =
    label === 'commit'
      ? await commitArtifactPair(traced.ports, {
          pair: paths.pair,
          manifest: Object.freeze({
            kind: 'edit' as const,
            request: Object.freeze({
              edits: Object.freeze([
                Object.freeze({ kind: 'set-default' as const, field: 'scope', value: 'user' }),
              ]),
            }),
          }),
          lock: Object.freeze({ kind: 'replace' as const, lock: lockFor(EDIT_AFTER) }),
        })
      : await recoverArtifactPair(
          traced.ports,
          paths.pair,
          label === 'rollback' ? 'rollback' : 'resume',
        );
  expect(result, `${label}: capability trace failed`).toMatchObject({ ok: true });
  return capabilityTupleTranscript(traced.events);
};

const requestedCommitActions = () =>
  Object.freeze({
    manifest: Object.freeze({ kind: 'replace', source: EDIT_REQUESTED }),
    lock: Object.freeze({ kind: 'replace', lock: lockFor(EDIT_REQUESTED) }),
  });

const runSeededCancellationWorker = async (
  label: string,
  path: 'resume' | 'rollback' | 'cleanup',
  seed: Readonly<Record<string, unknown>>,
  selector: Readonly<Record<string, unknown>>,
): Promise<{
  readonly root: string;
  readonly paths: Awaited<ReturnType<typeof prepareCrashPair>>;
  readonly outcome: CrashWorkerOutcome;
}> => {
  const root = await makeRoot(label);
  const paths = await prepareCrashPair(root);
  const seeded = await runCrashWorker(root, seed, 'SIGKILL', crashCommitStart());
  expect(seeded.reached, `${label}: failed to seed recovery state`).not.toBeNull();
  await expireKilledCentralLock(root);
  const actions = requestedCommitActions();
  const start =
    path === 'resume'
      ? Object.freeze({
          kind: 'start',
          operation: 'recover-then-commit',
          direction: 'resume',
          ...actions,
        })
      : Object.freeze({
          kind: 'start',
          operation: 'commit',
          recoveryHandoff: path === 'rollback' ? 'rollback' : 'resume',
          ...actions,
        });
  const outcome = await runCrashWorker(root, selector, 'SIGINT', start);
  return { root, paths, outcome };
};

describe('EWP-P2-TS04 — lossless human artifacts and recoverable pair mutation', () => {
  test('discovers exact structured transcripts for commit, resume, rollback, and cleanup', async () => {
    const commitRoot = await makeRoot('trace-commit');
    await prepareCrashPair(commitRoot);
    const commit = await runCrashWorker(commitRoot, {}, 'TRACE', crashCommitStart());
    expect(commit.result).toMatchObject({
      kind: 'result',
      operation: 'commit',
      result: { ok: true },
    });
    const resume = await traceRecoveryPath('resume', MIXED_RECOVERY_SEED, 'resume');
    const rollback = await traceRecoveryPath('rollback', ROLLBACK_RECOVERY_SEED, 'rollback');
    const cleanup = await traceRecoveryPath('cleanup', COMMITTED_RECOVERY_SEED, 'resume');
    const partialRoot = await makeRoot('trace-partial-failure');
    await prepareCrashPair(partialRoot);
    const partialFailure = await runCrashWorker(partialRoot, {}, 'TRACE', {
      ...crashCommitStart(),
      operation: 'commit-partial-failure',
      failExclusiveWriteAfterBytes: 7,
    });
    const capabilities = {
      commit: await traceCapabilityPath('commit'),
      resume: await traceCapabilityPath('resume'),
      rollback: await traceCapabilityPath('rollback'),
      cleanup: await traceCapabilityPath('cleanup'),
    };
    const transcripts = {
      commit: commit.barriers,
      resume: resume.barriers,
      rollback: rollback.barriers,
      cleanup: cleanup.barriers,
    };
    const fixture = recoveryFixture().structuredBarrierTuples;
    for (const name of ['commit', 'resume', 'rollback', 'cleanup'] as const) {
      assertExactTupleSet(transcripts[name], fixture[name], name);
      assertBarrierIdentities(transcripts[name], name);
    }
    const physical = recoveryFixture().physicalGaps;
    for (const [name, outcome] of Object.entries({
      commit,
      resume,
      rollback,
      cleanup,
    }) as readonly ['commit' | 'resume' | 'rollback' | 'cleanup', CrashWorkerOutcome][]) {
      assertExactPhysicalSet(outcome.physicalPoints, physical[name], name);
    }
    assertExactPhysicalSet(
      partialFailure.physicalPoints,
      physical.partialFailure,
      'partialFailure',
    );
    assertBarrierIdentities(partialFailure.barriers, 'partialFailure');
    const capabilityFixture = recoveryFixture().capabilitySignatures;
    for (const name of ['commit', 'resume', 'rollback', 'cleanup'] as const) {
      const expected = expandCapabilitySignatures(capabilityFixture[name]);
      expect(new Set(capabilities[name]).size, `${name}: duplicate live capability tuple`).toBe(
        capabilities[name].length,
      );
      expect([...capabilities[name]].sort(), `${name}: capability transcript drift`).toEqual(
        [...expected].sort(),
      );
    }
  }, 30_000);

  test('fixtures are counted, independent, hostile, and canonically shaped', () => {
    guardManifestFixture(manifestFixture());
    guardRecoveryFixture(recoveryFixture());
  });

  test('spawn fixtures expose only bounded IPC protocols and no production bypass', () => {
    const crashSource = readFileSync(join(FIXTURES, 'crash-child.ts'), 'utf8');
    const lockSource = readFileSync(join(FIXTURES, 'lock-child.ts'), 'utf8');
    expect(crashSource).toContain("kind: 'arm'");
    expect(crashSource).toContain("kind: 'reached'");
    expect(crashSource).toContain("kind: 'signal-ack'");
    expect(crashSource).toContain('JSON.stringify(message.barrier)');
    for (const policy of ['central', 'compatibility', 'legacy-compatibility', 'group']) {
      expect(lockSource).toContain(`'${policy}'`);
    }
    expect(lockSource).toContain("kind: 'hold' | 'contend'");
    for (const source of [crashSource, lockSource]) {
      expect(source).not.toContain('process.env');
      expect(source).not.toContain('SKILLSMITH_');
      expect(source).not.toContain('--test-');
      expect(source).not.toContain('P17_SECRET_CANARY');
    }
  });

  test('lock child acquisition and result channels reject fixture error, early exit, and timeout', async () => {
    const request = Object.freeze({
      kind: 'hold' as const,
      policy: 'central' as const,
      target: 'global',
      holdMs: 0,
    });
    const earlyRoot = await makeRoot('lock-protocol-early-exit');
    const early = spawnLockWorker(earlyRoot, request, {
      command: [process.execPath, '-e', 'process.exit(7)'],
      timeoutMs: 1_000,
    });
    await expect(early.acquired).rejects.toThrow(/exited/u);
    await expect(early.finished()).rejects.toThrow(/exited/u);

    const errorRoot = await makeRoot('lock-protocol-fixture-error');
    const fixtureError = spawnLockWorker(errorRoot, { ...request, target: 'not-global' });
    await expect(fixtureError.acquired).rejects.toThrow(/(?:fixture error|exited)/u);
    await expect(fixtureError.finished()).rejects.toThrow(/(?:fixture error|exited)/u);

    const timeoutRoot = await makeRoot('lock-protocol-timeout');
    const timeout = spawnLockWorker(timeoutRoot, request, {
      command: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
      timeoutMs: 100,
    });
    await expect(timeout.acquired).rejects.toThrow(/timeout/u);
    await expect(timeout.finished()).rejects.toThrow(/timeout/u);
  }, 5_000);

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
      expect(result.bytes, `${item.id}: result aliases caller view`).not.toBe(input);
      expect(result.bytes.buffer, `${item.id}: result aliases caller backing buffer`).not.toBe(
        input.buffer,
      );
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
  }, 60_000);

  test('executes the pure and coordinated no-op with the exact zero-mutation transcript', async () => {
    const pure = manifestFixture().successCases.find(
      (item) => item.id === 'semantic-no-op-keeps-original-bytes',
    );
    if (pure === undefined) throw new Error('missing semantic no-op fixture');
    const api = await loadAuthority();
    const pureInput = encoder.encode(pure.before);
    const pureResult = unwrap(api.editManifestBytes(pureInput, pure.request));
    expect(pureResult.changed).toBeFalse();
    expect(pureResult.bytes).toEqual(pureInput);

    const root = await makeRoot('noop');
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const traced = tracePorts(base, root);
    const result = await commitArtifactPair(traced.ports, {
      pair: pairFor(manifestPath, lockPath),
      manifest: { kind: 'keep' },
      lock: { kind: 'keep' },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { outcome: 'unchanged', externalBytesReplayed: false },
    });
    expect(traced.events).toEqual([
      'id:artifact-operation',
      'lock-enter:central:<root>/coordination/global',
      'recovery.discover',
      'observe:<root>/skillsmith.toml',
      'observe:<root>/skillsmith.toml',
      'observe:<root>/skillsmith.lock',
      'observe:<root>/skillsmith.lock',
      'lock-exit:central:<root>/coordination/global',
    ]);
    expect(await bytesAt(manifestPath)).toBeNull();
    expect(await bytesAt(lockPath)).toBeNull();
    await assertNoInternalResidue(base, root);
  });

  test('executes all nine real topology rows including aliasing and ancestor retarget', async () => {
    const observed = new Map<string, string>();
    const fixture = recoveryFixture();
    for (const { id, expected } of fixture.topologies) {
      if (id === 'leaf-alias' || id === 'ancestor-retarget') continue;
      const root = await makeRoot(`topology-${id}`);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const manifestPath = join(root, 'skillsmith.toml');
      const lockPath = join(root, 'skillsmith.lock');
      if (id === 'regular') await writeFile(manifestPath, EMPTY_SOURCE);
      if (id === 'symlink') {
        await writeFile(join(root, 'target'), EMPTY_SOURCE);
        await symlink(join(root, 'target'), manifestPath);
      }
      if (id === 'dangling-symlink') await symlink(join(root, 'missing'), manifestPath);
      if (id === 'directory') await mkdir(manifestPath);
      if (id === 'multi-link') {
        await writeFile(manifestPath, EMPTY_SOURCE);
        await link(manifestPath, join(root, 'second-link'));
      }
      let ports = base;
      if (id === 'special') {
        const fifo = Bun.spawnSync(['mkfifo', manifestPath], { stdout: 'pipe', stderr: 'pipe' });
        if (fifo.exitCode !== 0) {
          ports = Object.freeze({
            ...base,
            observe: async (path: string): Promise<ArtifactPathObservation> =>
              path === manifestPath
                ? Object.freeze({
                    kind: 'other' as const,
                    mode: 0o600,
                    identity: 'special',
                    linkCount: 1,
                    parent: (await base.observe(path)).parent,
                  })
                : base.observe(path),
          });
        }
      }
      const result = await readCoordinatedArtifactPair(ports, pairFor(manifestPath, lockPath));
      const reason = result.ok ? 'accepted' : result.error.reason;
      observed.set(id, reason);
      expect(reason, id).toBe(expected);
    }

    {
      const root = await makeRoot('topology-alias');
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const manifestPath = join(root, 'skillsmith.toml');
      const lockPath = join(root, 'skillsmith.lock');
      await writeFile(manifestPath, EMPTY_SOURCE);
      await writeFile(lockPath, lockBytesFor(EMPTY_SOURCE));
      const aliasPorts = Object.freeze({
        ...base,
        observe: async (path: string): Promise<ArtifactPathObservation> => {
          const value = await base.observe(path);
          return path === manifestPath || path === lockPath
            ? Object.freeze({ ...value, identity: 'same-leaf', linkCount: 1 })
            : value;
        },
      });
      const result = await readCoordinatedArtifactPair(aliasPorts, pairFor(manifestPath, lockPath));
      const reason = result.ok ? 'accepted' : result.error.reason;
      expect(reason).toBe(fixture.topologies.find((item) => item.id === 'leaf-alias')?.expected);
      observed.set('leaf-alias', reason);
    }

    {
      const root = await makeRoot('topology-retarget');
      const live = join(root, 'live');
      const displaced = join(root, 'displaced');
      await mkdir(live);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const scenario = await pairScenario(live, 'absent-absent');
      let retargeted = false;
      const ports = Object.freeze({
        ...base,
        afterBarrier: async (barrier: ArtifactPairBarrier) => {
          if (
            !retargeted &&
            barrier.kind === 'record-durable' &&
            barrier.cursor === 'final-guard'
          ) {
            retargeted = true;
            await rename(live, displaced);
            await mkdir(live);
          }
        },
      });
      const result = await commitArtifactPair(ports, scenario.request);
      expect(result.ok).toBeFalse();
      const reason = result.ok ? 'accepted' : result.error.reason;
      expect(reason).toBe(
        fixture.topologies.find((item) => item.id === 'ancestor-retarget')?.expected,
      );
      expect(await bytesAt(scenario.pair.file.path)).toBeNull();
      expect(await bytesAt(scenario.pair.lockfile.path)).toBeNull();
      observed.set('ancestor-retarget', reason);
    }

    expect([...observed.keys()].sort()).toEqual(fixture.topologies.map((item) => item.id).sort());
  }, 30_000);

  test('serializes absent targets, lock overrides, overlaps, and cancellation with exact cleanup', async () => {
    const cases = [
      { id: 'same-pair', first: ['A', 'B'], second: ['A', 'B'] },
      { id: 'same-manifest-lock-override', first: ['A', 'B'], second: ['A', 'C'] },
      { id: 'overlapping-pairs', first: ['A', 'B'], second: ['B', 'C'] },
    ] as const;
    for (const item of cases) {
      const root = await makeRoot(`lock-${item.id}`);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const makePair = (members: readonly [string, string]) =>
        pairFor(join(root, members[0]), join(root, members[1]));
      const firstPair = makePair(item.first);
      const secondPair = makePair(item.second);
      const firstEntered = deferred<void>();
      const releaseFirst = deferred<void>();
      let active = 0;
      let secondEntered = false;
      const first = withArtifactGroupLock(base, firstPair, undefined, async (lease) => {
        await lease.acquireCompatibilityTargets([firstPair.file.path, firstPair.lockfile.path]);
        active += 1;
        expect(active, item.id).toBe(1);
        firstEntered.resolve();
        await releaseFirst.promise;
        active -= 1;
      });
      await firstEntered.promise;
      const second = withArtifactGroupLock(base, secondPair, undefined, async (lease) => {
        await lease.acquireCompatibilityTargets([secondPair.file.path, secondPair.lockfile.path]);
        secondEntered = true;
        active += 1;
        expect(active, item.id).toBe(1);
        active -= 1;
      });
      await Bun.sleep(20);
      expect(secondEntered, `${item.id}: contender entered while holder was active`).toBeFalse();
      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(secondEntered, item.id).toBeTrue();
      expect(active, item.id).toBe(0);
      await assertNoInternalResidue(base, root);
    }

    const root = await makeRoot('lock-cancel');
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const pair = pairFor(join(root, 'A'), join(root, 'B'));
    const holderEntered = deferred<void>();
    const releaseHolder = deferred<void>();
    const holder = withArtifactGroupLock(base, pair, undefined, async (lease) => {
      await lease.acquireCompatibilityTargets([pair.file.path, pair.lockfile.path]);
      holderEntered.resolve();
      await releaseHolder.promise;
    });
    await holderEntered.promise;
    const controller = new AbortController();
    let cancelledCallback = false;
    const contender = withArtifactGroupLock(base, pair, controller.signal, async (lease) => {
      await lease.acquireCompatibilityTargets([pair.file.path, pair.lockfile.path]);
      cancelledCallback = true;
    });
    await Bun.sleep(20);
    controller.abort();
    await expect(contender).rejects.toMatchObject({ reason: 'cancelled', exitCode: 130 });
    expect(cancelledCallback).toBeFalse();
    releaseHolder.resolve();
    await holder;
    await assertNoInternalResidue(base, root);
  }, 20_000);

  test('serializes spawned central and cross-version target-lock contenders with exact cleanup', async () => {
    const root = await makeRoot('spawn-lock-central');
    const holder = spawnLockWorker(root, {
      kind: 'hold',
      policy: 'central',
      target: 'global',
      holdMs: 2_800,
    });
    expect(await holder.acquired).toMatchObject({
      kind: 'acquired',
      policy: 'central',
      target: 'global',
    });
    const contender = spawnLockWorker(root, {
      kind: 'contend',
      policy: 'central',
      target: 'global',
      holdMs: 0,
    });
    expect(await contender.finished()).toMatchObject({
      kind: 'result',
      policy: 'central',
      target: 'global',
      ok: false,
      error: { reason: 'lock-contention', exitCode: 3 },
    });
    expect(await holder.finished()).toMatchObject({
      kind: 'result',
      policy: 'central',
      target: 'global',
      ok: true,
    });
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, '.p2-ts04-coordination'));
    await assertNoInternalResidue(ports, root);

    const groupRoot = await makeRoot('spawn-lock-group');
    const groupHolder = spawnLockWorker(groupRoot, {
      kind: 'hold',
      policy: 'group',
      target: 'artifact.toml',
      holdMs: 2_800,
    });
    expect(await groupHolder.acquired).toMatchObject({ kind: 'acquired', policy: 'group' });
    const groupPorts = await createTestNodeArtifactCoordinatorPorts(
      join(groupRoot, '.p2-ts04-coordination'),
    );
    const groupPair = pairFor(
      join(groupRoot, 'artifact.toml'),
      join(groupRoot, 'artifact.toml.peer'),
    );
    let groupEntered = false;
    await expect(
      withArtifactGroupLock(groupPorts, groupPair, undefined, async (lease) => {
        await lease.acquireCompatibilityTargets([groupPair.file.path, groupPair.lockfile.path]);
        groupEntered = true;
      }),
    ).rejects.toMatchObject({ reason: 'lock-contention', exitCode: 3 });
    expect(groupEntered).toBeFalse();
    expect(await groupHolder.finished()).toMatchObject({ kind: 'result', ok: true });
    await assertNoInternalResidue(groupPorts, groupRoot);

    const oldRoot = await makeRoot('spawn-lock-old-writer');
    const oldWriter = spawnLockWorker(oldRoot, {
      kind: 'hold',
      policy: 'legacy-compatibility',
      target: 'artifact.toml',
      holdMs: 6_200,
    });
    expect(await oldWriter.acquired).toMatchObject({
      kind: 'acquired',
      policy: 'legacy-compatibility',
    });
    const oldPorts = await createTestNodeArtifactCoordinatorPorts(
      join(oldRoot, '.p2-ts04-coordination'),
    );
    const oldPair = pairFor(join(oldRoot, 'artifact.toml'), join(oldRoot, 'artifact.lock'));
    let oldEntered = false;
    await expect(
      withArtifactGroupLock(oldPorts, oldPair, undefined, async (lease) => {
        await lease.acquireCompatibilityTargets([oldPair.file.path, oldPair.lockfile.path]);
        oldEntered = true;
      }),
    ).rejects.toMatchObject({ reason: 'lock-contention', exitCode: 3 });
    expect(oldEntered).toBeFalse();
    expect(await oldWriter.finished()).toMatchObject({ kind: 'result', ok: true });
    await assertNoInternalResidue(oldPorts, oldRoot);

    const killedRoot = await makeRoot('spawn-lock-killed-marked');
    const killedHolder = spawnLockWorker(killedRoot, {
      kind: 'hold',
      policy: 'group',
      target: 'artifact.toml',
      holdMs: 19_000,
    });
    expect(await killedHolder.acquired).toMatchObject({ kind: 'acquired', policy: 'group' });
    killedHolder.kill();
    await expect(killedHolder.finished()).rejects.toThrow(/lock fixture exited/u);
    await expireKilledCentralLock(killedRoot);
    const killedPorts = await createTestNodeArtifactCoordinatorPorts(
      join(killedRoot, '.p2-ts04-coordination'),
    );
    const killedPair = pairFor(
      join(killedRoot, 'artifact.toml'),
      join(killedRoot, 'artifact.toml.peer'),
    );
    let killedRecoveryEntered = false;
    await withArtifactGroupLock(killedPorts, killedPair, undefined, async (lease) => {
      await lease.acquireCompatibilityTargets([killedPair.file.path, killedPair.lockfile.path]);
      killedRecoveryEntered = true;
    });
    expect(killedRecoveryEntered).toBeTrue();
    await assertNoInternalResidue(killedPorts, killedRoot);

    const legacyRoot = await makeRoot('legacy-target-lock');
    const legacyPorts = await createTestNodeArtifactCoordinatorPorts(
      join(legacyRoot, '.p2-ts04-coordination'),
    );
    const legacyPair = pairFor(
      join(legacyRoot, 'artifact.toml'),
      join(legacyRoot, 'artifact.lock'),
    );
    await mkdir(`${legacyPair.file.path}.lock`);
    let entered = false;
    await expect(
      withArtifactGroupLock(legacyPorts, legacyPair, undefined, async (lease) => {
        await lease.acquireCompatibilityTargets([legacyPair.file.path, legacyPair.lockfile.path]);
        entered = true;
      }),
    ).rejects.toMatchObject({ reason: 'lock-contention', exitCode: 3 });
    expect(entered).toBeFalse();
    await rm(`${legacyPair.file.path}.lock`, { recursive: true });
    await withArtifactGroupLock(legacyPorts, legacyPair, undefined, async (lease) => {
      await lease.acquireCompatibilityTargets([legacyPair.file.path, legacyPair.lockfile.path]);
      entered = true;
    });
    expect(entered).toBeTrue();
    await assertNoInternalResidue(legacyPorts, legacyRoot);
  }, 30_000);

  test('executes collision retry, backup collision, no-replace, and the exact two-directory transcript', async () => {
    let backupCollisionSafe = true;
    {
      const root = await makeRoot('collision-retry');
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      let createCalls = 0;
      const attempts: number[] = [];
      const collisionPaths: readonly string[][] = [];
      const ports = Object.freeze({
        ...base,
        createTransactionDirectoryExclusive: async (path: string, token: string) => {
          createCalls += 1;
          if (createCalls === 1) throw Object.assign(new Error('collision'), { code: 'EEXIST' });
          return base.createTransactionDirectoryExclusive(path, token);
        },
        recovery: Object.freeze({
          ...base.recovery,
          replace: async (
            record: Parameters<ArtifactCoordinatorPorts['recovery']['replace']>[0],
            revision: string,
          ) => {
            attempts.push(record.attempt);
            (collisionPaths as string[][]).push([...record.collisionPaths]);
            return base.recovery.replace(record, revision);
          },
        }),
      });
      const scenario = await pairScenario(root, 'absent-absent');
      const result = await commitArtifactPair(ports, scenario.request);
      expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
      expect(createCalls).toBe(2);
      expect(attempts).toContain(2);
      expect(collisionPaths.some((paths) => paths.length === 1)).toBeTrue();
      await assertNoInternalResidue(base, root);
    }

    {
      const root = await makeRoot('backup-collision');
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const scenario = await pairScenario(root, 'present-present');
      const sentinel = encoder.encode('external backup sentinel\n');
      let backupPath: string | null = null;
      const ports = Object.freeze({
        ...base,
        afterBarrier: async (barrier: ArtifactPairBarrier) => {
          if (
            backupPath === null &&
            barrier.kind === 'record-durable' &&
            barrier.cursor === 'lock-backup'
          ) {
            const record = (await base.recovery.discover())[0]?.record;
            backupPath =
              record?.objects.find((object) => object.role === 'lock' && object.slot === 'backup')
                ?.path ?? null;
            if (backupPath === null) throw new Error('missing backup authority');
            await writeFile(backupPath, sentinel, { flag: 'wx' });
          }
        },
      });
      const result = await commitArtifactPair(ports, scenario.request);
      backupCollisionSafe =
        !result.ok &&
        backupPath !== null &&
        JSON.stringify(await bytesAt(backupPath)) === JSON.stringify(sentinel) &&
        JSON.stringify(await bytesAt(scenario.pair.file.path)) ===
          JSON.stringify(scenario.beforeManifest) &&
        JSON.stringify(await bytesAt(scenario.pair.lockfile.path)) ===
          JSON.stringify(scenario.beforeLock);
    }

    {
      const root = await makeRoot('no-replace-winner');
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const scenario = await pairScenario(root, 'absent-absent');
      const external = encoder.encode(`note = "${SAFE_CANARY}"\n`);
      let injected = false;
      const ports = Object.freeze({
        ...base,
        linkFileNoReplace: async (source: string, destination: string) => {
          if (!injected && destination === scenario.pair.lockfile.path) {
            injected = true;
            await writeFile(destination, external, { flag: 'wx' });
          }
          return base.linkFileNoReplace(source, destination);
        },
      });
      const result = await commitArtifactPair(ports, scenario.request);
      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'external-writer-conflict' },
      });
      expect(await bytesAt(scenario.pair.lockfile.path)).toEqual(external);
      expect(await bytesAt(scenario.pair.file.path)).toBeNull();
    }

    {
      const root = await makeRoot('exact-transcript');
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const scenario = await pairScenario(root, 'present-present', true);
      const traced = tracePorts(base, root);
      const result = await commitArtifactPair(traced.ports, scenario.request);
      expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
      expect(normalizedMutationTranscript(traced.events)).toEqual([
        'recovery.create:prepared',
        'transaction:<root>/lock/.skillsmith-artifact-<tx>',
        'recovery.replace:forward:prepared',
        'transaction:<root>/manifest/.skillsmith-artifact-<tx>',
        'recovery.replace:forward:prepared',
        'recovery.replace:forward:staging',
        'write:<root>/lock/.skillsmith-artifact-<tx>/lock.stage:644',
        'chmod:<root>/lock/.skillsmith-artifact-<tx>/lock.stage:644',
        'fsync-file:<root>/lock/.skillsmith-artifact-<tx>/lock.stage',
        'recovery.replace:forward:staging',
        'write:<root>/manifest/.skillsmith-artifact-<tx>/manifest.stage:640',
        'chmod:<root>/manifest/.skillsmith-artifact-<tx>/manifest.stage:640',
        'fsync-file:<root>/manifest/.skillsmith-artifact-<tx>/manifest.stage',
        'recovery.replace:forward:staging',
        'recovery.replace:forward:final-guard',
        'recovery.replace:forward:lock-backup',
        'move:<root>/lock/skillsmith.lock-><root>/lock/.skillsmith-artifact-<tx>/lock.backup',
        'fsync-directory:<root>/lock/.skillsmith-artifact-<tx>',
        'fsync-directory:<root>/lock',
        'recovery.replace:forward:lock-install',
        'link:<root>/lock/.skillsmith-artifact-<tx>/lock.stage-><root>/lock/skillsmith.lock',
        'unlink:<root>/lock/.skillsmith-artifact-<tx>/lock.stage',
        'fsync-directory:<root>/lock/.skillsmith-artifact-<tx>',
        'fsync-directory:<root>/lock',
        'recovery.replace:forward:manifest-backup',
        'move:<root>/manifest/skillsmith.toml-><root>/manifest/.skillsmith-artifact-<tx>/manifest.backup',
        'fsync-directory:<root>/manifest/.skillsmith-artifact-<tx>',
        'fsync-directory:<root>/manifest',
        'recovery.replace:forward:manifest-install',
        'link:<root>/manifest/.skillsmith-artifact-<tx>/manifest.stage-><root>/manifest/skillsmith.toml',
        'unlink:<root>/manifest/.skillsmith-artifact-<tx>/manifest.stage',
        'fsync-directory:<root>/manifest/.skillsmith-artifact-<tx>',
        'fsync-directory:<root>/manifest',
        'recovery.replace:forward:pair-verify',
        'recovery.replace:forward:committed',
        'recovery.replace:forward:cleanup',
        'unlink:<root>/lock/.skillsmith-artifact-<tx>/lock.backup',
        'unlink:<root>/lock/.skillsmith-artifact-<tx>/owner',
        'fsync-directory:<root>/lock/.skillsmith-artifact-<tx>',
        'rmdir:<root>/lock/.skillsmith-artifact-<tx>',
        'fsync-directory:<root>/lock',
        'unlink:<root>/manifest/.skillsmith-artifact-<tx>/manifest.backup',
        'unlink:<root>/manifest/.skillsmith-artifact-<tx>/owner',
        'fsync-directory:<root>/manifest/.skillsmith-artifact-<tx>',
        'rmdir:<root>/manifest/.skillsmith-artifact-<tx>',
        'fsync-directory:<root>/manifest',
        'recovery.remove',
      ]);
      expect(await bytesAt(scenario.pair.file.path)).toEqual(scenario.afterManifest);
      expect(await bytesAt(scenario.pair.lockfile.path)).toEqual(scenario.afterLock);
      await assertNoInternalResidue(base, root);
    }
    expect(backupCollisionSafe, 'backup collision overwrote a non-owned sentinel').toBeTrue();
  }, 30_000);

  test('executes all eleven one-time replay and external-writer rows', async () => {
    const seen: string[] = [];
    let convergedExactly = true;
    const wrongRefusals: string[] = [];
    for (const fixture of recoveryFixture().externalChanges) {
      const root = await makeRoot(`replay-${fixture.id}`);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const scenario = await pairScenario(root, 'present-present');
      const formatOnly = `# retained external formatting\n${EDIT_BEFORE}`;
      const semanticOther = EDIT_BEFORE.replace('tools = ["codex"]', 'tools = ["claude-code"]');
      let mutated = false;
      let secondMutation = false;
      let parentDrift = false;
      const mutateBeforeFresh = async (): Promise<void> => {
        if (mutated) return;
        mutated = true;
        switch (fixture.id) {
          case 'no-fact-change':
            break;
          case 'format-only-untouched-target':
          case 'second-change-after-replay':
            await writeFile(scenario.pair.file.path, formatOnly);
            break;
          case 'already-exact-desired':
            await writeFile(scenario.pair.file.path, scenario.afterManifest);
            await writeFile(scenario.pair.lockfile.path, scenario.afterLock);
            break;
          case 'semantic-change':
            await writeFile(scenario.pair.file.path, semanticOther);
            break;
          case 'targeted-before-change':
            await writeFile(scenario.pair.file.path, EDIT_AFTER);
            break;
          case 'lock-bytes-change':
            await writeFile(
              scenario.pair.lockfile.path,
              new Uint8Array([...(scenario.beforeLock as Uint8Array), 0x0a]),
            );
            break;
          case 'mode-change':
            await chmod(scenario.pair.file.path, 0o600);
            break;
          case 'identity-change': {
            const replacement = join(root, 'identity-replacement');
            await writeFile(replacement, scenario.beforeManifest as Uint8Array, { mode: 0o640 });
            await rename(replacement, scenario.pair.file.path);
            break;
          }
          case 'parent-change':
            parentDrift = true;
            break;
          case 'aba-identity-drift': {
            const replacement = join(root, 'aba-replacement');
            await writeFile(replacement, encoder.encode(semanticOther), { mode: 0o640 });
            await writeFile(replacement, scenario.beforeManifest as Uint8Array);
            await rename(replacement, scenario.pair.file.path);
            break;
          }
          default:
            throw new Error(`unhandled external-change fixture ${fixture.id}`);
        }
      };
      const ports: ArtifactCoordinatorPorts = Object.freeze({
        ...base,
        observe: async (path: string): Promise<ArtifactPathObservation> => {
          const value = await base.observe(path);
          if (parentDrift && path === scenario.pair.file.path && value.parent.state === 'present') {
            return Object.freeze({
              ...value,
              parent: Object.freeze({
                ...value.parent,
                identity: `${value.parent.identity}:drift`,
              }),
            });
          }
          return value;
        },
        withFileLock: async (target, options, operation) =>
          base.withFileLock(target, options, async () => {
            if (options.policy === 'compatibility') await mutateBeforeFresh();
            return operation();
          }),
        afterBarrier: async (barrier: ArtifactPairBarrier) => {
          if (
            fixture.id === 'second-change-after-replay' &&
            !secondMutation &&
            barrier.kind === 'record-durable' &&
            barrier.cursor === 'staging'
          ) {
            secondMutation = true;
            await writeFile(scenario.pair.file.path, `# second external change\n${formatOnly}`);
          }
        },
      });
      const result = await commitArtifactPair(ports, scenario.request);
      seen.push(fixture.id);
      if (fixture.expected === 'commit') {
        expect(result, fixture.id).toMatchObject({
          ok: true,
          value: { outcome: 'committed', externalBytesReplayed: false },
        });
      } else if (fixture.expected === 'replay-once') {
        expect(result, fixture.id).toMatchObject({
          ok: true,
          value: { externalBytesReplayed: true },
        });
        expect(decoder.decode((await bytesAt(scenario.pair.file.path)) as Uint8Array)).toContain(
          'retained external formatting',
        );
      } else if (fixture.expected === 'converge') {
        convergedExactly = result.ok && result.value.outcome === 'unchanged';
      } else {
        if (result.ok || result.error.reason !== 'external-writer-conflict') {
          wrongRefusals.push(`${fixture.id}:${result.ok ? 'ok' : result.error.reason}`);
        }
      }
      if (result.ok) await assertNoInternalResidue(base, root);
      expect(JSON.stringify(result), fixture.id).not.toContain(SECRET_CANARY);
    }
    expect(seen).toEqual(recoveryFixture().externalChanges.map((item) => item.id));
    expect(wrongRefusals, 'external change rows used the wrong refusal').toEqual([]);
    expect(convergedExactly, 'exact desired manifest/lock did not converge').toBeTrue();
  }, 40_000);

  test('injects every declared fault point across all four pair states without a mixed terminal pair', async () => {
    const executed = new Set<string>();
    const unresolved: string[] = [];
    let expected = 0;
    for (const state of recoveryFixture().pairStates as readonly PairState[]) {
      for (const point of recoveryFixture().faultPoints) {
        const requiresExistingLock = point.includes('/lock.backup');
        const requiresExistingManifest = point.includes('/manifest.backup');
        if (requiresExistingLock && state !== 'absent-present' && state !== 'present-present') {
          continue;
        }
        if (requiresExistingManifest && state !== 'present-absent' && state !== 'present-present') {
          continue;
        }
        expected += 1;
        const root = await makeRoot(`fault-${state}-${executed.size}`);
        const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
        const scenario = await pairScenario(root, state);
        const traced = tracePorts(base, root, {
          failEvent: point,
          failCode: 'EIO',
          once: true,
        });
        const result = await commitArtifactPair(traced.ports, scenario.request);
        const label = `${state}:${point}`;
        expect(
          traced.events.some((event) => eventMatches(event, point)),
          `${label}: not reached`,
        ).toBeTrue();
        executed.add(label);
        expect(result.ok, `${label}: injected fault returned success`).toBeFalse();
        if (!result.ok) {
          expect(
            ['filesystem-failure', 'recovery-conflict'].includes(result.error.reason),
            `${label}:${result.error.reason}`,
          ).toBeTrue();
          expect(JSON.stringify(result), label).not.toContain(SECRET_CANARY);
        }

        const read = await readCoordinatedArtifactPair(base, scenario.pair);
        if (!read.ok) {
          unresolved.push(`${label}:${read.error.reason}`);
          continue;
        }
        const manifest = await bytesAt(scenario.pair.file.path);
        const lock = await bytesAt(scenario.pair.lockfile.path);
        const fullBefore =
          sameOptionalBytes(manifest, scenario.beforeManifest) &&
          sameOptionalBytes(lock, scenario.beforeLock);
        const fullAfter =
          sameOptionalBytes(manifest, scenario.afterManifest) &&
          sameOptionalBytes(lock, scenario.afterLock);
        expect(fullBefore || fullAfter, `${label}: mixed terminal pair`).toBeTrue();
        expect(await recoverArtifactPair(base, scenario.pair, 'rollback'), label).toEqual({
          ok: true,
          value: 'clean',
        });
        await assertNoInternalResidue(base, root);
      }
    }
    expect(executed.size).toBe(expected);
    expect(unresolved, 'fault points did not resolve through coordinated read').toEqual([]);
  }, 120_000);

  test('classifies EACCES and EPERM at every declared capability phase without secret leakage', async () => {
    const fixture = recoveryFixture().capabilitySignatures;
    const rows = (['EACCES', 'EPERM'] as const).flatMap((code) =>
      (['commit', 'resume', 'rollback', 'cleanup'] as const).flatMap((path) =>
        expandCapabilitySignatures(fixture[path]).map((key) => ({ code, path, key })),
      ),
    );
    const executed = new Set<string>();
    const wrongClassifications: string[] = [];
    await forEachBounded(rows, 8, async ({ code, path, key }, index) => {
      const separator = key.lastIndexOf('|');
      const signature = key.slice(0, separator);
      const occurrence = Number(key.slice(separator + 1));
      const label = `${code}:${path}:${key}`;
      const root = await makeRoot(`permission-${index}`);
      const paths = await prepareCrashPair(root);
      if (path !== 'commit') {
        const seed =
          path === 'cleanup'
            ? COMMITTED_RECOVERY_SEED
            : path === 'rollback'
              ? ROLLBACK_RECOVERY_SEED
              : MIXED_RECOVERY_SEED;
        const seeded = await runCrashWorker(root, seed, 'SIGKILL', crashCommitStart());
        expect(seeded.reached, `${label}: failed seed`).not.toBeNull();
        await expireKilledCentralLock(root);
      }
      const base = await createTestNodeArtifactCoordinatorPorts(
        join(root, '.p2-ts04-coordination'),
      );
      const traced = tracePorts(base, root, {
        failEvent: signature,
        failOccurrence: occurrence,
        failCode: code,
        once: true,
      });
      const result =
        path === 'commit'
          ? await commitArtifactPair(traced.ports, {
              pair: paths.pair,
              manifest: Object.freeze({
                kind: 'edit' as const,
                request: Object.freeze({
                  edits: Object.freeze([
                    Object.freeze({ kind: 'set-default' as const, field: 'scope', value: 'user' }),
                  ]),
                }),
              }),
              lock: Object.freeze({ kind: 'replace' as const, lock: lockFor(EDIT_AFTER) }),
            })
          : await recoverArtifactPair(
              traced.ports,
              paths.pair,
              path === 'rollback' ? 'rollback' : 'resume',
            );
      expect(
        capabilityTupleTranscript(traced.events),
        `${label}: capability not reached`,
      ).toContain(key);
      if (
        result.ok ||
        result.error.code !== 'artifact-mutation' ||
        result.error.reason !== 'permission-denied' ||
        result.error.exitCode !== 6 ||
        result.error.message !== 'artifact filesystem permission was denied'
      ) {
        wrongClassifications.push(`${label}:${result.ok ? 'ok' : String(result.error.reason)}`);
      }
      expect(JSON.stringify(result), label).not.toContain(SECRET_CANARY);
      const clean = await createTestNodeArtifactCoordinatorPorts(
        join(root, '.p2-ts04-coordination'),
      );
      const direction = path === 'rollback' || path === 'commit' ? 'rollback' : 'resume';
      const recovered = await recoverArtifactPair(clean, paths.pair, direction);
      expect(recovered.ok, `${label}:${JSON.stringify(recovered)}`).toBeTrue();
      const manifest = await bytesAt(paths.manifestPath);
      const lock = await bytesAt(paths.lockPath);
      const before =
        sameOptionalBytes(manifest, encoder.encode(EDIT_BEFORE)) &&
        sameOptionalBytes(lock, lockBytesFor(EDIT_BEFORE));
      const after =
        sameOptionalBytes(manifest, encoder.encode(EDIT_AFTER)) &&
        sameOptionalBytes(lock, lockBytesFor(EDIT_AFTER));
      expect(before || after, `${label}: mixed terminal pair`).toBeTrue();
      if (path === 'resume' || path === 'cleanup') expect(after, label).toBeTrue();
      if (path === 'rollback') expect(before, label).toBeTrue();
      expect(await recoverArtifactPair(clean, paths.pair, direction), label).toEqual({
        ok: true,
        value: 'clean',
      });
      await assertNoInternalResidue(clean, root);
      executed.add(label);
    });

    for (const [index, code] of (['EACCES', 'EPERM'] as const).entries()) {
      const root = await makeRoot(`permission-provision-${index}`);
      const base = await createTestNodeArtifactCoordinatorPorts(
        join(root, '.p2-ts04-coordination'),
      );
      const manifestPath = join(root, 'missing-parent', 'manifest.toml');
      const lockPath = join(root, 'missing-parent', 'manifest.lock');
      const pair = pairFor(manifestPath, lockPath);
      const point = 'mkdir:<root>/missing-parent:700';
      const traced = tracePorts(base, root, { failEvent: point, failCode: code, once: true });
      const result = await commitArtifactPair(traced.ports, {
        pair,
        manifest: Object.freeze({ kind: 'replace' as const, bytes: encoder.encode(EDIT_AFTER) }),
        lock: Object.freeze({ kind: 'replace' as const, lock: lockFor(EDIT_AFTER) }),
      });
      expect(result, `${code}:provisioning`).toMatchObject({
        ok: false,
        error: { reason: 'permission-denied', exitCode: 6 },
      });
      expect(await bytesAt(manifestPath)).toBeNull();
      expect(await bytesAt(lockPath)).toBeNull();
      await assertNoInternalResidue(base, root);
    }
    expect(executed.size).toBe(1_030);
    expect(
      {
        count: wrongClassifications.length,
        examples: wrongClassifications.slice(0, 12),
      },
      'capability permission failures used the wrong classification',
    ).toEqual({ count: 0, examples: [] });
  }, 300_000);

  test('SIGKILLs every declared inner physical gap and reaches a safe repeatable terminal state', async () => {
    const fixture = recoveryFixture().physicalGaps;
    const exercised = new Set<string>();
    const physicalResidue = {
      commit: [
        recoveryFixture().physicalCommitResidueStates,
        recoveryFixture().physicalCommitResidueBySelector,
      ],
      resume: [
        recoveryFixture().physicalResumeResidueStates,
        recoveryFixture().physicalResumeResidueBySelector,
      ],
      rollback: [
        recoveryFixture().physicalRollbackResidueStates,
        recoveryFixture().physicalRollbackResidueBySelector,
      ],
      cleanup: [
        recoveryFixture().physicalCleanupResidueStates,
        recoveryFixture().physicalCleanupResidueBySelector,
      ],
      partialFailure: [
        recoveryFixture().physicalPartialFailureResidueStates,
        recoveryFixture().physicalPartialFailureResidueBySelector,
      ],
    } as const;
    for (const path of ['commit', 'resume', 'rollback', 'cleanup'] as const) {
      const seed =
        path === 'cleanup'
          ? COMMITTED_RECOVERY_SEED
          : path === 'rollback'
            ? ROLLBACK_RECOVERY_SEED
            : MIXED_RECOVERY_SEED;
      const direction = path === 'rollback' || path === 'commit' ? 'rollback' : 'resume';
      for (const [index, key] of fixture[path].entries()) {
        const selector = physicalSelectorFromKey(key);
        let root: string;
        let paths: Awaited<ReturnType<typeof prepareCrashPair>>;
        let outcome: CrashWorkerOutcome;
        if (path === 'commit') {
          root = await makeRoot(`physical-${path}-${index}`);
          paths = await prepareCrashPair(root);
          outcome = await runCrashWorker(root, selector, 'SIGKILL', crashCommitStart());
        } else {
          const run = await runSeededRecoveryWorker(
            `physical-${path}-${index}`,
            seed,
            direction,
            selector,
            'SIGKILL',
          );
          ({ root, paths, outcome } = run);
        }
        expect(outcome.reached, `${path}:${key}`).not.toBeNull();
        expect(outcome.exitCode, `${path}:${key}`).not.toBe(0);
        await assertExactCrashResidue(
          root,
          paths,
          outcome,
          `physical|${path}|${key}`,
          physicalResidue[path][0],
          physicalResidue[path][1],
        );
        const preservesUnownedCollision =
          path === 'commit' &&
          selector.area === 'transaction' &&
          (selector.step === 'directory-created' || selector.step === 'owner-opened');
        const foreignCollision = preservesUnownedCollision
          ? await addForeignCollisionSentinel(root)
          : null;
        await expireKilledCentralLock(root);
        const ports = await createTestNodeArtifactCoordinatorPorts(
          join(root, '.p2-ts04-coordination'),
        );
        if (path === 'commit' && selector.area === 'stage' && selector.step === 'file-opened') {
          const resumed = await recoverArtifactPair(ports, paths.pair, 'resume');
          expect(resumed, `${path}:${key}`).toMatchObject({
            ok: false,
            error: { reason: 'recovery-conflict' },
          });
        }
        const recovered = await recoverArtifactPair(ports, paths.pair, direction);
        if (!recovered.ok && recovered.error.reason === 'recovery-record-invalid') {
          expect(await recoverArtifactPair(ports, paths.pair, direction)).toEqual(recovered);
          expect(await readCoordinatedArtifactPair(ports, paths.pair)).toEqual(recovered);
          await assertExactCrashResidue(
            root,
            paths,
            outcome,
            `physical|${path}|${key}`,
            physicalResidue[path][0],
            physicalResidue[path][1],
          );
          exercised.add(`${path}:${key}`);
          continue;
        }
        expect(recovered.ok, `${path}:${key}:${JSON.stringify(recovered)}`).toBeTrue();
        const commitRemovalFinished =
          path === 'commit' &&
          selector.area === 'recovery' &&
          (selector.step === 'file-unlinked' ||
            (selector.step === 'directory-fsynced' &&
              typeof selector.occurrence === 'number' &&
              selector.occurrence >= 11) ||
            (selector.step.startsWith('temp-') &&
              selector.step !== 'temp-opened' &&
              selector.occurrence === 10) ||
            (selector.step.startsWith('temp-') &&
              typeof selector.occurrence === 'number' &&
              selector.occurrence >= 11));
        const shouldBeAfter = path === 'resume' || path === 'cleanup' || commitRemovalFinished;
        expect(await bytesAt(paths.manifestPath), `${path}:${key}`).toEqual(
          encoder.encode(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
        );
        expect(await bytesAt(paths.lockPath), `${path}:${key}`).toEqual(
          lockBytesFor(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
        );
        expect(await recoverArtifactPair(ports, paths.pair, direction)).toEqual({
          ok: true,
          value: 'clean',
        });
        expect(await readCoordinatedArtifactPair(ports, paths.pair)).toMatchObject({ ok: true });
        if (foreignCollision !== null)
          await assertForeignCollisionUnchanged(ports, root, foreignCollision);
        else await assertNoInternalResidue(ports, root);
        exercised.add(`${path}:${key}`);
      }
    }

    for (const [index, partialKey] of fixture.partialFailure.entries()) {
      const partialSelector = physicalSelectorFromKey(partialKey);
      const partialRoot = await makeRoot(`physical-partial-failure-${index}`);
      const partialPaths = await prepareCrashPair(partialRoot);
      const partialOutcome = await runCrashWorker(partialRoot, partialSelector, 'SIGKILL', {
        ...crashCommitStart(),
        operation: 'commit-partial-failure',
        failExclusiveWriteAfterBytes: 7,
      });
      expect(partialOutcome.reached, partialKey).not.toBeNull();
      expect(partialOutcome.exitCode, partialKey).not.toBe(0);
      await assertExactCrashResidue(
        partialRoot,
        partialPaths,
        partialOutcome,
        `physical|partialFailure|${partialKey}`,
        physicalResidue.partialFailure[0],
        physicalResidue.partialFailure[1],
      );
      const preservesUnownedCollision =
        partialSelector.area === 'transaction' &&
        (partialSelector.step === 'directory-created' || partialSelector.step === 'owner-opened');
      const foreignCollision = preservesUnownedCollision
        ? await addForeignCollisionSentinel(partialRoot)
        : null;
      await expireKilledCentralLock(partialRoot);
      const partialPorts = await createTestNodeArtifactCoordinatorPorts(
        join(partialRoot, '.p2-ts04-coordination'),
      );
      const recovered = await recoverArtifactPair(partialPorts, partialPaths.pair, 'rollback');
      if (!recovered.ok && recovered.error.reason === 'recovery-record-invalid') {
        expect(await recoverArtifactPair(partialPorts, partialPaths.pair, 'rollback')).toEqual(
          recovered,
        );
        exercised.add(`partialFailure:${partialKey}`);
        continue;
      }
      expect(recovered, partialKey).toMatchObject({ ok: true });
      expect(await bytesAt(partialPaths.manifestPath), partialKey).toEqual(
        encoder.encode(EDIT_BEFORE),
      );
      expect(await bytesAt(partialPaths.lockPath), partialKey).toEqual(lockBytesFor(EDIT_BEFORE));
      expect(
        await readCoordinatedArtifactPair(partialPorts, partialPaths.pair),
        partialKey,
      ).toMatchObject({
        ok: true,
      });
      if (foreignCollision !== null)
        await assertForeignCollisionUnchanged(partialPorts, partialRoot, foreignCollision);
      else await assertNoInternalResidue(partialPorts, partialRoot);
      exercised.add(`partialFailure:${partialKey}`);
    }
    expect(exercised.size).toBe(
      fixture.commit.length +
        fixture.resume.length +
        fixture.rollback.length +
        fixture.cleanup.length +
        fixture.partialFailure.length,
    );
  }, 300_000);

  test('discovers every crashed overlap before a new pair commit', async () => {
    const names = new Map<string, string>();
    for (const [index, row] of recoveryFixture().overlapFollowups.entries()) {
      const root = await makeRoot(`overlap-crash-${index}`);
      names.set('A', join(root, 'manifest.toml'));
      names.set('B', join(root, 'manifest.lock'));
      names.set('C', join(root, 'C'));
      const outcome = await runCrashWorker(
        root,
        { kind: 'record-durable', cursor: 'prepared' },
        'SIGKILL',
        {
          kind: 'start',
          operation: 'commit',
          manifest: { kind: 'replace', source: EDIT_AFTER },
          lock: { kind: 'replace', lock: lockFor(EDIT_AFTER) },
        },
      );
      expect(outcome.reached).not.toBeNull();
      const manifestPath = names.get(row.requested[0] as string);
      const lockPath = names.get(row.requested[1] as string);
      if (manifestPath === undefined || lockPath === undefined)
        throw new Error('invalid overlap row');
      const ports = await createTestNodeArtifactCoordinatorPorts(
        join(root, '.p2-ts04-coordination'),
      );
      const pair = pairFor(manifestPath, lockPath);
      const request: ArtifactPairMutationRequest = Object.freeze({
        pair,
        manifest: Object.freeze({ kind: 'replace' as const, bytes: encoder.encode(EDIT_AFTER) }),
        lock: Object.freeze({ kind: 'replace' as const, lock: lockFor(EDIT_AFTER) }),
      });
      let committed = await commitArtifactPair(ports, request);
      if (!committed.ok && committed.error.reason === 'lock-contention') {
        await Bun.sleep(2_100);
        committed = await commitArtifactPair(ports, request);
      }
      expect(committed, JSON.stringify(row)).toMatchObject({
        ok: true,
        value: { outcome: 'recovered-and-committed' },
      });
      expect(await bytesAt(manifestPath)).toEqual(encoder.encode(EDIT_AFTER));
      expect(await bytesAt(lockPath)).toEqual(lockBytesFor(EDIT_AFTER));
      expect(await recoverArtifactPair(ports, pair, 'rollback')).toEqual({
        ok: true,
        value: 'clean',
      });
      expect(await readCoordinatedArtifactPair(ports, pair)).toMatchObject({ ok: true });
      await assertNoInternalResidue(ports, root);
    }
  }, 40_000);

  test('a coordinated reader resolves an interrupted mixed pair before exposing bytes', async () => {
    const root = await makeRoot('crash-reader');
    const manifestPath = join(root, 'manifest.toml');
    const lockPath = join(root, 'manifest.lock');
    await writeFile(manifestPath, EDIT_BEFORE, { mode: 0o640 });
    await writeFile(lockPath, lockBytesFor(EDIT_BEFORE), { mode: 0o644 });
    await runCrashWorker(
      root,
      {
        kind: 'mutation-returned',
        cursor: 'lock-install',
        operation: 'link-file-no-replace',
        role: 'lock',
        object: 'live',
      },
      'SIGKILL',
      {
        kind: 'start',
        operation: 'commit',
        manifest: {
          kind: 'edit',
          request: { edits: [{ kind: 'set-default', field: 'scope', value: 'user' }] },
        },
        lock: { kind: 'replace', lock: lockFor(EDIT_AFTER) },
      },
    );
    expect(await bytesAt(manifestPath)).toEqual(encoder.encode(EDIT_BEFORE));
    expect(await bytesAt(lockPath)).toEqual(lockBytesFor(EDIT_AFTER));
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, '.p2-ts04-coordination'));
    const pair = pairFor(manifestPath, lockPath);
    let snapshot = await readCoordinatedArtifactPair(ports, pair);
    if (!snapshot.ok && snapshot.error.reason === 'lock-contention') {
      await Bun.sleep(2_100);
      snapshot = await readCoordinatedArtifactPair(ports, pair);
    }
    expect(snapshot).toMatchObject({
      ok: true,
      value: { manifest: { state: 'file' }, lock: { state: 'file' } },
    });
    if (
      !snapshot.ok ||
      snapshot.value.manifest.state !== 'file' ||
      snapshot.value.lock.state !== 'file'
    ) {
      throw new Error('coordinated reader did not return a complete pair');
    }
    expect(snapshot.value.manifest.bytes).toEqual(encoder.encode(EDIT_BEFORE));
    expect(snapshot.value.lock.bytes).toEqual(lockBytesFor(EDIT_BEFORE));
    expect(await readCoordinatedArtifactPair(ports, pair)).toEqual(snapshot);
    await assertNoInternalResidue(ports, root);
  }, 20_000);

  test('SIGINTs before acquisition and every exact commit/resume/rollback/cleanup barrier', async () => {
    const fixture = recoveryFixture().structuredBarrierTuples;
    const selectors = [
      Object.freeze({ kind: 'before-acquisition' }),
      ...fixture.commit.map(barrierSelectorFromKey),
    ];
    for (const [index, selector] of selectors.entries()) {
      const root = await makeRoot(`sigint-${index}`);
      const paths = await prepareCrashPair(root);
      const outcome = await runCrashWorker(root, selector, 'SIGINT', crashCommitStart());
      const cursor = typeof selector.cursor === 'string' ? selector.cursor : null;
      const durableState =
        selector.kind === 'before-acquisition' ||
        selector.kind === 'lock-acquired' ||
        selector.kind === 'recovery-discovered'
          ? 'unobserved-before'
          : cursor === 'committed' || cursor === 'cleanup' || selector.kind === 'record-removed'
            ? 'after'
            : 'before';
      expect(outcome.result, JSON.stringify(selector)).toMatchObject({
        kind: 'result',
        operation: 'commit',
        result: {
          ok: false,
          error: {
            reason: 'cancelled',
            exitCode: 130,
            durableState,
          },
        },
      });
      const shouldBeAfter = durableState === 'after';
      expect(await bytesAt(paths.manifestPath), JSON.stringify(selector)).toEqual(
        encoder.encode(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
      );
      expect(await bytesAt(paths.lockPath), JSON.stringify(selector)).toEqual(
        lockBytesFor(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
      );
      const ports = await createTestNodeArtifactCoordinatorPorts(
        join(root, '.p2-ts04-coordination'),
      );
      expect(await readCoordinatedArtifactPair(ports, paths.pair)).toMatchObject({
        ok: true,
      });
      await assertNoInternalResidue(ports, root);
    }

    for (const path of ['resume', 'rollback', 'cleanup'] as const) {
      const seed =
        path === 'cleanup'
          ? COMMITTED_RECOVERY_SEED
          : path === 'rollback'
            ? ROLLBACK_RECOVERY_SEED
            : MIXED_RECOVERY_SEED;
      for (const [index, key] of fixture[path].entries()) {
        const selector = barrierSelectorFromKey(key);
        const run = await runSeededCancellationWorker(
          `sigint-${path}-${index}`,
          path,
          seed,
          selector,
        );
        expect(run.outcome.result, `${path}:${key}`).toMatchObject({
          kind: 'result',
          operation: path === 'resume' ? 'recover-then-commit' : 'commit',
          result: {
            ok: false,
            error: {
              reason: 'cancelled',
              exitCode: 130,
              durableState: 'unobserved-before',
            },
          },
        });
        const shouldBeAfter = path !== 'rollback';
        expect(await bytesAt(run.paths.manifestPath), `${path}:${key}`).toEqual(
          encoder.encode(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
        );
        expect(await bytesAt(run.paths.lockPath), `${path}:${key}`).toEqual(
          lockBytesFor(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
        );
        expect(await bytesAt(run.paths.manifestPath), `${path}:${key}:requested-edit`).not.toEqual(
          encoder.encode(EDIT_REQUESTED),
        );
        expect(await bytesAt(run.paths.lockPath), `${path}:${key}:requested-lock`).not.toEqual(
          lockBytesFor(EDIT_REQUESTED),
        );
        const ports = await createTestNodeArtifactCoordinatorPorts(
          join(run.root, '.p2-ts04-coordination'),
        );
        await assertNoInternalResidue(ports, run.root);
      }
    }
  }, 240_000);

  test('a recovery permission failure takes precedence over concurrent cancellation', async () => {
    const root = await makeRoot('cancel-recovery-precedence');
    const scenario = await pairScenario(root, 'present-present');
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const traced = tracePorts(base, root, {
      failEvent: 'recovery.replace:rollback:rollback-manifest-remove',
      failCode: 'EACCES',
      once: true,
    });
    const controller = new AbortController();
    const ports: ArtifactCoordinatorPorts = Object.freeze({
      ...traced.ports,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (barrier.kind === 'record-durable' && barrier.cursor === 'prepared') controller.abort();
      },
    });
    const result = await commitArtifactPair(ports, {
      ...scenario.request,
      signal: controller.signal,
    });
    expect(traced.events).toContain('recovery.replace:rollback:rollback-manifest-remove');
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'permission-denied', exitCode: 6 },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    expect(await recoverArtifactPair(base, scenario.pair, 'rollback')).toMatchObject({ ok: true });
    expect(await readCoordinatedArtifactPair(base, scenario.pair)).toMatchObject({ ok: true });
    await assertNoInternalResidue(base, root);
  });

  test('SIGKILLs every mutation/verification/durable gap including persisted recovery crashes', async () => {
    const fixture = recoveryFixture().structuredBarrierTuples;
    const structuredResidue = {
      commit: [
        recoveryFixture().structuredCommitResidueStates,
        recoveryFixture().structuredCommitResidueBySelector,
      ],
      resume: [
        recoveryFixture().structuredResumeResidueStates,
        recoveryFixture().structuredResumeResidueBySelector,
      ],
      rollback: [
        recoveryFixture().structuredRollbackResidueStates,
        recoveryFixture().structuredRollbackResidueBySelector,
      ],
      cleanup: [
        recoveryFixture().structuredCleanupResidueStates,
        recoveryFixture().structuredCleanupResidueBySelector,
      ],
    } as const;
    const crashable = (keys: readonly string[]) =>
      keys.filter((key) => /^(?:mutation-returned|object-verified|record-durable)\|/u.test(key));
    const commitSelectors = crashable(fixture.commit);
    for (const [index, key] of commitSelectors.entries()) {
      const selector = barrierSelectorFromKey(key);
      const root = await makeRoot(`sigkill-commit-${index}`);
      const paths = await prepareCrashPair(root);
      const outcome = await runCrashWorker(root, selector, 'SIGKILL', crashCommitStart());
      expect(outcome.reached, key).not.toBeNull();
      expect(outcome.exitCode, key).not.toBe(0);
      await assertExactCrashResidue(
        root,
        paths,
        outcome,
        `structured|commit|${key}`,
        structuredResidue.commit[0],
        structuredResidue.commit[1],
      );
      await expireKilledCentralLock(root);
      const ports = await createTestNodeArtifactCoordinatorPorts(
        join(root, '.p2-ts04-coordination'),
      );
      const cursor = typeof selector.cursor === 'string' ? selector.cursor : null;
      const shouldBeAfter = cursor === 'committed' || cursor === 'cleanup';
      const snapshot = await readCoordinatedArtifactPair(ports, paths.pair);
      expect(snapshot.ok, `${key}:${JSON.stringify(snapshot)}`).toBeTrue();
      expect(await bytesAt(paths.manifestPath), key).toEqual(
        encoder.encode(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
      );
      expect(await bytesAt(paths.lockPath), key).toEqual(
        lockBytesFor(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
      );
      expect(await recoverArtifactPair(ports, paths.pair, 'rollback'), key).toEqual({
        ok: true,
        value: 'clean',
      });
      expect(await readCoordinatedArtifactPair(ports, paths.pair), key).toEqual(snapshot);
      await assertNoInternalResidue(ports, root);
    }

    for (const path of ['resume', 'rollback', 'cleanup'] as const) {
      const seed =
        path === 'cleanup'
          ? COMMITTED_RECOVERY_SEED
          : path === 'rollback'
            ? ROLLBACK_RECOVERY_SEED
            : MIXED_RECOVERY_SEED;
      const direction = path === 'rollback' ? 'rollback' : 'resume';
      const selectors = crashable(fixture[path]);
      for (const [index, key] of selectors.entries()) {
        const selector = barrierSelectorFromKey(key);
        const run = await runSeededRecoveryWorker(
          `sigkill-${path}-${index}`,
          seed,
          direction,
          selector,
          'SIGKILL',
        );
        expect(run.outcome.reached, `${path}:${key}`).not.toBeNull();
        expect(run.outcome.exitCode, `${path}:${key}`).not.toBe(0);
        await assertExactCrashResidue(
          run.root,
          run.paths,
          run.outcome,
          `structured|${path}|${key}`,
          structuredResidue[path][0],
          structuredResidue[path][1],
        );
        await expireKilledCentralLock(run.root);
        const ports = await createTestNodeArtifactCoordinatorPorts(
          join(run.root, '.p2-ts04-coordination'),
        );
        const recovered = await recoverArtifactPair(ports, run.paths.pair, direction);
        expect(recovered.ok, `${path}:${key}:${JSON.stringify(recovered)}`).toBeTrue();
        const shouldBeAfter = path !== 'rollback';
        expect(await bytesAt(run.paths.manifestPath), `${path}:${key}`).toEqual(
          encoder.encode(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
        );
        expect(await bytesAt(run.paths.lockPath), `${path}:${key}`).toEqual(
          lockBytesFor(shouldBeAfter ? EDIT_AFTER : EDIT_BEFORE),
        );
        expect(
          await recoverArtifactPair(ports, run.paths.pair, direction),
          `${path}:${key}`,
        ).toEqual({ ok: true, value: 'clean' });
        expect(
          await readCoordinatedArtifactPair(ports, run.paths.pair),
          `${path}:${key}`,
        ).toMatchObject({ ok: true });
        await assertNoInternalResidue(ports, run.root);
      }
    }
  }, 300_000);
});
