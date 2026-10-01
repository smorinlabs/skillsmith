// Bun preload for test-spawned CLI subprocesses (see test-coordination.ts). It swaps only the
// production coordinator factory for the hermetic test factory; every other export is unchanged.
import { TEST_COORDINATION_ROOT_ENV, confineArtifactCoordination } from './test-coordination.ts';

const root = process.env[TEST_COORDINATION_ROOT_ENV];
if (root === undefined || root === '') {
  throw new Error(`${TEST_COORDINATION_ROOT_ENV} is required by the test coordination preload`);
}
confineArtifactCoordination(root);
