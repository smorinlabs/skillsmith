import type { CheckRunResult, Deprecation } from '@skillsmith/core';
import { toHealthV1Dto } from '@skillsmith/core/contracts/v1';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export type CliDeprecation = Deprecation;

export const CliDeprecationSchema = {
  parse(value: unknown): Deprecation {
    const probe = toHealthV1Dto({ findings: [], counts: { ok: 0, warning: 0, error: 0 } }, [
      value as Deprecation,
    ]);
    const parsed = currentWireCodecs.check.validate(probe);
    if (!parsed.ok || parsed.value.deprecations?.[0] === undefined) {
      throw new Error('invalid deprecation wire value');
    }
    return parsed.value.deprecations[0];
  },
};

export const DoctorJsonSchema = wireSchema(currentWireCodecs.check);

export const renderDoctorJson = (
  result: CheckRunResult,
  deprecations: readonly CliDeprecation[] = [],
  codec = currentWireCodecs.check,
): string => encodeWire(codec, toHealthV1Dto(result, deprecations));
