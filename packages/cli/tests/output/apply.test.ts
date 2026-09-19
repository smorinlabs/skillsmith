import { describe, expect, test } from 'bun:test';
import { createPlanningDiagnosticId } from '@skillsmith/core';
import type { ApplyReportV1Dto } from '@skillsmith/core/contracts/v1';
import { applyV1Codec } from '@skillsmith/core/contracts/v1';
import { Command } from 'commander';
import { currentWireCodecs } from '../../src/contracts/wire-contracts.ts';
import { renderApplyHuman } from '../../src/output/apply-human.ts';
import { renderApplyJson } from '../../src/output/apply-json.ts';
import type { RuntimeOutcome } from '../../src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../src/runtime/current-renderers.ts';

const zeroKinds = () => ({
  operationKinds: {
    install: 0,
    update: 0,
    remove: 0,
    'link-dev': 0,
    promote: 0,
    'move-scope': 0,
    adapt: 0,
    repair: 0,
    'write-manifest': 0,
    'write-lock': 0,
    'migrate-project-config': 0,
    'migrate-ledger': 0,
  },
  checkKinds: {
    'source-resolution': 0,
    capability: 0,
    'content-integrity': 0,
    verification: 0,
    'precondition-validation': 0,
  },
  diagnosticKinds: { noop: 0, skip: 0, refuse: 0, conflict: 0, warning: 0 },
});

const report = (): ApplyReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.apply-report',
  command: 'apply',
  mode: 'fresh-dry-run',
  state: 'ready',
  artifactPair: {
    manifestPath: '/fixture/skillsmith.toml',
    lockPath: '/fixture/skillsmith.lock',
    lockSource: 'explicit',
    selectionSource: 'explicit',
  },
  savedPlan: null,
  project: { effectiveCwd: '/fixture', root: '/fixture', identity: 'fixture' },
  options: {
    locked: true,
    prune: false,
    check: false,
    dryRun: true,
    continueOnError: false,
  },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'filter-noop',
    requestedTools: [],
    requestedScope: null,
    skills: [],
    tools: [],
    scopes: [],
  },
  operations: [],
  checks: [],
  diagnostics: [],
  approval: { required: false, outcome: 'not-required' },
  validation: { outcome: 'not-run', replanned: false },
  results: [],
  summary: {
    operations: 0,
    checks: 0,
    diagnostics: 0,
    drift: 0,
    refusals: 0,
    ...zeroKinds(),
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    rolledBack: 0,
    skipped: 0,
  },
});

const reportWithFailure = (
  code: 'apply-placement-root-not-directory' | 'reconcile-execution-cleanup-failed',
  message: string,
): ApplyReportV1Dto => {
  const base = report();
  const affected = { skill: null, source: null, tool: null, scope: null, path: null };
  const correlation = { groupId: null, pairId: null, operationId: null };
  const diagnostic = {
    diagnosticId: createPlanningDiagnosticId({
      domain: 'skillsmith.planning-diagnostic-identity',
      schemaVersion: 1,
      kind: 'conflict',
      severity: 'error',
      refusalClass: 'state',
      affected,
      correlation,
      reasonCode: code,
      selectionSource: base.selection.selectionSource,
    }),
    kind: 'conflict' as const,
    severity: 'error' as const,
    refusalClass: 'state' as const,
    affected,
    correlation,
    reason: { code, message },
    selectionSource: base.selection.selectionSource,
  };
  const rootFailure = code === 'apply-placement-root-not-directory';
  return {
    ...base,
    mode: rootFailure ? 'fresh-check' : 'fresh-execute',
    state: rootFailure ? 'refused' : 'completed',
    options: {
      ...base.options,
      check: rootFailure,
      dryRun: false,
    },
    diagnostics: [diagnostic],
    summary: {
      ...base.summary,
      diagnostics: 1,
      diagnosticKinds: { ...base.summary.diagnosticKinds, conflict: 1 },
    },
  };
};

