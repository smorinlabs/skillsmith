import { scanEnvFromRuntimePorts } from '../ports/compatibility.ts';
import { defaultRuntimePorts } from '../ports/default.ts';
import type { ScanEnv } from './types.ts';

/** @deprecated Use defaultRuntimePorts() for new application composition. */
export const defaultScanEnv = async (): Promise<ScanEnv> =>
  scanEnvFromRuntimePorts(await defaultRuntimePorts());
