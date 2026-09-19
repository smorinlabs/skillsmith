import { z } from 'zod';

import type { ListReport } from '../../application/read-services.ts';
import type { Origin, SkillEntry } from '../../skills/types.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodecDescriptor } from '../types.ts';

const FrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .strict()
  .nullable();

const OriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standalone') }).strict(),
  z
    .object({
      kind: z.literal('plugin'),
      pluginId: z.string(),
      pluginVersion: z.string(),
      pluginScope: z.enum(['user', 'project', 'managed', 'local']),
    })
    .strict(),
  z.object({ kind: z.literal('policy') }).strict(),
]);

const SkillEntrySchema = z
  .object({
    name: z.string(),
    path: z.string(),
    realpath: z.string(),
    tool: z.string(),
    scope: z.string(),
    root: z.string(),
    frontmatter: FrontmatterSchema,
    origin: OriginSchema,
    enabled: z.enum(['on', 'off', 'unset']),
  })
  .strict();

const ListV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    experimental: z.literal(true),
    skills: z.array(SkillEntrySchema),
  })
  .strict();

export type ListV2Dto = z.infer<typeof ListV2Schema>;

const descriptor = Object.freeze({
  id: 'list',
  version: 2,
  wireKind: null,
  embeddedVersion: 'schemaVersion',
  unknownFields: 'reject-recursive',
  formatting: Object.freeze({ indent: 2, terminalLf: false }),
  migrations: Object.freeze([]),
  compatibility: 'conservative',
} as const satisfies WireCodecDescriptor<'list', 2>);

export const listV2Codec = createJsonWireCodec(descriptor, ListV2Schema);

const toOriginDto = (origin: Origin): ListV2Dto['skills'][number]['origin'] => {
  switch (origin.kind) {
    case 'standalone':
      return { kind: 'standalone' };
    case 'plugin':
      return {
        kind: 'plugin',
        pluginId: origin.pluginId,
        pluginVersion: origin.pluginVersion,
        pluginScope: origin.pluginScope,
      };
    case 'policy':
      return { kind: 'policy' };
  }
};

const toSkillEntryDto = (entry: SkillEntry): ListV2Dto['skills'][number] => ({
  name: entry.name,
  path: entry.path,
  realpath: entry.realpath,
  tool: entry.tool,
  scope: entry.scope,
  root: entry.root,
  frontmatter:
    entry.frontmatter === null
      ? null
      : {
          name: entry.frontmatter.name,
          description: entry.frontmatter.description,
          version: entry.frontmatter.version,
        },
  origin: toOriginDto(entry.origin),
  enabled: entry.enabled,
});

/** Maps current list application reports to the stable experimental list wire contract. */
export const toListV2Dto = (report: ListReport): ListV2Dto => ({
  schemaVersion: 2,
  experimental: true,
  skills: report.entries.map(toSkillEntryDto),
});
