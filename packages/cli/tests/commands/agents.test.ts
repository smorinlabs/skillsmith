import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '@skillsmith/core';
import { runAgents } from '../../src/commands/agents.ts';

const env = (existing: string[]): ScanEnv => ({
  homeDir: '/Users/u',
  path: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => '1.0.0',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  withFileLock: (_p, fn) => fn(),
});

describe('runAgents', () => {
  test('markdown default: contains "Tools detected" header', async () => {
    const r = await runAgents({
      env: env([]),
      tools: undefined,
      format: 'markdown',
      detectedOnly: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('# Tools detected');
  });

  test('json format: parseable and has tools key', async () => {
    const r = await runAgents({
      env: env(['/opt/homebrew/bin/claude']),
      tools: undefined,
      format: 'json',
      detectedOnly: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p = JSON.parse(r.output);
      expect(p.tools['claude-code']).toHaveLength(1);
    }
  });

  test('unknown tool in --tool filter returns err', async () => {
    const r = await runAgents({
      env: env([]),
      tools: ['nope'],
      format: 'markdown',
      detectedOnly: false,
    });
    expect(r.ok).toBe(false);
  });
});
