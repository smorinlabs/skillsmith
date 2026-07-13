import { toolRegistry } from '@skillsmith/core';
import type { ToolRegistry, VerifyReport } from '@skillsmith/core';
import { z } from 'zod';

const ModeSchema = z.enum(['static', 'deep']);
const NormalizedSeveritySchema = z.enum(['error', 'warning', 'info']);
const OutcomeSchema = z.enum(['pass', 'warn', 'fail']);
const SummaryVerdictSchema = z.enum(['pass', 'warn', 'fail', 'inconclusive']);
const ModeStatusSchema = z.enum(['ran', 'skipped', 'error']);
const SkipReasonSchema = z.enum(['not-installed', 'timeout', 'exec-error']);
const SubjectSchema = z.enum(['skill', 'manifest', 'marketplace', 'plugin']);

const VerifyFindingSchema = z.object({
  checkId: z.string(),
  toolSeverity: z.string().nullable(),
  normalizedSeverity: NormalizedSeveritySchema,
  message: z.string(),
  file: z.string().nullable(),
  subject: SubjectSchema,
  raw: z.string().optional(),
});

const ModeResultSchema = z.object({
  mode: ModeSchema,
  status: ModeStatusSchema,
  skipReason: SkipReasonSchema.nullable(),
  coverage: z.object({ manifest: z.boolean(), skills: z.boolean() }),
  verdict: OutcomeSchema.nullable(),
  command: z.string(),
  findings: z.array(VerifyFindingSchema),
});

type VerifySchemaRegistry = Pick<ToolRegistry, 'toolsFor'>;

export const createVerifyJsonSchema = (registry: VerifySchemaRegistry) => {
  const tools = registry.toolsFor('verify-static');
  if (tools.length === 0) throw new Error('verify JSON schema requires a registered verifier');
  const ToolSchema = z.enum(tools as [string, ...string[]]);
  const ToolVerdictSchema = z.object({
    tool: ToolSchema,
    available: z.boolean(),
    toolVersion: z.string().nullable(),
    versionDrift: z.boolean(),
    skipReason: SkipReasonSchema.nullable(),
    verdict: SummaryVerdictSchema,
    modes: z.array(ModeResultSchema),
  });
  const verifiedAgainstShape = Object.fromEntries(
    tools.map((tool) => [tool, z.string()]),
  ) as Record<string, z.ZodString>;

  return z.object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.verify'),
    target: z.object({ path: z.string(), kind: z.enum(['plugin', 'skill']) }),
    requested: z.object({
      tools: z.array(ToolSchema),
      modes: z.array(ModeSchema),
      strict: z.boolean(),
      explicitTools: z.boolean(),
    }),
    verifiedAgainst: z.object(verifiedAgainstShape),
    summary: z.object({
      verdict: SummaryVerdictSchema,
      verified: z.array(ToolSchema),
      failed: z.array(ToolSchema),
      skipped: z.array(ToolSchema),
      counts: z.object({ error: z.number(), warning: z.number(), info: z.number() }),
    }),
    tools: z.array(ToolVerdictSchema),
  });
};

export const VerifyJsonSchema = createVerifyJsonSchema(toolRegistry);

export const renderVerifyJson = (report: VerifyReport): string => {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'skillsmith.verify' as const,
    target: report.target,
    requested: report.requested,
    verifiedAgainst: report.verifiedAgainst,
    summary: report.summary,
    tools: report.tools,
  };
  const parsed = VerifyJsonSchema.parse(payload);
  return JSON.stringify(parsed, null, 2);
};
