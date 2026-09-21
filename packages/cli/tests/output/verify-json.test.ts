import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyReport } from '@skillsmith/core';
import { VerifyJsonSchema, renderVerifyJson } from '../../src/output/verify-json.ts';

const GOLDEN_PATH = join(import.meta.dir, '..', 'fixtures', 'verify-report.golden.json');
const goldenText = readFileSync(GOLDEN_PATH, 'utf8');

// Matches docs/superpowers/specs/2026-07-06-verify-design.md §8 verbatim, minus `kind`
// (renderVerifyJson adds `kind`).
const report: VerifyReport = {
  schemaVersion: 1,
  target: { path: '/abs/plugins/dummytest', kind: 'plugin' },
  requested: {
    tools: ['claude-code', 'codex'],
    modes: ['static', 'deep'],
    strict: false,
    explicitTools: false,
  },
  verifiedAgainst: { 'claude-code': '2.1.202', codex: '0.142.5', muse: '1.3.0' },
  summary: {
    verdict: 'fail',
    verified: [],
    failed: ['claude-code', 'codex'],
    skipped: [],
    counts: { error: 3, warning: 2, info: 1 },
  },
  tools: [
    {
      tool: 'claude-code',
      available: true,
      toolVersion: '2.1.202',
      versionDrift: false,
      skipReason: null,
      verdict: 'fail',
      modes: [
        {
          mode: 'static',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict: 'fail',
          command: 'claude plugin validate <path>',
          findings: [
            {
              checkId: 'claude.frontmatter',
              toolSeverity: 'error',
              normalizedSeverity: 'error',
              message: 'YAML frontmatter failed to parse: YAML Parse error: Unexpected character.',
              file: 'skills/bad-yaml/SKILL.md',
              subject: 'skill',
            },
            {
              checkId: 'claude.description',
              toolSeverity: 'warning',
              normalizedSeverity: 'warning',
              message: 'No description in frontmatter.',
              file: 'skills/bad-nodesc/SKILL.md',
              subject: 'skill',
            },
          ],
        },
        {
          mode: 'deep',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: false, skills: true },
          verdict: 'warn',
          command:
            'CLAUDE_CONFIG_DIR=<tmp> claude --print --verbose --output-format stream-json --setting-sources "" --plugin-dir <path> "ok"',
          findings: [
            {
              checkId: 'claude.load-presence',
              toolSeverity: null,
              normalizedSeverity: 'warning',
              message:
                "skill 'bad-yaml' did not load (reason unavailable at runtime — see static validate)",
              file: 'skills/bad-yaml/SKILL.md',
              subject: 'skill',
            },
          ],
        },
      ],
    },
    {
      tool: 'codex',
      available: true,
      toolVersion: '0.142.5',
      versionDrift: false,
      skipReason: null,
      verdict: 'fail',
      modes: [
        {
          mode: 'static',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: false },
          verdict: 'pass',
          command: 'codex plugin marketplace add <root> && codex plugin add <name>@<mkt>',
          findings: [
            {
              checkId: 'codex.static-coverage',
              toolSeverity: null,
              normalizedSeverity: 'info',
              message: 'codex static checked the manifest only; run --deep for skill validation',
              file: null,
              subject: 'plugin',
            },
          ],
        },
        {
          mode: 'deep',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: false, skills: true },
          verdict: 'fail',
          command:
            'codex exec -C <proj> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "ok"',
          findings: [
            {
              checkId: 'codex.skill-load',
              toolSeverity: 'error',
              normalizedSeverity: 'error',
              message: 'invalid YAML: found unexpected end of stream at line 3 column 23',
              file: '.agents/skills/bad-yaml/SKILL.md',
              subject: 'skill',
            },
            {
              checkId: 'codex.skill-load',
              toolSeverity: 'error',
              normalizedSeverity: 'error',
              message: 'missing field `description`',
              file: '.agents/skills/bad-nodesc/SKILL.md',
              subject: 'skill',
            },
          ],
        },
      ],
    },
  ],
};

describe('renderVerifyJson', () => {
  test('matches the committed golden (parse-compare, formatting-proof)', () => {
    const rendered = renderVerifyJson(report);
    expect(JSON.parse(rendered)).toEqual(JSON.parse(goldenText));
  });

  test('validates against VerifyJsonSchema', () => {
    const rendered = renderVerifyJson(report);
    expect(() => VerifyJsonSchema.parse(JSON.parse(rendered))).not.toThrow();
  });

  test('top-level field set is exact; kind and schemaVersion are correct', () => {
    const rendered = JSON.parse(renderVerifyJson(report)) as Record<string, unknown>;
    expect(Object.keys(rendered).sort()).toEqual(
      [
        'kind',
        'requested',
        'schemaVersion',
        'summary',
        'target',
        'tools',
        'verifiedAgainst',
      ].sort(),
    );
    expect(rendered.kind).toBe('skillsmith.verify');
    expect(rendered.schemaVersion).toBe(1);
  });

  test('a report with skipReason "auth-required" smuggled in fails schema validation', () => {
    const bad = {
      ...report,
      tools: [{ ...report.tools[0], skipReason: 'auth-required' }, report.tools[1]],
    } as unknown as VerifyReport;
    expect(() => renderVerifyJson(bad)).toThrow();
  });

  test('a not-installed tool renders correctly and validates', () => {
    const notInstalled: VerifyReport = {
      ...report,
      requested: { tools: ['codex'], modes: ['static'], strict: false, explicitTools: true },
      summary: {
        verdict: 'inconclusive',
        verified: [],
        failed: [],
        skipped: ['codex'],
        counts: { error: 0, warning: 0, info: 0 },
      },
      tools: [
        {
          tool: 'codex',
          available: false,
          toolVersion: null,
          versionDrift: false,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        },
      ],
    };
    const rendered = JSON.parse(renderVerifyJson(notInstalled));
    expect(rendered.tools[0]).toEqual({
      tool: 'codex',
      available: false,
      toolVersion: null,
      versionDrift: false,
      skipReason: 'not-installed',
      verdict: 'inconclusive',
      modes: [],
    });
    expect(() => VerifyJsonSchema.parse(rendered)).not.toThrow();
  });
});
