import { describe, expect, test } from 'bun:test';
import { artifactContractRegistry } from '../../src/artifacts/registry.ts';
import {
  fromJournalV1Dto,
  fromLedgerV1Dto,
  fromLockV1Dto,
  fromManifestV1Dto,
  fromSavedPlanV1Dto,
  journalV1Codec,
  ledgerV1Codec,
  lockV1Codec,
  manifestV1Codec,
  savedPlanV1Codec,
  toJournalV1Dto,
  toLedgerV1Dto,
  toLockV1Dto,
  toManifestV1Dto,
  toSavedPlanV1Dto,
} from '../../src/contracts/v1/index.ts';
import {
  fromLedgerV2Dto,
  ledgerV2Codec,
  migrateLedgerV1DtoToV2Dto,
  toLedgerV2Dto,
} from '../../src/contracts/v2/index.ts';

describe('artifact contract registry', () => {
  test('owns the single ordered, immutable codec inventory', () => {
    expect(Object.isFrozen(artifactContractRegistry)).toBeTrue();
    expect(Object.isFrozen(artifactContractRegistry.codecs)).toBeTrue();
    expect(
      artifactContractRegistry.codecs.map(
        ({ descriptor }) => `${descriptor.id}@${descriptor.version}`,
      ),
    ).toEqual(['manifest@1', 'lock@1', 'plan@1', 'ledger@1', 'ledger@2', 'journal@1']);
    expect(artifactContractRegistry.latest('manifest')).toBe(manifestV1Codec);
    expect(artifactContractRegistry.latest('ledger')).toBe(ledgerV2Codec);
    expect(artifactContractRegistry.get('ledger', 3)).toBeUndefined();
  });

  test('versioned contract surfaces preserve registry and mapper identity', () => {
    expect(artifactContractRegistry.get('manifest', 1)).toBe(manifestV1Codec);
    expect(artifactContractRegistry.get('lock', 1)).toBe(lockV1Codec);
    expect(artifactContractRegistry.get('plan', 1)).toBe(savedPlanV1Codec);
    expect(artifactContractRegistry.get('ledger', 1)).toBe(ledgerV1Codec);
    expect(artifactContractRegistry.get('ledger', 2)).toBe(ledgerV2Codec);
    expect(artifactContractRegistry.get('journal', 1)).toBe(journalV1Codec);
    expect(manifestV1Codec.toDto).toBe(toManifestV1Dto);
    expect(manifestV1Codec.fromDto).toBe(fromManifestV1Dto);
    expect(lockV1Codec.toDto).toBe(toLockV1Dto);
    expect(lockV1Codec.fromDto).toBe(fromLockV1Dto);
    expect(savedPlanV1Codec.toDto).toBe(toSavedPlanV1Dto);
    expect(savedPlanV1Codec.fromDto).toBe(fromSavedPlanV1Dto);
    expect(ledgerV1Codec.toDto).toBe(toLedgerV1Dto);
    expect(ledgerV1Codec.fromDto).toBe(fromLedgerV1Dto);
    expect(ledgerV2Codec.toDto).toBe(toLedgerV2Dto);
    expect(ledgerV2Codec.fromDto).toBe(fromLedgerV2Dto);
    expect(journalV1Codec.toDto).toBe(toJournalV1Dto);
    expect(journalV1Codec.fromDto).toBe(fromJournalV1Dto);
    expect(typeof migrateLedgerV1DtoToV2Dto).toBe('function');
  });
});
