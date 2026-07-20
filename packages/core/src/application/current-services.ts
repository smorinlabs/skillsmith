import { createNodeArtifactCoordinatorPorts } from '../artifacts/node-coordinator.ts';
import { VERSION } from '../version.ts';
import { runApplyApplication } from './apply-service.ts';
import { runExportApplication } from './export-service.ts';
import { runInitApplication } from './init-service.ts';
import { LIFECYCLE_APPLICATION_SERVICES } from './lifecycle-services.ts';
import { runPlanApplication } from './plan-service.ts';
import { CURRENT_READ_APPLICATIONS } from './read-services.ts';
export { runExportApplication } from './export-service.ts';
export { runInitApplication } from './init-service.ts';
export { runPlanApplication } from './plan-service.ts';
export { runApplyApplication } from './apply-service.ts';
import {
  type ApplicationService,
  type CommandOutcome,
  type CurrentApplicationContext,
  type CurrentCommandRequest,
  NO_MUTATION,
} from './types.ts';

export type VersionApplicationRequest = Readonly<Record<string, never>>;

export interface VersionReport {
  readonly version: string;
}

/** Production composition seam; applications receive the resulting focused capability. */
export const defaultArtifactCoordinatorPorts = createNodeArtifactCoordinatorPorts;

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

export interface CliMetadataReport {
  readonly command: 'rootHelp' | 'configHelp' | 'completion' | 'help';
  readonly request: CurrentCommandRequest;
}

const metadataService =
  (
    command: CliMetadataReport['command'],
  ): ApplicationService<CurrentCommandRequest, CliMetadataReport> =>
  async (request): Promise<CommandOutcome<CliMetadataReport>> => ({
    report: { command, request },
    diagnostics: [],
    exitClass: 'success',
    mutation: NO_MUTATION,
    deprecations: [],
  });

export const runRootHelpApplication = metadataService('rootHelp');
export const runConfigHelpApplication = metadataService('configHelp');
export const runCompletionApplication = metadataService('completion');
export const runHelpApplication: ApplicationService<
  CurrentCommandRequest,
  CliMetadataReport
> = async (request) => {
  const topic = request.arguments[0];
  const known = request.options.knownHelpNames;
  if (typeof topic === 'string' && Array.isArray(known) && !known.includes(topic)) {
    return {
      report: { command: 'help', request },
      diagnostics: [
        {
          code: 'unknown-topic',
          severity: 'error',
          message: `'${topic}' is not a known command or topic`,
        },
      ],
      exitClass: 'usage',
      mutation: NO_MUTATION,
      deprecations: [],
    };
  }
  return metadataService('help')(request, {} as CurrentApplicationContext);
};

export type AnyCurrentApplicationService = (
  request: Readonly<CurrentCommandRequest>,
  context: CurrentApplicationContext,
) => Promise<CommandOutcome<unknown>>;

/** Exact public registry consumed by the shared CLI runtime and checked against CommandSpec. */
export const CURRENT_APPLICATION_SERVICES: Readonly<Record<string, AnyCurrentApplicationService>> =
  Object.freeze({
    rootHelp: runRootHelpApplication as AnyCurrentApplicationService,
    configHelp: runConfigHelpApplication as AnyCurrentApplicationService,
    version: runVersionApplication as unknown as AnyCurrentApplicationService,
    completion: runCompletionApplication as AnyCurrentApplicationService,
    help: runHelpApplication as AnyCurrentApplicationService,
    export: runExportApplication as AnyCurrentApplicationService,
    init: runInitApplication as AnyCurrentApplicationService,
    plan: runPlanApplication as AnyCurrentApplicationService,
    apply: runApplyApplication as AnyCurrentApplicationService,
    ...CURRENT_READ_APPLICATIONS,
    ...LIFECYCLE_APPLICATION_SERVICES,
  });
