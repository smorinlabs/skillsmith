import type { ArtifactCodec, ArtifactContractRegistry, ArtifactId } from './codec.ts';
import {
  journalV1Codec,
  validateJournalV1Dto,
  validateJournalV1DtoShape,
} from './journal-codec.ts';
import {
  deriveLedgerProjectRegistrations,
  describeLedgerV1Migration,
  fromLedgerV1Dto,
  fromLedgerV2Dto,
  ledgerByteRevision,
  ledgerSemanticRevision,
  ledgerV1Codec,
  ledgerV2Codec,
  legacyJournalMatchesLogicalShadow,
  legacyJournalOperationMatchesLogicalShadow,
  logicalJournalPairIdentity,
  toLedgerV2Dto,
  validateLedgerV1Dto,
} from './ledger-codec.ts';
import type { LedgerModel, LedgerV1Dto, LedgerV2Dto } from './ledger-types.ts';
import { lockV1Codec } from './lock-codec.ts';
import { manifestV1Codec } from './manifest-codec.ts';
import {
  ownArtifactDto,
  savedPlanV1Codec,
  validatePlanExecutionGuardsV1,
  validatePlanOperationIntentShapeV1,
  validatePlanOperationIntentV1,
} from './plan-codec.ts';

let codecs: readonly ArtifactCodec[] | undefined;

const contractCodecs = (): readonly ArtifactCodec[] => {
  codecs ??= Object.freeze([
    manifestV1Codec,
    lockV1Codec,
    savedPlanV1Codec,
    ledgerV1Codec,
    ledgerV2Codec,
    journalV1Codec,
  ] satisfies readonly ArtifactCodec[]);
  return codecs;
};

export const artifactContractRegistry: ArtifactContractRegistry = Object.freeze({
  get codecs(): readonly ArtifactCodec[] {
    return contractCodecs();
  },
  get(id: ArtifactId, version: number): ArtifactCodec | undefined {
    return contractCodecs().find(
      ({ descriptor }) => descriptor.id === id && descriptor.version === version,
    );
  },
  latest(id: ArtifactId): ArtifactCodec | undefined {
    let latest: ArtifactCodec | undefined;
    for (const codec of contractCodecs()) {
      if (
        codec.descriptor.id === id &&
        (latest === undefined || codec.descriptor.version > latest.descriptor.version)
      ) {
        latest = codec;
      }
    }
    return latest;
  },
});

export function resolveLedgerArtifactCodec(
  version: 1,
): ArtifactCodec<'ledger', 1, LedgerV1Dto, LedgerModel>;
export function resolveLedgerArtifactCodec(
  version: 2,
): ArtifactCodec<'ledger', 2, LedgerV2Dto, LedgerModel>;
export function resolveLedgerArtifactCodec(
  version: 1 | 2,
): ArtifactCodec<'ledger', 1 | 2, LedgerV1Dto | LedgerV2Dto, LedgerModel> {
  const codec = artifactContractRegistry.get('ledger', version);
  if (codec === undefined) throw new TypeError(`ledger artifact codec ${version} is unavailable`);
  return codec as ArtifactCodec<'ledger', 1 | 2, LedgerV1Dto | LedgerV2Dto, LedgerModel>;
}

export {
  deriveLedgerProjectRegistrations,
  describeLedgerV1Migration,
  fromLedgerV1Dto,
  fromLedgerV2Dto,
  legacyJournalOperationMatchesLogicalShadow,
  legacyJournalMatchesLogicalShadow,
  ledgerByteRevision,
  ledgerSemanticRevision,
  logicalJournalPairIdentity,
  ownArtifactDto,
  toLedgerV2Dto,
  validateJournalV1Dto,
  validateJournalV1DtoShape,
  validateLedgerV1Dto,
  validatePlanExecutionGuardsV1,
  validatePlanOperationIntentShapeV1,
  validatePlanOperationIntentV1,
};
