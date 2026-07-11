import { describe, expect, test } from 'bun:test';
import type { CheckRunResult, Finding } from '@skillsmith/core';
import { renderDoctorHuman } from '../../src/output/doctor-human.ts';
import { DoctorJsonSchema, renderDoctorJson } from '../../src/output/doctor-json.ts';

const finding: Finding = {
  checkId: 'scope-writable',
  severity: 'info',
  title: 'skill root not writable',
  message: 'codex/system root /etc/codex/skills: permission denied',
  remediation: 'select --scope=system only when intentionally managing this privileged scope',
  tool: 'codex',
  scope: 'system',
  path: '/etc/codex/skills',
  operation: 'access("/etc", W_OK) as uid 501',
  reason: 'checks whether SkillSmith can install or update skills in this scope',
  scopeInUse: false,
};

const result: CheckRunResult = {
  findings: [finding],
  counts: { ok: 1, warning: 0, error: 0 },
};

describe('doctor output', () => {
  test('human output preserves structured scope-writability context', () => {
    const output = renderDoctorHuman(result);

    expect(output).toContain('scope: codex/system');
    expect(output).toContain('path: /etc/codex/skills');
    expect(output).toContain('operation: access("/etc", W_OK) as uid 501');
    expect(output).toContain(
      'reason: checks whether SkillSmith can install or update skills in this scope',
    );
    expect(output).toContain('scope in use: no');
  });

  test('JSON output exposes and validates the same structured context', () => {
    const parsed = DoctorJsonSchema.parse(JSON.parse(renderDoctorJson(result)));

    expect(parsed.findings[0]).toEqual(expect.objectContaining(finding));
  });
});
