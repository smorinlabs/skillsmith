import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstallReport, UninstallReport } from '@skillsmith/core';
import {
  InstallJsonSchema,
  UninstallJsonSchema,
  renderInstallJson,
  renderUninstallJson,
} from '../../src/output/install-json.ts';

const INSTALL_GOLDEN = join(import.meta.dir, '..', 'fixtures', 'install-report.golden.json');
const UNINSTALL_GOLDEN = join(import.meta.dir, '..', 'fixtures', 'uninstall-report.golden.json');
const installGoldenText = readFileSync(INSTALL_GOLDEN, 'utf8');
const uninstallGoldenText = readFileSync(UNINSTALL_GOLDEN, 'utf8');

const SHA = `8c1d2e3f4a5b${'0'.repeat(28)}`;
const STORE_PATH =
  '/Users/alice/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@8c1d2e3f4a5b/factor-scan';

// Matches the task-9 brief's install JSON contract example, filled with concrete values, minus
// `kind`/`schemaVersion` (renderInstallJson adds those) and minus `error` (core-only).
const installReport: InstallReport = {
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
  summary: { installed: 2, updated: 0, repaired: 0, noop: 0, skipped: 0, refused: 0, failed: 0 },
};

const uninstallReport: UninstallReport = {
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
      before: { mode: 'pinned', placement: 'symlink', storePath: STORE_PATH, symlinkTarget: null },
      storeRetained: STORE_PATH,
      backupKept: null,
    },
  ],
  summary: { removed: 1, noop: 0, refused: 0, failed: 0 },
};

