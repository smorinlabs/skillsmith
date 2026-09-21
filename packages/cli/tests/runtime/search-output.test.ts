import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';

const entry = join(import.meta.dir, '../fixtures/search-output.ts');
let root = '';
let binary = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'skillsmith-search-output-'));
  binary = join(root, 'search-fixture');
  const built = Bun.spawnSync(
    [process.execPath, 'build', '--compile', entry, '--outfile', binary],
    {
      env: hermeticGitEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
  );
  expect(built.exitCode, built.stderr.toString()).toBe(0);
}, 60_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('search output drainage', () => {
  for (const mode of ['source', 'compiled']) {
    test(`${mode} drains a large JSON report through a slow pipe`, async () => {
      const command = mode === 'source' ? [process.execPath, entry] : [binary];
      const child = Bun.spawn([...command, 'search', 'react', '--json'], {
        cwd: root,
        env: hermeticGitEnv(),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => child.kill(), 15_000);
      const drain = async () => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let text = '';
        try {
          await Bun.sleep(100);
          for (;;) {
            const result = await reader.read();
            if (result.done) return text + decoder.decode();
            text += decoder.decode(result.value, { stream: true });
            await Bun.sleep(2);
          }
        } finally {
          reader.releaseLock();
        }
      };
      try {
        const [stdout, stderr, code] = await Promise.all([
          drain(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(Buffer.byteLength(stdout)).toBeGreaterThan(1_000_000);
        expect(stdout).toEndWith('}\n');
        expect(stdout).not.toContain('\u001b');
        const report = JSON.parse(stdout);
        expect(report.kind).toBe('skillsmith.search');
        expect(report.returned).toBe(20);
        expect(report.results).toHaveLength(20);
        for (const [index, hit] of report.results.entries())
          expect(hit.name).toBe(`${index}:${'é'.repeat(32_768)}`);
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
      }
    }, 20_000);
  }
});
