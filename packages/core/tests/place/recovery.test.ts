import { describe, expect, test } from 'bun:test';
import { isExecutionCancellation } from '../../src/execution/observation.ts';
import type { PlacementExecutionInput } from '../../src/place/execute.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import { recoverPlacement, recoveryRefusedMessage } from '../../src/place/recovery.ts';
import type { PlacementPorts } from '../../src/place/types.ts';

const input: PlacementExecutionInput = {
  env: {} as PlacementPorts,
  ledgerPath: '/tmp/placements.json',
  ledger: emptyLedgerModel('2026-07-16T00:00:00.000Z'),
  journalNow: () => '2026-07-16T00:00:00.000Z',
  newTransactionId: () => 'unused',
};

describe('placement recovery boundary', () => {
  test('routes recovery without mutating the supplied immutable state', async () => {
    const recovered = await recoverPlacement(input, 'resume', {
      skill: 'missing',
      tool: 'codex',
    });

    expect(recovered.ok).toBeFalse();
    if (!recovered.ok) expect(recovered.error.code).toBe('flip-refused');
    expect(recovered.state.ledger).toBe(input.ledger);
    expect(recoveryRefusedMessage('dev', 'alpha')).toContain('previous dev');
  });

  test('classifies revoked and trapping Proxy recovery throws without replacing them', () => {
    const revoked = Proxy.revocable(Object.create(null) as object, {});
    revoked.revoke();
    let descriptorTrapCalls = 0;
    const trapping = new Proxy(Object.create(null) as object, {
      getOwnPropertyDescriptor: () => {
        descriptorTrapCalls += 1;
        throw new Error('recovery proxy descriptor trap must not run');
      },
    });

    expect(isExecutionCancellation(revoked.proxy)).toBeFalse();
    expect(isExecutionCancellation(trapping)).toBeFalse();
    expect(descriptorTrapCalls).toBe(0);
  });
});
