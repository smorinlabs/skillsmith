import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultScanEnv } from '../../src/env/default.ts';

describe('defaultScanEnv.listDir', () => {
  test('returns entries without . / ..', async () => {
    const env = await defaultScanEnv();
    const d = join('/tmp', `sk-listdir-${Date.now()}`);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'a.txt'), '');
    await mkdir(join(d, 'sub'));
    try {
      const entries = [...(await env.listDir(d))].sort();
      expect(entries).toEqual(['a.txt', 'sub']);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('returns [] for a missing directory', async () => {
    const env = await defaultScanEnv();
    const entries = await env.listDir('/nope/definitely/not/here');
    expect(entries).toEqual([]);
  });
});
