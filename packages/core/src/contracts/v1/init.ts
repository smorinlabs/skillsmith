import { isAbsolute, join, normalize, parse } from 'node:path';
import { z } from 'zod';
import { type PlacementToolId, toolRegistry } from '../../agents/registry.ts';
import { normalizePortablePath, normalizeRegistryIdentity } from '../../artifacts/identity.ts';
import type { InitReport } from '../../init/types.ts';
import { containsSensitiveMaterial } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';

const writableTools = Object.freeze([
  ...toolRegistry.toolsFor('plan'),
]) as readonly PlacementToolId[];
const WritableToolSchema = z.enum(
  writableTools as readonly [PlacementToolId, ...PlacementToolId[]],
);
const writableToolOrder = new Map(writableTools.map((tool, index) => [tool, index] as const));
const WritableToolsSchema = z
  .array(WritableToolSchema)
  .max(writableTools.length)
  .refine(
    (tools) =>
      new Set(tools).size === tools.length &&
      tools.every((tool, index) => {
        const previous = tools[index - 1];
        return (
          previous === undefined ||
          (writableToolOrder.get(previous) ?? -1) < (writableToolOrder.get(tool) ?? -1)
        );
      }),
    'init tools must be unique and in registry order',
  );
const DefaultToolsSchema = WritableToolsSchema.refine(
  (tools) => tools.length > 0,
  'init default tools must be nonempty',
);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const OperationIdSchema = z.string().regex(/^operation:v1:[0-9a-f]{64}$/u);
const MachinePathSchema = z
  .string()
  .min(1)
  .refine((path) => isAbsolute(path) && normalize(path) === path, 'path must be normalized');
const ResourceSchema = z
  .object({
    kind: z.literal('manifest-bytes'),
    location: z.object({ kind: z.literal('machine-bound'), path: MachinePathSchema }).strict(),
  })
  .strict();
const AbsentBeforeSchema = z
  .object({
    state: z.literal('absent'),
    shape: z.null(),
    byteHash: z.null(),
    semanticHash: z.null(),
  })
  .strict();
const CanonicalBeforeSchema = z
  .object({
    state: z.literal('present'),
    shape: z.literal('canonical'),
    byteHash: DigestSchema,
    semanticHash: DigestSchema,
  })
  .strict();
const ReplaceBeforeSchema = z.union([
  z
    .object({
      state: z.literal('present'),
      shape: z.literal('canonical'),
      byteHash: DigestSchema,
      semanticHash: DigestSchema.nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal('present'),
      shape: z.enum(['mixed', 'empty', 'malformed', 'unknown']),
      byteHash: DigestSchema,
      semanticHash: z.null(),
    })
    .strict(),
]);
const LegacyBeforeSchema = z
  .object({
    state: z.literal('present'),
    shape: z.literal('legacy'),
    byteHash: DigestSchema,
    semanticHash: DigestSchema,
  })
  .strict();
const AfterSchema = z
  .object({ state: z.literal('canonical'), byteHash: DigestSchema, semanticHash: DigestSchema })
  .strict();
const ResultSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create-manifest'),
      operationId: OperationIdSchema,
      before: AbsentBeforeSchema,
      after: AfterSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('replace-manifest'),
      operationId: OperationIdSchema,
      before: ReplaceBeforeSchema,
      after: AfterSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('migrate-project-config'),
      operationId: OperationIdSchema,
      before: LegacyBeforeSchema,
      after: AfterSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('noop'),
      operationId: z.null(),
      before: CanonicalBeforeSchema,
      after: z.null(),
    })
    .strict(),
]);
const ForceSchema = z.discriminatedUnion('conflictType', [
  z
    .object({
      requested: z.boolean(),
      applied: z.literal(false),
      conflictType: z.null(),
      target: z.null(),
      normalBehavior: z.null(),
      forcedBehavior: z.null(),
      backup: z.null(),
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      applied: z.boolean(),
      conflictType: z.literal('destination-exists'),
      target: ResourceSchema,
      normalBehavior: z.literal('refuse'),
      forcedBehavior: z.literal('backup-and-replace'),
      backup: z.literal('required'),
    })
    .strict(),
]);
const EffectSchema = z
  .object({
    role: z.literal('manifest'),
    action: z.enum(['create', 'replace', 'migrate', 'unchanged']),
    operationId: OperationIdSchema.nullable(),
    outcome: z.enum(['planned', 'succeeded', 'not-run']),
  })
  .strict();
