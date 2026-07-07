import { join } from 'node:path';
import type { ScanEnv } from '../env/types.ts';

export const resolveDataDir = (env: ScanEnv, envVars: Record<string, string | undefined>): string =>
  envVars.SKILLSMITH_HOME ?? join(env.xdg.data, 'skillsmith');

export const storeRootOf = (dataDir: string): string => join(dataDir, 'store');

export const ledgerPathOf = (dataDir: string): string => join(dataDir, 'placements.json');
