import { join } from 'node:path';
import type { PlatformPaths, ResolvedRuntimeConfiguration } from '../ports/types.ts';

export const resolveDataDir = (
  paths: Pick<PlatformPaths, 'xdg'>,
  configuration: Pick<ResolvedRuntimeConfiguration, 'skillsmithHome'>,
): string => configuration.skillsmithHome ?? join(paths.xdg.data, 'skillsmith');

export const storeRootOf = (dataDir: string): string => join(dataDir, 'store');

export const ledgerPathOf = (dataDir: string): string => join(dataDir, 'placements.json');
