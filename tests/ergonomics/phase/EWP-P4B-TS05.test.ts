import { describe, expect, test } from 'bun:test';
import {
  STRICT_WHOLE_PAIR_CASES,
  createIncompleteWholePairFixture,
  destroyIncompleteWholePairFixture,
  runBoundedLockedPreview,
} from '../fixtures/p4b-lock-policy/cases.ts';

describe('EWP-P4B-TS05', () => {
  test('locked apply refuses an incomplete whole pair before any commit boundary', async () => {
    expect(STRICT_WHOLE_PAIR_CASES).toContain('bounded-tool');
    const selected = await createIncompleteWholePairFixture();
    try {
      const product = await runBoundedLockedPreview(selected, 'apply');
      expect(product.exitCode, product.stdout).toBe(3);
      expect(JSON.parse(product.stdout)).toMatchObject({
        kind: 'error',
        code: 'plan-locked-state',
        exitCode: 3,
      });
    } finally {
      await destroyIncompleteWholePairFixture(selected);
    }
  });
});
