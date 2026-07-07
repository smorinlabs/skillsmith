import { describe, expect, test } from 'bun:test';
import type { FlipReport } from '@skillsmith/core';
import { renderFlipHuman } from '../../src/output/flip-human.ts';

const STORE_PATH =
  '/Users/alice/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@3f2a1b9c0d4e/factor-scan';

describe('renderFlipHuman', () => {
  test('promote success: header, verify/snapshot/swap lines, summary', () => {
    const report: FlipReport = {
      op: 'promote',
      dryRun: false,
      requested: {
        targets: ['factor-scan'],
        all: false,
        tools: ['claude-code', 'codex'],
        explicitTools: false,
      },
      results: [
        {
          skill: 'factor-scan',
          tool: 'claude-code',
          placementPath: '/Users/alice/.claude/skills/factor-scan',
          action: 'flipped',
          reason: null,
          before: { mode: 'dev', symlinkTarget: '/Users/alice/c/x/factor-scan' },
          after: { mode: 'pinned', storePath: STORE_PATH },
          store: {
            path: STORE_PATH,
            rev: '3f2a1b9c0d4e',
            gitSha: 'a'.repeat(40),
            dirty: false,
            reused: false,
          },
          verify: { gate: 'passed', verdict: 'pass' },
        },
        {
          skill: 'factor-scan',
          tool: 'codex',
          placementPath: '/Users/alice/.codex/skills/factor-scan',
          action: 'flipped',
          reason: null,
          before: { mode: 'dev', symlinkTarget: '/Users/alice/c/x/factor-scan' },
          after: { mode: 'pinned', storePath: STORE_PATH },
          store: {
            path: STORE_PATH,
            rev: '3f2a1b9c0d4e',
            gitSha: 'a'.repeat(40),
            dirty: false,
            reused: true,
          },
          verify: { gate: 'passed', verdict: 'pass' },
        },
      ],
      summary: {
        flipped: 2,
        updated: 0,
        noop: 0,
        skipped: 0,
        refused: 0,
        failed: 0,
        rolledBack: 0,
      },
    };

    const out = renderFlipHuman(report, 0);
    expect(out).toContain('Promoting factor-scan');
    expect(out).toContain('tools: claude-code, codex');
    expect(out).toContain('snapshot smorinlabs/smorinlabs-harness@3f2a1b9c0d4e  (reused)');
    expect(out).toContain('snapshot smorinlabs/smorinlabs-harness@3f2a1b9c0d4e  (new store entry)');
    expect(out).toContain('swap');
    expect(out).toContain('2 flipped.  Exit code: 0');
  });

  test('dev success: source/swap lines, pin retained, summary', () => {
    const report: FlipReport = {
      op: 'dev',
      dryRun: false,
      requested: {
        targets: ['factor-scan'],
        all: false,
        tools: ['claude-code'],
        explicitTools: false,
      },
      results: [
        {
          skill: 'factor-scan',
          tool: 'claude-code',
          placementPath: '/Users/alice/.claude/skills/factor-scan',
          action: 'flipped',
          reason: null,
          before: { mode: 'pinned', storePath: STORE_PATH },
          after: { mode: 'dev', symlinkTarget: '/Users/alice/c/x/factor-scan' },
          store: {
            path: STORE_PATH,
            rev: '3f2a1b9c0d4e',
            gitSha: 'a'.repeat(40),
            dirty: false,
            reused: true,
          },
          verify: null,
        },
      ],
      summary: {
        flipped: 1,
        updated: 0,
        noop: 0,
        skipped: 0,
        refused: 0,
        failed: 0,
        rolledBack: 0,
      },
    };

    const out = renderFlipHuman(report, 0);
    expect(out).toContain('Flipping factor-scan to dev mode');
    expect(out).toContain('swap');
    expect(out).toContain('pin retained: smorinlabs/smorinlabs-harness@3f2a1b9c0d4e');
    expect(out).toContain('1 flipped.  Exit code: 0');
  });

  test('a success result carrying a warning reason is counted in the summary', () => {
    const report: FlipReport = {
      op: 'dev',
      dryRun: false,
      requested: {
        targets: ['factor-scan'],
        all: false,
        tools: ['claude-code'],
        explicitTools: false,
      },
      results: [
        {
          skill: 'factor-scan',
          tool: 'claude-code',
          placementPath: '/Users/alice/.claude/skills/factor-scan',
          action: 'flipped',
          reason: 'kept backup .../.skillsmith-backup-factor-scan-9f4c2a17: hash mismatch',
          before: { mode: 'pinned', storePath: STORE_PATH },
          after: { mode: 'dev', symlinkTarget: '/Users/alice/c/x/factor-scan' },
          store: {
            path: STORE_PATH,
            rev: '3f2a1b9c0d4e',
            gitSha: null,
            dirty: false,
            reused: true,
          },
          verify: null,
        },
      ],
      summary: {
        flipped: 1,
        updated: 0,
        noop: 0,
        skipped: 0,
        refused: 0,
        failed: 0,
        rolledBack: 0,
      },
    };

    const out = renderFlipHuman(report, 0);
    expect(out).toContain('1 flipped, 1 warning.  Exit code: 0');
  });

  test('a refused result renders a refusal line and the summary counts it', () => {
    const report: FlipReport = {
      op: 'promote',
      dryRun: false,
      requested: { targets: ['bad'], all: false, tools: ['claude-code'], explicitTools: false },
      results: [
        {
          skill: 'bad',
          tool: 'claude-code',
          placementPath: '/Users/alice/.claude/skills/bad',
          action: 'refused',
          reason: 'the source tree is dirty',
          before: null,
          after: null,
          store: null,
          verify: null,
        },
      ],
      summary: {
        flipped: 0,
        updated: 0,
        noop: 0,
        skipped: 0,
        refused: 1,
        failed: 0,
        rolledBack: 0,
      },
    };

    const out = renderFlipHuman(report, 2);
    expect(out).toContain('the source tree is dirty');
    expect(out).toContain('1 refused.  Exit code: 2');
  });
});
