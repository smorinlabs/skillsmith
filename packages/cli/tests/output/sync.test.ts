import { describe, expect, test } from 'bun:test';
import { type SyncReportV1Dto, syncV1Codec } from '@skillsmith/core/contracts/v1';
import { Command } from 'commander';
import { currentWireCodecs } from '../../src/contracts/wire-contracts.ts';
import { renderSyncHuman } from '../../src/output/sync-human.ts';
import { renderSyncJson } from '../../src/output/sync-json.ts';
import type { RuntimeOutcome } from '../../src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../src/runtime/current-renderers.ts';

const report: SyncReportV1Dto = {
  schemaVersion: 1,
  kind: 'skillsmith.sync',
  command: 'sync',
  mode: 'dry-run',
  state: 'ready',
  endpoints: {
    from: { kind: 'user', scope: 'user', selectedInput: 'user', projectRoot: null },
    to: { kind: 'path', scope: 'project', selectedInput: './b', projectRoot: '/b' },
  },
  artifactPair: null,
  options: { force: true, delete: true, save: false, dryRun: true, continueOnError: true },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'filter-noop',
    targets: [],
    skills: [],
    tools: [],
    groupIds: [],
    sourceMembers: 0,
    destinationMembers: 0,
  },
  operations: [],
  checks: [],
  diagnostics: [],
  approval: { required: false, outcome: 'not-required' },
  groups: [],
  effects: [],
  summary: {
    groups: 0,
    pairs: 0,
    planned: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notRun: 0,
    changed: 0,
    unchanged: 0,
    effects: 0,
    drift: 0,
    refusals: 0,
  },
};

const forbiddenSources = [
  'https://fixture.invalid/org/project',
  'ssh://git@fixture.invalid/org/project',
  'git@fixture.invalid:org/project',
  'git://fixture.invalid/org/project',
  'file:///fixture/project',
  'custom+v1://fixture/project',
] as const;

const safeLocalPaths = ['./credential-store', '/fixture/token-cache'] as const;

describe('sync output', () => {
  test('human and JSON expose the same exact option and selection facts', () => {
    const human = renderSyncHuman(report);
    expect(human).toContain(
      'force=true delete=true save=false dry-run=true continue-on-error=true',
    );
    expect(human).toContain('bounded-default/filter-noop');
    expect(JSON.parse(renderSyncJson(report, syncV1Codec))).toEqual(report);
  });

  test('both renderers fail closed on invalid or credential-bearing material', () => {
    const invalid = { ...report, state: 'private' };
    const credentialBearing: SyncReportV1Dto = {
      ...report,
      endpoints: {
        ...report.endpoints,
        to: {
          ...report.endpoints.to,
          selectedInput: '/fixture/access_token=SYNC_SECRET_CANARY',
          projectRoot: '/fixture/access_token=SYNC_SECRET_CANARY',
        },
      },
    };
    const refuses = (render: () => unknown): boolean => {
      try {
        render();
        return false;
      } catch {
        return true;
      }
    };
    expect({
      humanInvalid: refuses(() => renderSyncHuman(invalid as SyncReportV1Dto)),
      jsonInvalid: refuses(() => renderSyncJson(invalid as SyncReportV1Dto, syncV1Codec)),
      humanCredential: refuses(() => renderSyncHuman(credentialBearing)),
      jsonCredential: refuses(() => renderSyncJson(credentialBearing, syncV1Codec)),
    }).toEqual({
      humanInvalid: true,
      jsonInvalid: true,
      humanCredential: true,
      jsonCredential: true,
    });

    for (const source of forbiddenSources) {
      const sourceBearing: SyncReportV1Dto = {
        ...report,
        endpoints: {
          ...report.endpoints,
          to: { ...report.endpoints.to, selectedInput: source, projectRoot: source },
        },
      };
      expect(syncV1Codec.validate(sourceBearing), source).toMatchObject({ ok: false });
      expect(
        refuses(() => renderSyncHuman(sourceBearing)),
        source,
      ).toBeTrue();
      expect(
        refuses(() => renderSyncJson(sourceBearing, syncV1Codec)),
        source,
      ).toBeTrue();
    }

    for (const path of safeLocalPaths) {
      const localPathReport: SyncReportV1Dto = {
        ...report,
        endpoints: {
          ...report.endpoints,
          to: { ...report.endpoints.to, selectedInput: path, projectRoot: path },
        },
      };
      expect(syncV1Codec.validate(localPathReport), path).toMatchObject({ ok: true });
      expect(() => renderSyncHuman(localPathReport), path).not.toThrow();
      expect(JSON.parse(renderSyncJson(localPathReport, syncV1Codec)), path).toEqual(
        localPathReport,
      );
    }
  });

  test('current runtime binds sync to the strict mapped codec', () => {
    expect(currentWireCodecs.sync.descriptor).toEqual(syncV1Codec.descriptor);
    const renderer = createCurrentRendererRegistry(new Command()).sync;
    if (renderer === undefined) throw new Error('missing current sync renderer');
    const outcome: RuntimeOutcome = {
      report: { result: report },
      diagnostics: [],
      exitClass: 'success',
      mutation: { kind: 'preview', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    };
    expect(renderer.human(outcome)).toEqual({ stdout: renderSyncHuman(report) });
    expect(renderer.json(outcome)).toBe(renderSyncJson(report, currentWireCodecs.sync));
  });
});
