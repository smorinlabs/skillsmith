import { z } from 'zod';
import type {
  InstallReport,
  InstallResult,
  UninstallReport,
  UninstallResult,
} from '../../acquire/types.ts';
import { FLIP_TOOLS } from '../../agents/registry.ts';
import { createJsonWireCodec } from '../codec.ts';

const ToolV1Schema = z.enum(FLIP_TOOLS);
const ScopeV1Schema = z.enum(['user', 'project']);
const PlacementV1Schema = z.enum(['symlink', 'copy']);

const InstallStoreV1Schema = z
  .object({
    path: z.string(),
    rev: z.string(),
    gitSha: z.string(),
    reused: z.boolean(),
  })
  .strict()
  .nullable();

const InstallOriginV1Schema = z
  .object({
    host: z.string(),
    repo: z.string(),
    skillPath: z.string(),
    refRequested: z.string().nullable(),
    refResolved: z.string(),
    pin: z.boolean(),
  })
  .strict()
  .nullable();

const InstallVerifyV1Schema = z
  .object({
    gate: z.enum(['passed', 'warned', 'failed', 'skipped', 'inconclusive']),
    verdict: z.enum(['pass', 'warn', 'fail', 'inconclusive']).nullable(),
    mode: z.enum(['static', 'static+deep']).nullable(),
  })
  .strict()
  .nullable();

const InstallResultV1Schema = z
  .object({
    source: z.string(),
    skill: z.string().nullable(),
    tool: ToolV1Schema.nullable(),
    scope: ScopeV1Schema,
    placementPath: z.string().nullable(),
    action: z.enum(['installed', 'updated', 'repaired', 'noop', 'skipped', 'refused', 'failed']),
    reason: z.string().nullable(),
    placement: PlacementV1Schema.nullable(),
    store: InstallStoreV1Schema,
    origin: InstallOriginV1Schema,
    verify: InstallVerifyV1Schema,
    candidates: z.array(z.string()).nullable(),
  })
  .strict();

const InstallV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.install'),
    dryRun: z.boolean(),
    requested: z
      .object({
        sources: z.array(z.string()),
        tools: z.array(ToolV1Schema),
        explicitTools: z.boolean(),
        scope: ScopeV1Schema,
        explicitScope: z.boolean(),
        ref: z.string().nullable(),
        pin: z.boolean(),
        direct: z.boolean(),
        force: z.boolean(),
        verify: z.enum(['static', 'skipped']),
        deep: z.boolean(),
      })
      .strict(),
    results: z.array(InstallResultV1Schema),
    summary: z
      .object({
        installed: z.number(),
        updated: z.number(),
        repaired: z.number(),
        noop: z.number(),
        skipped: z.number(),
        refused: z.number(),
        failed: z.number(),
      })
      .strict(),
  })
  .strict();

const UninstallBeforeV1Schema = z
  .object({
    mode: z.enum(['dev', 'pinned']),
    placement: PlacementV1Schema.nullable(),
    storePath: z.string().nullable(),
    symlinkTarget: z.string().nullable(),
  })
  .strict()
  .nullable();

const UninstallResultV1Schema = z
  .object({
    skill: z.string(),
    tool: ToolV1Schema.nullable(),
    scope: ScopeV1Schema.nullable(),
    placementPath: z.string().nullable(),
    action: z.enum(['removed', 'noop', 'refused', 'failed']),
    reason: z.string().nullable(),
    before: UninstallBeforeV1Schema,
    storeRetained: z.string().nullable(),
    backupKept: z.string().nullable(),
  })
  .strict();

const UninstallV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.uninstall'),
    dryRun: z.boolean(),
    requested: z
      .object({
        targets: z.array(z.string()),
        tools: z.array(ToolV1Schema),
        explicitTools: z.boolean(),
        scope: ScopeV1Schema.nullable(),
        allScopes: z.boolean(),
        force: z.boolean(),
      })
      .strict(),
    results: z.array(UninstallResultV1Schema),
    summary: z
      .object({
        removed: z.number(),
        noop: z.number(),
        refused: z.number(),
        failed: z.number(),
      })
      .strict(),
  })
  .strict();

export type InstallV1Dto = z.infer<typeof InstallV1Schema>;
export type UninstallV1Dto = z.infer<typeof UninstallV1Schema>;

const toInstallResultV1Dto = (source: InstallResult): InstallV1Dto['results'][number] => ({
  source: source.source,
  skill: source.skill,
  tool: source.tool,
  scope: source.scope,
  placementPath: source.placementPath,
  action: source.action,
  reason: source.reason,
  placement: source.placement,
  store:
    source.store === null
      ? null
      : {
          path: source.store.path,
          rev: source.store.rev,
          gitSha: source.store.gitSha,
          reused: source.store.reused,
        },
  origin:
    source.origin === null
      ? null
      : {
          host: source.origin.host,
          repo: source.origin.repo,
          skillPath: source.origin.skillPath,
          refRequested: source.origin.refRequested,
          refResolved: source.origin.refResolved,
          pin: source.origin.pin,
        },
  verify:
    source.verify === null
      ? null
      : {
          gate: source.verify.gate,
          verdict: source.verify.verdict,
          mode: source.verify.mode,
        },
  candidates: source.candidates === null ? null : Array.from(source.candidates),
});

export const toInstallV1Dto = (report: InstallReport): InstallV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.install',
  dryRun: report.dryRun,
  requested: {
    sources: Array.from(report.requested.sources),
    tools: Array.from(report.requested.tools),
    explicitTools: report.requested.explicitTools,
    scope: report.requested.scope,
    explicitScope: report.requested.explicitScope,
    ref: report.requested.ref,
    pin: report.requested.pin,
    direct: report.requested.direct,
    force: report.requested.force,
    verify: report.requested.verify,
    deep: report.requested.deep,
  },
  results: report.results.map(toInstallResultV1Dto),
  summary: {
    installed: report.summary.installed,
    updated: report.summary.updated,
    repaired: report.summary.repaired,
    noop: report.summary.noop,
    skipped: report.summary.skipped,
    refused: report.summary.refused,
    failed: report.summary.failed,
  },
});

const toUninstallResultV1Dto = (source: UninstallResult): UninstallV1Dto['results'][number] => ({
  skill: source.skill,
  tool: source.tool,
  scope: source.scope,
  placementPath: source.placementPath,
  action: source.action,
  reason: source.reason,
  before:
    source.before === null
      ? null
      : {
          mode: source.before.mode,
          placement: source.before.placement,
          storePath: source.before.storePath,
          symlinkTarget: source.before.symlinkTarget,
        },
  storeRetained: source.storeRetained,
  backupKept: source.backupKept,
});

export const toUninstallV1Dto = (report: UninstallReport): UninstallV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.uninstall',
  dryRun: report.dryRun,
  requested: {
    targets: Array.from(report.requested.targets),
    tools: Array.from(report.requested.tools),
    explicitTools: report.requested.explicitTools,
    scope: report.requested.scope,
    allScopes: report.requested.allScopes,
    force: report.requested.force,
  },
  results: report.results.map(toUninstallResultV1Dto),
  summary: {
    removed: report.summary.removed,
    noop: report.summary.noop,
    refused: report.summary.refused,
    failed: report.summary.failed,
  },
});

export const installV1Codec = createJsonWireCodec(
  {
    id: 'install',
    version: 1,
    wireKind: 'skillsmith.install',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  InstallV1Schema,
);

export const uninstallV1Codec = createJsonWireCodec(
  {
    id: 'uninstall',
    version: 1,
    wireKind: 'skillsmith.uninstall',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  UninstallV1Schema,
);
