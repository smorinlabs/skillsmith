import { createHash } from 'node:crypto';
import type { CheckRunResult, Deprecation } from '@skillsmith/core';
import type { WireCodec } from '@skillsmith/core/contracts';
import { toHealthV1Dto } from '@skillsmith/core/contracts/v1';
import { toHealthV2Dto } from '@skillsmith/core/contracts/v2';
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

export const DoctorJsonSchema = wireSchema(currentWireCodecs.doctor);

type DoctorWireResult = Parameters<typeof toHealthV2Dto>[0];

const asDoctorResult = (result: CheckRunResult): DoctorWireResult => {
  if ('repair' in result && 'mutation' in result) return result as DoctorWireResult;
  const occurrences = new Map<string, number>();
  return {
    ...result,
    findings: result.findings.map((finding) => {
      const canonicalFinding = encodeWire(
        currentWireCodecs.check,
        toHealthV1Dto({ findings: [finding], counts: { ok: 0, warning: 0, error: 0 } }),
      );
      const occurrence = occurrences.get(canonicalFinding) ?? 0;
      occurrences.set(canonicalFinding, occurrence + 1);
      const digest = createHash('sha256')
        .update(canonicalFinding)
        .update('\u0000')
        .update(String(occurrence))
        .digest('hex');
      return { ...finding, findingId: `finding:v1:${digest}` as const };
    }),
    repair: { mode: 'not-requested', operations: [], results: [] },
    mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
  } as DoctorWireResult;
};

export const renderDoctorJson = (
  result: CheckRunResult,
  deprecations: readonly CliDeprecation[] = [],
  codec:
    | WireCodec<'health', 1, unknown>
    | WireCodec<'health', 2, unknown> = currentWireCodecs.doctor,
): string =>
  codec.descriptor.version === 2
    ? encodeWire(currentWireCodecs.doctor, toHealthV2Dto(asDoctorResult(result), deprecations))
    : encodeWire(currentWireCodecs.check, toHealthV1Dto(result, deprecations));
