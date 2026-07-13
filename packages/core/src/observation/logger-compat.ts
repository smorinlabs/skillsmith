import type { Logger } from '../env/logger.ts';
import { createObservationEmitter } from './observer.ts';
import { createOperationContext } from './operation-context.ts';
import type { ObservationBundle, ObserverEvent, ObserverPort } from './types.ts';

export type LegacyObservationActivity = 'detect' | 'list-skills' | 'list-commands' | 'diagnostics';

const LEGACY_WALL_TIME = '1970-01-01T00:00:00.000Z';

const legacyObserver = (logger: Logger, activity: LegacyObservationActivity): ObserverPort =>
  Object.freeze({
    observe(event: ObserverEvent): void {
      switch (event.kind) {
        case 'tool.detection.started':
          logger.debug(`detecting ${event.toolId}`);
          return;
        case 'tool.detection.completed':
          if (event.outcome === 'failure' || event.outcome === 'cancelled')
            logger.warn(`detection error for ${event.toolId}`, { code: event.errorCode });
          return;
        case 'operation.completed':
          if (
            event.operationKind !== 'inventory' ||
            event.standaloneCount === null ||
            event.bundledCount === null ||
            event.resultCount === null
          )
            return;
          if (activity === 'list-commands') {
            logger.debug(
              `listCommands: ${event.standaloneCount} standalone + ${event.bundledCount} plugin = ${event.resultCount}`,
            );
            return;
          }
          if (activity === 'list-skills' || activity === 'diagnostics')
            logger.debug(
              `listSkills: ${event.standaloneCount} standalone + ${event.bundledCount} plugin = ${event.resultCount} after filters`,
            );
          return;
        default:
          return;
      }
    },
  });

export const observationFromLegacyLogger = (
  logger: Logger,
  activity: LegacyObservationActivity,
  toolIds: readonly string[] = [],
): ObservationBundle => {
  const clock = Object.freeze({
    wallNowIso: () => LEGACY_WALL_TIME,
    monotonicMilliseconds: () => 0,
  });
  const context = createOperationContext({
    operationId: 'legacy-observation',
    command: 'legacy-scan',
    workflow: activity,
    clock,
    id: { nextId: () => 'unused' },
  });
  return Object.freeze({
    context,
    emitter: createObservationEmitter({ observer: legacyObserver(logger, activity), toolIds }),
  });
};
