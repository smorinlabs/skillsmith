import { describe, expect, test } from 'bun:test';
import type { CrossToolNamesReport } from '../../src/application/read-services.ts';
import {
  type CrossToolNamesV1Dto,
  crossToolNamesV1Codec,
  toCrossToolNamesV1Dto,
} from '../../src/contracts/v1/cross-tool-names.ts';

const dto = (): CrossToolNamesV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.cross-tool-names',
  groups: [
    {
      name: 'summarize',
      members: [
        { tool: 'claude-code', scope: 'user', path: '/h/.claude/skills/summarize' },
        { tool: 'codex', scope: 'project', path: '/repo/.agents/skills/summarize' },
      ],
    },
  ],
});

const report = (): CrossToolNamesReport => ({
  groups: [
    {
      name: 'summarize',
      members: [
        { tool: 'claude-code', scope: 'user', path: '/h/.claude/skills/summarize' },
        { tool: 'codex', scope: 'project', path: '/repo/.agents/skills/summarize' },
      ],
    },
  ],
  matchedEntries: 3,
});

describe('cross-tool-names@1 wire contract', () => {
  test('round-trips the strict canonical report', () => {
    const encoded = crossToolNamesV1Codec.encode(dto());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(encoded.value).toEndWith('\n');
    const decoded = crossToolNamesV1Codec.decode(encoded.value);
    expect(decoded).toEqual({ ok: true, value: dto() });
  });

  test('rejects recursive unknown fields and wrong kind or version', () => {
    expect(crossToolNamesV1Codec.validate({ ...dto(), extra: true })).toMatchObject({
      ok: false,
    });
    expect(
      crossToolNamesV1Codec.validate({
        ...dto(),
        groups: [{ ...dto().groups[0], extra: true }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      crossToolNamesV1Codec.validate({
        ...dto(),
        groups: [
          {
            name: 'summarize',
            members: [{ tool: 'codex', scope: 'user', path: '/p', extra: true }],
          },
        ],
      }),
    ).toMatchObject({ ok: false });
    expect(crossToolNamesV1Codec.validate({ ...dto(), kind: 'skillsmith.list' })).toMatchObject({
      ok: false,
    });
    expect(crossToolNamesV1Codec.validate({ ...dto(), schemaVersion: 2 })).toMatchObject({
      ok: false,
    });
    expect(
      crossToolNamesV1Codec.validate({
        ...dto(),
        groups: [
          {
            name: 'summarize',
            members: [{ tool: 'codex', scope: 'everywhere', path: '/p' }],
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  test('mapper projects groups explicitly and redacts name, tool, and path', () => {
    expect(toCrossToolNamesV1Dto(report())).toEqual(dto());
    const mapped = toCrossToolNamesV1Dto({
      groups: [
        {
          name: 'leak sk-testtoken123',
          members: [{ tool: 'codex', scope: 'user', path: '/h/sk-testtoken123' }],
        },
      ],
      matchedEntries: 1,
    });
    expect(mapped.groups[0]?.name).toBe('leak [REDACTED]');
    expect(mapped.groups[0]?.members[0]?.path).toBe('/h/[REDACTED]');
    expect(mapped.groups[0]?.members[0]?.scope).toBe('user');
  });
});
