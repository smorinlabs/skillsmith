import type { ScanEnv } from '../env/types.ts';
import type { ClockPort, IdPort, RuntimePorts } from './types.ts';

/** The capability surface that can be projected from the public 1.x ScanEnv contract. */
export type LegacyRuntimePorts = Omit<RuntimePorts, 'git' | 'http'>;

export interface LegacyRuntimePortSupplements {
  readonly clock: ClockPort;
  readonly id: IdPort;
}

export type RuntimePortsFromScanEnv = (
  env: ScanEnv,
  supplements: LegacyRuntimePortSupplements,
) => LegacyRuntimePorts;

export type ScanEnvFromRuntimePorts = (ports: LegacyRuntimePorts) => ScanEnv;
