import { z } from 'zod';
import type { Deprecation } from '../../application/types.ts';
import type { CheckRunResult, Finding } from '../../doctor/types.ts';
import { createJsonWireCodec } from '../codec.ts';

const FindingV1Schema = z
  .object({
    checkId: z.string(),
    severity: z.enum(['error', 'warning', 'info']),
    title: z.string(),
    message: z.string(),
    remediation: z.string().optional(),
    tool: z.string().optional(),
    scope: z.string().optional(),
    path: z.string().optional(),
    operation: z.string().optional(),
    reason: z.string().optional(),
    scopeInUse: z.boolean().optional(),
  })
  .strict();

const DeprecationV1Schema = z
  .object({
    spelling: z.string(),
    replacement: z.string(),
    removalVersion: z.string(),
    message: z.string(),
  })
  .strict();

const HealthV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    experimental: z.literal(true),
    findings: z.array(FindingV1Schema),
    counts: z
      .object({
        ok: z.number(),
        warning: z.number(),
        error: z.number(),
      })
      .strict(),
    deprecations: z.array(DeprecationV1Schema).optional(),
  })
  .strict();

export type HealthV1Dto = z.infer<typeof HealthV1Schema>;

const toFindingV1Dto = (source: Finding): HealthV1Dto['findings'][number] => {
  const finding: HealthV1Dto['findings'][number] = {
    checkId: source.checkId,
    severity: source.severity,
    title: source.title,
    message: source.message,
  };
  if (source.remediation !== undefined) finding.remediation = source.remediation;
  if (source.tool !== undefined) finding.tool = source.tool;
  if (source.scope !== undefined) finding.scope = source.scope;
  if (source.path !== undefined) finding.path = source.path;
  if (source.operation !== undefined) finding.operation = source.operation;
  if (source.reason !== undefined) finding.reason = source.reason;
  if (source.scopeInUse !== undefined) finding.scopeInUse = source.scopeInUse;
  return finding;
};

const toDeprecationV1Dto = (
  source: Deprecation,
): NonNullable<HealthV1Dto['deprecations']>[number] => ({
  spelling: source.spelling,
  replacement: source.replacement,
  removalVersion: source.removalVersion,
  message: source.message,
});

export const toHealthV1Dto = (
  result: CheckRunResult,
  deprecations: readonly Deprecation[] = [],
): HealthV1Dto => {
  const dto: HealthV1Dto = {
    schemaVersion: 1,
    experimental: true,
    findings: result.findings.map(toFindingV1Dto),
    counts: {
      ok: result.counts.ok,
      warning: result.counts.warning,
      error: result.counts.error,
    },
  };
  if (deprecations.length > 0) dto.deprecations = deprecations.map(toDeprecationV1Dto);
  return dto;
};

export const healthV1Codec = createJsonWireCodec(
  {
    id: 'health',
    version: 1,
    wireKind: null,
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  HealthV1Schema,
);
