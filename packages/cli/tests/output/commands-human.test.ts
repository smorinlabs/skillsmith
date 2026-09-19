import { describe, expect, test } from 'bun:test';
import type { CommandEntry } from '@skillsmith/core';
import { renderCommandsHuman } from '../../src/output/commands-human.ts';

const entry = (overrides: Partial<CommandEntry & Record<string, unknown>> = {}): CommandEntry => ({
  name: 'fixture',
  tool: 'claude-code',
  scope: 'user',
  path: '/h/.claude/commands/fixture.md',
  realpath: '/h/.claude/commands/fixture.md',
  root: '/h/.claude/commands',
  frontmatter: null,
  origin: { kind: 'standalone' },
  enabled: 'on',
  ...overrides,
});

describe('renderCommandsHuman', () => {
  test('distinguishes an active-filter no-op from a genuinely empty inventory', () => {
    expect(renderCommandsHuman([], { long: false, outcome: 'selected' })).toBe(
      'No slash commands installed.\n',
    );
    expect(renderCommandsHuman([], { long: false, outcome: 'filter-noop' })).toBe(
      'No slash commands installed.\nActive filters reduced the selected inventory to zero.\n',
    );
  });

  test('redacts sensitive values in long human output', () => {
    const secret = 'super-secret-command-canary';
    const rendered = renderCommandsHuman(
      [entry({ description: `access_token=${secret}`, path: `/command?api_key=${secret}` })],
      { long: true },
    );

    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('[REDACTED]');
  });
});
