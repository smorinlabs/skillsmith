import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { SUPPORTED_TOOLS } from '../agents/types.ts';
import {
  classifyManifestSource,
  normalizeManifestDocument,
  readManifestSource,
} from '../artifacts/index.ts';
import { type SkillSmithError, configError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type Config,
  type ConfigDocumentShape,
  type ParsedConfigDocument,
  SCOPES,
} from './types.ts';

const RegistrySchema = z
  .object({ default: z.string().min(1).optional() })
  .strict('registry: unknown key');

const FlatConfigSchema = z
  .object({
    tool: z.enum(SUPPORTED_TOOLS).optional(),
    scope: z.enum(SCOPES).optional(),
    path: z.string().optional(),
    registry: RegistrySchema.optional(),
  })
  .strict('unknown top-level key');

const parsedToml = (text: string): Result<unknown, SkillSmithError> => {
  try {
    return ok(parseToml(text));
  } catch {
    // Parser diagnostics may quote the malformed source line. Keep untrusted bytes out of errors.
    return err(configError('TOML parse error'));
  }
};

const schemaError = (
  label: string,
  issue: { readonly path: readonly (string | number)[]; readonly message: string } | undefined,
): SkillSmithError => {
  const safeSegments = new Set(['tool', 'scope', 'path', 'registry', 'default']);
  const segments = issue?.path.filter(
    (part): part is string => typeof part === 'string' && safeSegments.has(part),
  );
  const path = segments && segments.length > 0 ? segments.join('.') : '<root>';
  return configError(`${label}: ${path}: invalid value`);
};

export const classifyConfigDocument = (text: string): ConfigDocumentShape => {
  return classifyManifestSource(text);
};

const portableRegistry = (value: string, canonical: boolean): boolean => {
  if (/[%?#@]/.test(value)) return false;
  if (canonical) return /^[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._-]+)*$/.test(value);
  if (/^https:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === 'https:' &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.search === '' &&
        parsed.hash === '' &&
        parsed.pathname.split('/').every((part) => part !== '..')
      );
    } catch {
      return false;
    }
  }
  return /^[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._-]+)*$/.test(value);
};

/** Credential-free canonical registry identity accepted at environment/CLI boundaries. */
export const isCredentialFreeRegistryIdentity = (value: string): boolean =>
  portableRegistry(value, true);

export const parseProjectConfig = (text: string): Result<ParsedConfigDocument, SkillSmithError> => {
  const shape = classifyConfigDocument(text);
  if (shape !== 'canonical' && shape !== 'legacy') {
    return err(configError(`project config shape is ${shape}`));
  }
  const document = readManifestSource(text);
  if (!document.ok) return err(configError(document.error.message));
  const normalized = normalizeManifestDocument(document.value);
  if (!normalized.ok) return err(configError(normalized.error.message));
  const defaults = normalized.value.defaults;
  const tools = defaults?.tools;
  const singleton = tools?.length === 1 ? tools[0] : undefined;
  const registryDefault = normalized.value.registry?.default;
  const config: Config = {
    ...(singleton === undefined
      ? tools && tools.length > 1
        ? { tools: Object.freeze([...tools]) }
        : {}
      : { tool: singleton }),
    ...(defaults?.scope === undefined ? {} : { scope: defaults.scope }),
    ...(defaults?.path === undefined ? {} : { path: defaults.path }),
    ...(registryDefault === undefined ? {} : { registry: { default: registryDefault } }),
  };
  return ok(
    Object.freeze({
      config,
      shape,
      migrationPending: document.value.migrationPending,
      source: text,
    }),
  );
};

/** Parse the scalar user/system compatibility schema. Empty and comment-only files remain valid. */
export const parseConfig = (text: string): Result<Config, SkillSmithError> => {
  const raw = parsedToml(text);
  if (!raw.ok) return raw;
  const parsed = FlatConfigSchema.safeParse(raw.value);
  if (!parsed.success) return err(schemaError('config schema', parsed.error.issues[0]));
  const registry = parsed.data.registry?.default;
  if (registry !== undefined && !portableRegistry(registry, false)) {
    return err(configError('config registry identity is not credential-free'));
  }
  return ok(parsed.data as Config);
};
