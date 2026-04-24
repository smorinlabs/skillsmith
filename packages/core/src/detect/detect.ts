import { getAgent, listSupportedTools, registry } from '../agents/registry.ts';
import type { InstallRecord, SupportedTool } from '../agents/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { ScanEnv } from '../env/types.ts';
import { type SkillSmithError, unknownToolError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';

export interface DetectOptions {
  tools?: readonly SupportedTool[];
  logger?: Logger;
  signal?: AbortSignal;
}

export const detectTool = async (
  env: ScanEnv,
  tool: string,
  signal?: AbortSignal,
): Promise<Result<InstallRecord[], SkillSmithError>> => {
  const a = getAgent(tool);
  if (!a.ok) return a;
  return a.value.detect(env, signal);
};

export const detectAll = async (
  env: ScanEnv,
  opts: DetectOptions = {},
): Promise<Result<Map<SupportedTool, InstallRecord[]>, SkillSmithError>> => {
  const logger = opts.logger ?? noopLogger;
  const tools = opts.tools ?? listSupportedTools();

  for (const t of tools) {
    if (!(t in registry)) return err(unknownToolError(t));
  }

  const entries = await Promise.all(
    tools.map(async (t) => {
      logger.debug(`detecting ${t}`);
      const r = await registry[t].detect(env, opts.signal);
      if (!r.ok) {
        logger.warn(`detection error for ${t}`, { code: r.error.code });
        return [t, [] as InstallRecord[]] as const;
      }
      return [t, r.value] as const;
    }),
  );

  return ok(new Map(entries));
};
