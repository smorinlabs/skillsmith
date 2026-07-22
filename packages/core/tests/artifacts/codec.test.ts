import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ARTIFACT_MAX_NODES,
  LEDGER_ARTIFACT_MAX_NODES,
  artifactCodecError,
  canonicalJsonBytes,
  decodeArtifactUtf8,
  deepOwnFreeze,
  hasSensitiveArtifactContent,
  ownArtifactBytes,
  ownArtifactReadBytes,
  unsignedUtf16Compare,
} from '../../src/artifacts/codec.ts';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import type { LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
import {
  operationMatchesMatrix,
  validatePlanOperationIntentShapeV1,
} from '../../src/artifacts/plan-codec.ts';
import type { PlanOperationIntentV1, PlanOperationV1 } from '../../src/artifacts/plan-types.ts';
import { legacyJournalMatchesLogicalShadow } from '../../src/artifacts/registry.ts';

const decoder = new TextDecoder();

describe('artifact codec foundation', () => {
  test('keeps local pinned-copy sync intent journal-only and exact', () => {
    const hash = `sha256:${'a'.repeat(64)}` as ArtifactDigest;
    const source = { kind: 'local-dev' as const, path: '/fixture/source/alpha', contentHash: hash };
    const resource = {
      kind: 'live' as const,
      skill: 'alpha',
      tool: 'codex' as const,
      scope: 'user' as const,
      projectRoot: null,
      location: { kind: 'machine-bound' as const, path: '/fixture/live/alpha' },
    };
    const intent: PlanOperationIntentV1 = {
      operationId: 'operation:local-install',
      groupId: 'group:alpha',
      pairId: 'pair:alpha:codex',
      kind: 'install',
      skill: 'alpha',
      source,
      tool: 'codex',
      scope: 'user',
      before: { kind: 'absent', resource },
      after: {
        kind: 'placement',
        resource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source,
        contentHash: hash,
      },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      reversibility: { kind: 'none', retentionResourceIds: [] },
      conflict: null,
    };
    const savedOperation: PlanOperationV1 = {
      ...intent,
      dependsOn: [],
      reason: { code: 'sync-install-selected', message: 'Install alpha.' },
      selectionSource: 'bounded-default',
      preconditionIds: [],
      requiredCheckIds: [],
    };

    expect(operationMatchesMatrix(savedOperation)).toBeFalse();
    expect(validatePlanOperationIntentShapeV1(intent)).toMatchObject({ ok: true });
    for (const incompatible of [
      { ...intent, after: { ...intent.after, representation: 'symlink' as const } },
      { ...intent, after: { ...intent.after, linkTarget: resource.location } },
      {
        ...intent,
        after: { ...intent.after, contentHash: `sha256:${'b'.repeat(64)}` as const },
      },
      { ...intent, kind: 'promote' as const },
      { ...intent, kind: 'update' as const, before: intent.before },
    ]) {
      expect(validatePlanOperationIntentShapeV1(incompatible)).toMatchObject({ ok: false });
    }
    expect(
      validatePlanOperationIntentShapeV1({
        ...intent,
        kind: 'update',
        before: {
          ...intent.after,
          contentHash: `sha256:${'b'.repeat(64)}`,
        },
      }),
    ).toMatchObject({ ok: true });
  });

  test('constructs fixed secret-safe errors and bounds schema paths', () => {
    expect(
      artifactCodecError('plan', 2, 'unsupported-version', ['schemaVersion', 'x'.repeat(65), -1]),
    ).toEqual({
      code: 'artifact-codec',
      artifactId: 'plan',
      requestedVersion: 2,
      reason: 'unsupported-version',
      path: ['schemaVersion', '*', '*'],
      exitCode: 3,
      message: 'artifact version is not supported',
    });
    expect(artifactCodecError('manifest', Number.NaN, 'invalid-shape').requestedVersion).toBeNull();
  });

  test('owns ordinary bytes and refuses shared, subclassed, and hostile views', () => {
    const source = Uint8Array.of(1, 2, 3);
    const owned = ownArtifactBytes('plan', source, 1);
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    source[0] = 9;
    expect([...owned.value]).toEqual([1, 2, 3]);

    const buffer = Buffer.from([1]);
    expect(ownArtifactBytes('plan', buffer, 1).ok).toBe(false);
    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(ownArtifactBytes('plan', new Uint8Array(new SharedArrayBuffer(1)), 1).ok).toBe(false);
    }
    let shadowReads = 0;
    const shadowed = Uint8Array.of(1);
    Object.defineProperty(shadowed, 'buffer', {
      configurable: true,
      get: () => {
        shadowReads += 1;
        return new ArrayBuffer(1);
      },
    });
    expect(ownArtifactBytes('plan', shadowed, 1).ok).toBe(false);
    expect(shadowReads).toBe(0);
    let traps = 0;
    const hostile = new Proxy(source, {
      getPrototypeOf: () => {
        traps += 1;
        return Uint8Array.prototype;
      },
    });
    expect(ownArtifactBytes('plan', hostile, 1).ok).toBe(false);
    expect(traps).toBe(0);
  });

  test('fatal-decodes owned UTF-8 and rejects BOM and malformed input', () => {
    const decoded = decodeArtifactUtf8('journal', new TextEncoder().encode('{"ok":true}\n'), 1);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.source).toBe('{"ok":true}\n');
    expect(decodeArtifactUtf8('journal', Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b), 1).ok).toBe(false);
    expect(decodeArtifactUtf8('journal', Uint8Array.of(0xc3, 0x28), 1).ok).toBe(false);
  });

  test('copies filesystem Buffers only at the read and UTF-8 decode boundaries', () => {
    const source = Buffer.from('{"ok":true}\n');
    const readBytes = ownArtifactReadBytes('plan', source, 1);
    expect(readBytes.ok).toBe(true);
    const decoded = decodeArtifactUtf8('plan', source, 1);
    expect(decoded.ok).toBe(true);
    if (!readBytes.ok || !decoded.ok) return;
    source.fill(0);
    expect(decoder.decode(readBytes.value)).toBe('{"ok":true}\n');
    expect(Object.getPrototypeOf(readBytes.value)).toBe(Uint8Array.prototype);
    expect(decoder.decode(decoded.value.bytes)).toBe('{"ok":true}\n');
    expect(Object.getPrototypeOf(decoded.value.bytes)).toBe(Uint8Array.prototype);
    expect(ownArtifactBytes('plan', Buffer.from([1]), 1).ok).toBe(false);
  });

  test('deeply owns and freezes plain data without invoking accessors or proxy traps', () => {
    const source = { nested: [{ value: 1 }] };
    const owned = deepOwnFreeze<typeof source>('ledger', source, 2);
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    const sourceLeaf = source.nested[0];
    if (sourceLeaf) sourceLeaf.value = 2;
    expect(owned.value.nested[0]?.value).toBe(1);
    expect(Object.isFrozen(owned.value)).toBe(true);
    expect(Object.isFrozen(owned.value.nested)).toBe(true);
    expect(Object.isFrozen(owned.value.nested[0])).toBe(true);

    const protoKey = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const ownedProtoKey = deepOwnFreeze<Record<string, unknown>>('ledger', protoKey, 2);
    expect(ownedProtoKey.ok).toBe(true);
    if (ownedProtoKey.ok) {
      expect(Object.hasOwn(ownedProtoKey.value, '__proto__')).toBeTrue();
      expect(Object.getOwnPropertyDescriptor(ownedProtoKey.value, '__proto__')?.value).toEqual({
        polluted: true,
      });
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    }

    let reads = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'value';
      },
    });
    expect(deepOwnFreeze('ledger', accessor, 2).ok).toBe(false);
    expect(reads).toBe(0);
    const sensitiveKeyAccessor = Object.defineProperty({}, 'ghp_P17_SECRET_CANARY_123456789', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'value';
      },
    });
    const sensitiveKeyResult = deepOwnFreeze('ledger', sensitiveKeyAccessor, 2);
    expect(sensitiveKeyResult.ok).toBe(false);
    expect(JSON.stringify(sensitiveKeyResult)).not.toContain('P17_SECRET_CANARY');
    expect(reads).toBe(0);
    const dynamicKeyAccessor = Object.defineProperty({}, 'private-project-alpha', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'value';
      },
    });
    const dynamicKeyResult = deepOwnFreeze('lock', dynamicKeyAccessor, 1);
    expect(dynamicKeyResult.ok).toBe(false);
    if (!dynamicKeyResult.ok) expect(dynamicKeyResult.error.path).toEqual(['*']);
    expect(JSON.stringify(dynamicKeyResult)).not.toContain('private-project-alpha');
    expect(reads).toBe(0);
    expect(deepOwnFreeze('ledger', new Proxy({}, {}), 2).ok).toBe(false);
    const sparse = Array.from({ length: 3 }) as unknown[];
    sparse[0] = 1;
    sparse[2] = 3;
    Reflect.deleteProperty(sparse, '1');
    expect(deepOwnFreeze('ledger', sparse, 2).ok).toBe(false);
  });

  test('detects recursive sensitive content and fails closed on hostile values', () => {
    expect(hasSensitiveArtifactContent({ nested: ['safe', 'authorization=Bearer abcdefgh'] })).toBe(
      true,
    );
    expect(hasSensitiveArtifactContent({ nested: ['safe', 'P17_SECRET_CANARY'] })).toBe(true);
    expect(hasSensitiveArtifactContent({ nested: ['safe', 'sha256:abcd'] })).toBe(false);
    expect(hasSensitiveArtifactContent(new Proxy({}, {}))).toBe(true);
  });

  test('keeps the default ownership cap while permitting the bounded ledger history budget', () => {
    const aboveDefault = Array.from({ length: DEFAULT_ARTIFACT_MAX_NODES }, () => null);
    const ledgerLimits = { maxNodes: LEDGER_ARTIFACT_MAX_NODES } as const;
    expect(deepOwnFreeze('manifest', aboveDefault, 1).ok).toBeFalse();
    expect(hasSensitiveArtifactContent(aboveDefault)).toBeTrue();
    expect(deepOwnFreeze('ledger', aboveDefault, 2, ledgerLimits).ok).toBeTrue();
    expect(hasSensitiveArtifactContent(aboveDefault, ledgerLimits)).toBeFalse();

    const aboveLedger = Array.from({ length: LEDGER_ARTIFACT_MAX_NODES }, () => null);
    expect(deepOwnFreeze('ledger', aboveLedger, 2, ledgerLimits).ok).toBeFalse();
    expect(hasSensitiveArtifactContent(aboveLedger, ledgerLimits)).toBeTrue();
  });

  test('emits deterministic JSON bytes with the requested framing', () => {
    const dto = { schemaVersion: 1, kind: 'skillsmith.plan', values: ['b', 'a'] };
    const framed = canonicalJsonBytes('plan', dto, 1, true);
    expect(framed.ok).toBe(true);
    if (!framed.ok) return;
    expect(decoder.decode(framed.value)).toBe(`${JSON.stringify(dto, null, 2)}\n`);
    const compatibility = canonicalJsonBytes('ledger', dto, 1, false);
    expect(compatibility.ok).toBe(true);
    if (compatibility.ok) expect(decoder.decode(compatibility.value).endsWith('\n')).toBe(false);
  });

  test('compares unsigned UTF-16 strings without locale state', () => {
    expect(['z', 'a', 'ä'].sort(unsignedUtf16Compare)).toEqual(['a', 'z', 'ä']);
  });

  test('accepts only install and promote physical shadows for logical update and repair journals', () => {
    const placementPath = '/home/fixture/.agents/skills/alpha';
    const transactionId = 'transaction:update-alpha';
    const startedAt = '2026-07-15T00:00:00.000Z';
    const liveResource = {
      kind: 'live' as const,
      skill: 'alpha',
      tool: 'fixture-tool',
      scope: 'user' as const,
      projectRoot: null,
      location: { kind: 'machine-bound' as const, path: placementPath },
    };
    const logical = {
      transactionId,
      disposition: 'forward',
      phase: 'prepared',
      completedAt: null,
      context: { startedAt },
      intent: {
        kind: 'update',
        pairId: 'pair:alpha:fixture-tool',
        skill: 'alpha',
        tool: 'fixture-tool',
        scope: 'user',
        before: { kind: 'absent', resource: liveResource },
        after: { kind: 'absent', resource: liveResource },
      },
      actual: {
        before: [],
        after: [{ role: 'live', placementPath }],
      },
    } as unknown as LogicalJournalV1Dto;
    const matches = (op: NonNullable<LedgerPairV1Dto['journal']>['op']): boolean =>
      legacyJournalMatchesLogicalShadow(
        logical,
        { projectRoot: null, skill: 'alpha', tool: 'fixture-tool' },
        {
          placementPath,
          journal: {
            op,
            txId: transactionId,
            phase: 'prepared',
            startedAt,
            completedAt: null,
          },
        } as LedgerPairV1Dto,
      );

    expect((['install', 'promote'] as const).map(matches)).toEqual([true, true]);
    expect((['uninstall', 'dev', 'rollback'] as const).map(matches)).toEqual([false, false, false]);
    const repair = {
      ...logical,
      intent: { ...logical.intent, kind: 'repair' },
    } as unknown as LogicalJournalV1Dto;
    const repairMatches = (op: NonNullable<LedgerPairV1Dto['journal']>['op']): boolean =>
      legacyJournalMatchesLogicalShadow(
        repair,
        { projectRoot: null, skill: 'alpha', tool: 'fixture-tool' },
        {
          placementPath,
          journal: {
            op,
            txId: transactionId,
            phase: 'prepared',
            startedAt,
            completedAt: null,
          },
        } as LedgerPairV1Dto,
      );
    expect((['install', 'promote'] as const).map(repairMatches)).toEqual([true, true]);
    expect((['uninstall', 'dev', 'rollback'] as const).map(repairMatches)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test('accepts an install shadow only for the symlink re-pin subset of logical promote', () => {
    const placementPath = '/home/fixture/.claude/skills/alpha';
    const transactionId = 'transaction:repin-alpha';
    const startedAt = '2026-07-15T00:00:00.000Z';
    const liveResource = {
      kind: 'live' as const,
      skill: 'alpha',
      tool: 'claude-code',
      scope: 'user' as const,
      projectRoot: null,
      location: { kind: 'machine-bound' as const, path: placementPath },
    };
    const logical = {
      transactionId,
      disposition: 'forward',
      phase: 'prepared',
      completedAt: null,
      context: { startedAt },
      intent: {
        kind: 'promote',
        pairId: 'pair:alpha:claude-code',
        skill: 'alpha',
        tool: 'claude-code',
        scope: 'user',
        before: {
          kind: 'placement',
          resource: liveResource,
          classification: 'dev',
          representation: 'symlink',
        },
        after: {
          kind: 'placement',
          resource: liveResource,
          classification: 'pinned',
          representation: 'copy',
        },
      },
      actual: { before: [], after: [{ role: 'live', placementPath }] },
    } as unknown as LogicalJournalV1Dto;
    const pair = (op: 'install' | 'promote'): LedgerPairV1Dto =>
      ({
        placementPath,
        journal: {
          op,
          txId: transactionId,
          phase: 'prepared',
          startedAt,
          completedAt: null,
        },
      }) as LedgerPairV1Dto;
    const identity = { projectRoot: null, skill: 'alpha', tool: 'claude-code' } as const;

    expect(legacyJournalMatchesLogicalShadow(logical, identity, pair('install'))).toBeTrue();
    expect(legacyJournalMatchesLogicalShadow(logical, identity, pair('promote'))).toBeTrue();
    expect(
      legacyJournalMatchesLogicalShadow(
        {
          ...logical,
          intent: {
            ...logical.intent,
            before: { ...logical.intent.before, representation: 'copy' },
          },
        } as unknown as LogicalJournalV1Dto,
        identity,
        pair('install'),
      ),
    ).toBeFalse();
  });
});
