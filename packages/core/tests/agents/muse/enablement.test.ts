import { describe, expect, test } from 'bun:test';
import { resolveStandaloneActivation } from '../../../src/agents/muse/enablement.ts';
import type { InventoryReadPorts } from '../../../src/ports/types.ts';
import type { SkillEntry } from '../../../src/skills/types.ts';

const SETTINGS = '/h/.config/muse/settings.json';

const env = (files: Record<string, string> = {}): InventoryReadPorts => ({
  homeDir: '/h',
  executableSearchPath: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => p in files,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async (p) => files[p] ?? '',
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  modifiedAt: async () => null,
});

const entry = (path: string): SkillEntry => ({
  name: path.split('/').pop() ?? path,
  path,
  realpath: path,
  tool: 'muse',
  scope: 'user',
  root: '/h/.config/muse/skills',
  frontmatter: null,
  origin: { kind: 'standalone' },
  enabled: 'on',
});

const settings = (activation: unknown): string =>
  JSON.stringify({ schema_version: 1, skills: { activation } });

describe('muse resolveStandaloneActivation', () => {
  test('missing settings leaves the on default', async () => {
    const entries = [entry('/h/.config/muse/skills/a')];
    await resolveStandaloneActivation(env(), entries);
    expect(entries[0]?.enabled).toBe('on');
  });

  test('off and on records resolve, unrecorded stays on', async () => {
    const entries = [
      entry('/h/.config/muse/skills/a'),
      entry('/h/.config/muse/skills/b'),
      entry('/h/.config/muse/skills/c'),
    ];
    await resolveStandaloneActivation(
      env({
        [SETTINGS]: settings({
          user: {
            '$CONFIG_DIR/skills/a/SKILL.md': 'off',
            '$CONFIG_DIR/skills/b/SKILL.md': 'on',
          },
        }),
      }),
      entries,
    );
    expect(entries.map((e) => e.enabled)).toEqual(['off', 'on', 'on']);
  });

  test('expands $HOME keys for compatibility roots', async () => {
    const entries = [entry('/h/.agents/skills/s1')];
    await resolveStandaloneActivation(
      env({ [SETTINGS]: settings({ user: { '$HOME/.agents/skills/s1/SKILL.md': 'off' } }) }),
      entries,
    );
    expect(entries[0]?.enabled).toBe('off');
  });

  test('tolerates sibling scope maps and unknown values', async () => {
    const entries = [entry('/h/.config/muse/skills/a'), entry('/h/.config/muse/skills/b')];
    await resolveStandaloneActivation(
      env({
        [SETTINGS]: settings({
          user: {
            '$CONFIG_DIR/skills/a/SKILL.md': 'off',
            '$CONFIG_DIR/skills/b/SKILL.md': 'maybe',
          },
          project: { '/p/.agents/skills/other/SKILL.md': 'off' },
          future: ['not-a-map'],
        }),
      }),
      entries,
    );
    expect(entries.map((e) => e.enabled)).toEqual(['off', 'on']);
  });

  test('malformed settings fails the root', async () => {
    await expect(
      resolveStandaloneActivation(env({ [SETTINGS]: '{nope' }), [entry('/h/x')]),
    ).rejects.toThrow(/muse settings parse error/);
    await expect(
      resolveStandaloneActivation(env({ [SETTINGS]: '{"skills":42}' }), [entry('/h/x')]),
    ).rejects.toThrow(/muse settings schema error/);
  });
});
