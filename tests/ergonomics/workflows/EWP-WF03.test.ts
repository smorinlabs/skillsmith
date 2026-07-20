import { describe, expect, test } from 'bun:test';
import {
  SUPPORTED_REPRODUCTION_PLATFORMS,
  createIncompleteWholePairFixture,
  destroyIncompleteWholePairFixture,
  runBoundedLockedPreview,
} from '../fixtures/p4b-lock-policy/cases.ts';

describe('EWP-WF03', () => {
  test('reproducible bootstrap requires one complete frozen pair on supported platforms', async () => {
    expect(SUPPORTED_REPRODUCTION_PLATFORMS).toEqual(['darwin', 'linux']);
    const clone = await createIncompleteWholePairFixture();
    try {
      const product = await runBoundedLockedPreview(clone, 'apply');
      expect(product.exitCode, product.stdout).toBe(3);
      expect(JSON.parse(product.stdout)).toMatchObject({
        code: 'plan-locked-state',
        exitCode: 3,
      });
    } finally {
      await destroyIncompleteWholePairFixture(clone);
    }
  });
});