describe('renderInstallJson', () => {
  test('matches the committed golden (parse-compare, formatting-proof)', () => {
    const rendered = renderInstallJson(installReport);
    expect(JSON.parse(rendered)).toEqual(JSON.parse(installGoldenText));
  });

  test('validates against InstallJsonSchema', () => {
    const rendered = renderInstallJson(installReport);
    expect(() => InstallJsonSchema.parse(JSON.parse(rendered))).not.toThrow();
  });

  test('top-level field set is exact; kind and schemaVersion are correct', () => {
    const rendered = JSON.parse(renderInstallJson(installReport)) as Record<string, unknown>;
    expect(Object.keys(rendered).sort()).toEqual(
      ['schemaVersion', 'kind', 'dryRun', 'requested', 'results', 'summary'].sort(),
    );
    expect(rendered.kind).toBe('skillsmith.install');
    expect(rendered.schemaVersion).toBe(1);
  });

  test('the core-only `error` field never appears in the rendered output', () => {
    const withError: InstallReport = {
      ...installReport,
      results: [
        {
          ...installReport.results[0],
          error: { code: 'flip-refused', message: 'nope' },
        } as InstallReport['results'][number],
      ],
    };
    const rendered = JSON.parse(renderInstallJson(withError)) as {
      results: Record<string, unknown>[];
    };
    for (const r of rendered.results) expect('error' in r).toBe(false);
  });

  test('the core-only numeric request identity never appears in the v1 wire output', () => {
    const withRequestIndex: InstallReport = {
      ...installReport,
      results: installReport.results.map((result, requestIndex) => ({
        ...result,
        requestIndex,
      })),
    };
    const rendered = JSON.parse(renderInstallJson(withRequestIndex)) as {
      results: Record<string, unknown>[];
    };
    for (const result of rendered.results) expect('requestIndex' in result).toBeFalse();
  });

  test('schema rejects an install action foreign to the install action enum (`flipped`)', () => {
    const bad = {
      ...installReport,
      results: [{ ...installReport.results[0], action: 'flipped' }],
    } as unknown as InstallReport;
    expect(() => renderInstallJson(bad)).toThrow();
  });

  test('schema rejects a wrong `kind`', () => {
    const rendered = JSON.parse(renderInstallJson(installReport));
    rendered.kind = 'skillsmith.uninstall';
    expect(() => InstallJsonSchema.parse(rendered)).toThrow();
    expect(() => UninstallJsonSchema.parse(rendered)).toThrow();
  });

  test('a source-level failure (skill/tool null) round-trips with a candidates list', () => {
    const ambiguous: InstallReport = {
      ...installReport,
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
    const rendered = JSON.parse(renderInstallJson(ambiguous));
    expect(rendered.results[0].skill).toBeNull();
    expect(rendered.results[0].tool).toBeNull();
    expect(rendered.results[0].candidates).toHaveLength(2);
  });
});

describe('renderUninstallJson', () => {
  test('matches the committed golden (parse-compare, formatting-proof)', () => {
    const rendered = renderUninstallJson(uninstallReport);
    expect(JSON.parse(rendered)).toEqual(JSON.parse(uninstallGoldenText));
  });

  test('validates against UninstallJsonSchema', () => {
    const rendered = renderUninstallJson(uninstallReport);
    expect(() => UninstallJsonSchema.parse(JSON.parse(rendered))).not.toThrow();
  });

  test('top-level field set is exact; kind and schemaVersion are correct', () => {
    const rendered = JSON.parse(renderUninstallJson(uninstallReport)) as Record<string, unknown>;
    expect(Object.keys(rendered).sort()).toEqual(
      ['schemaVersion', 'kind', 'dryRun', 'requested', 'results', 'summary'].sort(),
    );
    expect(rendered.kind).toBe('skillsmith.uninstall');
    expect(rendered.schemaVersion).toBe(1);
  });

  test('the core-only `error` field never appears in the rendered output', () => {
    const withError: UninstallReport = {
      ...uninstallReport,
      results: [
        {
          ...uninstallReport.results[0],
          error: { code: 'flip-refused', message: 'nope' },
        } as UninstallReport['results'][number],
      ],
    };
    const rendered = JSON.parse(renderUninstallJson(withError)) as {
      results: Record<string, unknown>[];
    };
    for (const r of rendered.results) expect('error' in r).toBe(false);
  });

  test('schema rejects an uninstall action foreign to the uninstall action enum (`installed`)', () => {
    const bad = {
      ...uninstallReport,
      results: [{ ...uninstallReport.results[0], action: 'installed' }],
    } as unknown as UninstallReport;
    expect(() => renderUninstallJson(bad)).toThrow();
  });

  test('schema rejects a wrong `kind`', () => {
    const rendered = JSON.parse(renderUninstallJson(uninstallReport));
    rendered.kind = 'skillsmith.install';
    expect(() => UninstallJsonSchema.parse(rendered)).toThrow();
    expect(() => InstallJsonSchema.parse(rendered)).toThrow();
  });

  // U2 ambiguity carry-forward: `tool: null` alone must not collapse into a "not installed"
  // reading — that is only true when `action === 'noop'`. Here it is a `refused` ambiguity.
  test('a U2 ambiguity refusal (tool/scope null, action refused) round-trips distinctly from a noop', () => {
    const ambiguous: UninstallReport = {
      ...uninstallReport,
      results: [
        {
          skill: 'review',
          tool: null,
          scope: null,
          placementPath: null,
          action: 'refused',
          reason:
            "'review' is installed in multiple scopes: user, project; disambiguate with --scope, --tool, or --all-scopes",
          before: null,
          storeRetained: null,
          backupKept: null,
        },
      ],
      summary: { removed: 0, noop: 0, refused: 1, failed: 0 },
    };
    const rendered = JSON.parse(renderUninstallJson(ambiguous));
    expect(rendered.results[0].action).toBe('refused');
    expect(rendered.results[0].tool).toBeNull();
    expect(rendered.results[0].scope).toBeNull();
  });

  test('an absent target (action noop, tool/scope null) is distinct from the ambiguity refusal', () => {
    const notInstalled: UninstallReport = {
      ...uninstallReport,
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
    const rendered = JSON.parse(renderUninstallJson(notInstalled));
    expect(rendered.results[0].action).toBe('noop');
    expect(rendered.results[0].tool).toBeNull();
  });
});
