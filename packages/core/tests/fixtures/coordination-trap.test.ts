import { test, expect } from 'bun:test';
import { createNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { PRODUCTION_COORDINATOR_TRAP_MESSAGE } from './coordination-trap.ts';

// Canary for the bunfig [test].preload: the production coordinator factory must be trapped in
// the runner process, or a test that omits its coordinator silently takes the real account's
// `~/.skillsmith` global lock. This test fails loudly if the trap is ever unwired.
test('production artifact coordinator factory is trapped in the test runner', async () => {
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await expect(createNodeArtifactCoordinatorPorts()).rejects.toThrow(
      PRODUCTION_COORDINATOR_TRAP_MESSAGE,
    );
  } finally {
    process.stderr.write = stderrWrite;
  }
});
