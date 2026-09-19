import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const COUNT = 320;
const DESCRIPTION = `Unicode é 🦉 ${'fixture '.repeat(512)}`.trim();
let fixtureRoot = '';
let binary = '';
let env: Record<string, string | undefined>;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'skillsmith-list-output-'));
  binary = join(fixtureRoot, 'skillsmith');
  env = hermeticGitEnv({
    HOME: fixtureRoot,
    CODEX_HOME: join(fixtureRoot, '.codex'),
    CLAUDE_CONFIG_DIR: join(fixtureRoot, '.claude'),
    SKILLSMITH_HOME: join(fixtureRoot, 'data'),
    XDG_CONFIG_HOME: join(fixtureRoot, 'config'),
    XDG_DATA_HOME: join(fixtureRoot, 'xdg-data'),
    XDG_CACHE_HOME: join(fixtureRoot, 'cache'),
  });
  for (let i = 0; i < COUNT; i++) {
    const name = `skill-${String(i).padStart(4, '0')}`;
    const skill = join(fixtureRoot, '.agents', 'skills', name);
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${DESCRIPTION}\n---\n`,
    );
  }
  const compile = Bun.spawn(
    [process.execPath, 'build', '--compile', '--bytecode', CLI_ENTRYPOINT, '--outfile', binary],
    { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`native compile failed: ${stdout}\n${stderr}`);
}, 30_000);

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

const readSlowly = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
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

describe('large list JSON (#46)', () => {
  for (const executable of ['source', 'compiled'] as const) {
    for (const sink of ['pipe', 'slow-pipe', 'file'] as const) {
      test(`${executable}: complete output through ${sink}`, async () => {
        const destination = join(fixtureRoot, `${executable}-${sink}.json`);
        const file = sink === 'file' ? await open(destination, 'w') : undefined;
        try {
          const command = executable === 'source' ? [process.execPath, CLI_ENTRYPOINT] : [binary];
          const proc = Bun.spawn(
            [...command, 'list', '--tool', 'codex', '--scope', 'user', '--json'],
            {
              cwd: fixtureRoot,
              env: hermeticGitEnv(env),
              stdout: file?.fd ?? 'pipe',
              stderr: 'pipe',
            },
          );
          const output = file
            ? Promise.resolve('')
            : sink === 'slow-pipe'
              ? readSlowly(proc.stdout as ReadableStream<Uint8Array>)
              : new Response(proc.stdout as ReadableStream<Uint8Array>).text();
          const [code, piped, stderr] = await Promise.all([
            proc.exited,
            output,
            new Response(proc.stderr).text(),
          ]);
          const text = file ? await readFile(destination, 'utf8') : piped;
          expect(code).toBe(0);
          expect(stderr).toBe('');
          expect(Buffer.byteLength(text)).toBeGreaterThan(128 * 1024);
          const parsed = JSON.parse(text);
          expect(parsed.entries).toHaveLength(COUNT);
          expect(
            parsed.entries.every(
              (skill: { frontmatter: { description: string } }) =>
                skill.frontmatter.description === DESCRIPTION,
            ),
          ).toBe(true);
        } finally {
          await file?.close();
        }
      }, 30_000);
    }
  }
});
