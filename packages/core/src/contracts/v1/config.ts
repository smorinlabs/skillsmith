import { z } from 'zod';
import { SUPPORTED_TOOLS } from '../../agents/types.ts';
import type {
  ConfigGetReport,
  ConfigListReport,
  ConfigSetReport,
  ConfigUnsetReport,
} from '../../application/read-services.ts';
import { type Config, SCOPES } from '../../config/types.ts';
import { createJsonWireCodec } from '../codec.ts';

const ConfigV1Schema = z
  .object({
    tool: z.enum(SUPPORTED_TOOLS).optional(),
    tools: z.array(z.enum(SUPPORTED_TOOLS)).readonly().optional(),
    scope: z.enum(SCOPES).optional(),
    path: z.string().optional(),
    registry: z.object({ default: z.string().optional() }).strict().optional(),
  })
  .strict();

const ConfigNoticeV1Schema = z.union([
  z
    .object({
      code: z.literal('legacy-project-config'),
      path: z.string(),
      migrationPending: z.literal(true),
      migrationPhase: z.literal(2),
    })
    .strict(),
  z
    .object({
      code: z.literal('plural-tool-selection'),
      path: z.string().optional(),
      tools: z.array(z.enum(SUPPORTED_TOOLS)).readonly(),
      source: z.enum(['defaults', 'system', 'user', 'project', 'explicit-file', 'env', 'cli']),
      disposition: z.enum(['effective', 'shadowed']),
    })
    .strict(),
]);

const ConfigGetV1Schema = z
  .object({
    key: z.string(),
    value: z.string().nullable(),
    source: z
      .enum(['defaults', 'system', 'user', 'project', 'explicit-file', 'env', 'cli'])
      .optional(),
    notices: z.array(ConfigNoticeV1Schema).readonly().optional(),
  })
  .strict();

const SourcesV1Schema = z
  .object({
    tool: z
      .enum(['defaults', 'system', 'user', 'project', 'explicit-file', 'env', 'cli'])
      .optional(),
    scope: z
      .enum(['defaults', 'system', 'user', 'project', 'explicit-file', 'env', 'cli'])
      .optional(),
    path: z
      .enum(['defaults', 'system', 'user', 'project', 'explicit-file', 'env', 'cli'])
      .optional(),
    'registry.default': z
      .enum(['defaults', 'system', 'user', 'project', 'explicit-file', 'env', 'cli'])
      .optional(),
  })
  .strict();

const LayersV1Schema = z
  .object({
    defaults: ConfigV1Schema,
    system: ConfigV1Schema,
    user: ConfigV1Schema,
    project: ConfigV1Schema,
    'explicit-file': ConfigV1Schema,
    env: ConfigV1Schema,
    cli: ConfigV1Schema,
  })
  .strict();

const ConfigListUnscopedV1Schema = z
  .object({
    effective: ConfigV1Schema,
    sources: SourcesV1Schema,
    layers: LayersV1Schema,
    notices: z.array(ConfigNoticeV1Schema).readonly().optional(),
  })
  .strict();

const ConfigListV1Schema = z.union([ConfigListUnscopedV1Schema, ConfigV1Schema]);

const ConfigSetV1Schema = z
  .object({
    key: z.string(),
    value: z.string(),
    scope: z.enum(['system', 'user', 'project']),
    file: z.string().nullable(),
    operation: z.literal('migrate-project-config').optional(),
  })
  .strict();

const ConfigUnsetV1Schema = z
  .object({
    key: z.string(),
    scope: z.enum(['system', 'user', 'project']),
    file: z.string().nullable(),
    operation: z.literal('migrate-project-config').optional(),
  })
  .strict();

export type ConfigGetV1Dto = z.infer<typeof ConfigGetV1Schema>;
export type ConfigListV1Dto = z.infer<typeof ConfigListV1Schema>;
export type ConfigSetV1Dto = z.infer<typeof ConfigSetV1Schema>;
export type ConfigUnsetV1Dto = z.infer<typeof ConfigUnsetV1Schema>;

