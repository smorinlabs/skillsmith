import { z } from 'zod';
import { toolRegistry } from '../../agents/registry.ts';
import type { ListReport } from '../../application/read-services.ts';
import { SCOPES } from '../../config/types.ts';
import { redactSensitiveString } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';

const ScopeSchema = z.enum(['system', 'user', 'project', 'managed']);
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
const MemberSchema = z.object({ scope: ScopeSchema, path: z.string() }).strict();
const VisibilitySchema = z
  .object({
    state: z.enum(['unique', 'winner', 'shadowed', 'duplicate']),
    winner: z.string().nullable(),
    members: z.array(MemberSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const requiresWinner = value.state === 'winner' || value.state === 'shadowed';
    if ((requiresWinner && value.winner === null) || (!requiresWinner && value.winner !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['winner'],
        message: `winner does not match visibility state ${value.state}`,
      });
    }
  });
const SkillEntrySchema = z
  .object({
    name: z.string(),
    tool: z.string(),
    scope: ScopeSchema,
    mode: z.enum(['dev', 'pinned', 'unmanaged']),
    placement: z.enum(['symlink', 'copy', 'unknown']),
    path: z.string(),
    realpath: z.string(),
    root: z.string(),
    frontmatter: FrontmatterSchema,
    origin: OriginSchema,
    enabled: z.enum(['on', 'off', 'unset']),
    source: z.string().nullable(),
    revision: z.string().nullable(),
    store: z.string().nullable(),
    verification: z.enum(['passed', 'warned', 'skipped', 'unrecorded']),
    description: z.string().nullable(),
    visibility: VisibilitySchema,
  })
  .strict();
const SelectionSchema = z
  .object({
    source: z.literal('bounded-default'),
    tools: z.array(z.string()),
    scopes: z.array(ScopeSchema),
    filters: z
      .object({
        names: z.array(z.string()),
        mode: z.enum(['dev', 'pinned', 'unmanaged']).nullable(),
        source: z.string().nullable(),
        revision: z.string().nullable(),
        description: z.string().nullable(),
        verification: z.enum(['verified', 'unverified']).nullable(),
        enabled: z.enum(['enabled-only', 'disabled-only', 'unconfigured-only']).nullable(),
        duplicates: z.boolean(),
      })
      .strict(),
    outcome: z.enum(['selected', 'filter-noop']),
  })
  .strict();
const CollisionGroupSchema = z
  .object({
    tool: z.string(),
    name: z.string(),
    winner: z.string().nullable(),
    members: z.array(MemberSchema),
  })
  .strict();
const ListV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    kind: z.literal('skillsmith.list'),
    selection: SelectionSchema,
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        collisionGroups: z.number().int().nonnegative(),
      })
      .strict(),
    entries: z.array(SkillEntrySchema),
    collisionGroups: z.array(CollisionGroupSchema),
  })
  .strict();

export type ListV3Dto = z.infer<typeof ListV3Schema>;

const frontmatterDto = (source: ListReport['entries'][number]['frontmatter']) =>
  source === null
    ? null
    : {
        ...(source.name === undefined ? {} : { name: redactSensitiveString(source.name) }),
        ...(source.description === undefined
          ? {}
          : { description: redactSensitiveString(source.description) }),
        ...(source.version === undefined ? {} : { version: redactSensitiveString(source.version) }),
      };
const originDto = (source: ListReport['entries'][number]['origin']) =>
  source.kind === 'plugin'
    ? {
        kind: 'plugin' as const,
        pluginId: redactSensitiveString(source.pluginId),
        pluginVersion: redactSensitiveString(source.pluginVersion),
        pluginScope: source.pluginScope,
      }
    : { kind: source.kind };
const membersDto = (
  members: readonly Readonly<{ readonly scope: string; readonly path: string }>[],
): ListV3Dto['collisionGroups'][number]['members'] =>
  members.map((member) => ({
    scope: member.scope as ListV3Dto['collisionGroups'][number]['members'][number]['scope'],
    path: redactSensitiveString(member.path),
  }));

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const toolOrder = new Map(toolRegistry.ids.map((tool, index) => [tool, index] as const));
const scopeOrder = new Map(SCOPES.map((scope, index) => [scope, index] as const));
const orderedEntries = (entries: ListReport['entries']): ListReport['entries'] =>
  [...entries].sort(
    (left, right) =>
      (toolOrder.get(left.tool) ?? Number.MAX_SAFE_INTEGER) -
        (toolOrder.get(right.tool) ?? Number.MAX_SAFE_INTEGER) ||
      (scopeOrder.get(left.scope) ?? Number.MAX_SAFE_INTEGER) -
        (scopeOrder.get(right.scope) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.name, right.name) ||
      compareText(left.path, right.path),
  );

