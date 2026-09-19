import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FlipReport,
  type OperationIdentity,
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
  createPlanCheckId,
} from '@skillsmith/core';
import { flipV3Codec, toFlipV3Dto } from '@skillsmith/core/contracts/v3';
import { renderFlipJson } from '../../src/output/flip-json.ts';
import { wireSchema } from '../../src/output/wire-codec.ts';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const liveResource = {
  kind: 'live' as const,
  skill: 'factor-scan',
  tool: 'claude-code' as const,
  scope: 'user' as const,
  projectRoot: null,
  location: {
    kind: 'machine-bound' as const,
    path: '/Users/alice/.claude/skills/factor-scan',
  },
};
const source = {
  kind: 'local-dev' as const,
  path: '/Users/alice/c/agent-tools/skills/factor-scan',
  contentHash: HASH,
};
const GROUP_ID = createOperationGroupId({
  domain: 'skillsmith.operation-group-identity',
  schemaVersion: 1,
  command: 'promote',
  skill: 'factor-scan',
  source,
  scope: 'user',
  target: null,
});
const PAIR_ID = createOperationPairId({
  domain: 'skillsmith.operation-pair-identity',
  schemaVersion: 1,
  groupId: GROUP_ID,
  tool: 'claude-code',
  resource: liveResource,
});
const before = {
  kind: 'placement' as const,
  resource: liveResource,
  classification: 'dev' as const,
  representation: 'symlink' as const,
  linkTarget: {
    kind: 'machine-bound' as const,
    path: '/Users/alice/c/agent-tools/skills/factor-scan',
  },
  dangling: false,
  source,
  contentHash: HASH,
};
const after = {
  kind: 'placement' as const,
  resource: liveResource,
  classification: 'pinned' as const,
  representation: 'copy' as const,
  linkTarget: null,
  dangling: false,
  source,
  contentHash: HASH,
};
const identity: OperationIdentity = {
  domain: 'skillsmith.operation-identity',
  schemaVersion: 1,
  groupId: GROUP_ID,
  pairId: PAIR_ID,
  kind: 'promote',
  skill: 'factor-scan',
  source,
  tool: 'claude-code',
  scope: 'user',
};
const operationId = createOperationId(identity);
const checkId = createPlanCheckId({
  domain: 'skillsmith.plan-check-identity',
  schemaVersion: 1,
  kind: 'verification',
  operationIds: [operationId],
  tool: 'claude-code',
  mode: 'static',
  expectedContentHash: HASH,
});
const plan = createOperationPlan({
  domain: 'skillsmith.operation-plan',
  schemaVersion: 1,
  command: 'promote',
  selection: {
    source: 'explicit-targets',
    outcome: 'selected',
    targets: ['factor-scan'],
    all: false,
    skills: ['factor-scan'],
    tools: ['claude-code'],
    scopes: ['user'],
    groupIds: [GROUP_ID],
  },
  batchPolicy: 'fail-fast',
  operations: [
    {
      operationId,
      groupId: GROUP_ID,
      pairId: PAIR_ID,
      kind: 'promote',
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
      skill: 'factor-scan',
      source,
      tool: 'claude-code',
      scope: 'user',
      before,
      after,
      reason: { code: 'promote', message: 'promote factor-scan' },
      selectionSource: 'explicit-targets',
      preconditionIds: [],
      requiredCheckIds: [checkId],
      reversibility: {
        kind: 'conditional',
        retentionResourceIds: [`retention:v1:${operationId}`],
      },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      conflict: null,
    },
  ],
  checks: [
    {
      checkId,
      blocking: true,
      operationIds: [operationId],
      kind: 'verification',
      tool: 'claude-code',
      mode: 'static',
      expectedContentHash: HASH,
    },
  ],
  diagnostics: [],
});
const executionResult = createOperationExecutionResult({
  operationId,
  outcome: 'succeeded',
  actualBefore: before,
  actualAfter: after,
  force: null,
  error: null,
});
const report = {
  op: 'promote',
  dryRun: false,
  requested: {
    targets: ['factor-scan'],
    all: false,
    tools: ['claude-code'],
    explicitTools: true,
  },
  plan,
  executionResults: [executionResult],
  results: [
    {
      skill: 'factor-scan',
      tool: 'claude-code',
      placementPath: '/Users/alice/.claude/skills/factor-scan',
      action: 'flipped',
      reason: null,
      before: { mode: 'dev', symlinkTarget: source.path },
      after: { mode: 'pinned', storePath: '/Users/alice/.skillsmith/store/factor-scan' },
      store: null,
      verify: { gate: 'passed', verdict: 'pass' },
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
    created: 0,
    adopted: 0,
  },
} as const satisfies FlipReport;

const GOLDEN_PATH = join(import.meta.dir, '..', 'fixtures', 'flip-report-v3.golden.json');
const FlipV3JsonSchema = wireSchema(flipV3Codec);
const renderFlipV3Json = (value: FlipReport): string => renderFlipJson(value, flipV3Codec);

describe('flip report contract v3', () => {
  test('keeps the historical golden bytes frozen', () => {
    const bytes = readFileSync(GOLDEN_PATH);
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(
      '38a5d72a99e370ee4ea35925db5383c327fd3d5757c073212570e626f83f10f3',
    );
  });

  test('refuses the G3B-02 scheduling-only skipped outcome instead of widening flip@3', () => {
    const skippedReport = {
      ...report,
      executionResults: [
        {
          ...executionResult,
          outcome: 'skipped-after-failure',
          actualAfter: before,
          error: null,
        },
      ],
    } as unknown as FlipReport;
    expect(() => toFlipV3Dto(skippedReport)).toThrow(/flip@3|skipped-after-failure/i);
  });

  test('matches the committed strict plan/result golden', () => {
    expect(JSON.parse(renderFlipV3Json(report))).toEqual(
      JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')),
    );
  });

  test('exposes exact root, selection, and execution-result fields without legacy rows', () => {
    const rendered = JSON.parse(renderFlipV3Json(report)) as Record<string, unknown>;
    expect(Object.keys(rendered).sort()).toEqual(
      [
        'schemaVersion',
        'kind',
        'op',
        'dryRun',
        'summary',
        'selection',
        'operations',
        'checks',
        'diagnostics',
        'results',
      ].sort(),
    );
    expect(Object.keys(rendered.selection as Record<string, unknown>).sort()).toEqual(
      ['source', 'outcome', 'targets', 'all', 'tools', 'scopes', 'groupIds', 'batchPolicy'].sort(),
    );
    const result = (rendered.results as Record<string, unknown>[])[0];
    expect(Object.keys(result ?? {}).sort()).toEqual(
      ['operationId', 'outcome', 'actualBefore', 'actualAfter', 'force', 'error'].sort(),
    );
    expect(result).toEqual(executionResult as unknown as Record<string, unknown>);
    for (const legacy of ['requested', 'plan', 'executionResults']) {
      expect(rendered).not.toHaveProperty(legacy);
    }
    for (const legacy of ['skill', 'tool', 'action', 'placementPath', 'store', 'verify']) {
      expect(result).not.toHaveProperty(legacy);
    }
  });

  test('rejects unknown recursive fields and uncorrelated or partial execution results', () => {
    const rendered = JSON.parse(renderFlipV3Json(report)) as Record<string, unknown>;
    expect(FlipV3JsonSchema.safeParse({ ...rendered, legacy: true }).success).toBeFalse();
    expect(
      FlipV3JsonSchema.safeParse({
        ...rendered,
        selection: { ...(rendered.selection as Record<string, unknown>), skills: ['factor-scan'] },
      }).success,
    ).toBeFalse();
    expect(
      FlipV3JsonSchema.safeParse({
        ...rendered,
        results: [
          {
            ...((rendered.results as Record<string, unknown>[])[0] ?? {}),
            operationId: 'operation:v1:uncorrelated',
          },
        ],
      }).success,
    ).toBeFalse();
    expect(FlipV3JsonSchema.safeParse({ ...rendered, results: [] }).success).toBeFalse();
  });
});
