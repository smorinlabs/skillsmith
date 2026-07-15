import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface StatusGolden {
  readonly selection: {
    readonly source: string;
    readonly toolSource: string;
    readonly scopeSource: string;
    readonly outcome: string;
  };
  readonly context: {
    readonly effectiveCwd: string;
    readonly projectRoot: string | null;
    readonly projectSource: string | null;
  };
  readonly entries: readonly {
    readonly name: string;
    readonly convergence: 'converged' | 'drift';
    readonly placements: readonly unknown[];
  }[];
  readonly summary: {
    readonly entries: number;
    readonly converged: number;
    readonly drifting: number;
    readonly migrationPending: boolean;
  };
}

const ROOT = resolve(import.meta.dir, '../../../..');
const HUMAN_PATH = resolve(ROOT, 'tests/ergonomics/fixtures/p3a-ts04/status-human.golden.txt');
const JSON_PATH = resolve(ROOT, 'tests/ergonomics/fixtures/p3a-ts04/status-v1.golden.json');
const human = readFileSync(HUMAN_PATH, 'utf8');
const status = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as StatusGolden;

const entryHeadings = (): readonly string[] =>
  [...human.matchAll(/^([^\s].*?) — (?:converged|drift)$/gmu)].map((match) => match[1] ?? '');

describe('status human rendering contract', () => {
  test('has byte-stable headers, one terminal LF, and no terminal-control bytes', () => {
    expect(human.endsWith('\n')).toBeTrue();
    expect(human.endsWith('\n\n')).toBeFalse();
    expect(human).not.toContain('\r');
    expect(human).not.toContain(String.fromCharCode(27));
    expect(human.split('\n').slice(0, 5)).toEqual([
      'Status — targets: bounded-default; tools: unbounded-default; scopes: unbounded-default; outcome: selected',
      'Context — cwd: /repo; project: /repo (shared-project)',
      'Artifacts — project-default; manifest: current v1; lock: current v1; relationship: current',
      'Ledger — current v2; migration pending: no',
      '',
    ]);
  });

  test('projects the same selection and context values as status@1', () => {
    expect(human).toContain(
      `Status — targets: ${status.selection.source}; tools: ${status.selection.toolSource}; scopes: ${status.selection.scopeSource}; outcome: ${status.selection.outcome}`,
    );
    expect(human).toContain(
      `Context — cwd: ${status.context.effectiveCwd}; project: ${status.context.projectRoot} (${status.context.projectSource})`,
    );
  });

  test('renders every skill exactly once in canonical entry order', () => {
    expect(entryHeadings()).toEqual(status.entries.map((entry) => entry.name));
    expect(new Set(entryHeadings()).size).toBe(status.entries.length);
    expect(status.entries.reduce((count, entry) => count + entry.placements.length, 0)).toBe(15);
  });

  test('keeps fixed fact scalars and composite tuples literal', () => {
    expect(human).toContain(
      'placement-drift (drift): expected ["copy","pinned","/repo/.kilo/skills/placement-drift"]; actual ["symlink","dev","/repo/.kilo/skills/placement-drift"]',
    );
    expect(human).toContain(
      'source-drift (drift): expected ["github.com","skillsmith/status-fixtures","source-drift"]; actual ["git.example.test","other/repository","source-drift"]',
    );
    expect(human).toContain('broken-live (drift): expected valid; actual ledger-recorded-absence');
  });

  test('renders journal retention and shell-quotes the exact remediation argv', () => {
    expect(human).toContain(
      'journal logical/update tx-shadowed-fleet — pending backed-up; before: pinned; abort: eligible',
    );
    expect(human).toContain(
      'retained-live backup/live /data/skillsmith/backups/shadowed-fleet — satisfied; retain until: 2026-08-01T00:00:00.000Z',
    );
    expect(human).toContain('resume: rerun the same operation');
    expect(human).toContain(
      "abort: 'skillsmith' 'undo' '/repo/.agents/skills/shadowed-fleet' '--tool' 'codex' '--scope' 'project'",
    );
  });

  test('closes with the exact entry summary rather than placement counts', () => {
    expect(status.summary).toEqual({
      entries: 14,
      converged: 2,
      drifting: 12,
      migrationPending: false,
    });
    expect(human).toEndWith(
      'Summary — 14 skills: 2 converged, 12 drifting; migration pending: no\n',
    );
  });
});
