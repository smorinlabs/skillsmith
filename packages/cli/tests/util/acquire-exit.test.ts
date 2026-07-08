import { describe, expect, test } from 'bun:test';
import type {
  InstallReport,
  InstallResult,
  SkillSmithError,
  UninstallReport,
  UninstallResult,
} from '@skillsmith/core';
import { acquireExitCode } from '../../src/util/acquire-exit.ts';

const installResult = (overrides: Partial<InstallResult> = {}): InstallResult => ({
  source: 'acme/repo/x',
  skill: 'x',
  tool: 'claude-code',
  scope: 'user',
  placementPath: '/x',
  action: 'installed',
  reason: null,
  placement: 'symlink',
  store: null,
  origin: null,
  verify: null,
  candidates: null,
  ...overrides,
});

const installReport = (results: InstallResult[]): InstallReport => ({
  dryRun: false,
  requested: {
    sources: [],
    tools: ['claude-code'],
    explicitTools: false,
    scope: 'user',
    explicitScope: false,
    ref: null,
    pin: false,
    direct: false,
    force: false,
    verify: 'static',
    deep: false,
  },
  results,
  summary: { installed: 0, updated: 0, repaired: 0, noop: 0, skipped: 0, refused: 0, failed: 0 },
});

const uninstallResult = (overrides: Partial<UninstallResult> = {}): UninstallResult => ({
  skill: 'x',
  tool: 'claude-code',
  scope: 'user',
  placementPath: '/x',
  action: 'removed',
  reason: null,
  before: null,
  storeRetained: null,
  backupKept: null,
  ...overrides,
});

const uninstallReport = (results: UninstallResult[]): UninstallReport => ({
  dryRun: false,
  requested: {
    targets: [],
    tools: ['claude-code'],
    explicitTools: false,
    scope: null,
    allScopes: false,
    force: false,
  },
  results,
  summary: { removed: 0, noop: 0, refused: 0, failed: 0 },
});

describe('acquireExitCode', () => {
  test('all success actions on an install report -> 0', () => {
    const r = installReport([
      installResult({ action: 'installed' }),
      installResult({ action: 'noop' }),
      installResult({ action: 'skipped' }),
    ]);
    expect(acquireExitCode(r)).toBe(0);
  });

  test('empty results -> 0', () => {
    expect(acquireExitCode(installReport([]))).toBe(0);
    expect(acquireExitCode(uninstallReport([]))).toBe(0);
  });

  const codeTable: [SkillSmithError, number][] = [
    [{ code: 'generic', message: 'x' }, 1],
    [{ code: 'flip-failed', message: 'x' }, 1],
    [{ code: 'flip-refused', message: 'x' }, 2],
    [{ code: 'ledger-error', message: 'x' }, 3],
    [{ code: 'placement-not-found', message: 'x' }, 4],
    [{ code: 'tool-unavailable', message: 'x' }, 4],
    [{ code: 'source-unresolvable', message: 'x' }, 5],
    [{ code: 'permission-denied', message: 'x' }, 6],
  ];

  for (const [error, expected] of codeTable) {
    test(`install: ${error.code} -> exit ${expected}`, () => {
      const r = installReport([installResult({ action: 'failed', error })]);
      expect(acquireExitCode(r)).toBe(expected);
    });

    test(`uninstall: ${error.code} -> exit ${expected}`, () => {
      const r = uninstallReport([uninstallResult({ action: 'failed', error })]);
      expect(acquireExitCode(r)).toBe(expected);
    });
  }

  test('batch max rule: highest per-result code wins regardless of order', () => {
    const refused: SkillSmithError = { code: 'flip-refused', message: 'x' };
    const notFound: SkillSmithError = { code: 'placement-not-found', message: 'x' };
    const r = installReport([
      installResult({ action: 'refused', error: refused }),
      installResult({ action: 'refused', error: notFound }),
    ]);
    expect(acquireExitCode(r)).toBe(4);
  });

  test('a success result mixed with a failure -> the failure code wins', () => {
    const perm: SkillSmithError = { code: 'permission-denied', message: 'x' };
    const r = uninstallReport([
      uninstallResult({ action: 'removed' }),
      uninstallResult({ action: 'failed', error: perm }),
    ]);
    expect(acquireExitCode(r)).toBe(6);
  });
});
