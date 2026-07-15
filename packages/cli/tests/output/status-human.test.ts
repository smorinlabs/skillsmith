import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { statusV1Codec } from '../../../core/src/contracts/v1/status.ts';
import { renderStatusHuman } from '../../src/output/status-human.ts';

type MutableRecord = Record<string, unknown>;

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
    expect(human).toContain(
      'repository revision: satisfied; expected resource:sha256:retained-revision; observed resource:sha256:retained-revision',
    );
    expect(human).toContain(
      'content hash: satisfied; domain source-content; expected sha256:retained-content; observed sha256:retained-content',
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

  test('encodes every untrusted scalar and shell-quotes adversarial argv without terminal control', () => {
    const candidate = structuredClone(status) as unknown as MutableRecord;
    const context = candidate.context as MutableRecord;
    context.effectiveCwd = '/repo/line\nansi\u001b[31m-c1\u0085-separators\u2028\u2029';
    const entries = candidate.entries as MutableRecord[];
    const entry = entries.find((value) => value.name === 'shadowed-fleet');
    if (entry === undefined) throw new Error('missing adversarial status fixture entry');
    entry.name = 'shadowed\n\u001b[2J-fleet';
    const desired = (entry.desired as MutableRecord).value as MutableRecord;
    const source = desired.source as MutableRecord;
    source.host = 'git\u0000.example';
    source.repository = 'owner\u0009repository';
    source.path = 'skill\u007fpath';
    desired.ref = 'main\u009fref';
    const locked = (entry.locked as MutableRecord).value as MutableRecord;
    locked.resolvedSha = 'revision\u2028unsafe';

    const placements = entry.placements as MutableRecord[];
    const shadowed = placements[0] as MutableRecord;
    const shadow = shadowed.shadow as MutableRecord;
    shadow.winner = '/winner\n\u001b[H';
    const shadowFact = (shadowed.facts as MutableRecord[])[0] as MutableRecord;
    shadowFact.expected = 'expected\rvalue';
    shadowFact.actual = 'actual\u2029value';

    const placement = placements[1] as MutableRecord;
    const identity = placement.identity as MutableRecord;
    const adversarialPath = "/repo/skill' ;$(printf owned)\n\u001b[31m";
    identity.tool = 'codex\u0080';
    identity.path = adversarialPath;
    const journal = placement.journal as MutableRecord;
    journal.transactionId = 'tx\n\u001b]8;;https://invalid.test\u0007';
    const retention = (journal.retention as MutableRecord[])[0] as MutableRecord;
    retention.resourceId = 'retained\u000bresource';
    retention.path = '/retained\u000cpath';
    retention.retainUntil = 'later\u2029';
    const revision = retention.repositoryRevision as MutableRecord;
    const revisionExpected = revision.expected as MutableRecord;
    const revisionObserved = revision.observed as MutableRecord;
    revisionExpected.digest = 'sha256:revision\u001f';
    revisionObserved.digest = revisionExpected.digest;
    const content = retention.contentHash as MutableRecord;
    content.expected = 'sha256:content\u009f';
    content.observed = content.expected;
    const abort = (journal.remediation as MutableRecord).abort as string[];
    abort[2] = adversarialPath;
    abort[4] = identity.tool as string;

    const parsed = statusV1Codec.validate(candidate);
    if (!parsed.ok) throw new Error(`invalid adversarial fixture: ${JSON.stringify(parsed.error)}`);
    const rendered = renderStatusHuman(parsed.value);
    expect(rendered.split('\n')).toHaveLength(human.split('\n').length);
    const unsafeCharacters = [...rendered].filter((character) => {
      const codePoint = character.codePointAt(0) ?? -1;
      return (
        codePoint !== 0x0a &&
        (codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          codePoint === 0x2028 ||
          codePoint === 0x2029)
      );
    });
    expect(unsafeCharacters).toEqual([]);
    for (const escaped of [
      '\\u0000',
      '\\u0009',
      '\\u000a',
      '\\u000b',
      '\\u000c',
      '\\u000d',
      '\\u001b',
      '\\u001f',
      '\\u007f',
      '\\u0080',
      '\\u0085',
      '\\u009f',
      '\\u2028',
      '\\u2029',
    ]) {
      expect(rendered).toContain(escaped);
    }
    expect(rendered).toContain("'/repo/skill'\\'' ;$(printf owned)\\u000a\\u001b[31m'");
  });
});
