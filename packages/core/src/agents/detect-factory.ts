import { classifyInstallMethod, findOnPath } from '../detect/scanners.ts';
import { type SkillSmithError, genericError } from '../errors.ts';
import type { DetectionPorts } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { InstallRecord, SupportedTool } from './types.ts';

export const createBinaryDetect =
  (
    tool: SupportedTool,
    binary: string,
    versionEnv?: Record<string, string>,
  ): ((
    env: DetectionPorts,
    signal?: AbortSignal,
  ) => Promise<Result<InstallRecord[], SkillSmithError>>) =>
  async (env, signal) => {
    try {
      const paths = await findOnPath(env, binary);
      const records = await Promise.all(
        paths.map(
          async (p): Promise<InstallRecord> => ({
            path: p,
            version: await env.runVersion(p, ['--version'], signal, versionEnv),
            installMethod: classifyInstallMethod(p),
          }),
        ),
      );
      return ok(records);
    } catch (e) {
      return err(genericError(`${tool} detection failed`, e));
    }
  };
