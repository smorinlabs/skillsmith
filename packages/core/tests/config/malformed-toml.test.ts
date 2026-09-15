import { describe, expect, test } from 'bun:test';
import { hermeticGitEnv } from '../fixtures/git-env.ts';

const schemaPath = new URL('../../src/config/schema.ts', import.meta.url).pathname;

describe('bounded malformed TOML rejection (#65)', () => {
  for (const input of ['a=[1 #', 'a={x=1 #']) {
    test(`unterminated comment: ${input}`, async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `import { parseConfig } from ${JSON.stringify(schemaPath)}; console.log(JSON.stringify(parseConfig(${JSON.stringify(input)})));`,
        ],
        { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
      );
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 1000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(timedOut).toBe(false);
        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: 'config-error' } });
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      }
    });
  }
});
