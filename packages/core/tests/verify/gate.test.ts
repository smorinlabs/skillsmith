import { describe, expect, test } from 'bun:test';
import { type VerificationGateRequest, evaluateVerificationGate } from '../../src/verify/gate.ts';

describe('evaluateVerificationGate', () => {
  const cases = [
    { verdict: 'pass', strict: false, gate: 'passed', blocked: false },
    { verdict: 'pass', strict: true, gate: 'passed', blocked: false },
    { verdict: 'warn', strict: false, gate: 'warned', blocked: false },
    { verdict: 'warn', strict: true, gate: 'failed', blocked: true },
    { verdict: 'fail', strict: false, gate: 'failed', blocked: true },
    { verdict: 'fail', strict: true, gate: 'failed', blocked: true },
    { verdict: 'inconclusive', strict: false, gate: 'inconclusive', blocked: false },
    { verdict: 'inconclusive', strict: true, gate: 'failed', blocked: true },
  ] as const;

  for (const expected of cases) {
    test(`${expected.verdict} with strict=${expected.strict}`, () => {
      const request: VerificationGateRequest = {
        verdict: expected.verdict,
        strict: expected.strict,
        requestedMode: 'static',
      };
      const decision = evaluateVerificationGate(request);

      expect(decision).toEqual({ gate: expected.gate, blocked: expected.blocked });
      expect(Object.keys(decision)).toEqual(['gate', 'blocked']);
      expect(Object.isFrozen(decision)).toBeTrue();
    });
  }

  test('mode selection does not alter verdict semantics', () => {
    expect(
      evaluateVerificationGate({
        verdict: 'warn',
        strict: false,
        requestedMode: 'static+deep',
      }),
    ).toEqual({ gate: 'warned', blocked: false });
  });
});
