import { describe, expect, test } from 'bun:test';
import { codexAdapter, codexAgent } from '../../src/agents/codex/index.ts';
import type { DetectionPorts } from '../../src/ports/types.ts';

const env = (existing: string[]): DetectionPorts => ({
  homeDir: '/Users/u',
  executableSearchPath: ['/usr/bin'],
  platform: 'darwin',
  xdg: { config: '/c', data: '/d', cache: '/k' },
  fileExists: async (p) => existing.includes(p),
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => '0.5.1',
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  modifiedAt: async () => null,
});

describe('codexAgent', () => {
  test('tool identity + installHint', () => {
    expect(codexAgent.tool).toBe('codex');
    expect(codexAgent.installHint).toContain('codex');
  });

  test('owns the static-plus-deep update verification policy', () => {
    expect(codexAdapter.verification.gatePolicy.update).toBe('static+deep');
  });

  test('returns InstallRecord[] when codex binary is present', async () => {
    const r = await codexAgent.detect(env(['/opt/homebrew/bin/codex']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]).toEqual({
        path: '/opt/homebrew/bin/codex',
        version: '0.5.1',
        installMethod: 'brew',
      });
    }
  });
});
