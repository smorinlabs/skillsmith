import type { SummaryVerdict } from './types.ts';

export type VerificationGate = 'passed' | 'warned' | 'failed' | 'inconclusive';

export interface VerificationGateRequest {
  readonly verdict: SummaryVerdict;
  readonly strict: boolean;
  readonly requestedMode: 'static' | 'static+deep';
}

export interface VerificationGateDecision {
  readonly gate: VerificationGate;
  readonly blocked: boolean;
}

/**
 * Reduce one produced verification verdict into the lifecycle gate shared by install and flip.
 *
 * `requestedMode` is intentionally part of the input contract even though current strict
 * semantics do not vary by mode. Keeping the selected mode explicit prevents callers from
 * re-deriving policy while preserving a small, pure authority.
 */
export const evaluateVerificationGate = ({
  verdict,
  strict,
}: VerificationGateRequest): VerificationGateDecision => {
  if (verdict === 'pass') return Object.freeze({ gate: 'passed', blocked: false });
  if (verdict === 'fail') return Object.freeze({ gate: 'failed', blocked: true });
  return Object.freeze(
    strict
      ? { gate: 'failed', blocked: true }
      : verdict === 'warn'
        ? { gate: 'warned', blocked: false }
        : { gate: 'inconclusive', blocked: false },
  );
};
