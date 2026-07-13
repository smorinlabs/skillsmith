import { VERSION } from '../version.ts';
import { type ApplicationService, type CommandOutcome, NO_MUTATION } from './types.ts';

export type VersionApplicationRequest = Readonly<Record<string, never>>;

export interface VersionReport {
  readonly version: string;
}

/**
 * Zero-discovery application canary. It intentionally does not inspect the transitional context,
 * construct an environment, resolve a project, or load configuration.
 */
export const runVersionApplication: ApplicationService<
  VersionApplicationRequest,
  VersionReport
> = async (_request, _context): Promise<CommandOutcome<VersionReport>> => ({
  report: { version: VERSION },
  diagnostics: [],
  exitClass: 'success',
  mutation: NO_MUTATION,
  deprecations: [],
});