describe('apply renderers', () => {
  test('human output renders the strict report facts without a second presentation model', () => {
    const output = renderApplyHuman(report());
    expect(output).toContain('Apply: fresh-dry-run (ready)');
    expect(output).toContain('Manifest: /fixture/skillsmith.toml');
    expect(output).toContain('Lock: /fixture/skillsmith.lock');
    expect(output).toContain('Project: /fixture [fixture] cwd=/fixture');
    expect(output).toContain("Approval: { outcome: 'not-required', required: false }");
    expect(output).toContain("Validation: { outcome: 'not-run', replanned: false }");
    expect(output).toContain(
      'Summary: 0 operations, 0 succeeded, 0 failed, 0 cancelled, 0 rolled back, 0 skipped, 0 drift, 0 refusals',
    );
    expect(output.endsWith('\n')).toBeTrue();
  });

  test('JSON output is exactly the mapped strict apply-report codec projection', () => {
    expect(currentWireCodecs.apply.descriptor).toEqual(applyV1Codec.descriptor);
    const output = renderApplyJson(report(), currentWireCodecs.apply);
    const encoded = applyV1Codec.encode(report());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(output).toBe(encoded.value);
    expect(JSON.parse(output)).toEqual(report());
  });

  test('human output preserves exact operation IDs and their supplied order', () => {
    const first = { operationId: 'operation:z', kind: 'install' };
    const second = { operationId: 'operation:a', kind: 'write-lock' };
    const withOperations = {
      ...report(),
      operations: [first, second],
    } as unknown as ApplyReportV1Dto;
    const output = renderApplyHuman(withOperations);
    expect(output.indexOf('operation:z')).toBeLessThan(output.indexOf('operation:a'));
  });

  test('the current runtime renderer keeps a non-null strict report authoritative', () => {
    const renderer = createCurrentRendererRegistry(new Command()).apply;
    if (renderer === undefined) throw new Error('missing current apply renderer');
    const value = report();
    const outcome: RuntimeOutcome = {
      report: { result: value },
      diagnostics: [{ code: 'fixture-warning', severity: 'warning', message: 'fixture warning' }],
      exitClass: 'success',
      mutation: { kind: 'preview', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
    const human = renderer.human(outcome);
    expect(human).toEqual({
      stdout: renderApplyHuman(value),
      stderr: 'warning: fixture warning\n',
    });
    expect(renderer.json(outcome)).toBe(renderApplyJson(value, currentWireCodecs.apply));
  });

  test('human and JSON output retain root-observation and post-execution cleanup failures', () => {
    const renderer = createCurrentRendererRegistry(new Command()).apply;
    if (renderer === undefined) throw new Error('missing current apply renderer');
    for (const [code, message] of [
      [
        'apply-placement-root-not-directory',
        'the planned codex/user placement root is not a directory',
      ],
      [
        'reconcile-execution-cleanup-failed',
        'reconciliation execution completed but temporary source cleanup failed',
      ],
    ] as const) {
      const value = reportWithFailure(code, message);
      expect(applyV1Codec.validate(value)).toMatchObject({ ok: true });
      const outcome: RuntimeOutcome = {
        report: { result: value },
        diagnostics: [{ code, severity: 'error', message }],
        exitClass: 'failure',
        mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
        deprecations: [],
      };

      const human = renderer.human(outcome);
      if (typeof human === 'string') throw new Error('apply human renderer lost structured output');
      expect(human.stdout).toContain(code);
      expect(human.stdout).toContain(message);
      expect(human.stderr ?? '').toBe('');
      const renderedJson = renderer.json(outcome);
      if (typeof renderedJson !== 'string') throw new Error('apply JSON renderer returned streams');
      const json = JSON.parse(renderedJson);
      expect(json.diagnostics).toEqual([
        expect.objectContaining({ reason: { code, message }, severity: 'error' }),
      ]);
    }
  });
});
