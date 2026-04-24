import { describe, expect, test } from 'bun:test';
import { getAgent, listSupportedTools, registry } from '../../src/agents/registry.ts';

describe('agents registry', () => {
  test('listSupportedTools returns all four tools in order', () => {
    expect(listSupportedTools()).toEqual(['claude-code', 'codex', 'kilo-code', 'opencode']);
  });

  test('registry has an Agent for every supported tool', () => {
    for (const t of listSupportedTools()) {
      expect(registry[t].tool).toBe(t);
    }
  });

  test('getAgent returns ok for a known tool and err for an unknown one', () => {
    const good = getAgent('codex');
    expect(good.ok).toBe(true);
    const bad = getAgent('nope');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('unknown-tool');
  });
});
