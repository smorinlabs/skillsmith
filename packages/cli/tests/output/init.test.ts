import { describe, expect, test } from 'bun:test';
import type { ArtifactDigest, InitReport } from '@skillsmith/core';
import { initV1Codec, toInitV1Dto } from '@skillsmith/core/contracts/v1';
import { planInitManifest } from '../../../core/src/artifacts/init.ts';
import { prepareInitOperationPlan } from '../../../core/src/init/plan.ts';
import { renderInitHuman } from '../../src/output/init-human.ts';
import { renderInitJson } from '../../src/output/init-json.ts';

const digest = (character: string) => `sha256:${character.repeat(64)}` as ArtifactDigest;
const operationId = `operation:v1:${'c'.repeat(64)}`;
const report: InitReport = Object.freeze({
  schemaVersion: 1,
  kind: 'skillsmith.init',
  reportVersion: 1,
  dryRun: true,
  requested: Object.freeze({
    tools: Object.freeze(['codex'] as const),
    explicitTools: true,
    toolSource: 'explicit',
    scope: 'project',
    explicitScope: true,
    file: '/work/skillsmith.toml',
    force: false,
  }),
  defaults: Object.freeze({
    tools: Object.freeze(['codex'] as const),
    scope: 'project',
    path: null,
    registryDefault: null,
  }),
  artifactSelection: Object.freeze({
    outcome: 'selected',
    selectedBy: 'explicit-file',
    manifestPath: '/work/skillsmith.toml',
    lockPath: '/work/skillsmith.lock',
    lockSource: 'sibling',
  }),
  result: Object.freeze({
    action: 'create-manifest',
    operationId,
    before: Object.freeze({ state: 'absent', shape: null, byteHash: null, semanticHash: null }),
    after: Object.freeze({ state: 'canonical', byteHash: digest('a'), semanticHash: digest('b') }),
  }),
  force: Object.freeze({
    requested: false,
    applied: false,
    conflictType: null,
    target: null,
    normalBehavior: null,
    forcedBehavior: null,
    backup: null,
  }),
  effects: Object.freeze([
    Object.freeze({ role: 'manifest', action: 'create', operationId, outcome: 'planned' }),
    Object.freeze({ role: 'lock', action: 'not-written', operationId: null, outcome: 'not-run' }),
    Object.freeze({ role: 'live', action: 'not-written', operationId: null, outcome: 'not-run' }),
    Object.freeze({ role: 'ledger', action: 'not-written', operationId: null, outcome: 'not-run' }),
  ] as const),
  summary: Object.freeze({ changed: 1, unchanged: 0 }),
});

