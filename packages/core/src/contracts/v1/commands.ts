import { z } from 'zod';
import type { CommandsReport } from '../../application/read-services.ts';
import type { CommandEntry } from '../../commands/types.ts';
import type { Frontmatter, Origin } from '../../skills/types.ts';
import { createJsonWireCodec } from '../codec.ts';

const FrontmatterV1Schema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .strict()
  .nullable();

const OriginV1Schema = z.discriminatedUnion('kind', [
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

const CommandEntryV1Schema = z
  .object({
    name: z.string(),
    path: z.string(),
    realpath: z.string(),
    tool: z.string(),
    scope: z.string(),
    root: z.string(),
    frontmatter: FrontmatterV1Schema,
    origin: OriginV1Schema,
    enabled: z.enum(['on', 'off', 'unset']),
  })
  .strict();

const CommandsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    experimental: z.literal(true),
    commands: z.array(CommandEntryV1Schema),
  })
  .strict();

export type CommandsV1Dto = z.infer<typeof CommandsV1Schema>;

const toFrontmatterV1Dto = (source: Frontmatter | null): z.infer<typeof FrontmatterV1Schema> => {
  if (source === null) return null;
  const frontmatter: Exclude<z.infer<typeof FrontmatterV1Schema>, null> = {};
  if (source.name !== undefined) frontmatter.name = source.name;
  if (source.description !== undefined) frontmatter.description = source.description;
  if (source.version !== undefined) frontmatter.version = source.version;
  return frontmatter;
};

const toOriginV1Dto = (source: Origin): z.infer<typeof OriginV1Schema> => {
  if (source.kind === 'standalone') return { kind: 'standalone' };
  if (source.kind === 'policy') return { kind: 'policy' };
  return {
    kind: 'plugin',
    pluginId: source.pluginId,
    pluginVersion: source.pluginVersion,
    pluginScope: source.pluginScope,
  };
};

const toCommandEntryV1Dto = (source: CommandEntry): CommandsV1Dto['commands'][number] => ({
  name: source.name,
  path: source.path,
  realpath: source.realpath,
  tool: source.tool,
  scope: source.scope,
  root: source.root,
  frontmatter: toFrontmatterV1Dto(source.frontmatter),
  origin: toOriginV1Dto(source.origin),
  enabled: source.enabled,
});

export const toCommandsV1Dto = (report: CommandsReport): CommandsV1Dto => ({
  schemaVersion: 1,
  experimental: true,
  commands: report.entries.map(toCommandEntryV1Dto),
});

export const commandsV1Codec = createJsonWireCodec(
  {
    id: 'commands',
    version: 1,
    wireKind: null,
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  CommandsV1Schema,
);
