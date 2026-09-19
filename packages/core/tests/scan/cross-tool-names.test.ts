import { describe, expect, test } from 'bun:test';
import type { SupportedTool } from '../../src/agents/types.ts';
import type { Scope } from '../../src/config/types.ts';
import { groupCrossToolNames } from '../../src/scan/cross-tool-names.ts';
import type { SkillEntry } from '../../src/skills/types.ts';

const entry = (name: string, tool: SupportedTool, scope: Scope, path: string): SkillEntry =>
  ({
    name,
    path,
    realpath: path,
    tool,
    scope,
    root: '/h',
    frontmatter: null,
    origin: { kind: 'standalone' },
    enabled: 'on',
  }) as SkillEntry;

describe('groupCrossToolNames', () => {
  test('groups a name shared by two tools with every placement', () => {
    const groups = groupCrossToolNames([
      entry('summarize', 'codex', 'user', '/h/.agents/skills/summarize'),
      entry('summarize', 'claude-code', 'user', '/h/.claude/skills/summarize'),
      entry('summarize', 'codex', 'project', '/repo/.agents/skills/summarize'),
      entry('unique', 'codex', 'user', '/h/.agents/skills/unique'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('summarize');
    expect(groups[0]?.members).toEqual([
      { tool: 'claude-code', scope: 'user', path: '/h/.claude/skills/summarize' },
      { tool: 'codex', scope: 'user', path: '/h/.agents/skills/summarize' },
      { tool: 'codex', scope: 'project', path: '/repo/.agents/skills/summarize' },
    ]);
  });

  test('excludes one tool across two scopes', () => {
    expect(
      groupCrossToolNames([
        entry('shared', 'codex', 'user', '/h/.agents/skills/shared'),
        entry('shared', 'codex', 'project', '/repo/.agents/skills/shared'),
      ]),
    ).toEqual([]);
  });

  test('treats case variants as distinct names', () => {
    expect(
      groupCrossToolNames([
        entry('Foo', 'codex', 'user', '/h/.agents/skills/Foo'),
        entry('foo', 'claude-code', 'user', '/h/.claude/skills/foo'),
      ]),
    ).toEqual([]);
  });

  test('retains groups whose members share one real path', () => {
    const groups = groupCrossToolNames([
      entry('linked', 'codex', 'user', '/shared/skills/linked'),
      entry('linked', 'opencode', 'user', '/shared/skills/linked'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);
  });

  test('orders groups by name and members by tool, scope, path', () => {
    const groups = groupCrossToolNames([
      entry('b-name', 'opencode', 'user', '/h/.opencode/b'),
      entry('a-name', 'codex', 'project', '/repo/.agents/a'),
      entry('b-name', 'codex', 'user', '/h/.agents/b'),
      entry('a-name', 'claude-code', 'user', '/h/.claude/a'),
    ]);
    expect(groups.map((group) => group.name)).toEqual(['a-name', 'b-name']);
    expect(groups[0]?.members.map((member) => `${member.tool}:${member.scope}`)).toEqual([
      'claude-code:user',
      'codex:project',
    ]);
  });

  test('returns no groups for empty inventory', () => {
    expect(groupCrossToolNames([])).toEqual([]);
  });
});
