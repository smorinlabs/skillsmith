import { describe, expect, test } from 'bun:test';
import {
  type ApplicationService,
  COMMAND_EXIT_CLASSES,
  type CurrentApplicationContext,
  NO_MUTATION,
  VERSION,
  type VersionApplicationRequest,
  type VersionReport,
  runVersionApplication,
} from '@skillsmith/core';

describe('current application-service foundation', () => {
  test('exit classes cover code-1 failure without assigning numeric CLI policy', () => {
    expect(COMMAND_EXIT_CLASSES).toEqual([
      'success',
      'failure',
      'usage',
      'state',
      'capability',
      'source',
      'permission',
      'drift',
      'cancelled',
    ]);
    expect(COMMAND_EXIT_CLASSES).not.toContain(1 as never);
  });

  test('version is a typed zero-discovery application service', async () => {
    const service: ApplicationService<VersionApplicationRequest, VersionReport> =
      runVersionApplication;
    const poisonedContext = new Proxy({} as CurrentApplicationContext, {
      get: (_target, property) => {
        throw new Error(`version application unexpectedly read context.${String(property)}`);
      },
    });

    expect(await service({}, poisonedContext)).toEqual({
      report: { version: VERSION },
      diagnostics: [],
      exitClass: 'success',
      mutation: NO_MUTATION,
      deprecations: [],
    });
  });

  test('the shared no-mutation value is immutable', () => {
    expect(NO_MUTATION).toEqual({
      kind: 'none',
      planned: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(Object.isFrozen(NO_MUTATION)).toBeTrue();
  });
});
