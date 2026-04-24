import { describe, expect, test } from 'bun:test';
import { defaultScanEnv } from '../../src/env/default.ts';

describe('defaultScanEnv', () => {
  test('populates homeDir, path, platform, xdg from process env', async () => {
    const env = await defaultScanEnv();
    expect(env.homeDir.length).toBeGreaterThan(0);
    expect(Array.isArray(env.path)).toBe(true);
    expect(['darwin', 'linux', 'win32']).toContain(env.platform);
    expect(env.xdg.config.length).toBeGreaterThan(0);
    expect(env.xdg.data.length).toBeGreaterThan(0);
    expect(env.xdg.cache.length).toBeGreaterThan(0);
  });

  test('fileExists returns true for this test file and false for a made-up path', async () => {
    const env = await defaultScanEnv();
    const self = new URL(import.meta.url).pathname;
    expect(await env.fileExists(self)).toBe(true);
    expect(await env.fileExists('/definitely/not/a/real/path/xyz')).toBe(false);
  });
});
