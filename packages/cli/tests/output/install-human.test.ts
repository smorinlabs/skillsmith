import { describe, expect, test } from 'bun:test';
import type { InstallReport, UninstallReport, VerifyReport } from '@skillsmith/core';
import { Command } from 'commander';
import { CURRENT_RENDERER_REPORTS } from '../../../../tests/ergonomics/fixtures/p1-ts10/reports.ts';
import { renderInstallHuman, renderUninstallHuman } from '../../src/output/install-human.ts';
import type { RuntimeOutcome } from '../../src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../src/runtime/current-renderers.ts';

const SHA = `8c1d2e3f4a5b${'0'.repeat(28)}`;
const STORE_PATH =
  '/Users/alice/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@8c1d2e3f4a5b/factor-scan';
const codexStaticNotice = (_tool: string, skill: string): string =>
  `codex static checks the manifest only — run 'skillsmith verify ${skill} --deep' for a full load check`;

const successOutcome = (report: unknown): RuntimeOutcome => ({
  report,
  diagnostics: [],
  exitClass: 'success',
  mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
  deprecations: [],
});

const stdout = (rendered: string | { readonly stdout?: string }): string =>
  typeof rendered === 'string' ? rendered : (rendered.stdout ?? '');

describe('renderInstallHuman', () => {
  test('success: header, verify/store/place lines (claude-code + codex), codex manifest-only note, summary', () => {
    const report: InstallReport = {
      dryRun: false,
      requested: {
        sources: ['smorinlabs/smorinlabs-harness/factor-scan'],
        tools: ['claude-code', 'codex'],
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
      results: [
        {
          source: 'smorinlabs/smorinlabs-harness/factor-scan',
          skill: 'factor-scan',
          tool: 'claude-code',
          scope: 'user',
          placementPath: '/Users/alice/.claude/skills/factor-scan',
          action: 'installed',
          reason: null,
          placement: 'symlink',
          store: { path: STORE_PATH, rev: '8c1d2e3f4a5b', gitSha: SHA, reused: false },
          origin: {
            host: 'github.com',
            repo: 'smorinlabs/smorinlabs-harness',
            skillPath: 'plugins/factor-harness/skills/factor-scan',
            refRequested: null,
            refResolved: SHA,
            pin: false,
          },
          verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
          candidates: null,
        },
        {
          source: 'smorinlabs/smorinlabs-harness/factor-scan',
          skill: 'factor-scan',
          tool: 'codex',
          scope: 'user',
          placementPath: '/Users/alice/.agents/skills/factor-scan',
          action: 'installed',
          reason: null,
          placement: 'symlink',
          store: { path: STORE_PATH, rev: '8c1d2e3f4a5b', gitSha: SHA, reused: true },
          origin: {
            host: 'github.com',
            repo: 'smorinlabs/smorinlabs-harness',
            skillPath: 'plugins/factor-harness/skills/factor-scan',
            refRequested: null,
            refResolved: SHA,
            pin: false,
          },
          verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
          candidates: null,
        },
      ],
      summary: {
        installed: 2,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: 0,
        failed: 0,
      },
    };

    const out = renderInstallHuman(report, 0, codexStaticNotice);
    expect(out).toContain(
      'Installing factor-scan  (smorinlabs/smorinlabs-harness @ 8c1d2e3f4a5b, scope: user)',
    );
    expect(out).toContain('verify   static: pass');
    expect(out).toContain('(reused)');
    expect(out).toContain('(new entry)');
    expect(out).toContain(
      "codex static checks the manifest only — run 'skillsmith verify factor-scan --deep' for a full load check",
    );
    expect(out).toContain('installed');
    expect(out).toContain('2 installed.  Exit code: 0');
  });

  test('the pure renderer default contains no selected adapter notice', () => {
    const base = {
      dryRun: false,
      requested: {
        sources: ['fixture/source'],
        tools: ['codex'],
        explicitTools: true,
        scope: 'user',
        explicitScope: false,
        ref: null,
        pin: false,
        direct: false,
        force: false,
        verify: 'static',
        deep: false,
      },
      results: [
        {
          source: 'fixture/source',
          skill: 'fixture-skill',
          tool: 'codex',
          scope: 'user',
          placementPath: '/fixture/skills/fixture-skill',
          action: 'installed',
          reason: null,
          placement: 'symlink',
          store: { path: '/fixture/store/fixture-skill', rev: 'main', gitSha: SHA, reused: false },
          origin: null,
          verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
          candidates: null,
        },
      ],
      summary: {
        installed: 1,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: 0,
        failed: 0,
      },
    } satisfies InstallReport;

    expect(renderInstallHuman(base, 0)).not.toContain('note:');
  });

  test('uses an injected selected static notice without reading registry state', () => {
    const base = {
      dryRun: false,
      requested: {
        sources: ['fixture/source'],
        tools: ['codex'],
        explicitTools: true,
        scope: 'user',
        explicitScope: false,
        ref: null,
        pin: false,
        direct: false,
        force: false,
        verify: 'static',
        deep: false,
      },
      results: [
        {
          source: 'fixture/source',
          skill: 'fixture-skill',
          tool: 'codex',
          scope: 'user',
          placementPath: '/fixture/skills/fixture-skill',
          action: 'installed',
          reason: null,
          placement: 'symlink',
          store: { path: '/fixture/store/fixture-skill', rev: 'main', gitSha: SHA, reused: false },
          origin: null,
          verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
          candidates: null,
        },
      ],
      summary: {
        installed: 1,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: 0,
        failed: 0,
      },
    } satisfies InstallReport;

    const out = renderInstallHuman(
      base,
      0,
      (tool, skill) => `${tool} selected notice for ${skill}`,
    );
    expect(out).toContain('codex selected notice for fixture-skill');
    expect(out).not.toContain('checks the manifest only');
  });

  test('--deep codex result: static+deep verdict, no manifest-only note', () => {
    const report: InstallReport = {
      dryRun: false,
      requested: {
        sources: ['acme/tools/review'],
        tools: ['codex'],
        explicitTools: true,
        scope: 'user',
        explicitScope: false,
        ref: null,
        pin: false,
        direct: false,
        force: false,
        verify: 'static',
        deep: true,
      },
      results: [
        {
          source: 'acme/tools/review',
          skill: 'review',
          tool: 'codex',
          scope: 'user',
          placementPath: '/Users/alice/.agents/skills/review',
          action: 'installed',
          reason: null,
          placement: 'symlink',
          store: { path: STORE_PATH, rev: '8c1d2e3f4a5b', gitSha: SHA, reused: false },
          origin: {
            host: 'github.com',
            repo: 'acme/tools',
            skillPath: 'review',
            refRequested: null,
            refResolved: SHA,
            pin: false,
          },
          verify: { gate: 'passed', verdict: 'pass', mode: 'static+deep' },
          candidates: null,
        },
      ],
      summary: {
        installed: 1,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: 0,
        failed: 0,
      },
    };

    const out = renderInstallHuman(report, 0);
    expect(out).toContain('verify   static+deep: pass');
    expect(out).not.toContain('manifest only');
  });

  test('idempotent noop: "already installed at" block + --force/--ref guidance', () => {
    const report: InstallReport = {
      dryRun: false,
      requested: {
        sources: ['smorinlabs/smorinlabs-harness/factor-scan'],
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
      results: [
        {
          source: 'smorinlabs/smorinlabs-harness/factor-scan',
          skill: 'factor-scan',
          tool: 'claude-code',
          scope: 'user',
          placementPath: '/Users/alice/.claude/skills/factor-scan',
          action: 'noop',
          reason: 'already installed at 8c1d2e3f4a5b',
          placement: 'symlink',
          store: { path: STORE_PATH, rev: '8c1d2e3f4a5b', gitSha: SHA, reused: true },
          origin: {
            host: 'github.com',
            repo: 'smorinlabs/smorinlabs-harness',
            skillPath: 'plugins/factor-harness/skills/factor-scan',
            refRequested: null,
            refResolved: SHA,
            pin: false,
          },
          verify: null,
          candidates: null,
        },
      ],
      summary: {
        installed: 0,
        updated: 0,
        repaired: 0,
        noop: 1,
        skipped: 0,
        refused: 0,
        failed: 0,
      },
    };

    const out = renderInstallHuman(report, 0);
    expect(out).toContain(
      'factor-scan is already installed at smorinlabs/smorinlabs-harness@8c1d2e3f4a5b',
    );
    expect(out).toContain('(store symlink)');
    expect(out).toContain(
      'Use --force to reinstall, or --ref <ref> to install a different revision.',
    );
    expect(out).toContain('1 up to date.  Exit code: 0');
  });

  test('a refused result renders a refusal line and the summary counts it', () => {
    const report: InstallReport = {
      dryRun: false,
      requested: {
        sources: ['acme/agent-tools/review'],
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
      results: [
        {
          source: 'acme/agent-tools/review',
          skill: null,
          tool: null,
          scope: 'user',
          placementPath: null,
          action: 'refused',
          reason: "'review' matches 2 skills — re-run with one of the exact paths above",
          placement: null,
          store: null,
          origin: null,
          verify: null,
          candidates: [
            'acme/agent-tools//plugins/web/skills/review',
            'acme/agent-tools//plugins/api/skills/review',
          ],
        },
      ],
      summary: {
        installed: 0,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: 1,
        failed: 0,
      },
    };

    const out = renderInstallHuman(report, 2);
    expect(out).toContain("'review' matches 2 skills");
    expect(out).toContain('1 refused.  Exit code: 2');
  });

  test('groups real duplicate requests by numeric request identity, not their safe display label', () => {
    const result = (requestIndex: number) => ({
      source: '[REJECTED_SOURCE]',
      requestIndex,
      skill: null,
      tool: null,
      scope: 'user' as const,
      placementPath: null,
      action: 'refused' as const,
      reason: 'source input was refused',
      placement: null,
      store: null,
      origin: null,
      verify: null,
      candidates: null,
    });
    const report: InstallReport = {
      dryRun: false,
      requested: {
        sources: ['[REJECTED_SOURCE]', '[REJECTED_SOURCE]'],
        tools: ['codex'],
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
      results: [result(0), result(1)],
      summary: {
        installed: 0,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: 2,
        failed: 0,
      },
    };

    const output = renderInstallHuman(report, 2);
    expect(output.match(/^Installing \[REJECTED_SOURCE\]$/gmu)).toHaveLength(2);
    expect(output).toContain('2 refused.  Exit code: 2');
  });
});

describe('current renderer adapter facts', () => {
  const renderers = createCurrentRendererRegistry(new Command());
  const renderer = (name: string) => {
    const selected = renderers[name];
    if (selected === undefined) throw new Error(`missing current renderer ${name}`);
    return selected;
  };

  test('injects the registered install static notice', () => {
    const rendered = stdout(
      renderer('install').human(successOutcome(CURRENT_RENDERER_REPORTS.install)),
    );
    expect(rendered).toContain(
      "codex static checks the manifest only — run 'skillsmith verify fixture-skill --deep'",
    );
  });

  test('injects the registered deep-coverage suffix', () => {
    const fixture = CURRENT_RENDERER_REPORTS.verify.result;
    const value = {
      ...fixture,
      requested: { ...fixture.requested, tools: ['claude-code'] },
      tools: fixture.tools.map((tool) => ({ ...tool, tool: 'claude-code' })),
    } as unknown as VerifyReport;
    const rendered = stdout(renderer('verify').human(successOutcome({ result: value })));
    expect(rendered).toContain('skills ✓ (presence)');
  });
});

describe('renderUninstallHuman', () => {
  test('success: header, remove lines (claude-code + codex), store-retained note, summary', () => {
    const report: UninstallReport = {
      dryRun: false,
      requested: {
        targets: ['factor-scan'],
        tools: ['claude-code', 'codex'],
        explicitTools: false,
        scope: null,
        allScopes: false,
        force: false,
      },
      results: [
        {
          skill: 'factor-scan',
          tool: 'claude-code',
          scope: 'user',
          placementPath: '/Users/alice/.claude/skills/factor-scan',
          action: 'removed',
          reason: null,
          before: {
            mode: 'pinned',
            placement: 'symlink',
            storePath: STORE_PATH,
            symlinkTarget: null,
          },
          storeRetained: STORE_PATH,
          backupKept: null,
        },
        {
          skill: 'factor-scan',
          tool: 'codex',
          scope: 'user',
          placementPath: '/Users/alice/.agents/skills/factor-scan',
          action: 'removed',
          reason: null,
          before: {
            mode: 'pinned',
            placement: 'symlink',
            storePath: STORE_PATH,
            symlinkTarget: null,
          },
          storeRetained: STORE_PATH,
          backupKept: null,
        },
      ],
      summary: { removed: 2, noop: 0, refused: 0, failed: 0 },
    };

    const out = renderUninstallHuman(report, 0);
    expect(out).toContain('Removing factor-scan  (scope: user)');
    expect(out).toContain('remove   store symlink');
    expect(out).toContain(`store entry retained: ${STORE_PATH}`);
    expect(out).toContain('2 removed.  Exit code: 0');
  });

  test('a backup-kept warning renders alongside the store-retained note', () => {
    const report: UninstallReport = {
      dryRun: false,
      requested: {
        targets: ['review'],
        tools: ['claude-code'],
        explicitTools: false,
        scope: null,
        allScopes: false,
        force: true,
      },
      results: [
        {
          skill: 'review',
          tool: 'claude-code',
          scope: 'user',
          placementPath: '/Users/alice/.claude/skills/review',
          action: 'removed',
          reason: 'kept backup .../.skillsmith-backup-review-9f4c2a17: hash mismatch',
          before: { mode: 'pinned', placement: 'copy', storePath: STORE_PATH, symlinkTarget: null },
          storeRetained: null,
          backupKept: '/Users/alice/.claude/skills/.skillsmith-backup-review-9f4c2a17',
        },
      ],
      summary: { removed: 1, noop: 0, refused: 0, failed: 0 },
    };

    const out = renderUninstallHuman(report, 0);
    expect(out).toContain('remove   store copy');
    expect(out).toContain(
      'backup kept: /Users/alice/.claude/skills/.skillsmith-backup-review-9f4c2a17',
    );
  });

  test('not installed anywhere (noop): reason passthrough, no per-tool block', () => {
    const report: UninstallReport = {
      dryRun: false,
      requested: {
        targets: ['nope'],
        tools: ['claude-code', 'codex'],
        explicitTools: false,
        scope: null,
        allScopes: false,
        force: false,
      },
      results: [
        {
          skill: 'nope',
          tool: null,
          scope: null,
          placementPath: null,
          action: 'noop',
          reason: "'nope' is not installed anywhere skillsmith manages",
          before: null,
          storeRetained: null,
          backupKept: null,
        },
      ],
      summary: { removed: 0, noop: 1, refused: 0, failed: 0 },
    };

    const out = renderUninstallHuman(report, 0);
    expect(out).toContain("'nope' is not installed anywhere skillsmith manages");
    expect(out).not.toContain('Removing nope');
    expect(out).toContain('Exit code: 0');
  });

  // U2 carry-forward: tool === null here means AMBIGUITY (action: 'refused'), not "not
  // installed" — must render distinctly from the noop case above and must exit non-zero.
  test('U2 ambiguity refusal (tool/scope null, action refused): reason passthrough, exit 2', () => {
    const report: UninstallReport = {
      dryRun: false,
      requested: {
        targets: ['review'],
        tools: ['claude-code', 'codex'],
        explicitTools: false,
        scope: null,
        allScopes: false,
        force: false,
      },
      results: [
        {
          skill: 'review',
          tool: null,
          scope: null,
          placementPath: null,
          action: 'refused',
          reason:
            "'review' is installed in multiple scopes: user (claude-code at ~/.claude/skills/review), project (claude-code at ./.claude/skills/review); disambiguate with --scope, --tool, or --all-scopes",
          before: null,
          storeRetained: null,
          backupKept: null,
        },
      ],
      summary: { removed: 0, noop: 0, refused: 1, failed: 0 },
    };

    const out = renderUninstallHuman(report, 2);
    expect(out).toContain("'review' is installed in multiple scopes");
    expect(out).not.toContain('is not installed');
    expect(out).toContain('1 refused.  Exit code: 2');
  });
});
