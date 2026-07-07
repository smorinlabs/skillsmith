import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'verify');
const read = (...p: string[]) => Bun.file(join(FIXTURES, ...p)).text();

describe('verify fixtures', () => {
  test('dummytest control plugin has both manifests and four skills', async () => {
    const claude = JSON.parse(await read('dummytest', '.claude-plugin', 'plugin.json'));
    const codex = JSON.parse(await read('dummytest', '.codex-plugin', 'plugin.json'));
    expect(claude.name).toBe('dummytest');
    expect(codex.name).toBe('dummytest');
    for (const s of ['good-skill', 'bad-yaml', 'bad-noframe', 'bad-nodesc']) {
      expect(await Bun.file(join(FIXTURES, 'dummytest', 'skills', s, 'SKILL.md')).exists()).toBe(
        true,
      );
    }
  });

  test('good-skill has name and description frontmatter', async () => {
    const t = await read('dummytest', 'skills', 'good-skill', 'SKILL.md');
    expect(t).toContain('name: good-skill');
    expect(t).toContain('description:');
  });

  test('bad-yaml has an unterminated quote and unclosed list', async () => {
    const t = await read('dummytest', 'skills', 'bad-yaml', 'SKILL.md');
    expect(t).toContain('"unterminated string');
    expect(t).toContain('[one, two');
  });

  test('bad-noframe has no frontmatter delimiters', async () => {
    const t = await read('dummytest', 'skills', 'bad-noframe', 'SKILL.md');
    expect(t).not.toContain('---');
  });

  test('bad-nodesc has frontmatter but no description', async () => {
    const t = await read('dummytest', 'skills', 'bad-nodesc', 'SKILL.md');
    expect(t).toContain('name: bad-nodesc');
    expect(t).not.toContain('description:');
  });

  test('broken manifests are actually broken', async () => {
    await expect(
      read('claude-badjson', '.claude-plugin', 'plugin.json').then(JSON.parse),
    ).rejects.toThrow();
    await expect(
      read('codex-badplug', '.codex-plugin', 'plugin.json').then(JSON.parse),
    ).rejects.toThrow();
    const noname = JSON.parse(await read('claude-noname', '.claude-plugin', 'plugin.json'));
    expect(noname.name).toBeUndefined();
  });

  test('bare-skill is a lone valid SKILL.md with no plugin manifest', async () => {
    const t = await read('bare-skill', 'SKILL.md');
    expect(t).toContain('name: bare-skill');
    expect(t).toContain('description:');
    expect(
      await Bun.file(join(FIXTURES, 'bare-skill', '.claude-plugin', 'plugin.json')).exists(),
    ).toBe(false);
  });
});
