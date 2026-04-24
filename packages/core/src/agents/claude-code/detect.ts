import { classifyInstallMethod, findOnPath } from '../../detect/scanners.ts';
import type { ScanEnv } from '../../env/types.ts';
import { type SkillSmithError, genericError } from '../../errors.ts';
import { type Result, err, ok } from '../../result.ts';
import type { InstallRecord } from '../types.ts';

const BINARY = 'claude';

export const detect = async (
  env: ScanEnv,
  signal?: AbortSignal,
): Promise<Result<InstallRecord[], SkillSmithError>> => {
  try {
    const paths = await findOnPath(env, BINARY);
    const records = await Promise.all(
      paths.map(
        async (p): Promise<InstallRecord> => ({
          path: p,
          version: await env.runVersion(p, ['--version'], signal),
          installMethod: classifyInstallMethod(p),
        }),
      ),
    );
    return ok(records);
  } catch (e) {
    return err(genericError('claude-code detection failed', e));
  }
};
