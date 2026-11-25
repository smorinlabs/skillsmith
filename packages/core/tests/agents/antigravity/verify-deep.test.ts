import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  analyzeAntigravityAcpOutput,
  verifyAntigravity,
} from '../../../src/agents/antigravity/verify.ts';
import type { ExecOptions, ExecResult, ScanEnv } from '../../../src/env/types.ts';
import type { VerifyPorts } from '../../../src/verify/types.ts';
import { runtimePorts } from '../../fixtures/runtime-ports.ts';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'verify');
const PINNED_VERSION = '1.5.16';

const acpTranscript = (commands: readonly string[]): string =>
  [
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, result: { sessionId: 's1' } }),
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: commands.map((name) => ({ name, description: '' })),
        },
      },
    }),
  ].join('\n');

const fileExistsFake = (p: string): boolean => {
  if (p === '/fake/agy') return true;
  if (p.startsWith(FIXTURES)) return existsSync(p);
  return false;
};

const scanEnvFixture = (): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => fileExistsFake(p),
  realpath: async (p) => p,
  listDir: async (p) => readdir(p),
  readText: async (p) => readFile(p, 'utf8'),
  runVersion: async () => 'unknown',
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

const fakeInstalled = (overrides: Partial<ScanEnv> = {}): VerifyPorts => {
  const base = runtimePorts({
    ...scanEnvFixture(),
    path: ['/fake'],
    runVersion: async () => PINNED_VERSION,
    ...overrides,
  });
  return {
    ...base,
    ...(overrides.removeTree
      ? {
          removeTree: async (p) => {
            await overrides.removeTree?.(p);
            await base.removeTree(p);
          },
        }
      : {}),
  };
};

describe('analyzeAntigravityAcpOutput', () => {
  test('passes when all expected command names are present alongside built-ins', () => {
    const stdout = acpTranscript(['goal', 'compact', 'good-skill', 'custom-fm-name']);
    const result = analyzeAntigravityAcpOutput(stdout, [
      { commandName: 'good-skill', folderName: 'good-skill', file: 'skills/good-skill/SKILL.md' },
      { commandName: 'custom-fm-name', folderName: 'dir-name', file: 'skills/dir-name/SKILL.md' },
    ]);
    expect(result).toEqual({ findings: [], complete: true });
  });

  test('emits presence warning for each missing skill', () => {
    const stdout = acpTranscript(['goal', 'good-skill']);
    const result = analyzeAntigravityAcpOutput(stdout, [
      { commandName: 'good-skill', folderName: 'good-skill', file: 'skills/good-skill/SKILL.md' },
      { commandName: 'bad-yaml', folderName: 'bad-yaml', file: 'skills/bad-yaml/SKILL.md' },
    ]);
    expect(result).toEqual({
      complete: true,
      findings: [
        {
          checkId: 'antigravity.load-presence',
          toolSeverity: null,
          normalizedSeverity: 'warning',
          message:
            "skill 'bad-yaml' did not load (reason unavailable at runtime — see static validate)",
          file: 'skills/bad-yaml/SKILL.md',
          subject: 'skill',
        },
      ],
    });
  });

  test('rejects missing responses, RPC errors, malformed JSON, and missing notification', () => {
    expect('error' in analyzeAntigravityAcpOutput('', [])).toBe(true);
    expect('error' in analyzeAntigravityAcpOutput('not-json', [])).toBe(true);
    expect(
      'error' in
        analyzeAntigravityAcpOutput(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'fail' } }),
          [],
        ),
    ).toBe(true);
    expect(
      'error' in
        analyzeAntigravityAcpOutput(
          [
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
            JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }),
            JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }),
          ].join('\n'),
          [],
        ),
    ).toBe(true);
  });
});

describe('verifyAntigravity deep mode', () => {
  test('invokes agy acp over bounded JSON-RPC with isolated env and notification wait', async () => {
    let capturedArgs: readonly string[] = [];
    let capturedOpts: ExecOptions | undefined;
    const removed: string[] = [];
    const env = fakeInstalled({
      exec: async (_bin, args, opts): Promise<ExecResult> => {
        capturedArgs = args;
        capturedOpts = opts;
        return {
          code: 0,
          stdout: acpTranscript(['goal', 'good-skill', 'bad-nodesc']),
          stderr: '',
          timedOut: false,
        };
      },
      removeTree: async (p) => {
        removed.push(p);
      },
    });

    const r = await verifyAntigravity(env, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(capturedArgs).toEqual(['acp', '--disable-telemetry']);
    expect(capturedOpts?.env?.GEMINI_API_KEY).toBe('skillsmith-offline-probe');
    expect(capturedOpts?.unsetEnv).toContain('GOOGLE_API_KEY');
    expect(capturedOpts?.jsonRpc?.map((m) => m.method)).toEqual([
      'initialize',
      'authenticate',
      'session/new',
    ]);
    expect(capturedOpts?.jsonRpcUntilNotification).toEqual({
      method: 'session/update',
      path: ['params', 'update', 'sessionUpdate'],
      equals: 'available_commands_update',
    });

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.verdict).toBe('warn');
    expect(mode?.findings.map((f) => f.file).sort()).toEqual([
      'skills/bad-noframe/SKILL.md',
      'skills/bad-yaml/SKILL.md',
    ]);
    expect(removed).toHaveLength(2);
  });

  test('matches frontmatter name when it differs from the folder name', async () => {
    const env = fakeInstalled({
      exec: async () => ({
        code: 0,
        stdout: acpTranscript(['mismatched-name']),
        stderr: '',
        timedOut: false,
      }),
    });
    const r = await verifyAntigravity(env, {
      path: join(FIXTURES, 'antigravity-warn'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verdict).toBe('pass');
    expect(r.value.modes[0]?.findings).toEqual([]);
  });

  test('reports timeout and protocol errors as deep mode errors', async () => {
    const env = fakeInstalled({
      exec: async () => ({
        code: -1,
        stdout: '',
        stderr: 'Bearer secret-token',
        timedOut: true,
        protocolError: 'deadline exceeded',
      }),
    });
    const r = await verifyAntigravity(env, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verdict).toBe('inconclusive');
    expect(r.value.modes[0]?.skipReason).toBe('timeout');
    expect(r.value.modes[0]?.findings[0]?.message).not.toContain('secret-token');
  });
});
