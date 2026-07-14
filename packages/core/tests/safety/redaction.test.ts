import { describe, expect, test } from 'bun:test';
import {
  containsSensitiveMaterial,
  redactObservationValue,
  redactSensitiveString,
  redactSensitiveValue,
} from '../../src/safety/redaction.ts';

describe('shared safety redaction authority', () => {
  test('redacts authorization, token, assignment, URL userinfo/query/fragment grammar', () => {
    const cases = [
      ['Authorization: Bearer canary-canary', 'Authorization: [REDACTED]'],
      ['Basic Y2FuYXJ5OmNhbmFyeQ==', '[REDACTED]'],
      ['ghp_abcdefghijk', '[REDACTED]'],
      ['sk-abcdefghijk', '[REDACTED]'],
      ['api_key=canary', 'api_key=[REDACTED]'],
      ['access_token=canary-canary', 'access_token=[REDACTED]'],
      ['github_token=canary-canary', 'github_token=[REDACTED]'],
      ['client_secret=canary-canary', 'client_secret=[REDACTED]'],
      ['password: canary', 'password: [REDACTED]'],
      ['Cookie: session=canary; preference=also-canary', 'Cookie: [REDACTED]'],
      ['api%5Fkey%3Dcanary-canary', 'api_key=[REDACTED]'],
      [
        'fetch https://user:pass@example.com/acme/repo?token=canary#fragment now',
        'fetch https://example.com/acme/repo now',
      ],
      ['ssh://git@git.example.com/acme/repo.git', 'ssh://git@git.example.com/acme/repo.git'],
    ] as const;
    for (const [input, expected] of cases) {
      expect(redactSensitiveString(input), input).toBe(expected);
      expect(containsSensitiveMaterial(input), input).toBe(input !== expected);
    }
    expect(redactObservationValue).toBe(redactSensitiveValue);
    expect(containsSensitiveMaterial('[REDACTED]')).toBeTrue();
  });

  test('redacts percent-encoded credential names before literal assignment delimiters', () => {
    const canary = 'P17_SECRET_CANARY';
    for (const key of [
      '%74oken',
      't%6fken',
      '%73ecret',
      '%70assword',
      '%63redential',
      '%61uthorization',
      '%63ookie',
      'api_%6bey',
      '%2574oken',
      '%2525252574oken',
    ]) {
      const input = `${key}=${canary}`;
      expect(redactSensitiveString(input), input).not.toContain(canary);
      expect(redactSensitiveString(input), input).toContain('[REDACTED]');
      expect(containsSensitiveMaterial(input), input).toBeTrue();
    }
    const url = `https://example.test/repo/%74oken=${canary}?x=1`;
    expect(redactSensitiveString(url)).toBe('https://example.test/repo/token=[REDACTED]');
    expect(containsSensitiveMaterial(url)).toBeTrue();

    let overBudgetKey = '%74oken';
    for (let depth = 0; depth < 40; depth += 1) {
      overBudgetKey = overBudgetKey.replaceAll('%', '%25');
    }
    const overBudget = `${overBudgetKey}=${canary}`;
    expect(redactSensitiveString(overBudget)).toBe('[REDACTED]');
    expect(containsSensitiveMaterial(overBudget)).toBeTrue();
  });

  test('sanitizes ordinary property names and fails closed on projected-key collisions', () => {
    const marker = 'P17_MARKER_F13_123456789';
    const assignmentKey = `password=${marker}`;
    const urlKey = `https://user:${marker}@example.test/acme/repo`;
    let getterReads = 0;
    const assignmentGetter = (): string => {
      getterReads++;
      return marker;
    };
    const source: Record<string, unknown> = { ordinary: { retained: true } };
    Object.defineProperty(source, assignmentKey, {
      enumerable: true,
      get: assignmentGetter,
    });
    Object.defineProperty(source, urlKey, {
      enumerable: true,
      value: { visible: 'diagnostic' },
    });
    const keysBefore = Reflect.ownKeys(source);
    const assignmentBefore = Object.getOwnPropertyDescriptor(source, assignmentKey);
    const urlBefore = Object.getOwnPropertyDescriptor(source, urlKey);

    const output = redactSensitiveValue(source) as Readonly<Record<string, unknown>>;
    expect(JSON.stringify(output)).not.toContain(marker);
    expect(Reflect.ownKeys(output)).toEqual([
      'ordinary',
      'password=[REDACTED]',
      'https://example.test/acme/repo',
    ]);
    expect(output.ordinary).toEqual({ retained: true });
    expect(output['password=[REDACTED]']).toBe('[REDACTED]');
    expect(output['https://example.test/acme/repo']).toEqual({ visible: 'diagnostic' });
    expect(Object.isFrozen(output)).toBeTrue();
    expect(Object.isFrozen(output.ordinary)).toBeTrue();
    expect(getterReads).toBe(0);
    expect(Reflect.ownKeys(source)).toEqual(keysBefore);
    expect(Object.getOwnPropertyDescriptor(source, assignmentKey)).toEqual(assignmentBefore);
    expect(Object.getOwnPropertyDescriptor(source, urlKey)).toEqual(urlBefore);

    const array: unknown[] = ['ordinary'];
    Object.defineProperty(array, assignmentKey, { enumerable: true, value: marker });
    const arrayOutput = redactSensitiveValue(array) as readonly unknown[];
    expect(JSON.stringify(arrayOutput)).not.toContain(marker);
    expect(Reflect.ownKeys(arrayOutput)).toContain('password=[REDACTED]');
    expect(
      (arrayOutput as unknown as Readonly<Record<string, unknown>>)['password=[REDACTED]'],
    ).toBe('[REDACTED]');
    expect(Object.getOwnPropertyDescriptor(array, assignmentKey)?.value).toBe(marker);

    const firstCollision = {
      ordinary: 'preserved only when unambiguous',
      [`token=${marker}-one`]: 1,
      [`token=${marker}-two`]: 2,
    };
    const secondCollision = {
      [`token=${marker}-two`]: 2,
      [`token=${marker}-one`]: 1,
      ordinary: 'preserved only when unambiguous',
    };
    const firstBefore = JSON.stringify(firstCollision);
    const secondBefore = JSON.stringify(secondCollision);
    expect(redactSensitiveValue(firstCollision)).toBe('[KEY_COLLISION]');
    expect(redactSensitiveValue(secondCollision)).toBe('[KEY_COLLISION]');
    expect(JSON.stringify(redactSensitiveValue(firstCollision))).not.toContain(marker);
    expect(JSON.stringify(firstCollision)).toBe(firstBefore);
    expect(JSON.stringify(secondCollision)).toBe(secondBefore);
  });

  test('copies/freeze ordinary data and safely reduces hostile structures and Errors', () => {
    let getterReads = 0;
    let proxyReads = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterReads++;
        return 'ghp_secretsecret';
      },
    });
    const proxy = new Proxy(
      { value: 'ghp_secretsecret' },
      {
        ownKeys: () => {
          proxyReads++;
          return ['value'];
        },
      },
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const error = new Error('Bearer secret-secret', {
      cause: new Error('password=secret-secret'),
    });
    Object.defineProperties(error, {
      code: { value: 'EACCES', enumerable: true },
      exitCode: { value: 6, enumerable: true },
    });
    const source = { authorization: { nested: true }, accessor, proxy, cycle, error };
    const output = redactSensitiveValue(source) as Readonly<Record<string, unknown>>;
    expect(JSON.stringify(output)).not.toContain('secret-secret');
    expect(JSON.stringify(output)).toContain('[ACCESSOR]');
    expect(JSON.stringify(output)).toContain('[PROXY]');
    expect(JSON.stringify(output)).toContain('[CIRCULAR]');
    expect(output.authorization).toBe('[REDACTED]');
    expect(output.error).toMatchObject({ code: 'EACCES', exitCode: 6 });
    expect(Object.isFrozen(output)).toBeTrue();
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
  });
});
