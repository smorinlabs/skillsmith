import type { CheckRunResult } from '@skillsmith/core';
import { z } from 'zod';

const FindingSchema = z.object({
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
});

export const DoctorJsonSchema = z.object({
  schemaVersion: z.literal(1),
  experimental: z.literal(true),
  findings: z.array(FindingSchema),
  counts: z.object({ ok: z.number(), warning: z.number(), error: z.number() }),
});

export const renderDoctorJson = (r: CheckRunResult): string =>
  JSON.stringify(
    { schemaVersion: 1, experimental: true, findings: r.findings, counts: r.counts },
    null,
    2,
  );
