import { describe, expect, test } from 'bun:test';
import { HELP_TOPIC_NAMES, renderTopic } from '../../src/help/topics.ts';

describe('help topics', () => {
  test('allowlist contains the 6 topics', () => {
    expect(HELP_TOPIC_NAMES).toEqual([
      'exit-codes',
      'environment',
      'scopes',
      'manifest',
      'sources',
      'formatting',
    ]);
  });

  test('renderTopic returns non-empty content for each known topic', () => {
    for (const t of HELP_TOPIC_NAMES) {
      const r = renderTopic(t);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.length).toBeGreaterThan(0);
    }
  });

  test('renderTopic returns err for unknown topic', () => {
    const r = renderTopic('nope');
    expect(r.ok).toBe(false);
  });
});
