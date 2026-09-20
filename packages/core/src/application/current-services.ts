import { createNodeArtifactCoordinatorPorts } from '../artifacts/node-coordinator.ts';
import { VERSION } from '../version.ts';
import { runApplyApplication } from './apply-service.ts';
import { runExportApplication } from './export-service.ts';
import { runGcApplication } from './gc-service.ts';
import { runInitApplication } from './init-service.ts';
import { LIFECYCLE_APPLICATION_SERVICES } from './lifecycle-services.ts';
import { runPlanApplication } from './plan-service.ts';
import { CURRENT_READ_APPLICATIONS } from './read-services.ts';
import { runSearchApplication } from './search-service.ts';
import { runSyncApplication } from './sync-service.ts';
import { runUndoApplication } from './undo-service.ts';
import { runUpdateApplication } from './update-service.ts';
export { runExportApplication } from './export-service.ts';
export { runGcApplication } from './gc-service.ts';
export { runInitApplication } from './init-service.ts';
export { runPlanApplication } from './plan-service.ts';
export { runApplyApplication } from './apply-service.ts';
export { runSyncApplication } from './sync-service.ts';
export { runUpdateApplication } from './update-service.ts';
export { runUndoApplication } from './undo-service.ts';
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
const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [leftIndex, leftCharacter] of [...left].entries()) {
    const current = [leftIndex + 1];
    for (const [rightIndex, rightCharacter] of [...right].entries()) {
      current.push(
        Math.min(
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex + 1] ?? 0) + 1,
          (previous[rightIndex] ?? 0) + (leftCharacter === rightCharacter ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? right.length;
};

const nearestHelpName = (topic: string, known: readonly string[]): string | undefined => {
  const ranked = [...new Set(known)]
    .map((name) => ({ name, distance: editDistance(topic, name) }))
    .toSorted(
      (left, right) => left.distance - right.distance || left.name.localeCompare(right.name),
    );
  const nearest = ranked[0];
  const threshold = Math.max(1, Math.min(3, Math.floor(Math.max(topic.length, 3) / 3)));
  return nearest !== undefined && nearest.distance <= threshold ? nearest.name : undefined;
};

export const runHelpApplication: ApplicationService<
  CurrentCommandRequest,
  CliMetadataReport
> = async (request) => {
  const topic = request.arguments[0];
  const known = request.options.knownHelpNames;
  if (typeof topic === 'string' && Array.isArray(known) && !known.includes(topic)) {
    const suggestion = nearestHelpName(
      topic,
      known.filter((name): name is string => typeof name === 'string'),
    );
    return {
      report: { command: 'help', request },
      diagnostics: [
        {
          code: 'unknown-topic',
          severity: 'error',
          message: `'${topic}' is not a known command or topic${suggestion === undefined ? '' : `. Did you mean '${suggestion}'?`}`,
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
export const CURRENT_APPLICATION_SERVICES = Object.freeze({
  search: runSearchApplication,
  rootHelp: runRootHelpApplication as AnyCurrentApplicationService,
  configHelp: runConfigHelpApplication as AnyCurrentApplicationService,
  version: runVersionApplication as unknown as AnyCurrentApplicationService,
  completion: runCompletionApplication as AnyCurrentApplicationService,
  help: runHelpApplication as AnyCurrentApplicationService,
  export: runExportApplication as AnyCurrentApplicationService,
  gc: runGcApplication as AnyCurrentApplicationService,
  init: runInitApplication as AnyCurrentApplicationService,
  plan: runPlanApplication as AnyCurrentApplicationService,
  apply: runApplyApplication as AnyCurrentApplicationService,
  sync: runSyncApplication as AnyCurrentApplicationService,
  update: runUpdateApplication as AnyCurrentApplicationService,
  undo: runUndoApplication as AnyCurrentApplicationService,
  ...CURRENT_READ_APPLICATIONS,
  ...LIFECYCLE_APPLICATION_SERVICES,
});
