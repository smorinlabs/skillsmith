import { describe, expect, test } from 'bun:test';
import {
  createIncompleteWholePairFixture,
  destroyIncompleteWholePairFixture,
  runBoundedLockedPreview,
} from '../fixtures/p4b-lock-policy/cases.ts';

describe('EWP-WF04', () => {
  test('existing-fleet restore refuses an incomplete explicit pair even when a filter is satisfiable', async () => {
    const restored = await createIncompleteWholePairFixture();
    try {
      const product = await runBoundedLockedPreview(restored, 'plan');
      expect(product.exitCode, product.stdout).toBe(3);
      expect(JSON.parse(product.stdout)).toMatchObject({
        kind: 'error',
        code: 'plan-locked-state',
      });
    } finally {
      await destroyIncompleteWholePairFixture(restored);
    }
  });
});
