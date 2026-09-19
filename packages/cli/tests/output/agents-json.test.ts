import { describe, expect, test } from 'bun:test';
import type { InstallRecord, SupportedTool } from '@skillsmith/core';
import { AgentsJsonSchema, renderAgentsJson } from '../../src/output/agents-json.ts';

const sample = new Map<SupportedTool, InstallRecord[]>([
  ['claude-code', [{ path: '/opt/homebrew/bin/claude', version: '1.2.3', installMethod: 'brew' }]],
  ['codex', []],
  ['kilo-code', []],
  ['opencode', []],
]);

describe('renderAgentsJson', () => {
  test('produces schema-valid JSON', () => {
    const json = renderAgentsJson(sample);
    const parsed = JSON.parse(json);
    const r = AgentsJsonSchema.safeParse(parsed);
    expect(r.success).toBe(true);
  });

  test('includes all four tools in current agents@2 detections', () => {
    const parsed = JSON.parse(renderAgentsJson(sample));
    expect(parsed.detections.map((detection: { tool: string }) => detection.tool)).toEqual([
      'claude-code',
      'codex',
      'kilo-code',
      'opencode',
    ]);
  });
});
