import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

let root = '';
let home = '';
let project = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skillsmith-cross-tool-names-'));
  home = join(root, 'home');
  project = join(root, 'project');
  await mkdir(home);
  await mkdir(project);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const skill = async (parent: string, toolDir: string, name: string) => {
  const path = join(parent, toolDir, 'skills', name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n`);
};

const run = async (command: string, ...args: string[]) => {
  const proc = Bun.spawn([process.execPath, CLI_ENTRYPOINT, command, ...args], {
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
  return { code, stdout, stderr };
};

const ctn = (...args: string[]) => run('cross-tool-names', ...args);
const TOOLS = ['--tool', 'codex', '--tool', 'claude-code'];

describe('cross-tool-names (#41)', () => {
  test('TS01 groups a cross-tool name with every placement', async () => {
    await skill(home, '.claude', 'shared');
    await skill(project, '.agents', 'shared');
    await skill(home, '.agents', 'solo');
    const { code, stdout, stderr } = await ctn(...TOOLS, '--json');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].name).toBe('shared');
    expect(parsed.groups[0].members).toEqual([
      { tool: 'claude-code', scope: 'user', path: join(home, '.claude/skills/shared') },
      { tool: 'codex', scope: 'project', path: join(project, '.agents/skills/shared') },
    ]);
    const human = await ctn(...TOOLS);
    expect(human.stdout).toContain('shared (2 tools, 2 placements)');
  });

  test('TS01 excludes one tool across two scopes', async () => {
    await skill(home, '.agents', 'shared');
    await skill(project, '.agents', 'shared');
    const { code, stdout } = await ctn(...TOOLS, '--json');
    expect(code).toBe(0);
    expect(JSON.parse(stdout).groups).toEqual([]);
  });

  test('TS01 treats case variants as distinct names', async () => {
    await skill(home, '.agents', 'Foo');
    await skill(home, '.claude', 'foo');
    const { code, stdout } = await ctn(...TOOLS, '--json');
    expect(code).toBe(0);
    expect(JSON.parse(stdout).groups).toEqual([]);
  });

  test('TS01 makes no winner, conflict, or precedence claim', async () => {
    await skill(home, '.claude', 'shared');
    await skill(project, '.agents', 'shared');
    const { stdout } = await ctn(...TOOLS, '--json');
    expect(stdout).not.toContain('winner');
    expect(stdout).not.toContain('conflict');
    expect(stdout).not.toContain('precedence');
  });

  test('TS01 leaves list --duplicates silent on cross-tool reuse', async () => {
    await skill(home, '.claude', 'shared');
    await skill(project, '.agents', 'shared');
    const duplicates = await run('list', ...TOOLS, '--duplicates', '--json');
    expect(duplicates.code).toBe(0);
    expect(JSON.parse(duplicates.stdout).skills).toEqual([]);
    const { stdout } = await ctn(...TOOLS, '--json');
    expect(JSON.parse(stdout).groups).toHaveLength(1);
  });

  test('TS02 reports zero-match selection truthfully', async () => {
    await skill(home, '.agents', 'solo');
    const human = await ctn('missing-*', ...TOOLS);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe('No skills matched the selected inventory.\n');
    const json = await ctn('missing-*', ...TOOLS, '--json');
    expect(JSON.parse(json.stdout).groups).toEqual([]);
  });

  test('TS02 reports matched-but-unreused selection truthfully', async () => {
    await skill(home, '.agents', 'solo');
    const human = await ctn(...TOOLS);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe('No skill names repeat across the selected tools.\n');
  });

  test('TS02 renders exact human bytes for one group', async () => {
    await skill(home, '.claude', 'shared');
    await skill(project, '.agents', 'shared');
    const { code, stdout } = await ctn(...TOOLS);
    expect(code).toBe(0);
    expect(stdout).toBe(
      `shared (2 tools, 2 placements)\n  claude-code user ${join(home, '.claude/skills/shared')}\n  codex project ${join(project, '.agents/skills/shared')}\n`,
    );
  });

  test('TS02 emits versioned JSON without selection or summary keys', async () => {
    await skill(home, '.claude', 'shared');
    await skill(project, '.agents', 'shared');
    const { stdout } = await ctn(...TOOLS, '--json');
    const parsed = JSON.parse(stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe('skillsmith.cross-tool-names');
    expect('selection' in parsed).toBeFalse();
    expect('summary' in parsed).toBeFalse();
  });

  test('TS03 filtering out the second tool dissolves the group', async () => {
    await skill(home, '.claude', 'shared');
    await skill(project, '.agents', 'shared');
    const { stdout } = await ctn('--tool', 'codex', '--json');
    expect(JSON.parse(stdout).groups).toEqual([]);
  });

  test('TS03 scope filters apply before grouping', async () => {
    await skill(home, '.claude', 'shared');
    await skill(project, '.agents', 'shared');
    const { stdout } = await ctn(...TOOLS, '--scope', 'user', '--json');
    expect(JSON.parse(stdout).groups).toEqual([]);
    const both = await ctn(...TOOLS, '--json');
    expect(JSON.parse(both.stdout).groups).toHaveLength(1);
  });

  test('TS03 orders groups by name and members by tool, scope, path', async () => {
    await skill(project, '.agents', 'b-name');
    await skill(home, '.claude', 'b-name');
    await skill(project, '.agents', 'a-name');
    await skill(home, '.claude', 'a-name');
    const { stdout } = await ctn(...TOOLS, '--json');
    const parsed = JSON.parse(stdout);
    expect(parsed.groups.map((group: { name: string }) => group.name)).toEqual([
      'a-name',
      'b-name',
    ]);
    expect(
      parsed.groups[0].members.map(
        (member: { tool: string; scope: string }) => `${member.tool}:${member.scope}`,
      ),
    ).toEqual(['claude-code:user', 'codex:project']);
  });

  test('TS04 rejects mutually exclusive filters with exit 2', async () => {
    const { code, stdout, stderr } = await ctn('--enabled', '--disabled');
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('mutually exclusive');
  });

  test('TS04 unknown tools fail the same way list fails them', async () => {
    const ours = await ctn('--tool', 'nope');
    const theirs = await run('list', '--tool', 'nope');
    expect(ours.code).toBe(theirs.code);
    expect(ours.code).not.toBe(0);
    expect(ours.stdout).toBe('');
    expect(ours.stderr).toBe(theirs.stderr);
  });

  test('TS04 unreadable placements match list behavior exactly', async () => {
    // Main-line listSkills skips unreadable entries; the new report inherits
    // that shared behavior rather than inventing its own error semantics.
    await skill(home, '.agents', 'solo');
    const denied = join(home, '.agents', 'skills', 'solo');
    await chmod(denied, 0o000);
    try {
      const ours = await ctn(...TOOLS, '--json');
      const theirs = await run('list', '--tool', 'codex', '--json');
      expect(ours.code).toBe(theirs.code);
      expect(JSON.parse(ours.stdout).groups).toEqual([]);
      expect(JSON.parse(theirs.stdout).skills).toEqual([]);
    } finally {
      await chmod(denied, 0o755);
    }
  });
});
