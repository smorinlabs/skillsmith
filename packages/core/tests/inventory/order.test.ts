import { describe, expect, test } from 'bun:test';
import {
  canonicalInventoryScopes,
  canonicalInventoryTools,
  compareCommandInventoryEntries,
  compareInventoryText,
  compareSkillInventoryEntries,
} from '../../src/inventory/order.ts';

describe('inventory canonical ordering', () => {
  test('uses unsigned UTF-16 text comparison instead of locale order', () => {
    expect(['/😀', '/a', '/Z'].sort(compareInventoryText)).toEqual(['/Z', '/a', '/😀']);
  });

  test('orders skills and commands by registry, scope, name, then path', () => {
    const skillRows = [
      { tool: 'codex' as const, scope: 'user' as const, name: 'a', path: '/2' },
      { tool: 'claude-code' as const, scope: 'project' as const, name: 'a', path: '/1' },
      { tool: 'claude-code' as const, scope: 'user' as const, name: 'z', path: '/1' },
      { tool: 'claude-code' as const, scope: 'user' as const, name: 'a', path: '/2' },
      { tool: 'claude-code' as const, scope: 'user' as const, name: 'a', path: '/1' },
    ];
    expect([...skillRows].sort(compareSkillInventoryEntries).map((row) => row.path)).toEqual([
      '/1',
      '/2',
      '/1',
      '/1',
      '/2',
    ]);

    const commandRows = [
      { tool: 'codex' as const, scope: 'user' as const, name: 'a', path: '/1' },
      { tool: 'claude-code' as const, scope: 'project' as const, name: 'a', path: '/1' },
      { tool: 'claude-code' as const, scope: 'user' as const, name: 'a', path: '/1' },
    ];
    expect([...commandRows].sort(compareCommandInventoryEntries).map((row) => row.scope)).toEqual([
      'user',
      'project',
      'user',
    ]);
  });

  test('deduplicates selected tools and scopes in canonical frozen order', () => {
    const tools = canonicalInventoryTools(['opencode', 'codex', 'opencode']);
    const scopes = canonicalInventoryScopes(['managed', 'user', 'managed']);

    expect(tools).toEqual(['codex', 'opencode']);
    expect(scopes).toEqual(['user', 'managed']);
    expect(Object.isFrozen(tools)).toBeTrue();
    expect(Object.isFrozen(scopes)).toBeTrue();
  });
});
