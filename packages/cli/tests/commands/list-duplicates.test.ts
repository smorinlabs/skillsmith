import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

let root = '';
let home = '';
let project = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skillsmith-duplicates-'));
  home = join(root, 'home');
  project = join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  // P17 includes project scope only when an actual project context is present.
  const init = Bun.spawn(['git', 'init', '--quiet', project], {
    env: hermeticGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await init.exited) !== 0) throw new Error(await new Response(init.stderr).text());
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const skill = async (parent: string, toolDir: string, name: string) => {
  const path = join(parent, toolDir, 'skills', name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n`);
};

const list = async (...args: string[]) => {
  const proc = Bun.spawn([process.execPath, CLI_ENTRYPOINT, 'list', ...args], {
    cwd: project,
    env: hermeticGitEnv({
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      SKILLSMITH_HOME: join(home, 'data'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'xdg-data'),
      XDG_CACHE_HOME: join(home, 'cache'),
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe('');
  return stdout;
};

describe('list duplicate inventory (#41)', () => {
  test('populated inventory with no conflict has truthful human and JSON empty states', async () => {
    await skill(home, '.agents', 'unique');
    expect(JSON.parse(await list('--tool', 'codex', '--json')).entries).toHaveLength(1);
    expect(JSON.parse(await list('--tool', 'codex', '--duplicates', '--json')).entries).toEqual([]);
    expect(await list('--tool', 'codex', '--duplicates')).toBe(
      'No duplicate skills matched the selected inventory.\n',
    );
  });

  test('same-tool user/project conflicts agree across human, JSON and filters', async () => {
    await skill(home, '.agents', 'shared');
    await skill(project, '.agents', 'shared');
    const duplicates = JSON.parse(await list('--tool', 'codex', '--duplicates', '--json')).entries;
    expect(duplicates).toHaveLength(2);
    expect(duplicates.map((entry: { scope: string }) => entry.scope).sort()).toEqual([
      'project',
      'user',
    ]);
    expect(await list('--tool', 'codex', '--duplicates')).toContain('shared');
    expect(await list('missing-*', '--tool', 'codex', '--duplicates')).toBe(
      'No duplicate skills matched the selected inventory.\n',
    );
  });

  test('cross-tool name reuse alone is not a conflict', async () => {
    await skill(home, '.claude', 'shared');
    await skill(project, '.agents', 'shared');
    const tools = ['--tool', 'codex', '--tool', 'claude-code'];
    expect(JSON.parse(await list(...tools, '--json')).entries).toHaveLength(2);
    expect(JSON.parse(await list(...tools, '--duplicates', '--json')).entries).toEqual([]);
  });
});