const untouchedEffectSchema = <Role extends 'lock' | 'live' | 'ledger'>(role: Role) =>
  z
    .object({
      role: z.literal(role),
      action: z.literal('not-written'),
      operationId: z.null(),
      outcome: z.literal('not-run'),
    })
    .strict();

const InitV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.init'),
    reportVersion: z.literal(1),
    dryRun: z.boolean(),
    requested: z
      .object({
        tools: WritableToolsSchema,
        explicitTools: z.boolean(),
        toolSource: z.enum(['explicit', 'config', 'detected', 'none']),
        scope: z.enum(['user', 'project']).nullable(),
        explicitScope: z.boolean(),
        file: MachinePathSchema.nullable(),
        force: z.boolean(),
      })
      .strict(),
    defaults: z
      .object({
        tools: DefaultToolsSchema.nullable(),
        scope: z.enum(['user', 'project']).nullable(),
        path: z.string().min(1).nullable(),
        registryDefault: z.string().min(1).nullable(),
      })
      .strict(),
    artifactSelection: z
      .object({
        outcome: z.literal('selected'),
        selectedBy: z.enum(['explicit-file', 'project', 'user']),
        manifestPath: MachinePathSchema,
        lockPath: MachinePathSchema,
        lockSource: z.literal('sibling'),
      })
      .strict(),
    result: ResultSchema,
    force: ForceSchema,
    effects: z.tuple([
      EffectSchema,
      untouchedEffectSchema('lock'),
      untouchedEffectSchema('live'),
      untouchedEffectSchema('ledger'),
    ]),
    summary: z
      .object({
        changed: z.union([z.literal(0), z.literal(1)]),
        unchanged: z.union([z.literal(0), z.literal(1)]),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const effect = value.effects[0];
    const expectedAction = {
      'create-manifest': 'create',
      'replace-manifest': 'replace',
      'migrate-project-config': 'migrate',
      noop: 'unchanged',
    }[value.result.action];
    const expectedOutcome =
      value.result.action === 'noop' ? 'not-run' : value.dryRun ? 'planned' : 'succeeded';
    const unchanged = value.result.action === 'noop';
    const toolsEqual =
      value.requested.tools.length === (value.defaults.tools?.length ?? 0) &&
      value.requested.tools.every((tool, index) => tool === value.defaults.tools?.[index]);
    const toolSourceValid =
      value.requested.toolSource === 'explicit'
        ? value.requested.explicitTools && value.requested.tools.length > 0
        : value.requested.toolSource === 'config' || value.requested.toolSource === 'detected'
          ? !value.requested.explicitTools && value.requested.tools.length > 0
          : !value.requested.explicitTools &&
            value.requested.tools.length === 0 &&
            value.defaults.tools === null;
    const selectedFileValid =
      value.artifactSelection.selectedBy === 'explicit-file'
        ? value.requested.file === value.artifactSelection.manifestPath
        : value.requested.file === null;
    const explicitScopeSelectionValid =
      !value.requested.explicitScope ||
      value.artifactSelection.selectedBy === 'explicit-file' ||
      value.artifactSelection.selectedBy === value.requested.scope;
    const portablePathValid =
      value.defaults.path === null ||
      (value.defaults.scope !== null &&
        !containsSensitiveMaterial(value.defaults.path) &&
        normalizePortablePath(value.defaults.path, value.defaults.scope, 'defaults.path').ok);
    const normalizedRegistry =
      value.defaults.registryDefault === null
        ? null
        : normalizeRegistryIdentity(value.defaults.registryDefault, {}, 'registry.default');
    const registryDefaultValid =
      value.defaults.registryDefault === null ||
      (!containsSensitiveMaterial(value.defaults.registryDefault) &&
        normalizedRegistry !== null &&
        normalizedRegistry.ok &&
        normalizedRegistry.value === value.defaults.registryDefault);
    const manifestParts = parse(value.artifactSelection.manifestPath);
    const expectedLockPath = join(manifestParts.dir, `${manifestParts.name}.lock`);
    const replacement = value.result.action === 'replace-manifest';
    const forceValid = replacement
      ? value.force.conflictType === 'destination-exists' &&
        value.force.applied === !value.dryRun &&
        value.force.target.location.path === value.artifactSelection.manifestPath
      : value.force.conflictType === null;
    const invalid =
      effect.role !== 'manifest' ||
      effect.action !== expectedAction ||
      effect.operationId !== value.result.operationId ||
      effect.outcome !== expectedOutcome ||
      value.summary.changed !== (unchanged ? 0 : 1) ||
      value.summary.unchanged !== (unchanged ? 1 : 0) ||
      value.requested.force !== value.force.requested ||
      value.requested.scope !== value.defaults.scope ||
      (value.defaults.scope === null && value.defaults.path !== null) ||
      (value.requested.explicitScope && value.requested.scope === null) ||
      !toolsEqual ||
      !toolSourceValid ||
      !selectedFileValid ||
      !explicitScopeSelectionValid ||
      !portablePathValid ||
      !registryDefaultValid ||
      value.artifactSelection.lockPath !== expectedLockPath ||
      !forceValid;
    if (invalid)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'init report fields are inconsistent',
      });
  });

