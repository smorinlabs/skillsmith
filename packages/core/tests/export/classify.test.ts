import { describe, expect, test } from 'bun:test';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
import { classifyExport } from '../../src/export/classify.ts';
import type { ExportObservation } from '../../src/export/observe.ts';
import type { SkillInventoryEntry } from '../../src/inventory/types.ts';

const entry = (scope: SkillInventoryEntry['scope']): SkillInventoryEntry =>
  Object.freeze({
    name: 'alpha',
    tool: 'claude-code',
    scope,
    path: '/machine/alpha',
    realpath: '/machine/alpha',
    root: '/machine',
    frontmatter: null,
    origin: { kind: 'standalone' as const },
    enabled: 'on' as const,
    mode: 'unmanaged' as const,
    placement: 'copy' as const,
    source: null,
    revision: null,
    store: null,
    verification: 'unrecorded' as const,
    description: null,
    visibility: Object.freeze({
      state: 'unique' as const,
      members: Object.freeze([]),
      winner: null,
    }),
  });

const observation = (entries: readonly SkillInventoryEntry[]): ExportObservation =>
  ({
    project: { projectRoot: null },
    sourceProjectRoot: null,
    homeDir: '/home/fixture',
    request: {},
    pair: null,
    inventory: {
      selection: {
        source: 'bounded-default',
        tools: ['claude-code'],
        scopes: ['system'],
        filters: {},
        outcome: 'selected',
      },
      entries,
      collisionGroups: [],
    },
    entries: entries.map((candidate) => ({
      entry: candidate,
      ledgerPair: null,
      liveContentHash: null,
      git: null,
      defaultLocation: true,
    })),
    ledger: { state: 'absent', artifact: 'ledger', migration: null },
    ledgerPath: '/state/placements.json',
    manifest: null,
    lock: null,
  }) as unknown as ExportObservation;

const managedObservation = (
  input: {
    readonly name?: string;
    readonly path?: string;
    readonly defaultLocation?: boolean;
    readonly source?: string;
    readonly requestedRef?: string;
    readonly liveContentHash?: ArtifactDigest;
    readonly portableContentHash?: ArtifactDigest | null;
  } = {},
): ExportObservation => {
  const contentHash = `sha256:${'b'.repeat(64)}` as ArtifactDigest;
  const path = input.path ?? '/home/fixture/.claude/skills/alpha';
  const candidate = Object.freeze({
    ...entry('user'),
    name: input.name ?? 'alpha',
    path,
    realpath: path,
    root: '/home/fixture/.claude/skills',
    mode: 'pinned' as const,
    placement: 'copy' as const,
  });
  const pair: LedgerPairV1Dto = Object.freeze({
    placementPath: path,
    mode: 'pinned',
    dev: null,
    pinned: Object.freeze({
      storePath: '/state/store/alpha',
      rev: 'a'.repeat(12),
      gitSha: 'a'.repeat(40),
      dirty: false,
      contentHash,
      snapshotAt: '2026-07-18T00:00:00.000Z',
      verify: 'skipped',
      placement: 'copy',
    }),
    origin: Object.freeze({
      source: input.source ?? 'github.com/acme/skills//alpha',
      host: 'github.com',
      repo: 'acme/skills',
      skillPath: 'alpha',
      refRequested: input.requestedRef ?? 'main',
      refResolved: 'a'.repeat(40),
      pin: false,
      installedAt: '2026-07-18T00:00:00.000Z',
    }),
    journal: null,
  });
  return {
    ...observation([candidate]),
    request: { tools: ['claude-code'], scope: 'user' },
    entries: [
      {
        entry: candidate,
        ledgerPair: pair,
        liveContentHash: input.liveContentHash ?? contentHash,
        portableContentHash:
          input.portableContentHash === undefined
            ? (`sha256:${'d'.repeat(64)}` as ArtifactDigest)
            : input.portableContentHash,
        git: null,
        defaultLocation: input.defaultLocation ?? true,
      },
    ],
    ledger: {
      state: 'present',
      model: {
        skills: { alpha: { tools: { 'claude-code': pair } } },
        projects: {},
        projectRegistrations: {},
        transactions: {},
        history: [],
      },
    },
  } as unknown as ExportObservation;
};

