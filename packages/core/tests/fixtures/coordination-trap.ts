import { mock } from 'bun:test';
import * as nodeCoordinator from '../../src/artifacts/node-coordinator.ts';

// Guard for test isolation: production coordination deliberately ignores HOME/XDG and locks the
// real account's `~/.skillsmith/coordination/artifacts-v1/global`. A test that reaches that
// fallback writes into the developer's real home and fails with `operation failed` whenever any
// other process on the machine holds the lock. Loaded by preload.ts, this makes the production
// factory fail loudly in every test-runner process; tests inject
// createTestNodeArtifactCoordinatorPorts or call confineArtifactCoordination instead.
export const PRODUCTION_COORDINATOR_TRAP_MESSAGE =
  'test constructed the production artifact coordinator (real ~/.skillsmith global lock)';

/** The real production factory, for the tests that build the production adapter on purpose. */
export const productionArtifactCoordinatorPorts =
  nodeCoordinator.createNodeArtifactCoordinatorPorts;

mock.module('../../src/artifacts/node-coordinator.ts', () => ({
  ...nodeCoordinator,
  createNodeArtifactCoordinatorPorts: async () => {
    const error = new Error(PRODUCTION_COORDINATOR_TRAP_MESSAGE);
    // Callers such as runInstall redact unknown errors to `operation failed`; name the culprit.
    process.stderr.write(`${error.stack ?? error.message}\n`);
    throw error;
  },
}));
