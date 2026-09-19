import { z } from 'zod';
import { type ToolRegistry, toolRegistry } from '../../agents/registry.ts';
import type { ModeResult, ToolVerdict, VerifyFinding, VerifyReport } from '../../verify/types.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodec } from '../types.ts';

type VerifySchemaRegistry = Pick<ToolRegistry, 'toolsFor'>;

const VerifyFindingV1Schema = z
  .object({
    checkId: z.string(),
    toolSeverity: z.string().nullable(),
    normalizedSeverity: z.enum(['error', 'warning', 'info']),
    message: z.string(),
    file: z.string().nullable(),
    subject: z.enum(['skill', 'manifest', 'marketplace', 'plugin']),
    raw: z.string().optional(),
  })
  .strict();

const ModeResultV1Schema = z
  .object({
    mode: z.enum(['static', 'deep']),
    status: z.enum(['ran', 'skipped', 'error']),
    skipReason: z.enum(['not-installed', 'timeout', 'exec-error']).nullable(),
    coverage: z.object({ manifest: z.boolean(), skills: z.boolean() }).strict(),
    verdict: z.enum(['pass', 'warn', 'fail']).nullable(),
    command: z.string(),
    findings: z.array(VerifyFindingV1Schema),
  })
  .strict();

const createVerifyV1Schema = (registry: VerifySchemaRegistry) => {
  const tools = registry.toolsFor('verify-static');
  if (tools.length === 0) throw new Error('verify@1 requires a registered static verifier');
  const ToolV1Schema = z.enum(Array.from(tools) as [string, ...string[]]);
  const verifiedAgainstShape = Object.fromEntries(
    tools.map((tool) => [tool, z.string()]),
  ) as Record<string, z.ZodString>;

  return z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('skillsmith.verify'),
      target: z
        .object({
          path: z.string(),
          kind: z.enum(['plugin', 'skill']),
        })
        .strict(),
      requested: z
        .object({
          tools: z.array(ToolV1Schema),
          modes: z.array(z.enum(['static', 'deep'])),
          strict: z.boolean(),
          explicitTools: z.boolean(),
        })
        .strict(),
      verifiedAgainst: z.object(verifiedAgainstShape).strict(),
      summary: z
        .object({
          verdict: z.enum(['pass', 'warn', 'fail', 'inconclusive']),
          verified: z.array(ToolV1Schema),
          failed: z.array(ToolV1Schema),
          skipped: z.array(ToolV1Schema),
          counts: z
            .object({
              error: z.number(),
              warning: z.number(),
              info: z.number(),
            })
            .strict(),
        })
        .strict(),
      tools: z.array(
        z
          .object({
            tool: ToolV1Schema,
            available: z.boolean(),
            toolVersion: z.string().nullable(),
            versionDrift: z.boolean(),
            skipReason: z.enum(['not-installed', 'timeout', 'exec-error']).nullable(),
            verdict: z.enum(['pass', 'warn', 'fail', 'inconclusive']),
            modes: z.array(ModeResultV1Schema),
          })
          .strict(),
      ),
    })
    .strict();
};

const VerifyV1Schema = createVerifyV1Schema(toolRegistry);

export type VerifyV1Dto = z.infer<typeof VerifyV1Schema>;

const toVerifyFindingV1Dto = (source: VerifyFinding): z.infer<typeof VerifyFindingV1Schema> => {
  const dto: z.infer<typeof VerifyFindingV1Schema> = {
    checkId: source.checkId,
    toolSeverity: source.toolSeverity,
    normalizedSeverity: source.normalizedSeverity,
    message: source.message,
    file: source.file,
    subject: source.subject,
  };
  if (source.raw !== undefined) dto.raw = source.raw;
  return dto;
};

const toModeResultV1Dto = (source: ModeResult): z.infer<typeof ModeResultV1Schema> => ({
  mode: source.mode,
  status: source.status,
  skipReason: source.skipReason,
  coverage: {
    manifest: source.coverage.manifest,
    skills: source.coverage.skills,
  },
  verdict: source.verdict,
  command: source.command,
  findings: source.findings.map(toVerifyFindingV1Dto),
});

const toToolVerdictV1Dto = (source: ToolVerdict<string>): VerifyV1Dto['tools'][number] => ({
  tool: source.tool,
  available: source.available,
  toolVersion: source.toolVersion,
  versionDrift: source.versionDrift,
  skipReason: source.skipReason,
  verdict: source.verdict,
  modes: source.modes.map(toModeResultV1Dto),
});

export const toVerifyV1Dto = (report: VerifyReport<string>): VerifyV1Dto => {
  const verifiedAgainst: Record<string, string> = {};
  for (const [tool, version] of Object.entries(report.verifiedAgainst)) {
    verifiedAgainst[tool] = version;
  }
  return {
    schemaVersion: 1,
    kind: 'skillsmith.verify',
    target: {
      path: report.target.path,
      kind: report.target.kind,
    },
    requested: {
      tools: Array.from(report.requested.tools),
      modes: Array.from(report.requested.modes),
      strict: report.requested.strict,
      explicitTools: report.requested.explicitTools,
    },
    verifiedAgainst,
    summary: {
      verdict: report.summary.verdict,
      verified: Array.from(report.summary.verified),
      failed: Array.from(report.summary.failed),
      skipped: Array.from(report.summary.skipped),
      counts: {
        error: report.summary.counts.error,
        warning: report.summary.counts.warning,
        info: report.summary.counts.info,
      },
    },
    tools: report.tools.map(toToolVerdictV1Dto),
  };
};

const VERIFY_DESCRIPTOR = {
  id: 'verify',
  version: 1,
  wireKind: 'skillsmith.verify',
  embeddedVersion: 'schemaVersion',
  unknownFields: 'reject-recursive',
  formatting: { indent: 2, terminalLf: false },
  migrations: [],
  compatibility: 'conservative',
} as const;

export const createVerifyV1Codec = (
  registry: VerifySchemaRegistry,
): WireCodec<'verify', 1, VerifyV1Dto> =>
  createJsonWireCodec(VERIFY_DESCRIPTOR, createVerifyV1Schema(registry)) as WireCodec<
    'verify',
    1,
    VerifyV1Dto
  >;

export const verifyV1Codec = createVerifyV1Codec(toolRegistry);