describe('export classification', () => {
  test('sanitizes nonrepresentable scopes without reading live content', () => {
    const result = classifyExport(observation([entry('system')]));
    expect(result.ok).toBeTrue();
    expect(result.ok && result.value.portable).toEqual([]);
    expect(result.ok && result.value.results).toEqual([
      {
        name: 'alpha',
        tools: ['claude-code'],
        scope: 'system',
        classification: 'unsupported-scope',
        action: 'skipped',
        reason: 'unsupported-scope',
      },
    ]);
  });

  test('refuses a pending ledger transaction before classifying entries', () => {
    const withTransaction = {
      ...observation([]),
      ledger: {
        state: 'present',
        model: { transactions: { pending: {} } },
      },
    } as unknown as ExportObservation;
    const result = classifyExport(withTransaction);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'export-pending-ledger-transaction', exitClass: 'state' },
    });
  });

  test('maps only home-contained custom roots and omits the adapter default path', () => {
    const defaultResult = classifyExport(managedObservation());
    expect(defaultResult.ok && defaultResult.value.portable[0]?.path).toBeNull();

    const custom = classifyExport(
      managedObservation({
        path: '/home/fixture/portable/custom/alpha',
        defaultLocation: false,
      }),
    );
    expect(custom.ok && custom.value.portable[0]?.path).toBe('~/portable/custom');

    const outside = classifyExport(
      managedObservation({ path: '/opt/machine-only/alpha', defaultLocation: false }),
    );
    expect(outside.ok && outside.value.results[0]).toMatchObject({
      action: 'skipped',
      reason: 'invalid-path',
    });
  });

  test('scrubs credential sources and live-content mismatches into closed skip reasons', () => {
    const canary = 'user:synthetic-secret';
    const credential = classifyExport(
      managedObservation({ source: `https://${canary}@github.com/acme/skills//alpha` }),
    );
    expect(credential.ok && credential.value.results[0]).toMatchObject({
      action: 'skipped',
      reason: 'invalid-source',
    });
    expect(JSON.stringify(credential)).not.toContain(canary);

    const mismatch = classifyExport(
      managedObservation({ liveContentHash: `sha256:${'c'.repeat(64)}` as ArtifactDigest }),
    );
    expect(mismatch.ok && mismatch.value.results[0]).toMatchObject({
      action: 'skipped',
      reason: 'live-content-mismatch',
    });
  });

  test('keeps the legacy digest as an integrity gate but exports only the exact portable digest', () => {
    const portableContentHash = `sha256:${'e'.repeat(64)}` as ArtifactDigest;
    const exact = classifyExport(managedObservation({ portableContentHash }));
    expect(exact.ok && exact.value.portable[0]?.contentHash).toBe(portableContentHash);

    const unavailable = classifyExport(managedObservation({ portableContentHash: null }));
    expect(unavailable.ok && unavailable.value.results[0]).toMatchObject({
      action: 'skipped',
      reason: 'invalid-content',
    });
  });

  test('sanitizes invalid manifest names and requested refs before candidate creation', () => {
    const invalidName = classifyExport(managedObservation({ name: 'bad name' }));
    expect(invalidName.ok && invalidName.value.portable).toEqual([]);
    expect(invalidName.ok && invalidName.value.results[0]).toMatchObject({
      name: 'invalid-name',
      action: 'skipped',
      reason: 'invalid-source',
    });

    const invalidRef = classifyExport(managedObservation({ requestedRef: 'bad ref' }));
    expect(invalidRef.ok && invalidRef.value.portable).toEqual([]);
    expect(invalidRef.ok && invalidRef.value.results[0]).toMatchObject({
      name: 'alpha',
      action: 'skipped',
      reason: 'invalid-source',
    });
  });
});
