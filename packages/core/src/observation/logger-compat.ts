import type { Logger } from '../env/logger.ts';
import { createObservationEmitter, noopObserver } from './observer.ts';
import { createOperationContext } from './operation-context.ts';
import { redactObservationValue } from './redaction.ts';
import type { ObservationBundle, ObserverEvent, ObserverPort } from './types.ts';

export type LegacyObservationActivity = 'detect' | 'list-skills' | 'list-commands' | 'diagnostics';

const LEGACY_WALL_TIME = '1970-01-01T00:00:00.000Z';

const redactedString = (value: string): string => redactObservationValue(value) as string;

const legacyObserver = (logger: Logger, activity: LegacyObservationActivity): ObserverPort =>
  Object.freeze({
    observe(event: ObserverEvent): void {
      switch (event.kind) {
        case 'tool.detection.started':
          logger.debug(`detecting ${redactedString(event.toolId)}`);
          return;
        case 'tool.detection.completed':
          if (event.outcome === 'failure' || event.outcome === 'cancelled')
            logger.warn(`detection error for ${redactedString(event.toolId)}`, {
              code: event.errorCode === null ? null : redactedString(event.errorCode),
            });
          return;
        case 'operation.completed':
          if (
            event.outcome !== 'success' ||
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

export const resolveObservationBundle = (
  observation: ObservationBundle | undefined,
  logger: Logger | undefined,
  activity: LegacyObservationActivity,
  toolIds: readonly string[] = [],
): ObservationBundle => {
  if (observation !== undefined) return observation;
  if (logger !== undefined) return observationFromLegacyLogger(logger, activity, toolIds);
  const clock = Object.freeze({
    wallNowIso: () => LEGACY_WALL_TIME,
    monotonicMilliseconds: () => 0,
  });
  const context = createOperationContext({
    operationId: 'noop-observation',
    command: 'direct-scan',
    workflow: activity,
    clock,
    id: { nextId: () => 'unused' },
  });
  return Object.freeze({
    context,
    emitter: createObservationEmitter({ observer: noopObserver, toolIds }),
  });
};
