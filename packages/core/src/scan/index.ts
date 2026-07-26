import { getAgent, listSupportedTools, registry } from '../agents/registry.ts';
import type { InstallRecord, SupportedTool } from '../agents/types.ts';
import type { Logger } from '../env/logger.ts';
import { type SkillSmithError, unknownToolError } from '../errors.ts';
import type { ObservationBundle } from '../observation/index.ts';
import { resolveObservationBundle } from '../observation/logger-compat.ts';
import type { DetectionPorts } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';

export interface DetectOptions {
  tools?: readonly SupportedTool[];
  observation?: ObservationBundle;
  /** @deprecated Use observation. */
  logger?: Logger;
  signal?: AbortSignal;
}

export const detectTool = async (
  env: DetectionPorts,
  tool: string,
  signal?: AbortSignal,
): Promise<Result<InstallRecord[], SkillSmithError>> => {
  const a = getAgent(tool);
  if (!a.ok) return a;
  return a.value.detect(env, signal);
};

export const detectAll = async (
  env: DetectionPorts,
  opts: DetectOptions = {},
): Promise<Result<Map<SupportedTool, InstallRecord[]>, SkillSmithError>> => {
  const tools = opts.tools ?? listSupportedTools();

  for (const t of tools) {
    if (!(t in registry)) return err(unknownToolError(t));
  }

  const observation = resolveObservationBundle(opts.observation, opts.logger, 'detect', [
    ...new Set(tools),
  ]);

  const entries = await Promise.all(
    tools.map(async (t) => {
      const span = observation.emitter.begin(observation.context, {
        kind: 'tool.detection.started',
        toolId: t,
      });
      const r = await registry[t].detect(env, opts.signal);
      if (!r.ok) {
        observation.emitter.complete(span, {
          outcome: 'failure',
          errorCode: r.error.code,
          resultCount: 0,
        });
        return [t, [] as InstallRecord[]] as const;
      }
      observation.emitter.complete(span, {
        outcome: 'success',
        errorCode: null,
        resultCount: r.value.length,
      });
      return [t, r.value] as const;
    }),
  );

  return ok(new Map(entries));
};
