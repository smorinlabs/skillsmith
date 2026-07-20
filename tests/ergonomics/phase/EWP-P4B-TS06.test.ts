import { describe, expect, test } from 'bun:test';
import {
  createIncompleteWholePairFixture,
  destroyIncompleteWholePairFixture,
  runBoundedLockedPreview,
} from '../fixtures/p4b-lock-policy/cases.ts';

describe('EWP-P4B-TS06', () => {
  test('a copied pair cannot claim locked reproduction when any manifest entry is absent', async () => {
    const machineB = await createIncompleteWholePairFixture();
    try {
      const product = await runBoundedLockedPreview(machineB, 'plan');
      expect(product.exitCode, product.stdout).toBe(3);
      expect(JSON.parse(product.stdout)).toMatchObject({
        kind: 'error',
        code: 'plan-locked-state',
        exitCode: 3,
      });
    } finally {
      await destroyIncompleteWholePairFixture(machineB);
    }
  });
});
