import { describe, expect, test } from 'bun:test';
import type {
  EnabledState,
  Origin,
  PluginProvenanceScope,
  SkillEntry,
} from '../../src/skills/types.ts';

describe('Origin', () => {
  test('standalone variant is constructible', () => {
    const o: Origin = { kind: 'standalone' };
    expect(o.kind).toBe('standalone');
  });

  test('plugin variant carries id / version / scope', () => {
    const o: Origin = {
      kind: 'plugin',
      pluginId: 'foo@bar',
      pluginVersion: '1.2.3',
      pluginScope: 'user',
    };
    if (o.kind === 'plugin') {
      expect(o.pluginId).toBe('foo@bar');
      expect(o.pluginVersion).toBe('1.2.3');
    }
  });

  test('policy variant has no extra data', () => {
    const o: Origin = { kind: 'policy' };
    expect(o.kind).toBe('policy');
  });

  test('all four PluginProvenanceScope values are accepted', () => {
    const scopes: PluginProvenanceScope[] = ['user', 'project', 'managed', 'local'];
    expect(scopes).toHaveLength(4);
  });

  test('EnabledState has three values', () => {
    const states: EnabledState[] = ['on', 'off', 'unset'];
    expect(states).toHaveLength(3);
  });
});

describe('SkillEntry', () => {
  test('carries origin + enabled (EnabledState)', () => {
    const e: SkillEntry = {
      name: 'grep',
      path: '/h/.claude/skills/grep',
      realpath: '/h/.claude/skills/grep',
      tool: 'claude-code',
      scope: 'user',
      root: '/h/.claude/skills',
      frontmatter: null,
      origin: { kind: 'standalone' },
      enabled: 'on',
    };
    expect(e.enabled).toBe('on');
    expect(e.origin.kind).toBe('standalone');
  });
});
