import { describe, expect, test } from 'bun:test';
import type { ListReport } from '@skillsmith/core';
import { ListJsonSchema, renderListJson } from '../../src/output/list-json.ts';

const report = (name: string, path: string): ListReport['entries'][number] => ({
  name,
  tool: 'codex',
  scope: 'user',
  mode: 'unmanaged',
  placement: 'copy',
  path,
  realpath: path,
  root: '/h/.codex/skills',
  frontmatter: null,
  origin: { kind: 'standalone' },
  enabled: 'on',
  source: null,
  revision: null,
  store: null,
  verification: 'unrecorded',
  description: null,
  visibility: { state: 'unique', winner: null, members: [{ scope: 'user', path }] },
});

describe('renderListJson', () => {
  test('emits strict current list@3 bytes for an empty report', () => {
    const parsed = JSON.parse(renderListJson([]));
    expect(ListJsonSchema.safeParse(parsed).success).toBeTrue();
    expect(parsed).toMatchObject({
      schemaVersion: 3,
      kind: 'skillsmith.list',
      summary: { total: 0, collisionGroups: 0 },
      entries: [],
    });
  });

  test('sorts entries canonically and redacts sensitive values', () => {
    const secret = 'list-json-secret';
    const rendered = renderListJson({
      entries: [report('z', '/z'), { ...report('a', '/a'), description: `api_key=${secret}` }],
      collisionGroups: [],
      long: true,
    });
    const parsed = JSON.parse(rendered);

    expect(parsed.entries.map((entry: { name: string }) => entry.name)).toEqual(['a', 'z']);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('[REDACTED]');
    expect(ListJsonSchema.safeParse(parsed).success).toBeTrue();
  });
});
