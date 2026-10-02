import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { confineTrappedCoordinator } from './coordination-trap.ts';

/**
 * Production artifact coordination deliberately ignores HOME/XDG and locks the real account's
 * `~/.skillsmith/coordination/artifacts-v1/global`. CLI subprocesses spawned by tests load this
 * preload so their coordinator is confined to the fixture root named by the environment variable.
 */
export const TEST_COORDINATION_PRELOAD = join(import.meta.dir, 'test-coordination-preload.ts');
export const TEST_COORDINATION_ROOT_ENV = 'SKILLSMITH_TEST_COORDINATION_ROOT';

/** Swap this process's production coordinator factory for the hermetic one rooted at `root`. */
export const confineArtifactCoordination = (root: string): void => {
  // Concurrent CLI children can share one fresh root, and the adapter's first-use mkdir is not
  // race tolerant; pre-create its private directories (as an existing account root would be).
  for (const directory of ['recovery', 'member-owners']) {
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  }
  // The coordinator rejects symlinked ancestors such as macOS /var -> /private/var.
  confineTrappedCoordinator(realpathSync(root));
};
