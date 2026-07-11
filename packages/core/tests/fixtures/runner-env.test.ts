import { test, expect } from 'bun:test';
import { GIT_REPO_SCRUB_VARS } from './git-env.ts';

// Canary for the bunfig [test].preload: the runner process itself must be
// clean, or tests that call production spawn paths in-process (execCommand,
// defaultScanEnv) re-inherit a hook's GIT_DIR (#17). Under lefthook pre-push
// this test fails loudly if the preload is ever unwired.
test('test runner env carries no git repo-location variables', () => {
  for (const name of GIT_REPO_SCRUB_VARS) {
    expect(process.env[name]).toBeUndefined();
  }
});
