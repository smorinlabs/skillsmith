import { describe, expect, test } from 'bun:test';
import { resolveScopeFlags } from '../../src/util/scope-resolver.ts';

describe('resolveScopeFlags', () => {
  test('no flags → null (means all)', () => {
    const r = resolveScopeFlags({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  test('--scope=user → user', () => {
    const r = resolveScopeFlags({ scope: 'user' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('user');
  });

  test('--user shorthand → user', () => {
    const r = resolveScopeFlags({ user: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('user');
  });

  test('--user --system → conflict error', () => {
    const r = resolveScopeFlags({ user: true, system: true });
    expect(r.ok).toBe(false);
  });

  test('--scope=user --project → conflict error', () => {
    const r = resolveScopeFlags({ scope: 'user', project: true });
    expect(r.ok).toBe(false);
  });

  test('--scope=user --user → agrees, returns user', () => {
    const r = resolveScopeFlags({ scope: 'user', user: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('user');
  });

  test('--managed shorthand → managed', () => {
    const r = resolveScopeFlags({ managed: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('managed');
  });

  test('--managed --system → conflict error', () => {
    const r = resolveScopeFlags({ managed: true, system: true });
    expect(r.ok).toBe(false);
  });
});