export type InitV1Dto = z.infer<typeof InitV1Schema>;

export const toInitV1Dto = (report: InitReport): InitV1Dto => ({
  schemaVersion: report.schemaVersion,
  kind: report.kind,
  reportVersion: report.reportVersion,
  dryRun: report.dryRun,
  requested: {
    tools: Array.from(report.requested.tools) as InitV1Dto['requested']['tools'],
    explicitTools: report.requested.explicitTools,
    toolSource: report.requested.toolSource,
    scope: report.requested.scope,
    explicitScope: report.requested.explicitScope,
    file: report.requested.file,
    force: report.requested.force,
  },
  defaults: {
    tools:
      report.defaults.tools === null
        ? null
        : (Array.from(report.defaults.tools) as NonNullable<InitV1Dto['defaults']['tools']>),
    scope: report.defaults.scope,
    path: report.defaults.path,
    registryDefault: report.defaults.registryDefault,
  },
  artifactSelection: {
    outcome: report.artifactSelection.outcome,
    selectedBy: report.artifactSelection.selectedBy,
    manifestPath: report.artifactSelection.manifestPath,
    lockPath: report.artifactSelection.lockPath,
    lockSource: report.artifactSelection.lockSource,
  },
  result: {
    action: report.result.action,
    operationId: report.result.operationId,
    before: {
      state: report.result.before.state,
      shape: report.result.before.shape,
      byteHash: report.result.before.byteHash,
      semanticHash: report.result.before.semanticHash,
    },
    after:
      report.result.after === null
        ? null
        : {
            state: report.result.after.state,
            byteHash: report.result.after.byteHash,
            semanticHash: report.result.after.semanticHash,
          },
  } as InitV1Dto['result'],
  force: {
    requested: report.force.requested,
    applied: report.force.applied,
    conflictType: report.force.conflictType,
    target:
      report.force.target === null
        ? null
        : {
            kind: report.force.target.kind,
            ...('location' in report.force.target
              ? {
                  location: {
                    kind: report.force.target.location.kind,
                    ...('path' in report.force.target.location
                      ? { path: report.force.target.location.path }
                      : {}),
                  },
                }
              : {}),
          },
    normalBehavior: report.force.normalBehavior,
    forcedBehavior: report.force.forcedBehavior,
    backup: report.force.backup,
  } as InitV1Dto['force'],
  effects: report.effects.map((effect) => ({
    role: effect.role,
    action: effect.action,
    operationId: effect.operationId,
    outcome: effect.outcome,
  })) as InitV1Dto['effects'],
  summary: { changed: report.summary.changed, unchanged: report.summary.unchanged },
});

export const initV1Codec = createJsonWireCodec(
  {
    id: 'init',
    version: 1,
    wireKind: 'skillsmith.init',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  InitV1Schema,
);
