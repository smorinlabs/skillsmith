import { describe, expect, test } from 'bun:test';
import type { CommandEntry } from '../../src/commands/types.ts';

describe('CommandEntry', () => {
  test('carries all fields parallel to SkillEntry', () => {
    const e: CommandEntry = {
      name: 'ci-audit',
      path: '/h/.claude/commands/ci-audit.md',
      realpath: '/h/.claude/commands/ci-audit.md',
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/commands',
      frontmatter: { description: 'audit CI' },
      origin: { kind: 'standalone' },
      enabled: 'on',
    };
    expect(e.name).toBe('ci-audit');
    expect(e.enabled).toBe('on');
  });

  test('path ends in .md', () => {
    const e: CommandEntry = {
      name: 'foo',
      path: '/x/foo.md',
      realpath: '/x/foo.md',
      tool: 'claude-code',
      scope: 'project',
      root: '/x',
      frontmatter: null,
      origin: { kind: 'standalone' },
      enabled: 'on',
    };
    expect(e.path.endsWith('.md')).toBe(true);
  });
});
