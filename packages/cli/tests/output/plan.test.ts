import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import {
  type PlanOperationV1Dto,
  type PlanV1Dto,
  planV1Codec,
} from '@skillsmith/core/contracts/v1';
import { renderPlanHuman, renderPlanOperationHuman } from '../../src/output/plan-human.ts';
import { renderPlanJson } from '../../src/output/plan-json.ts';

type PlanDigestV1 = Extract<
  NonNullable<PlanOperationV1Dto['source']>,
  { kind: 'portable' }
>['contentHash'];

const report = (): PlanV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.plan-report',
  command: 'plan',
  state: 'refused',
  artifactPair: {
    manifestPath: '/fixture/skillsmith.toml',
    lockPath: '/fixture/skillsmith.lock',
    lockSource: 'sibling',
    selectionSource: 'explicit',
  },
  project: { effectiveCwd: '/fixture', root: '/fixture', identity: 'fixture' },
  options: { locked: true, prune: false, check: false },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'selected',
    requestedTools: ['codex'],
    requestedScope: 'user',
    skills: ['alpha'],
    tools: ['codex'],
    scopes: ['user'],
  },
  operations: [
    {
      operationId: 'operation:v1:fixture-alpha',
      groupId: 'group:v1:fixture-alpha',
      pairId: 'pair:v1:fixture-alpha',
      kind: 'install',
      dependsOn: [],
      skill: 'alpha',
      source: {
        kind: 'portable',
        identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'alpha' },
        requestedRef: null,
        resolvedSha: 'a'.repeat(40),
        sourcePath: 'alpha',
        contentHash: `sha256:${'b'.repeat(64)}` as PlanDigestV1,
      },
      tool: 'codex',
      scope: 'user',
      selectionSource: 'bounded-default',
      before: {
        kind: 'absent',
        resource: {
          kind: 'live',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectRoot: null,
          location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
        },
      },
      after: {
        kind: 'placement',
        resource: {
          kind: 'live',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectRoot: null,
          location: { kind: 'machine-bound', path: '/fixture/live/alpha' },
        },
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source: null,
        contentHash: `sha256:${'b'.repeat(64)}` as PlanDigestV1,
      },
      reason: { code: 'desired-placement-absent', message: 'Placement is absent.' },
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: { kind: 'none', retentionResourceIds: [] },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      conflict: null,
    },
  ],
  checks: [],
  diagnostics: [
    {
      diagnosticId: 'diagnostic:v1:fixture-alpha',
      kind: 'refuse',
      severity: 'error',
      refusalClass: 'state',
      affected: {
        skill: 'alpha',
        source: {
          kind: 'portable',
          identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'alpha' },
          requestedRef: null,
          resolvedSha: 'a'.repeat(40),
          sourcePath: 'alpha',
          contentHash: `sha256:${'b'.repeat(64)}` as PlanDigestV1,
        },
        tool: 'codex',
        scope: 'user',
        path: { kind: 'machine-bound', path: '/fixture/live/alpha' },
      },
      correlation: {
        groupId: 'group:v1:fixture-alpha',
        pairId: 'pair:v1:fixture-alpha',
        operationId: 'operation:v1:fixture-alpha',
      },
      reason: {
        code: 'modified-managed-target',
        message: 'Managed placement has local modifications.',
      },
      selectionSource: 'bounded-default',
    },
  ],
  summary: {
    operations: 1,
    checks: 0,
    diagnostics: 1,
    drift: 1,
    refusals: 1,
    operationKinds: {
      install: 1,
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
    diagnosticKinds: { noop: 0, skip: 0, refuse: 1, conflict: 0, warning: 0 },
  },
  savedOutput: {
    path: '/fixture/review.skillsmith.plan',
    disposition: 'created',
    mode: '0600',
    portability: 'machine-bound',
  },
});

describe('plan renderers', () => {
  test('human output preserves the complete semantic review facts', () => {
    const value = report();
    const output = renderPlanHuman(value);
    const fact = (input: unknown): string =>
      inspect(input, {
        breakLength: Number.POSITIVE_INFINITY,
        compact: true,
        depth: null,
        sorted: true,
      });
    const exactRows = output
      .split('\n')
      .filter((line) => line.startsWith('  exact: '))
      .map((line) => line.slice('  exact: '.length));
    const summaryKinds = output
      .split('\n')
      .find((line) => line.startsWith('Summary kinds: '))
      ?.slice('Summary kinds: '.length);
    const savedReceipt = output
      .split('\n')
      .find((line) => line.startsWith('Saved receipt: '))
      ?.slice('Saved receipt: '.length);

    expect(output).toContain('Plan: /fixture/skillsmith.toml');
    expect(output).toContain('Project: /fixture [fixture] cwd=/fixture');
    expect(output).toContain('Selection: codex / user');
    expect(output).toContain('Selected skills: alpha');
    expect(output).toContain(
      'operation:v1:fixture-alpha install alpha / codex / user absent -> placement',
    );
    expect(exactRows).toEqual([
      fact({
        groupId: value.operations[0]?.groupId,
        pairId: value.operations[0]?.pairId,
        dependsOn: value.operations[0]?.dependsOn,
        source: value.operations[0]?.source,
        selectionSource: value.operations[0]?.selectionSource,
        before: value.operations[0]?.before,
        after: value.operations[0]?.after,
        preconditionIds: value.operations[0]?.preconditionIds,
        requiredCheckIds: value.operations[0]?.requiredCheckIds,
        reversibility: value.operations[0]?.reversibility,
        mutates: value.operations[0]?.mutates,
        conflict: value.operations[0]?.conflict,
        reason: value.operations[0]?.reason,
      }),
      fact({
        severity: value.diagnostics[0]?.severity,
        refusalClass: value.diagnostics[0]?.refusalClass,
        affected: value.diagnostics[0]?.affected,
        correlation: value.diagnostics[0]?.correlation,
        reason: value.diagnostics[0]?.reason,
        selectionSource: value.diagnostics[0]?.selectionSource,
      }),
    ]);
    expect(output).toContain('Summary: 1 operations, 0 checks, 1 diagnostics, 1 drift, 1 refusals');
    expect(output).toContain('Conclusion: refused with drift (1 refusals)');
    expect(summaryKinds).toBe(
      fact({
        operationKinds: value.summary.operationKinds,
        checkKinds: value.summary.checkKinds,
        diagnosticKinds: value.summary.diagnosticKinds,
      }),
    );
    expect(savedReceipt).toBe(fact(value.savedOutput));
    expect(output).toContain('Saved: /fixture/review.skillsmith.plan (created, 0600)');
    expect(output.endsWith('\n')).toBeTrue();
  });

  test('JSON output is exactly the strict plan-report codec projection', () => {
    const output = renderPlanJson(report(), planV1Codec);
    const encoded = planV1Codec.encode(report());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(output).toBe(encoded.value);
    expect(JSON.parse(output)).toEqual(report());
  });

  test('the generic operation renderer accepts an injected adaptation row without tool policy', () => {
    expect(renderPlanOperationHuman({ kind: 'adapt' })).toBe('synthetic adapt');
  });
});