const toConfigV1Dto = (source: Config): z.infer<typeof ConfigV1Schema> => {
  const dto: z.infer<typeof ConfigV1Schema> = {};
  if (source.tool !== undefined) dto.tool = source.tool;
  if (source.tools !== undefined) dto.tools = source.tools;
  if (source.scope !== undefined) dto.scope = source.scope;
  if (source.path !== undefined) dto.path = source.path;
  if (source.registry !== undefined) {
    dto.registry = {};
    if (source.registry.default !== undefined) dto.registry.default = source.registry.default;
  }
  return dto;
};

const toSourcesV1Dto = (source: ConfigListReport['sources']): z.infer<typeof SourcesV1Schema> => {
  const dto: z.infer<typeof SourcesV1Schema> = {};
  if (source.tool !== undefined) dto.tool = source.tool;
  if (source.scope !== undefined) dto.scope = source.scope;
  if (source.path !== undefined) dto.path = source.path;
  if (source['registry.default'] !== undefined)
    dto['registry.default'] = source['registry.default'];
  return dto;
};

const toLayersV1Dto = (source: ConfigListReport['layers']): z.infer<typeof LayersV1Schema> => ({
  defaults: toConfigV1Dto(source.defaults),
  system: toConfigV1Dto(source.system),
  user: toConfigV1Dto(source.user),
  project: toConfigV1Dto(source.project),
  'explicit-file': toConfigV1Dto(source['explicit-file']),
  env: toConfigV1Dto(source.env),
  cli: toConfigV1Dto(source.cli),
});

export const toConfigGetV1Dto = (report: ConfigGetReport): ConfigGetV1Dto => {
  const dto: ConfigGetV1Dto = { key: report.key, value: report.value };
  if (report.scope === undefined && report.source !== undefined) dto.source = report.source;
  if (report.notices !== undefined) dto.notices = report.notices;
  return dto;
};

export const toConfigListV1Dto = (report: ConfigListReport): ConfigListV1Dto => {
  if (report.scope !== undefined) return toConfigV1Dto(report.layers[report.scope]);
  return {
    effective: toConfigV1Dto(report.effective),
    sources: toSourcesV1Dto(report.sources),
    layers: toLayersV1Dto(report.layers),
    ...(report.notices === undefined ? {} : { notices: report.notices }),
  };
};

export const toConfigSetV1Dto = (report: ConfigSetReport): ConfigSetV1Dto => ({
  key: report.key,
  value: report.value,
  scope: report.scope,
  file: report.file,
  ...('operation' in report && report.operation === 'migrate-project-config'
    ? { operation: report.operation }
    : {}),
});

export const toConfigUnsetV1Dto = (report: ConfigUnsetReport): ConfigUnsetV1Dto => ({
  key: report.key,
  scope: report.scope,
  file: report.file,
  ...('operation' in report && report.operation === 'migrate-project-config'
    ? { operation: report.operation }
    : {}),
});

export const configGetV1Codec = createJsonWireCodec(
  {
    id: 'config-get',
    version: 1,
    wireKind: null,
    embeddedVersion: null,
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  ConfigGetV1Schema,
);

export const configListV1Codec = createJsonWireCodec(
  {
    id: 'config-list',
    version: 1,
    wireKind: null,
    embeddedVersion: null,
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  ConfigListV1Schema,
);

export const configSetV1Codec = createJsonWireCodec(
  {
    id: 'config-set',
    version: 1,
    wireKind: null,
    embeddedVersion: null,
    unknownFields: 'reject-recursive',
    formatting: { indent: 0, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  ConfigSetV1Schema,
);

export const configUnsetV1Codec = createJsonWireCodec(
  {
    id: 'config-unset',
    version: 1,
    wireKind: null,
    embeddedVersion: null,
    unknownFields: 'reject-recursive',
    formatting: { indent: 0, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  ConfigUnsetV1Schema,
);
