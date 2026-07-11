import { expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import { buildInTemporaryRoot } from './temporary-root.ts';

test('buildInTemporaryRoot removes its root when construction throws', async () => {
  let allocatedRoot = '';

  await expect(
    buildInTemporaryRoot('skillsmith-cleanup-test-', async (base) => {
      allocatedRoot = base;
      throw new Error('injected construction failure');
    }),
  ).rejects.toThrow('injected construction failure');

  expect(allocatedRoot).not.toBe('');
  await expect(access(allocatedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});
