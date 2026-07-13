import { describe, expect, test } from 'bun:test';
import {
  type CurrentApplicationContext,
  type ScanEnv,
  resolveRuntimeConfiguration,
  runAgentsApplication,
} from '@skillsmith/core';
import { runtimePorts } from '../../../core/tests/fixtures/runtime-ports.ts';

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
  modifiedAt: async () => null,
  withFileLock: (_p, fn) => fn(),
});

const context = (scanEnv: ScanEnv): CurrentApplicationContext => ({
  ports: runtimePorts(scanEnv),
  configuration: resolveRuntimeConfiguration({}),
  interaction: {
    mode: 'noninteractive',
    choose: async () => ({ status: 'refused', reason: 'test' }),
    confirm: async () => ({ status: 'refused', reason: 'test' }),
  },
  invocationCwd: '/repo',
  globalOptions: {},
});

describe('runAgentsApplication', () => {
  test('returns structured detections for rendering', async () => {
    const outcome = await runAgentsApplication(
      { arguments: [], options: { tool: [], detectedOnly: false } },
      context(env(['/opt/homebrew/bin/claude'])),
    );
    expect(outcome.exitClass).toBe('success');
    expect(outcome.report.detections.get('claude-code')).toHaveLength(1);
  });

  test('unknown tool in --tool filter returns a semantic usage outcome', async () => {
    const outcome = await runAgentsApplication(
      { arguments: [], options: { tool: ['nope'], detectedOnly: false } },
      context(env([])),
    );
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.diagnostics[0]?.message).toContain('nope');
  });
});
