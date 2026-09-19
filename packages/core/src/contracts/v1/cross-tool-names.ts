import { z } from 'zod';
import type { CrossToolNamesReport } from '../../application/read-services.ts';
import { redactSensitiveString } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodec } from '../types.ts';

const ScopeSchema = z.enum(['system', 'user', 'project', 'managed']);

const CrossToolNamesV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.cross-tool-names'),
    groups: z.array(
      z
        .object({
          name: z.string(),
          members: z.array(
            z
              .object({
                tool: z.string(),
                scope: ScopeSchema,
                path: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export type CrossToolNamesV1Dto = z.infer<typeof CrossToolNamesV1Schema>;

export const toCrossToolNamesV1Dto = (report: CrossToolNamesReport): CrossToolNamesV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.cross-tool-names',
  groups: report.groups.map((group) => ({
    name: redactSensitiveString(group.name),
    members: group.members.map((member) => ({
      tool: redactSensitiveString(member.tool),
      scope: member.scope,
      path: redactSensitiveString(member.path),
    })),
  })),
});

export const crossToolNamesV1Codec = createJsonWireCodec(
  {
    id: 'cross-tool-names',
    version: 1,
    wireKind: 'skillsmith.cross-tool-names',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  CrossToolNamesV1Schema,
) as unknown as WireCodec<'cross-tool-names', 1, CrossToolNamesV1Dto>;
