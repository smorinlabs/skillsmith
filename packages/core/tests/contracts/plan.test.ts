import { describe, expect, test } from 'bun:test';
import type { PlanDigestV1 } from '../../src/artifacts/plan-types.ts';
import { type PlanV1Dto, planV1Codec } from '../../src/contracts/v1/plan.ts';

const report = (): PlanV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.plan-report',
  command: 'plan',
  state: 'ready',
  artifactPair: {
    manifestPath: '/fixture/project/skillsmith.toml',
    lockPath: '/fixture/project/skillsmith.lock',
    lockSource: 'sibling',
    selectionSource: 'explicit',
  },
  project: {
    effectiveCwd: '/fixture/project',
    root: '/fixture/project',
    identity: 'fixture-project',
  },
  options: { locked: true, prune: false, check: false },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'selected',
    requestedTools: [],
    requestedScope: null,
    skills: [],
    tools: ['codex'],
    scopes: ['project'],
  },
  operations: [],
  checks: [],
  diagnostics: [],
  summary: {
    operations: 0,
    checks: 0,
    diagnostics: 0,
    drift: 0,
    refusals: 0,
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
  },
  savedOutput: null,
});

describe('plan-report@1 wire contract', () => {
  test('owns a stable report identity and canonical terminal-LF bytes', () => {
    expect(planV1Codec.descriptor).toMatchObject({
      id: 'plan-report',
      version: 1,
      wireKind: 'skillsmith.plan-report',
      unknownFields: 'reject-recursive',
      formatting: { indent: 2, terminalLf: true },
    });
    const encoded = planV1Codec.encode(report());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(encoded.value.endsWith('\n')).toBeTrue();
    const decoded = planV1Codec.decode(encoded.value);
    expect(decoded).toEqual({ ok: true, value: report() });
  });

  test('rejects unknown root and nested fields recursively', () => {
    expect(planV1Codec.validate({ ...report(), unexpected: true }).ok).toBeFalse();
    expect(
      planV1Codec.validate({
        ...report(),
        selection: { ...report().selection, unexpected: true },
      }).ok,
    ).toBeFalse();
  });

  test('rejects summary drift and refusal-state contradictions', () => {
    expect(
      planV1Codec.validate({
        ...report(),
        summary: { ...report().summary, operations: 1 },
      }).ok,
    ).toBeFalse();
    expect(planV1Codec.validate({ ...report(), state: 'refused' }).ok).toBeFalse();
  });

  test('round-trips full canonical operations, checks, and diagnostics without projection loss', () => {
    const resource = {
      kind: 'live' as const,
      skill: 'alpha',
      tool: 'codex' as const,
      scope: 'project' as const,
      projectRoot: { kind: 'machine-bound' as const, path: '/fixture/project' },
      location: { kind: 'machine-bound' as const, path: '/fixture/project/.agents/skills/alpha' },
    };
    const source = {
      kind: 'portable' as const,
      identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'skills/alpha' },
      requestedRef: null,
      resolvedSha: 'a'.repeat(40),
      sourcePath: 'skills/alpha',
      contentHash: `sha256:${'b'.repeat(64)}` as PlanDigestV1,
    };
    const checkId = 'check:v1:fixture';
    const preconditionId = 'precondition:v1:fixture';
    const value: PlanV1Dto = {
      ...report(),
      selection: {
        ...report().selection,
        requestedTools: ['codex'],
        requestedScope: 'project',
        skills: ['alpha'],
      },
      operations: [
        {
          operationId: 'operation:v1:fixture',
          groupId: 'group:v1:fixture',
          pairId: 'pair:v1:fixture',
          kind: 'update',
          dependsOn: [],
          skill: 'alpha',
          source,
          tool: 'codex',
          scope: 'project',
          before: {
            kind: 'placement',
            resource,
            classification: 'unmanaged',
            representation: 'copy',
            linkTarget: null,
            dangling: false,
            source: null,
            contentHash: `sha256:${'c'.repeat(64)}` as PlanDigestV1,
          },
          after: {
            kind: 'placement',
            resource,
            classification: 'pinned',
            representation: 'symlink',
            linkTarget: { kind: 'machine-bound', path: '/fixture/store/alpha' },
            dangling: false,
            source,
            contentHash: source.contentHash,
          },
          reason: { code: 'desired-placement-refresh', message: 'Refresh selected placement.' },
          selectionSource: 'bounded-default',
          preconditionIds: [preconditionId],
          requiredCheckIds: [checkId],
          reversibility: { kind: 'conditional', retentionResourceIds: ['resource:v1:backup'] },
          mutates: { live: true, manifest: false, lock: false, ledger: true },
          conflict: {
            class: 'unmanaged-target',
            normal: 'refuse',
            forced: 'backup-and-replace',
            target: resource,
            backup: 'required',
          },
        },
      ],
      checks: [
        {
          checkId,
          kind: 'capability',
          operationIds: ['operation:v1:fixture'],
          blocking: true,
          capabilityPreconditionId: 'capability:v1:fixture',
        },
      ],
      diagnostics: [
        {
          diagnosticId: 'diagnostic:v1:fixture',
          kind: 'warning',
          severity: 'warning',
          refusalClass: null,
          affected: {
            skill: 'alpha',
            source,
            tool: 'codex',
            scope: 'project',
            path: resource.location,
          },
          correlation: {
            groupId: 'group:v1:fixture',
            pairId: 'pair:v1:fixture',
            operationId: 'operation:v1:fixture',
          },
          reason: { code: 'fixture-warning', message: 'Fixture warning.' },
          selectionSource: 'bounded-default',
        },
      ],
      summary: {
        operations: 1,
        checks: 1,
        diagnostics: 1,
        drift: 1,
        refusals: 0,
        operationKinds: { ...report().summary.operationKinds, update: 1 },
        checkKinds: { ...report().summary.checkKinds, capability: 1 },
        diagnosticKinds: { ...report().summary.diagnosticKinds, warning: 1 },
      },
    };
    const encoded = planV1Codec.encode(value);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(planV1Codec.decode(encoded.value)).toEqual({ ok: true, value });
    expect(
      planV1Codec.validate({
        ...value,
        operations: [
          { ...value.operations[0], before: { ...value.operations[0]?.before, extra: 1 } },
        ],
      }).ok,
    ).toBeFalse();

    expect(
      planV1Codec.validate({
        ...value,
        operations: [{ ...value.operations[0], dependsOn: ['operation:v1:missing-dependency'] }],
      }).ok,
    ).toBeFalse();
    expect(
      planV1Codec.validate({
        ...value,
        operations: [{ ...value.operations[0], requiredCheckIds: ['check:v1:missing'] }],
      }).ok,
    ).toBeFalse();
    expect(
      planV1Codec.validate({
        ...value,
        checks: [{ ...value.checks[0], operationIds: ['operation:v1:missing'] }],
      }).ok,
    ).toBeFalse();
    expect(
      planV1Codec.validate({
        ...value,
        diagnostics: [
          {
            ...value.diagnostics[0],
            correlation: {
              ...value.diagnostics[0]?.correlation,
              operationId: 'operation:v1:missing',
            },
          },
        ],
      }).ok,
    ).toBeFalse();
    expect(
      planV1Codec.validate({
        ...value,
        summary: {
          ...value.summary,
          operationKinds: { ...value.summary.operationKinds, install: 1, update: 0 },
        },
      }).ok,
    ).toBeFalse();
    expect(
      planV1Codec.validate({
        ...value,
        operations: [value.operations[0], value.operations[0]],
        summary: {
          ...value.summary,
          operations: 2,
          drift: 2,
          operationKinds: { ...value.summary.operationKinds, update: 2 },
        },
      }).ok,
    ).toBeFalse();
    expect(
      planV1Codec.validate({
        ...value,
        diagnostics: [
          {
            ...value.diagnostics[0],
            severity: 'error',
            refusalClass: 'state',
          },
        ],
      }).ok,
    ).toBeFalse();
    const secondOperation = {
      ...value.operations[0],
      operationId: 'operation:v1:fixture-second',
      groupId: 'group:v1:fixture-second',
      pairId: 'pair:v1:fixture-second',
      requiredCheckIds: [],
    };
    expect(
      planV1Codec.validate({
        ...value,
        operations: [value.operations[0], secondOperation],
        diagnostics: [
          {
            ...value.diagnostics[0],
            correlation: {
              groupId: value.operations[0]?.groupId ?? null,
              pairId: secondOperation.pairId,
              operationId: null,
            },
          },
        ],
        summary: {
          ...value.summary,
          operations: 2,
          drift: 2,
          operationKinds: { ...value.summary.operationKinds, update: 2 },
        },
      }).ok,
    ).toBeFalse();
  });
});
