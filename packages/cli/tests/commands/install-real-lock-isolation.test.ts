import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeArtifactCoordinatorPorts } from '../../../core/src/artifacts/node-coordinator.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';

// Guard for test isolation: production coordination deliberately ignores HOME/XDG and locks the
// real account's `~/.skillsmith/coordination/artifacts-v1/global`. A test that reaches that
// fallback fails with `operation failed` whenever any other process on the machine holds the
// lock. Hold the real lock exactly as production does, then run a representative install test
// file that once relied on the fallback; it must pass because tests no longer touch that lock.
const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const ISOLATED_FILE = './packages/cli/tests/commands/install-scope-filter.test.ts';

test('install tests pass while the real account artifact lock is held elsewhere', async () => {
  const production = await createNodeArtifactCoordinatorPorts();
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'skillsmith-real-lock-guard-')));
  const runIsolatedFile = async (): Promise<{ exitCode: number; output: string }> => {
    const child = Bun.spawn(
      [process.execPath, 'test', ISOLATED_FILE, '--timeout=60000', '--max-concurrency=1'],
      {
        cwd: REPOSITORY_ROOT,
        env: hermeticGitEnv({ TMPDIR: runRoot }),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}${stderr}` };
  };
  try {
    let result: { exitCode: number; output: string };
    try {
      result = await production.withFileLock(
        join(production.coordinationRoot, 'global'),
        { policy: 'central', centralOperationId: '0000000000000001', retryDelaysMs: [0] },
        runIsolatedFile,
      );
    } catch (error) {
      // Another process on this machine already holds the real lock: the premise holds anyway.
      if ((error as { reason?: unknown }).reason !== 'lock-contention') throw error;
      result = await runIsolatedFile();
    }
    expect(result.exitCode, result.output).toBe(0);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}, 120_000);
