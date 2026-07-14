import type { ArtifactCodec, ArtifactContractRegistry, ArtifactId } from './codec.ts';
import {
  journalV1Codec,
  validateJournalV1Dto,
  validateJournalV1DtoShape,
} from './journal-codec.ts';
import {
  describeLedgerV1Migration,
  fromLedgerV1Dto,
  ledgerByteRevision,
  ledgerSemanticRevision,
  ledgerV1Codec,
  ledgerV2Codec,
  validateLedgerV1Dto,
} from './ledger-codec.ts';
import { lockV1Codec } from './lock-codec.ts';
import { manifestV1Codec } from './manifest-codec.ts';
import {
  ownArtifactDto,
  savedPlanV1Codec,
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

export {
  describeLedgerV1Migration,
  fromLedgerV1Dto,
  ledgerByteRevision,
  ledgerSemanticRevision,
  ownArtifactDto,
  validateJournalV1Dto,
  validateJournalV1DtoShape,
  validateLedgerV1Dto,
  validatePlanOperationIntentShapeV1,
  validatePlanOperationIntentV1,
};
