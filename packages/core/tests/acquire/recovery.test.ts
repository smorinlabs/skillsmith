import { describe, expect, test } from 'bun:test';
import { recoverAcquire, recoverCommittedAcquireJournals } from '../../src/acquire/recovery.ts';
import type { PlacementExecutionInput } from '../../src/place/execute.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import type { PlacementPorts } from '../../src/place/types.ts';

const input: PlacementExecutionInput = {
  env: {} as PlacementPorts,
  ledgerPath: '/tmp/placements.json',
  ledger: emptyLedgerModel('2026-07-16T00:00:00.000Z'),
  journalNow: () => '2026-07-16T00:00:00.000Z',
  newTransactionId: () => 'unused',
};

describe('acquisition recovery boundary', () => {
  test('routes same-operation resume and committed-journal cleanup', async () => {
    const resumed = await recoverAcquire(input, { skill: 'missing', tool: 'codex' });
    expect(resumed.ok).toBeFalse();
    expect(resumed.state.ledger).toBe(input.ledger);

    const swept = await recoverCommittedAcquireJournals(input);
    expect(swept.ok).toBeTrue();
    if (swept.ok) expect(swept.value).toEqual([]);
    expect(swept.state.ledger).toBe(input.ledger);
  });
});
