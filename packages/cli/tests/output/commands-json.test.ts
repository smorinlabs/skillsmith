import { describe, expect, test } from 'bun:test';
import type { CommandsReport } from '@skillsmith/core';
import { CommandsJsonSchema, renderCommandsJson } from '../../src/output/commands-json.ts';

const entry = (name: string, path: string): CommandsReport['entries'][number] => ({
  name,
  tool: 'claude-code',
  scope: 'user',
  path,
  realpath: path,
  root: '/h/.claude/commands',
  frontmatter: null,
  origin: { kind: 'standalone' },
  enabled: 'on',
  description: null,
});

describe('renderCommandsJson', () => {
  test('emits strict current commands@2 bytes for an empty report', () => {
    const parsed = JSON.parse(renderCommandsJson([]));
    expect(CommandsJsonSchema.safeParse(parsed).success).toBeTrue();
    expect(parsed).toMatchObject({
      schemaVersion: 2,
      kind: 'skillsmith.commands',
      summary: { total: 0 },
      entries: [],
    });
  });

  test('sorts entries canonically and redacts sensitive values', () => {
    const secret = 'commands-json-secret';
    const rendered = renderCommandsJson({
      entries: [entry('z', '/z'), { ...entry('a', '/a'), description: `api_key=${secret}` }],
      long: true,
    });
    const parsed = JSON.parse(rendered);

    expect(parsed.entries.map((item: { name: string }) => item.name)).toEqual(['a', 'z']);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('[REDACTED]');
    expect(CommandsJsonSchema.safeParse(parsed).success).toBeTrue();
  });
});
