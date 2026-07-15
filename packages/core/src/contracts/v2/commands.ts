import { z } from 'zod';
import { toolRegistry } from '../../agents/registry.ts';
import type { CommandsReport } from '../../application/read-services.ts';
import { redactSensitiveString } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';

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
const SelectionSchema = z
  .object({
    source: z.literal('bounded-default'),
    tools: z.array(z.string()),
    scopes: z.array(z.enum(['user', 'project'])),
    filters: z
      .object({
        names: z.array(z.string()),
        enabled: z.enum(['enabled-only', 'disabled-only', 'unconfigured-only']).nullable(),
      })
      .strict(),
    outcome: z.enum(['selected', 'filter-noop']),
  })
  .strict();
const CommandEntrySchema = z
  .object({
    name: z.string(),
    tool: z.string(),
    scope: z.enum(['user', 'project']),
    path: z.string(),
    realpath: z.string(),
    root: z.string(),
    frontmatter: FrontmatterSchema,
    origin: OriginSchema,
    enabled: z.enum(['on', 'off', 'unset']),
    description: z.string().nullable(),
  })
  .strict();
const CommandsV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('skillsmith.commands'),
    selection: SelectionSchema,
    summary: z.object({ total: z.number().int().nonnegative() }).strict(),
    entries: z.array(CommandEntrySchema),
  })
  .strict();

export type CommandsV2Dto = z.infer<typeof CommandsV2Schema>;

const frontmatterDto = (source: CommandsReport['entries'][number]['frontmatter']) =>
  source === null
    ? null
    : {
        ...(source.name === undefined ? {} : { name: redactSensitiveString(source.name) }),
        ...(source.description === undefined
          ? {}
          : { description: redactSensitiveString(source.description) }),
        ...(source.version === undefined ? {} : { version: redactSensitiveString(source.version) }),
      };
const originDto = (source: CommandsReport['entries'][number]['origin']) =>
  source.kind === 'plugin'
    ? {
        kind: 'plugin' as const,
        pluginId: redactSensitiveString(source.pluginId),
        pluginVersion: redactSensitiveString(source.pluginVersion),
        pluginScope: source.pluginScope,
      }
    : { kind: source.kind };

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const toolOrder = new Map(toolRegistry.ids.map((tool, index) => [tool, index] as const));
const scopeOrder = new Map([
  ['user', 0],
  ['project', 1],
] as const);
const orderedEntries = (entries: CommandsReport['entries']): CommandsReport['entries'] =>
  [...entries].sort(
    (left, right) =>
      (toolOrder.get(left.tool) ?? Number.MAX_SAFE_INTEGER) -
        (toolOrder.get(right.tool) ?? Number.MAX_SAFE_INTEGER) ||
      (scopeOrder.get(left.scope as 'user' | 'project') ?? Number.MAX_SAFE_INTEGER) -
        (scopeOrder.get(right.scope as 'user' | 'project') ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.name, right.name) ||
      compareText(left.path, right.path),
  );

export const toCommandsV2Dto = (report: CommandsReport): CommandsV2Dto => ({
  schemaVersion: 2,
  kind: 'skillsmith.commands',
  selection: {
    source: 'bounded-default',
    tools: toolRegistry.ids.filter((tool) =>
      new Set(report.selection?.tools ?? toolRegistry.ids).has(tool),
    ),
    scopes: (['user', 'project'] as const).filter((scope) =>
      new Set(report.selection?.scopes ?? ['user', 'project']).has(scope),
    ),
    filters: {
      names: [...((report.selection?.filters.names as readonly string[] | undefined) ?? [])],
      enabled:
        (report.selection?.filters.enabled as
          | 'enabled-only'
          | 'disabled-only'
          | 'unconfigured-only'
          | null
          | undefined) ?? null,
    },
    outcome:
      report.selection?.outcome ?? (report.entries.length === 0 ? 'filter-noop' : 'selected'),
  },
  summary: { total: report.entries.length },
  entries: orderedEntries(report.entries).map((entry) => ({
    name: redactSensitiveString(entry.name),
    tool: redactSensitiveString(entry.tool),
    scope: entry.scope as 'user' | 'project',
    path: redactSensitiveString(entry.path),
    realpath: redactSensitiveString(entry.realpath),
    root: redactSensitiveString(entry.root),
    frontmatter: frontmatterDto(entry.frontmatter),
    origin: originDto(entry.origin),
    enabled: entry.enabled,
    description:
      entry.description === undefined || entry.description === null
        ? entry.frontmatter?.description === undefined
          ? null
          : redactSensitiveString(entry.frontmatter.description)
        : redactSensitiveString(entry.description),
  })),
});

export const commandsV2Codec = createJsonWireCodec(
  {
    id: 'commands',
    version: 2,
    wireKind: 'skillsmith.commands',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  CommandsV2Schema,
);