describe('init output', () => {
  test('JSON encodes once through strict init@1 and rejects cross-field drift', () => {
    const value = JSON.parse(renderInitJson(report, initV1Codec));
    expect(value).toEqual(toInitV1Dto(report));
    expect(initV1Codec.validate({ ...value, extra: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid-shape', path: ['extra'] },
    });
    expect(
      initV1Codec.validate({ ...value, summary: { changed: 0, unchanged: 1 } }).ok,
    ).toBeFalse();

    const replacement = structuredClone(value);
    replacement.dryRun = false;
    replacement.requested.force = true;
    replacement.result = {
      action: 'replace-manifest',
      operationId,
      before: {
        state: 'present',
        shape: 'malformed',
        byteHash: digest('d'),
        semanticHash: null,
      },
      after: { state: 'canonical', byteHash: digest('a'), semanticHash: digest('b') },
    };
    replacement.force = {
      requested: true,
      applied: true,
      conflictType: 'destination-exists',
      target: {
        kind: 'manifest-bytes',
        location: { kind: 'machine-bound', path: '/work/skillsmith.toml' },
      },
      normalBehavior: 'refuse',
      forcedBehavior: 'backup-and-replace',
      backup: 'required',
    };
    replacement.effects[0] = {
      role: 'manifest',
      action: 'replace',
      operationId,
      outcome: 'succeeded',
    };
    expect(initV1Codec.validate(replacement).ok).toBeTrue();

    const invalidReports = [
      {
        ...value,
        requested: {
          ...value.requested,
          tools: ['codex', 'claude-code'],
        },
        defaults: { ...value.defaults, tools: ['codex', 'claude-code'] },
      },
      {
        ...value,
        requested: { ...value.requested, explicitTools: false, toolSource: 'none' },
      },
      {
        ...value,
        requested: { ...value.requested, scope: null },
        defaults: { ...value.defaults, scope: null, path: 'skills' },
      },
      {
        ...value,
        requested: { ...value.requested, file: null },
      },
      {
        ...value,
        requested: {
          ...value.requested,
          scope: 'user',
          explicitScope: true,
          file: null,
        },
        defaults: { ...value.defaults, scope: 'user' },
        artifactSelection: { ...value.artifactSelection, selectedBy: 'project' },
      },
      {
        ...value,
        defaults: { ...value.defaults, path: '/absolute' },
      },
      {
        ...value,
        defaults: { ...value.defaults, registryDefault: 'https://fixture.invalid/team' },
      },
      {
        ...value,
        defaults: {
          ...value.defaults,
          registryDefault: `fixture.invalid/ghp_${'1'.repeat(36)}`,
        },
      },
      {
        ...value,
        artifactSelection: { ...value.artifactSelection, lockPath: '/work/not-a-sibling.lock' },
      },
      {
        ...value,
        result: {
          ...value.result,
          before: {
            state: 'present',
            shape: 'canonical',
            byteHash: digest('d'),
            semanticHash: digest('e'),
          },
        },
      },
      {
        ...replacement,
        force: {
          ...replacement.force,
          target: {
            kind: 'manifest-bytes',
            location: { kind: 'machine-bound', path: '/work/other.toml' },
          },
        },
      },
      {
        ...replacement,
        force: { ...replacement.force, applied: false },
      },
      {
        ...replacement,
        result: {
          ...replacement.result,
          before: { ...replacement.result.before, shape: 'legacy', semanticHash: digest('e') },
        },
      },
    ];
    for (const invalid of invalidReports) expect(initV1Codec.validate(invalid).ok).toBeFalse();
  });

  test('human output names the selected manifest and untouched sibling', () => {
    expect(renderInitHuman(report)).toBe(
      `Init: create-manifest (planned)\nManifest: /work/skillsmith.toml\nLock: /work/skillsmith.lock (not written)\nBefore: absent\nAfter: canonical; bytes ${digest('a')}; semantics ${digest('b')}\nForce: requested no; applied no; conflict none; backup none\n`,
    );
  });

  test('known fixture hashes prove producer domains and init@1 field placement', () => {
    const classification = planInitManifest({
      skeleton: {},
      current: { state: 'absent' },
      legacyIntent: { requireMatch: [] },
      force: false,
    });
    expect(classification.ok).toBeTrue();
    if (!classification.ok) return;
    const prepared = prepareInitOperationPlan({
      request: {
        tools: [],
        explicitTools: false,
        toolSource: 'none',
        scope: null,
        explicitScope: false,
        file: '/work/skillsmith.toml',
        force: false,
      },
      dryRun: true,
      defaults: { tools: null, scope: null, path: null, registryDefault: null },
      selection: report.artifactSelection,
      skeleton: {},
      classification: classification.value,
      observed: {
        state: 'absent',
        parent: { state: 'present', path: '/work', identity: 'fixture-parent' },
      },
    });
    const manifestBytes = 'sha256:f59632b3a21636f59c5f3f93b747c27663df80cb2a9bc9c4f7a1f19803c6049b';
    const manifestSemantics =
      'sha256:cd8e75a20fadb8a5e7a05138f382a0abb5d31f405f315180b8bfec3e597d4229';
    const resourceBytes = 'sha256:ade706565a80a020dff9d8cbbf44fe4e595a7ee14a1879784fb95f69a58c472b';
    expect(classification.value.after).toMatchObject({
      source: 'version = 1\n',
      byteHash: manifestBytes,
      semanticHash: manifestSemantics,
    });
    expect(prepared.result.after).toMatchObject({
      byteHash: manifestBytes,
      semanticHash: manifestSemantics,
    });
    const operation = prepared.plan.operations[0];
    expect(operation?.after).toMatchObject({
      kind: 'manifest',
      byteHash: resourceBytes,
      semanticHash: manifestSemantics,
    });

    const operationId = prepared.result.operationId;
    expect(operationId).not.toBeNull();
    if (operationId === null) return;
    const producerReport: InitReport = Object.freeze({
      ...report,
      requested: prepared.request,
      defaults: prepared.defaults,
      artifactSelection: prepared.selection,
      result: prepared.result,
      effects: Object.freeze([
        Object.freeze({ role: 'manifest', action: 'create', operationId, outcome: 'planned' }),
        report.effects[1],
        report.effects[2],
        report.effects[3],
      ]) as InitReport['effects'],
    });
    const dto = toInitV1Dto(producerReport);
    expect(dto.result.after).toMatchObject({
      byteHash: manifestBytes,
      semanticHash: manifestSemantics,
    });
    expect(initV1Codec.validate(dto).ok).toBeTrue();
  });
});
