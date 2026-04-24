import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { SUPPORTED_TOOLS } from '../agents/types.ts';
import { type SkillSmithError, configError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type { Config } from './types.ts';

const RegistrySchema = z.object({ default: z.string().optional() }).strict('registry: unknown key');

const ConfigSchema = z
  .object({
    tool: z.enum(SUPPORTED_TOOLS as unknown as readonly [string, ...string[]]).optional(),
    scope: z.enum(['system', 'user', 'project']).optional(),
    path: z.string().optional(),
    registry: RegistrySchema.optional(),
  })
  .strict('unknown top-level key');

export const parseConfig = (text: string): Result<Config, SkillSmithError> => {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    return err(configError(`TOML parse error: ${e instanceof Error ? e.message : String(e)}`));
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') || '<root>';
    return err(configError(`config schema: ${path}: ${first?.message ?? 'invalid'}`));
  }
  return ok(parsed.data as Config);
};
