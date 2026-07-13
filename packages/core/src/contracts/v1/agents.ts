import { z } from 'zod';
import type { AgentsReport } from '../../application/read-services.ts';
import { createJsonWireCodec } from '../codec.ts';

const InstallRecordV1Schema = z
  .object({
    path: z.string(),
    version: z.string(),
    installMethod: z.enum([
      'brew',
      'npm-global',
      'bun-global',
      'native-installer',
      'app-bundle',
      'unknown',
    ]),
  })
  .strict();

type InstallRecordV1Dto = z.infer<typeof InstallRecordV1Schema>;

const AgentsToolsV1Schema = z
  .custom<Record<string, InstallRecordV1Dto[]>>((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }, 'agents tools must be an object')
  .superRefine((tools, context) => {
    for (const [tool, records] of Object.entries(tools)) {
      if (!Array.isArray(records)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [tool], message: 'expected array' });
        continue;
      }
      for (const [index, record] of records.entries()) {
        const parsed = InstallRecordV1Schema.safeParse(record);
        if (parsed.success) continue;
        for (const issue of parsed.error.issues) {
          const unknownKey =
            issue.code === z.ZodIssueCode.unrecognized_keys ? issue.keys[0] : undefined;
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [tool, index, ...issue.path, ...(unknownKey === undefined ? [] : [unknownKey])],
            message: 'invalid install record',
          });
        }
      }
    }
  })
  .transform((tools) => Object.assign(Object.create(null) as typeof tools, tools));

const AgentsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    experimental: z.literal(true),
    tools: AgentsToolsV1Schema,
  })
  .strict();

export type AgentsV1Dto = z.infer<typeof AgentsV1Schema>;

export const toAgentsV1Dto = (report: AgentsReport): AgentsV1Dto => {
  const tools = Object.create(null) as AgentsV1Dto['tools'];
  for (const [tool, records] of report.detections) {
    tools[tool] = records.map((record) => ({
      path: record.path,
      version: record.version,
      installMethod: record.installMethod,
    }));
  }
  return { schemaVersion: 1, experimental: true, tools };
};

export const agentsV1Codec = createJsonWireCodec(
  {
    id: 'agents',
    version: 1,
    wireKind: null,
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  AgentsV1Schema,
);
