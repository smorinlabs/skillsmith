import { describe, expect, test } from 'bun:test';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { LedgerModel } from '../../src/artifacts/ledger-types.ts';
import { deriveLedgerProjectRegistrations } from '../../src/artifacts/registry.ts';
import {
  buildGcPlan,
  gcRequestDigest,
  normalizeGcForgetRoots,
  parseGcDuration,
  withoutLedgerProjectAt,
} from '../../src/gc/plan.ts';
import type { GcObjectObservation } from '../../src/gc/types.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';

describe('GC pure request and ledger planning', () => {
  test('accepts only the closed positive duration grammar with safe millisecond products', () => {
    expect(parseGcDuration('1s')).toEqual({
      ok: true,
      value: { input: '1s', milliseconds: 1_000 },
    });
    expect(parseGcDuration('2m')).toEqual({
      ok: true,
      value: { input: '2m', milliseconds: 120_000 },
    });
    expect(parseGcDuration('3h')).toEqual({
      ok: true,
      value: { input: '3h', milliseconds: 10_800_000 },
    });
    for (const value of ['0s', '-1s', '+1s', '1.5h', ' 1h', '1', '1H', '999999999999999999w']) {
      expect(parseGcDuration(value), value).toMatchObject({
        ok: false,
        error: { code: 'invalid-duration' },
      });
    }
  });

  test('normalizes missing roots lexically, preserves first order, and deduplicates exact keys', () => {
    expect(
      normalizeGcForgetRoots('/workspace/current', ['../retired', '../retired', './gone']),
    ).toEqual({
      ok: true,
      value: ['/workspace/retired', '/workspace/current/gone'],
    });
    expect(normalizeGcForgetRoots('/workspace', [''])).toMatchObject({
      ok: false,
      error: { code: 'invalid-forget' },
    });
  });

  test('binds only semantic retry selectors in the recovery request digest', () => {
    const oneHour = parseGcDuration('1h');
    const sixtyMinutes = parseGcDuration('60m');
    if (!oneHour.ok || !sixtyMinutes.ok) throw new Error('duration fixture failed');
    expect(gcRequestDigest(oneHour.value, ['/retired'])).toBe(
      gcRequestDigest(sixtyMinutes.value, ['/retired']),
    );
    expect(gcRequestDigest(oneHour.value, ['/retired'])).not.toBe(
      gcRequestDigest(oneHour.value, ['/different']),
    );
  });

  test('removes exact project subtrees and re-derives registrations without other mutation', () => {
    const base = emptyLedgerModel('2026-07-23T00:00:00.000Z');
    const pair = {
      placementPath: '/retired/.agents/skills/review',
      mode: 'dev' as const,
      dev: {
        sourcePath: '/source/review',
        resolvedPath: '/source/review',
        repoRoot: null,
        sourceRelPath: null,
        remote: null,
        recordedAt: '2026-07-23T00:00:00.000Z',
      },
    };
    const projects = {
      '/retired': { skills: { review: { tools: { codex: pair } } } },
      '/other': { skills: {} },
    };
    const model: LedgerModel = Object.freeze({
      ...base,
      projects,
      projectRegistrations: deriveLedgerProjectRegistrations(projects),
      transactions: Object.freeze({ transaction: {} as never }),
      history: Object.freeze([{} as never]),
    });
    const result = withoutLedgerProjectAt(model, ['/retired']);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.projects).toEqual({ '/other': { skills: {} } });
    expect(result.value.projectRegistrations).toEqual({ '/other': { consumers: [] } });
    expect(result.value.transactions).toBe(model.transactions);
    expect(result.value.history).toBe(model.history);
    expect(model.projects).toHaveProperty('/retired');
    expect(withoutLedgerProjectAt(model, ['/missing'])).toMatchObject({
      ok: false,
      error: { code: 'invalid-forget' },
    });
  });

  test('builds deterministic dependency-ordered actions and an immutable public preview', () => {
    const model = emptyLedgerModel('2026-07-23T00:00:00.000Z');
    const sourceLedger = Object.freeze({
      state: 'present' as const,
      sourceVersion: 1 as const,
      bytes: new Uint8Array([1]),
      byteRevision: `sha256:${'a'.repeat(64)}` as ArtifactDigest,
      semanticRevision: `sha256:${'b'.repeat(64)}` as ArtifactDigest,
      model,
    });
    const object = Object.freeze({
      id: 'fixture/repo@0123456789ab/review',
      kind: 'store' as const,
      path: '/data/store/fixture/repo@0123456789ab/review',
      relativePath: 'fixture/repo@0123456789ab/review',
      namespace: 'fixture',
      repository: 'repo',
      revision: '0123456789ab',
      skill: 'review',
      contentHash: `sha256:${'c'.repeat(64)}` as ArtifactDigest,
      modifiedAt: 1,
      logicalBytes: 6,
      rootIdentity: 'root',
      namespaceIdentity: 'namespace',
      repositoryIdentity: 'repository',
      directoryIdentity: 'directory',
      directoryLinkCount: 2,
      entries: [],
    }) satisfies GcObjectObservation;
    const input = {
      sourceLedger,
      model,
      postForgetModel: model,
      inventory: {
        state: 'ok' as const,
        root: '/data/store',
        rootIdentity: 'root',
        objects: [object],
        issues: [] as const,
      },
      classifications: [
        { object, protection: [], ageEligible: true, outcome: 'eligible' as const },
      ],
      duration: null,
      nowMilliseconds: 100,
      projects: [
        {
          root: '/retired',
          current: false,
          existing: false,
          registered: true,
          requested: true,
          action: 'forget-project' as const,
          outcome: 'planned' as const,
          reason: null,
        },
      ],
      dataDir: '/data',
      storeRoot: '/data/store',
      ledgerPath: '/data/placements.json',
      project: { effectiveCwd: '/workspace', root: '/workspace', identity: 'workspace' },
      retryArguments: ['gc', '--forget-project', '/retired', '--yes'],
      normalizedForgetRoots: ['/retired'],
    };
    const first = buildGcPlan(input);
    const second = buildGcPlan(structuredClone(input));
    const migrationAction = first.actions[0];
    const forgetAction = first.actions[1];
    if (migrationAction === undefined || forgetAction === undefined) {
      throw new Error('expected migration and forget actions');
    }
    expect(second).toEqual(first);
    expect(first.actions.map(({ kind }) => kind)).toEqual([
      'migrate-ledger',
      'forget-project',
      'reclaim-store',
    ]);
    expect(first.actions[1]?.dependencyIds).toEqual([migrationAction.actionId]);
    expect(first.actions[2]?.dependencyIds).toEqual([
      migrationAction.actionId,
      forgetAction.actionId,
    ]);
    expect(first.report.summary).toMatchObject({ eligibleItems: 1, eligibleBytes: 6 });
    expect(Object.isFrozen(first.report)).toBeTrue();
    expect(Object.isFrozen(first.report.actions)).toBeTrue();
  });
});
