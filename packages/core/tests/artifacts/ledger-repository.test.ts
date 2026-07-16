import { describe, expect, test } from 'bun:test';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import { createLedgerRepository } from '../../src/artifacts/ledger-repository.ts';
import type { LedgerWriter } from '../../src/artifacts/ledger-writer.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';

const digest = (hex: string): ArtifactDigest => `sha256:${hex.repeat(64)}` as ArtifactDigest;

describe('private ledger repository adapter', () => {
  test('maps a canonical writer observation into one immutable expected revision', async () => {
    const ledgerPath = '/fixture/data/placements.json';
    const model = emptyLedgerModel('2026-07-16T00:00:00.000Z');
    const writer = {
      ledgerPath,
      recoveryPointerPath: '/fixture/data/recovery/ledger.json',
      read: async () => ({
        ok: true as const,
        value: Object.freeze({
          state: 'present' as const,
          sourceVersion: 2 as const,
          bytes: new Uint8Array([1, 2, 3]),
          byteRevision: digest('a'),
          semanticRevision: digest('b'),
          model,
        }),
      }),
    } as LedgerWriter;
    const repository = createLedgerRepository({
      resourceId: 'ledger:user',
      writer,
      metadata: {
        readFileMetadata: async (path) =>
          path === ledgerPath
            ? { kind: 'file', mode: 0o600, identity: 'target:1', linkCount: 1 }
            : { kind: 'dir', mode: 0o700, identity: 'parent:1', linkCount: 1 },
      },
    });

    const observed = await repository.observe('ledger:user');

    expect(observed.ok).toBeTrue();
    if (!observed.ok) return;
    expect(observed.value.value).toBe(model);
    expect(observed.value.revision).toMatchObject({
      domain: 'ledger',
      resourceId: 'ledger:user',
      state: 'present',
      byteRevision: digest('a'),
      semanticRevision: digest('b'),
    });
    expect(Object.isFrozen(observed.value)).toBeTrue();
    expect(Object.isFrozen(observed.value.revision)).toBeTrue();
  });

  test('refuses another resource and another domain before logical staging', async () => {
    const ledgerPath = '/fixture/data/placements.json';
    const repository = createLedgerRepository({
      resourceId: 'ledger:user',
      writer: {
        ledgerPath,
        recoveryPointerPath: '/fixture/data/recovery/ledger.json',
        read: async () => ({
          ok: true as const,
          value: Object.freeze({
            state: 'absent' as const,
            sourceVersion: null,
            bytes: null,
            byteRevision: null,
            semanticRevision: null,
            model: null,
          }),
        }),
      } as LedgerWriter,
      metadata: {
        readFileMetadata: async (path) =>
          path === ledgerPath
            ? { kind: 'absent', mode: null, identity: null, linkCount: 0 }
            : { kind: 'dir', mode: 0o700, identity: 'parent:1', linkCount: 1 },
      },
    });

    expect(await repository.observe('ledger:other')).toEqual({
      ok: false,
      error: {
        code: 'state-repository',
        domain: 'ledger',
        reason: 'invalid-request',
      },
    });
    expect(
      await repository.stage({
        schemaVersion: 1,
        operationId: 'operation:fixture',
        domain: 'live',
        resourceId: 'ledger:user',
        expectedRevision: {} as never,
        editDigest: digest('c'),
      }),
    ).toEqual({ ok: false, error: { code: 'invalid-logical-stage' } });
  });

  test('ignores transient sibling lock link-count changes in the parent revision', async () => {
    const ledgerPath = '/fixture/data/placements.json';
    let parentLinkCount = 2;
    let parentMode = 0o700;
    let parentIdentity = 'parent:1';
    const repository = createLedgerRepository({
      resourceId: 'ledger:user',
      writer: {
        ledgerPath,
        recoveryPointerPath: '/fixture/data/recovery/ledger.json',
        read: async () => ({
          ok: true as const,
          value: Object.freeze({
            state: 'absent' as const,
            sourceVersion: null,
            bytes: null,
            byteRevision: null,
            semanticRevision: null,
            model: null,
          }),
        }),
      } as LedgerWriter,
      metadata: {
        readFileMetadata: async (path) =>
          path === ledgerPath
            ? { kind: 'absent', mode: null, identity: null, linkCount: 0 }
            : {
                kind: 'dir',
                mode: parentMode,
                identity: parentIdentity,
                linkCount: parentLinkCount,
              },
      },
    });
    const beforeLock = await repository.observeRevision('ledger:user');
    parentLinkCount += 1;
    const whileLocked = await repository.observeRevision('ledger:user');
    parentMode = 0o750;
    const afterModeChange = await repository.observeRevision('ledger:user');
    parentMode = 0o700;
    parentIdentity = 'parent:2';
    const afterReplacement = await repository.observeRevision('ledger:user');

    expect(beforeLock).toEqual(whileLocked);
    expect(afterModeChange).not.toEqual(beforeLock);
    expect(afterReplacement).not.toEqual(beforeLock);
  });

  test('reobserves under staging authority and rejects a forged caller observation', async () => {
    const ledgerPath = '/fixture/data/placements.json';
    const model = emptyLedgerModel('2026-07-16T00:00:00.000Z');
    let byteRevision = digest('a');
    const repository = createLedgerRepository({
      resourceId: 'ledger:user',
      writer: {
        ledgerPath,
        recoveryPointerPath: '/fixture/data/recovery/ledger.json',
        read: async () => ({
          ok: true as const,
          value: Object.freeze({
            state: 'present' as const,
            sourceVersion: 2 as const,
            bytes: new Uint8Array([1]),
            byteRevision,
            semanticRevision: digest('b'),
            model,
          }),
        }),
      } as LedgerWriter,
      metadata: {
        readFileMetadata: async (path) =>
          path === ledgerPath
            ? { kind: 'file', mode: 0o600, identity: 'target:1', linkCount: 1 }
            : { kind: 'dir', mode: 0o700, identity: 'parent:1', linkCount: 1 },
      },
    });
    const initial = await repository.observeRevision('ledger:user');
    expect(initial.ok).toBeTrue();
    if (!initial.ok) return;
    byteRevision = digest('c');

    const staged = await repository.stage({
      schemaVersion: 1,
      operationId: 'operation:fixture',
      domain: 'ledger',
      resourceId: 'ledger:user',
      expectedRevision: initial.value,
      editDigest: digest('d'),
      observedRevision: initial.value,
    } as never);

    expect(staged).toEqual({
      ok: false,
      error: { code: 'stale-revision', domain: 'ledger', resourceId: 'ledger:user' },
    });
  });
});
