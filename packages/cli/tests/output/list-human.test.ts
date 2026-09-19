import { describe, expect, test } from 'bun:test';
import type { InventoryCollisionGroupReport, SkillEntry } from '@skillsmith/core';
import { renderListHuman } from '../../src/output/list-human.ts';

const entry = (overrides: Partial<SkillEntry & Record<string, unknown>> = {}): SkillEntry => ({
  name: 'fixture',
  tool: 'codex',
  scope: 'user',
  path: '/h/.codex/skills/fixture',
  realpath: '/h/.codex/skills/fixture',
  root: '/h/.codex/skills',
  frontmatter: null,
  origin: { kind: 'standalone' },
  enabled: 'on',
  ...overrides,
});

describe('renderListHuman', () => {
  test('distinguishes an active-filter no-op from a genuinely empty inventory', () => {
    expect(renderListHuman([], { long: false, outcome: 'selected' })).toBe(
      'No skills installed.\n',
    );
    expect(renderListHuman([], { long: false, outcome: 'filter-noop' })).toBe(
      'No skills matched the active filters.\n',
    );
  });

  test('redacts sensitive values in long human output', () => {
    const secret = 'super-secret-list-canary';
    const rendered = renderListHuman(
      [
        entry({
          source: `https://example.test/skill?access_token=${secret}`,
          description: `api_key=${secret}`,
        }),
      ],
      { long: true },
    );

    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('[REDACTED]');
  });

  test('adds complete winner and ambiguous diagnostics to compact duplicate output', () => {
    const groups: readonly InventoryCollisionGroupReport[] = [
      {
        tool: 'claude-code',
        name: 'resolved',
        winner: '/managed/resolved',
        members: [
          { scope: 'managed', path: '/managed/resolved' },
          { scope: 'user', path: '/user/resolved' },
        ],
      },
      {
        tool: 'codex',
        name: 'ambiguous',
        winner: null,
        members: [
          { scope: 'user', path: '/user/ambiguous' },
          { scope: 'project', path: '/project/ambiguous' },
        ],
      },
    ];
    const rendered = renderListHuman([entry()], {
      long: false,
      duplicates: true,
      collisionGroups: groups,
    });

    expect(rendered).toContain('managed:/managed/resolved');
    expect(rendered).toContain('user:/user/resolved');
    expect(rendered).toContain('winner /managed/resolved');
    expect(rendered).toContain('user:/user/ambiguous');
    expect(rendered).toContain('project:/project/ambiguous');
    expect(rendered).toContain('ambiguous.');
  });
});

test('no duplicate matches does not claim the inventory is empty', () => {
  expect(renderListHuman([], { long: false, outcome: 'filter-noop', duplicates: true })).toBe(
    'No duplicate skills matched the selected inventory.\n',
  );
});
