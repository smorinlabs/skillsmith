import type { CommandEntry } from '@skillsmith/core';
import { z } from 'zod';

const FrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .nullable();

const OriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standalone') }),
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string(),
    pluginVersion: z.string(),
    pluginScope: z.enum(['user', 'project', 'managed', 'local']),
  }),
  z.object({ kind: z.literal('policy') }),
]);

const CommandEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  realpath: z.string(),
  tool: z.string(),
  scope: z.string(),
  root: z.string(),
  frontmatter: FrontmatterSchema,
  origin: OriginSchema,
  enabled: z.enum(['on', 'off', 'unset']),
});

export const CommandsJsonSchema = z.object({
  schemaVersion: z.literal(1),
  experimental: z.literal(true),
  commands: z.array(CommandEntrySchema),
});

export const renderCommandsJson = (entries: readonly CommandEntry[]): string =>
  JSON.stringify({ schemaVersion: 1, experimental: true, commands: entries }, null, 2);
