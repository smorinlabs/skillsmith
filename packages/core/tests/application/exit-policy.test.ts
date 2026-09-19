import { describe, expect, test } from 'bun:test';
import {
  exitClassForApplicationError,
  selectApplicationExitClass,
} from '../../src/application/exit-policy.ts';

describe('shared application exit policy', () => {
  test('preserves the lifecycle error mapping after extraction', () => {
    expect(
      [
        'generic',
        'invalid-argument',
        'config-error',
        'placement-not-found',
        'source-unresolvable',
        'permission-denied',
        'cancelled',
      ].map((code) => exitClassForApplicationError({ code })),
    ).toEqual(['failure', 'usage', 'state', 'capability', 'source', 'permission', 'cancelled']);
  });

  test('honors explicit classes while cancellation remains dominant', () => {
    expect(exitClassForApplicationError({ code: 'fixture', exitClass: 'permission' })).toBe(
      'permission',
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      exitClassForApplicationError({ code: 'fixture', exitClass: 'permission' }, controller.signal),
    ).toBe('cancelled');
  });

  test('selects the highest shared precedence independent of input order', () => {
    const classes = ['failure', 'usage', 'state', 'capability', 'source', 'permission'] as const;
    expect(selectApplicationExitClass(classes)).toBe('permission');
    expect(selectApplicationExitClass([...classes].reverse())).toBe('permission');
    expect(selectApplicationExitClass([...classes, 'cancelled'])).toBe('cancelled');
    expect(selectApplicationExitClass(['success', 'drift'])).toBe('success');
  });
});