const orderedCollisionGroups = (
  groups: NonNullable<ListReport['collisionGroups']>,
): NonNullable<ListReport['collisionGroups']> =>
  [...groups].sort(
    (left, right) =>
      (toolOrder.get(left.tool) ?? Number.MAX_SAFE_INTEGER) -
        (toolOrder.get(right.tool) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.name, right.name),
  );

const redactedNullable = (value: string | null | undefined): string | null =>
  value === undefined || value === null ? null : redactSensitiveString(value);

export const toListV3Dto = (report: ListReport): ListV3Dto => ({
  schemaVersion: 3,
  kind: 'skillsmith.list',
  selection: {
    source: 'bounded-default',
    tools: toolRegistry.ids.filter((tool) =>
      new Set(report.selection?.tools ?? toolRegistry.ids).has(tool),
    ),
    scopes: SCOPES.filter((scope) => new Set(report.selection?.scopes ?? SCOPES).has(scope)),
    filters: {
      names: [...((report.selection?.filters.names as readonly string[] | undefined) ?? [])].map(
        redactSensitiveString,
      ),
      mode:
        (report.selection?.filters.mode as 'dev' | 'pinned' | 'unmanaged' | null | undefined) ??
        null,
      source: redactedNullable(report.selection?.filters.source as string | null | undefined),
      revision: redactedNullable(report.selection?.filters.revision as string | null | undefined),
      description: redactedNullable(
        report.selection?.filters.description as string | null | undefined,
      ),
      verification:
        (report.selection?.filters.verification as 'verified' | 'unverified' | null | undefined) ??
        null,
      enabled:
        (report.selection?.filters.enabled as
          | 'enabled-only'
          | 'disabled-only'
          | 'unconfigured-only'
          | null
          | undefined) ?? null,
      duplicates: (report.selection?.filters.duplicates as boolean | undefined) ?? false,
    },
    outcome:
      report.selection?.outcome ?? (report.entries.length === 0 ? 'filter-noop' : 'selected'),
  },
  summary: {
    total: report.entries.length,
    collisionGroups: report.collisionGroups?.length ?? 0,
  },
  entries: orderedEntries(report.entries).map((entry) => ({
    name: redactSensitiveString(entry.name),
    tool: redactSensitiveString(entry.tool),
    scope: entry.scope,
    mode: entry.mode ?? 'unmanaged',
    placement: entry.placement ?? 'unknown',
    path: redactSensitiveString(entry.path),
    realpath: redactSensitiveString(entry.realpath),
    root: redactSensitiveString(entry.root),
    frontmatter: frontmatterDto(entry.frontmatter),
    origin: originDto(entry.origin),
    enabled: entry.enabled,
    source: redactedNullable(entry.source),
    revision: redactedNullable(entry.revision),
    store: redactedNullable(entry.store),
    verification: entry.verification ?? 'unrecorded',
    description:
      entry.description === undefined || entry.description === null
        ? redactedNullable(entry.frontmatter?.description)
        : redactSensitiveString(entry.description),
    visibility: {
      state: entry.visibility?.state ?? 'unique',
      winner: redactedNullable(entry.visibility?.winner),
      members: membersDto(entry.visibility?.members ?? [{ scope: entry.scope, path: entry.path }]),
    },
  })),
  collisionGroups: orderedCollisionGroups(report.collisionGroups ?? []).map((group) => ({
    tool: redactSensitiveString(group.tool),
    name: redactSensitiveString(group.name),
    winner: redactedNullable(group.winner),
    members: membersDto(group.members),
  })),
});

export const listV3Codec = createJsonWireCodec(
  {
    id: 'list',
    version: 3,
    wireKind: 'skillsmith.list',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  ListV3Schema,
);
