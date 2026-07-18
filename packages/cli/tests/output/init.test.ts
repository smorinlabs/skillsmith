import { describe, expect, test } from 'bun:test';
import type { ArtifactDigest, InitReport } from '@skillsmith/core';
import { initV1Codec, toInitV1Dto } from '@skillsmith/core/contracts/v1';
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
});
