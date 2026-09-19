import { describe, expect, test } from 'bun:test';
import { normalizeCliError, renderCliError } from '../../src/output/error-boundary.ts';

const CANARY = 'P17_SECRET_CANARY';

describe('CLI error boundary', () => {
  test('redacts nested credential URLs before human or JSON rendering', () => {
    const normalized = normalizeCliError({
      code: 'flip-refused',
      message: `fetch failed for https://alice:${CANARY}@example.test/repo?token=${CANARY}#${CANARY}`,
    });

    expect(normalized).toEqual({
      code: 'flip-refused',
      message: 'fetch failed for https://example.test/repo',
      exitCode: 2,
    });
    for (const rendered of [
      renderCliError(normalized, 'human'),
      renderCliError(normalized, 'json'),
    ]) {
      expect(rendered).not.toContain(CANARY);
      expect(rendered).not.toContain('alice');
      expect(rendered).toContain('https://example.test/repo');
    }
  });

  test('does not invoke accessors or proxy traps while normalizing hostile values', () => {
    let getterReads = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperties(accessor, {
      code: {
        enumerable: true,
        get: () => {
          getterReads += 1;
          return 'generic';
        },
      },
      message: {
        enumerable: true,
        get: () => {
          getterReads += 1;
          return CANARY;
        },
      },
    });
    expect(JSON.stringify(normalizeCliError(accessor))).not.toContain(CANARY);
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxy = new Proxy(
      { message: CANARY },
      {
        get: () => {
          proxyReads += 1;
          return CANARY;
        },
        ownKeys: () => {
          proxyReads += 1;
          return ['message'];
        },
      },
    );
    expect(normalizeCliError(proxy)).toEqual({
      code: 'generic',
      message: '[PROXY]',
      exitCode: 1,
    });
    expect(proxyReads).toBe(0);
  });

  test('redacts fallback values through the same safe-copy boundary', () => {
    const normalized = normalizeCliError(null, {
      code: 'transport',
      message: `Authorization: Bearer ${CANARY}_123456`,
      exitCode: 5,
    });
    expect(normalized).toEqual({
      code: 'transport',
      message: 'Authorization: [REDACTED]',
      exitCode: 5,
    });
    expect(JSON.stringify(normalized)).not.toContain(CANARY);
  });

  test('preserves the closed artifact mutation exit taxonomy without exposing details', () => {
    const normalized = normalizeCliError({
      code: 'artifact-mutation',
      exitCode: 6,
      reason: 'permission-denied',
      message: `write denied: password=${CANARY}`,
      recovery: { secret: CANARY },
    });
    expect(normalized).toEqual({
      code: 'artifact-mutation',
      message: 'write denied: password=[REDACTED]',
      exitCode: 6,
    });
    expect(JSON.stringify(normalized)).not.toContain(CANARY);
  });
});
