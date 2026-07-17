import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CurrentInstallReport,
  CurrentUninstallReport,
  InstallReport,
  UninstallReport,
} from '@skillsmith/core';
import {
  installV1Codec,
  toInstallV1Dto,
  toUninstallV1Dto,
  uninstallV1Codec,
} from '@skillsmith/core/contracts/v1';
import {
  installV2Codec,
  toInstallV2Dto,
  toUninstallV2Dto,
  uninstallV2Codec,
} from '@skillsmith/core/contracts/v2';
import {
  currentWireCodecs,
  currentWireCommandMappings,
  currentWireContractRegistry,
} from '../../src/contracts/wire-contracts.ts';
import {
  InstallJsonSchema,
  UninstallJsonSchema,
  renderInstallJson,
  renderUninstallJson,
} from '../../src/output/install-json.ts';

const INSTALL_GOLDEN = join(import.meta.dir, '..', 'fixtures', 'install-report.golden.json');
const UNINSTALL_GOLDEN = join(import.meta.dir, '..', 'fixtures', 'uninstall-report.golden.json');
const installGoldenText = readFileSync(INSTALL_GOLDEN, 'utf8');
const uninstallGoldenText = readFileSync(UNINSTALL_GOLDEN, 'utf8');

const SHA = `8c1d2e3f4a5b${'0'.repeat(28)}`;
const STORE_PATH =
  '/Users/alice/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@8c1d2e3f4a5b/factor-scan';

// Matches the task-9 brief's install JSON contract example, filled with concrete values, minus
// `kind`/`schemaVersion` (renderInstallJson adds those) and minus `error` (core-only).
const installReport: InstallReport = {
  dryRun: false,
  requested: {
    sources: ['smorinlabs/smorinlabs-harness/factor-scan'],
    tools: ['claude-code', 'codex'],
    explicitTools: false,
    scope: 'user',
    explicitScope: false,
    ref: null,
    pin: false,
    direct: false,
    force: false,
    verify: 'static',
    deep: false,
  },
  results: [
    {
      source: 'smorinlabs/smorinlabs-harness/factor-scan',
      skill: 'factor-scan',
      tool: 'claude-code',
      scope: 'user',
      placementPath: '/Users/alice/.claude/skills/factor-scan',
      action: 'installed',
      reason: null,
      placement: 'symlink',
      store: { path: STORE_PATH, rev: '8c1d2e3f4a5b', gitSha: SHA, reused: false },
      origin: {
        host: 'github.com',
        repo: 'smorinlabs/smorinlabs-harness',
        skillPath: 'plugins/factor-harness/skills/factor-scan',
        refRequested: null,
        refResolved: SHA,
        pin: false,
      },
      verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
      candidates: null,
    },
    {
      source: 'smorinlabs/smorinlabs-harness/factor-scan',
      skill: 'factor-scan',
      tool: 'codex',
      scope: 'user',
      placementPath: '/Users/alice/.agents/skills/factor-scan',
      action: 'installed',
      reason: null,
      placement: 'symlink',
      store: { path: STORE_PATH, rev: '8c1d2e3f4a5b', gitSha: SHA, reused: true },
      origin: {
        host: 'github.com',
        repo: 'smorinlabs/smorinlabs-harness',
        skillPath: 'plugins/factor-harness/skills/factor-scan',
        refRequested: null,
        refResolved: SHA,
        pin: false,
      },
      verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
      candidates: null,
    },
  ],
  summary: { installed: 2, updated: 0, repaired: 0, noop: 0, skipped: 0, refused: 0, failed: 0 },
};

const uninstallReport: UninstallReport = {
  dryRun: false,
  requested: {
    targets: ['factor-scan'],
    tools: ['claude-code', 'codex'],
    explicitTools: false,
    scope: null,
    allScopes: false,
    force: false,
  },
  results: [
    {
      skill: 'factor-scan',
      tool: 'claude-code',
      scope: 'user',
      placementPath: '/Users/alice/.claude/skills/factor-scan',
      action: 'removed',
      reason: null,
      before: { mode: 'pinned', placement: 'symlink', storePath: STORE_PATH, symlinkTarget: null },
      storeRetained: STORE_PATH,
      backupKept: null,
    },
  ],
  summary: { removed: 1, noop: 0, refused: 0, failed: 0 },
};

const CURRENT_SOURCE = 'https://alice:supersecret@example.com/owner/repo/skill';
const CURRENT_MANIFEST = '/tmp/token=preserve-manifest.toml';
const CURRENT_LOCK = '/tmp/token=preserve-lock.lock';
const noConflict = {
  requested: false,
  applied: false,
  conflictType: null,
  target: null,
  normalBehavior: null,
  forcedBehavior: null,
  backup: null,
} as const;

const currentInstallReport: CurrentInstallReport = {
  reportVersion: 2,
  dryRun: false,
  saveMode: 'desired-state',
  artifactPair: {
    manifestPath: CURRENT_MANIFEST,
    lockPath: CURRENT_LOCK,
    lockSource: 'explicit',
  },
  artifactSelection: { outcome: 'selected', selectedBy: 'explicit-file' },
  artifactEffects: [
    {
      groupId: 'group:install:0',
      skill: 'factor-scan',
      manifestAction: 'update',
      lockAction: 'update',
      migration: 'none',
      outcome: 'succeeded',
      reason: null,
    },
  ],
  requested: {
    sources: [CURRENT_SOURCE],
    tools: ['claude-code'],
    explicitTools: true,
    scope: 'project',
    explicitScope: true,
    ref: null,
    pin: false,
    direct: false,
    force: true,
    verify: 'static',
    deep: false,
    batchPolicy: 'fail-fast',
    path: './token=preserve-path',
  },
  results: [
    {
      source: CURRENT_SOURCE,
      skill: 'factor-scan',
      tool: 'claude-code',
      scope: 'project',
      placementPath: '/tmp/token=preserve-live/factor-scan',
      action: 'installed',
      reason: 'token=preserve-authoritative-reason',
      placement: 'symlink',
      store: { path: STORE_PATH, rev: '8c1d2e3f4a5b', gitSha: SHA, reused: false },
      origin: {
        host: 'example.com',
        repo: 'owner/repo',
        skillPath: 'skill',
        refRequested: null,
        refResolved: SHA,
        pin: false,
      },
      verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
      candidates: null,
      requestIndex: 0,
      groupId: 'group:install:0',
      pairId: 'pair:claude-code:project',
      executionOutcome: 'succeeded',
      drift: { status: 'in-sync', futureApply: 'none', reason: null },
      force: {
        requested: true,
        applied: true,
        conflictType: 'destination-exists',
        target: {
          kind: 'live',
          skill: 'factor-scan',
          tool: 'claude-code',
          scope: 'project',
          projectRoot: { kind: 'machine-bound', path: '/tmp/token=preserve-project' },
          location: { kind: 'machine-bound', path: '/tmp/token=preserve-live/factor-scan' },
        },
        normalBehavior: 'refuse',
        forcedBehavior: 'backup-and-replace',
        backup: 'required',
      },
      error: { code: 'flip-refused', message: 'core-only synthetic error' },
    },
  ],
  summary: {
    installed: 1,
    updated: 0,
    repaired: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
    desiredState: { changed: 1, unchanged: 0, retained: 0, notWritten: 0, failed: 0 },
  },
};

const currentUninstallReport: CurrentUninstallReport = {
  reportVersion: 2,
  dryRun: true,
  saveMode: 'live-only',
  artifactPair: null,
  artifactSelection: { outcome: 'none', reason: 'no-save' },
  artifactEffects: [
    {
      groupId: 'group:uninstall:0',
      skill: 'factor-scan',
      manifestAction: 'not-write',
      lockAction: 'not-write',
      migration: 'none',
      outcome: 'planned',
      reason: null,
    },
  ],
  requested: {
    targets: ['factor-scan', 'later-skill'],
    tools: ['claude-code'],
    explicitTools: true,
    scope: 'user',
    allScopes: false,
    force: true,
    batchPolicy: 'fail-fast',
  },
  results: [
    {
      skill: 'factor-scan',
      tool: 'claude-code',
      scope: 'user',
      placementPath: '/tmp/token=preserve-uninstall/factor-scan',
      action: 'removed',
      reason: null,
      before: {
        mode: 'pinned',
        placement: 'symlink',
        storePath: STORE_PATH,
        symlinkTarget: null,
      },
      storeRetained: STORE_PATH,
      backupKept: null,
      requestIndex: 0,
      groupId: 'group:uninstall:0',
      pairId: 'pair:claude-code:user',
      executionOutcome: 'succeeded',
      drift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
      force: {
        requested: true,
        applied: false,
        conflictType: 'source-changed',
        target: { kind: 'store', contentHash: `sha256:${'a'.repeat(64)}` },
        normalBehavior: 'refuse',
        forcedBehavior: 'replace',
        backup: 'none',
      },
    },
    {
      skill: 'later-skill',
      tool: 'claude-code',
      scope: 'user',
      placementPath: null,
      action: 'skipped',
      reason: 'skipped after an earlier group failed',
      before: null,
      storeRetained: null,
      backupKept: null,
      requestIndex: 1,
      groupId: 'group:uninstall:1',
      pairId: 'pair:claude-code:user',
      executionOutcome: 'skipped-after-failure',
      drift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
      force: noConflict,
    },
  ],
  summary: {
    removed: 1,
    noop: 0,
    refused: 0,
    failed: 0,
    desiredState: { changed: 0, unchanged: 0, retained: 0, notWritten: 2, failed: 0 },
  },
};

describe('renderInstallJson', () => {
  test('matches the committed golden (parse-compare, formatting-proof)', () => {
    const rendered = renderInstallJson(installReport);
    expect(JSON.parse(rendered)).toEqual(JSON.parse(installGoldenText));
  });

  test('validates against InstallJsonSchema', () => {
    const rendered = renderInstallJson(installReport);
    expect(() => InstallJsonSchema.parse(JSON.parse(rendered))).not.toThrow();
  });

  test('top-level field set is exact; kind and schemaVersion are correct', () => {
    const rendered = JSON.parse(renderInstallJson(installReport)) as Record<string, unknown>;
    expect(Object.keys(rendered).sort()).toEqual(
      ['schemaVersion', 'kind', 'dryRun', 'requested', 'results', 'summary'].sort(),
    );
    expect(rendered.kind).toBe('skillsmith.install');
    expect(rendered.schemaVersion).toBe(1);
  });

  test('the core-only `error` field never appears in the rendered output', () => {
    const withError: InstallReport = {
      ...installReport,
      results: [
        {
          ...installReport.results[0],
          error: { code: 'flip-refused', message: 'nope' },
        } as InstallReport['results'][number],
      ],
    };
    const rendered = JSON.parse(renderInstallJson(withError)) as {
      results: Record<string, unknown>[];
    };
    for (const r of rendered.results) expect('error' in r).toBe(false);
  });

  test('the core-only numeric request identity never appears in the v1 wire output', () => {
    const withRequestIndex: InstallReport = {
      ...installReport,
      results: installReport.results.map((result, requestIndex) => ({
        ...result,
        requestIndex,
      })),
    };
    const rendered = JSON.parse(renderInstallJson(withRequestIndex)) as {
      results: Record<string, unknown>[];
    };
    for (const result of rendered.results) expect('requestIndex' in result).toBeFalse();
  });

  test('schema rejects an install action foreign to the install action enum (`flipped`)', () => {
    const bad = {
      ...installReport,
      results: [{ ...installReport.results[0], action: 'flipped' }],
    } as unknown as InstallReport;
    expect(() => renderInstallJson(bad)).toThrow();
  });

  test('schema rejects a wrong `kind`', () => {
    const rendered = JSON.parse(renderInstallJson(installReport));
    rendered.kind = 'skillsmith.uninstall';
    expect(() => InstallJsonSchema.parse(rendered)).toThrow();
    expect(() => UninstallJsonSchema.parse(rendered)).toThrow();
  });

  test('a source-level failure (skill/tool null) round-trips with a candidates list', () => {
    const ambiguous: InstallReport = {
      ...installReport,
      results: [
        {
          source: 'acme/agent-tools/review',
          skill: null,
          tool: null,
          scope: 'user',
          placementPath: null,
          action: 'refused',
          reason: "'review' matches 2 skills — re-run with one of the exact paths above",
          placement: null,
          store: null,
          origin: null,
          verify: null,
          candidates: [
            'acme/agent-tools//plugins/web/skills/review',
            'acme/agent-tools//plugins/api/skills/review',
          ],
        },
      ],
      summary: {
        installed: 0,
        updated: 0,
        repaired: 0,
        noop: 0,
        skipped: 0,
        refused: 1,
        failed: 0,
      },
    };
    const rendered = JSON.parse(renderInstallJson(ambiguous));
    expect(rendered.results[0].skill).toBeNull();
    expect(rendered.results[0].tool).toBeNull();
    expect(rendered.results[0].candidates).toHaveLength(2);
  });
});

describe('renderUninstallJson', () => {
  test('matches the committed golden (parse-compare, formatting-proof)', () => {
    const rendered = renderUninstallJson(uninstallReport);
    expect(JSON.parse(rendered)).toEqual(JSON.parse(uninstallGoldenText));
  });

  test('validates against UninstallJsonSchema', () => {
    const rendered = renderUninstallJson(uninstallReport);
    expect(() => UninstallJsonSchema.parse(JSON.parse(rendered))).not.toThrow();
  });

  test('top-level field set is exact; kind and schemaVersion are correct', () => {
    const rendered = JSON.parse(renderUninstallJson(uninstallReport)) as Record<string, unknown>;
    expect(Object.keys(rendered).sort()).toEqual(
      ['schemaVersion', 'kind', 'dryRun', 'requested', 'results', 'summary'].sort(),
    );
    expect(rendered.kind).toBe('skillsmith.uninstall');
    expect(rendered.schemaVersion).toBe(1);
  });

  test('the core-only `error` field never appears in the rendered output', () => {
    const withError: UninstallReport = {
      ...uninstallReport,
      results: [
        {
          ...uninstallReport.results[0],
          error: { code: 'flip-refused', message: 'nope' },
        } as UninstallReport['results'][number],
      ],
    };
    const rendered = JSON.parse(renderUninstallJson(withError)) as {
      results: Record<string, unknown>[];
    };
    for (const r of rendered.results) expect('error' in r).toBe(false);
  });

  test('schema rejects an uninstall action foreign to the uninstall action enum (`installed`)', () => {
    const bad = {
      ...uninstallReport,
      results: [{ ...uninstallReport.results[0], action: 'installed' }],
    } as unknown as UninstallReport;
    expect(() => renderUninstallJson(bad)).toThrow();
  });

  test('schema rejects a wrong `kind`', () => {
    const rendered = JSON.parse(renderUninstallJson(uninstallReport));
    rendered.kind = 'skillsmith.install';
    expect(() => UninstallJsonSchema.parse(rendered)).toThrow();
    expect(() => InstallJsonSchema.parse(rendered)).toThrow();
  });

  // U2 ambiguity carry-forward: `tool: null` alone must not collapse into a "not installed"
  // reading — that is only true when `action === 'noop'`. Here it is a `refused` ambiguity.
  test('a U2 ambiguity refusal (tool/scope null, action refused) round-trips distinctly from a noop', () => {
    const ambiguous: UninstallReport = {
      ...uninstallReport,
      results: [
        {
          skill: 'review',
          tool: null,
          scope: null,
          placementPath: null,
          action: 'refused',
          reason:
            "'review' is installed in multiple scopes: user, project; disambiguate with --scope, --tool, or --all-scopes",
          before: null,
          storeRetained: null,
          backupKept: null,
        },
      ],
      summary: { removed: 0, noop: 0, refused: 1, failed: 0 },
    };
    const rendered = JSON.parse(renderUninstallJson(ambiguous));
    expect(rendered.results[0].action).toBe('refused');
    expect(rendered.results[0].tool).toBeNull();
    expect(rendered.results[0].scope).toBeNull();
  });

  test('an absent target (action noop, tool/scope null) is distinct from the ambiguity refusal', () => {
    const notInstalled: UninstallReport = {
      ...uninstallReport,
      results: [
        {
          skill: 'nope',
          tool: null,
          scope: null,
          placementPath: null,
          action: 'noop',
          reason: "'nope' is not installed anywhere skillsmith manages",
          before: null,
          storeRetained: null,
          backupKept: null,
        },
      ],
      summary: { removed: 0, noop: 1, refused: 0, failed: 0 },
    };
    const rendered = JSON.parse(renderUninstallJson(notInstalled));
    expect(rendered.results[0].action).toBe('noop');
    expect(rendered.results[0].tool).toBeNull();
  });
});

describe('G4A-01 additive lifecycle v2 wire contracts', () => {
  test('maps and round-trips every current install field without plan/error leakage', () => {
    const hostileResult = {
      ...(currentInstallReport.results[0] as CurrentInstallReport['results'][number]),
    };
    Object.defineProperty(hostileResult, 'error', {
      enumerable: true,
      get: () => {
        throw new Error('excluded result error getter was invoked');
      },
    });
    const withPlan = {
      ...currentInstallReport,
      results: [hostileResult],
    } as CurrentInstallReport;
    Object.defineProperty(withPlan, 'plan', {
      enumerable: true,
      get: () => {
        throw new Error('excluded plan getter was invoked');
      },
    });
    const dto = toInstallV2Dto(withPlan);

    expect(dto).toMatchObject({
      schemaVersion: 2,
      kind: 'skillsmith.install',
      saveMode: 'desired-state',
      artifactPair: {
        manifestPath: CURRENT_MANIFEST,
        lockPath: CURRENT_LOCK,
        lockSource: 'explicit',
      },
      requested: {
        sources: ['https://example.com/owner/repo/skill'],
        batchPolicy: 'fail-fast',
        path: './token=preserve-path',
      },
      results: [
        {
          source: 'https://example.com/owner/repo/skill',
          reason: 'token=preserve-authoritative-reason',
          requestIndex: 0,
          groupId: 'group:install:0',
          pairId: 'pair:claude-code:project',
          executionOutcome: 'succeeded',
          drift: { status: 'in-sync', futureApply: 'none', reason: null },
          force: {
            requested: true,
            applied: true,
            conflictType: 'destination-exists',
            normalBehavior: 'refuse',
            forcedBehavior: 'backup-and-replace',
            backup: 'required',
            target: {
              kind: 'live',
              projectRoot: { kind: 'machine-bound', path: '/tmp/token=preserve-project' },
              location: {
                kind: 'machine-bound',
                path: '/tmp/token=preserve-live/factor-scan',
              },
            },
          },
        },
      ],
      summary: {
        desiredState: { changed: 1, unchanged: 0, retained: 0, notWritten: 0, failed: 0 },
      },
    });
    expect('reportVersion' in dto).toBeFalse();
    expect('plan' in dto).toBeFalse();
    const firstResult = dto.results[0];
    if (firstResult === undefined) throw new Error('current install result missing');
    expect('error' in firstResult).toBeFalse();
    expect(JSON.stringify(dto)).not.toContain('supersecret');

    const validated = installV2Codec.validate(dto);
    expect(validated.ok).toBeTrue();
    const encoded = installV2Codec.encode(dto);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    const decoded = installV2Codec.decode(encoded.value);
    expect(decoded).toEqual({ ok: true, value: dto });
  });

  test('maps uninstall skipped scheduling, desired-state counts, and source-changed force exactly', () => {
    const dto = toUninstallV2Dto(currentUninstallReport);
    expect(dto).toMatchObject({
      schemaVersion: 2,
      kind: 'skillsmith.uninstall',
      saveMode: 'live-only',
      artifactPair: null,
      artifactSelection: { outcome: 'none', reason: 'no-save' },
      requested: { batchPolicy: 'fail-fast' },
      results: [
        {
          action: 'removed',
          executionOutcome: 'succeeded',
          force: {
            conflictType: 'source-changed',
            target: { kind: 'store', contentHash: `sha256:${'a'.repeat(64)}` },
            normalBehavior: 'refuse',
            forcedBehavior: 'replace',
            backup: 'none',
          },
        },
        {
          action: 'skipped',
          executionOutcome: 'skipped-after-failure',
          force: noConflict,
        },
      ],
      summary: {
        desiredState: { changed: 0, unchanged: 0, retained: 0, notWritten: 2, failed: 0 },
      },
    });
    expect('skipped' in dto.summary).toBeFalse();
    const validated = uninstallV2Codec.validate(dto);
    expect(validated).toEqual({ ok: true, value: dto });
  });

  test('rejects unknown recursive fields, invalid force branches, and unsafe counters', () => {
    const unknown = structuredClone(toInstallV2Dto(currentInstallReport)) as unknown as Record<
      string,
      unknown
    >;
    const result = (unknown.results as Array<Record<string, unknown>>)[0];
    const force = result?.force as Record<string, unknown>;
    const target = force.target as Record<string, unknown>;
    target.unexpected = true;
    const unknownResult = installV2Codec.validate(unknown);
    expect(unknownResult.ok).toBeFalse();
    if (unknownResult.ok) throw new Error('recursive unknown field passed');
    expect(unknownResult.error.path).toEqual(['results', 0, 'force', 'target', 'unexpected']);

    const invalidForce = structuredClone(
      toUninstallV2Dto(currentUninstallReport),
    ) as unknown as Record<string, unknown>;
    const uninstallResult = (invalidForce.results as Array<Record<string, unknown>>)[0];
    const sourceChanged = uninstallResult?.force as Record<string, unknown>;
    sourceChanged.forcedBehavior = 'backup-and-replace';
    sourceChanged.backup = 'required';
    expect(uninstallV2Codec.validate(invalidForce).ok).toBeFalse();

    const invalidCount = structuredClone(toInstallV2Dto(currentInstallReport)) as unknown as Record<
      string,
      unknown
    >;
    (invalidCount.summary as Record<string, unknown>).installed = Number.MAX_SAFE_INTEGER + 1;
    expect(installV2Codec.validate(invalidCount).ok).toBeFalse();
  });

  test('rejects contradictory artifact mode, drift, desired-state, and scheduling facts', () => {
    const missingSelectedPair = structuredClone(
      toInstallV2Dto(currentInstallReport),
    ) as unknown as Record<string, unknown>;
    missingSelectedPair.artifactPair = null;
    expect(installV2Codec.validate(missingSelectedPair).ok).toBeFalse();

    const liveOnlySelected = structuredClone(
      toUninstallV2Dto(currentUninstallReport),
    ) as unknown as Record<string, unknown>;
    liveOnlySelected.artifactPair = {
      manifestPath: '/tmp/forbidden.toml',
      lockPath: '/tmp/forbidden.lock',
      lockSource: 'sibling',
    };
    liveOnlySelected.artifactSelection = {
      outcome: 'selected',
      selectedBy: 'explicit-file',
    };
    expect(uninstallV2Codec.validate(liveOnlySelected).ok).toBeFalse();

    const liveOnlyWrite = structuredClone(
      toUninstallV2Dto(currentUninstallReport),
    ) as unknown as Record<string, unknown>;
    const effects = liveOnlyWrite.artifactEffects as Array<Record<string, unknown>>;
    if (effects[0] === undefined) throw new Error('missing live-only effect fixture');
    effects[0].manifestAction = 'update';
    expect(uninstallV2Codec.validate(liveOnlyWrite).ok).toBeFalse();

    const liveOnlyDrift = structuredClone(
      toUninstallV2Dto(currentUninstallReport),
    ) as unknown as Record<string, unknown>;
    const liveOnlyResults = liveOnlyDrift.results as Array<Record<string, unknown>>;
    if (liveOnlyResults[0] === undefined) throw new Error('missing live-only result fixture');
    liveOnlyResults[0].drift = { status: 'in-sync', futureApply: 'none', reason: null };
    expect(uninstallV2Codec.validate(liveOnlyDrift).ok).toBeFalse();

    const liveOnlyChanged = structuredClone(
      toUninstallV2Dto(currentUninstallReport),
    ) as unknown as Record<string, unknown>;
    const liveOnlySummary = liveOnlyChanged.summary as Record<string, unknown>;
    liveOnlySummary.desiredState = {
      changed: 1,
      unchanged: 0,
      retained: 0,
      notWritten: 1,
      failed: 0,
    };
    expect(uninstallV2Codec.validate(liveOnlyChanged).ok).toBeFalse();

    for (const [action, executionOutcome] of [
      ['skipped', 'succeeded'],
      ['removed', 'skipped-after-failure'],
    ] as const) {
      const contradictory = structuredClone(
        toUninstallV2Dto(currentUninstallReport),
      ) as unknown as Record<string, unknown>;
      const results = contradictory.results as Array<Record<string, unknown>>;
      if (results[0] === undefined) throw new Error('missing uninstall result fixture');
      results[0].action = action;
      results[0].executionOutcome = executionOutcome;
      expect(uninstallV2Codec.validate(contradictory).ok).toBeFalse();
    }
  });

  test('registers both @2 codecs while intentionally retaining current renderers on @1', () => {
    expect(currentWireContractRegistry.get('install', 2)?.descriptor).toEqual(
      installV2Codec.descriptor,
    );
    expect(currentWireContractRegistry.get('uninstall', 2)?.descriptor).toEqual(
      uninstallV2Codec.descriptor,
    );
    expect(currentWireCommandMappings).toContainEqual({
      commandPath: 'skillsmith install',
      contractId: 'install',
      version: 1,
    });
    expect(currentWireCommandMappings).toContainEqual({
      commandPath: 'skillsmith uninstall',
      contractId: 'uninstall',
      version: 1,
    });
    expect(currentWireCodecs.install.descriptor).toEqual(installV1Codec.descriptor);
    expect(currentWireCodecs.uninstall.descriptor).toEqual(uninstallV1Codec.descriptor);
    expect(renderInstallJson(installReport)).toBe(
      (() => {
        const encoded = installV1Codec.encode(toInstallV1Dto(installReport));
        if (!encoded.ok) throw new Error(encoded.error.message);
        return encoded.value;
      })(),
    );
    expect(renderUninstallJson(uninstallReport)).toBe(
      (() => {
        const encoded = uninstallV1Codec.encode(toUninstallV1Dto(uninstallReport));
        if (!encoded.ok) throw new Error(encoded.error.message);
        return encoded.value;
      })(),
    );
  });

  test('declares no implicit migration and refuses either report generation at the wrong mapper', () => {
    expect(installV2Codec.descriptor.migrations).toEqual([]);
    expect(uninstallV2Codec.descriptor.migrations).toEqual([]);
    const installV1 = installV2Codec.decode(
      JSON.stringify({ schemaVersion: 1, kind: 'skillsmith.install' }),
    );
    expect(installV1.ok).toBeFalse();
    if (installV1.ok) throw new Error('install@2 decoded v1');
    expect(installV1.error.code).toBe('unsupported-version');

    expect(() => toInstallV1Dto(currentInstallReport as unknown as InstallReport)).toThrow(
      'reportVersion 1',
    );
    expect(() => toUninstallV1Dto(currentUninstallReport as unknown as UninstallReport)).toThrow(
      'reportVersion 1',
    );
    expect(() => toInstallV2Dto(installReport as unknown as CurrentInstallReport)).toThrow(
      'reportVersion 2',
    );
    expect(() => toUninstallV2Dto(uninstallReport as unknown as CurrentUninstallReport)).toThrow(
      'reportVersion 2',
    );
    expect(() => renderInstallJson(currentInstallReport as unknown as InstallReport)).toThrow(
      'reportVersion 1',
    );
  });

  test('v1 report-version guards inspect inherited descriptors without invoking hostile code', () => {
    const withPrototype = <T extends object>(value: T, prototype: object | null): T => {
      const clone = Object.create(null) as T;
      Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value));
      Object.setPrototypeOf(clone, prototype);
      return clone;
    };

    const inheritedV1 = withPrototype(installReport, { reportVersion: 1 });
    expect(toInstallV1Dto(inheritedV1)).toEqual(toInstallV1Dto(installReport));
    expect(toUninstallV1Dto({ ...uninstallReport, reportVersion: 1 })).toEqual(
      toUninstallV1Dto(uninstallReport),
    );

    const inheritedV2 = withPrototype(installReport, { reportVersion: 2 });
    expect(() => toInstallV1Dto(inheritedV2)).toThrow('reportVersion 1');

    let getterReads = 0;
    const accessorPrototype = Object.create(null) as object;
    Object.defineProperty(accessorPrototype, 'reportVersion', {
      configurable: true,
      get: () => {
        getterReads += 1;
        return 1;
      },
    });
    const inheritedAccessor = withPrototype(uninstallReport, accessorPrototype);
    expect(() => toUninstallV1Dto(inheritedAccessor)).toThrow('reportVersion 1');
    expect(getterReads).toBe(0);

    let proxyTraps = 0;
    const proxyPrototype = new Proxy(
      { reportVersion: 1 },
      {
        get: () => {
          proxyTraps += 1;
          return undefined;
        },
        getOwnPropertyDescriptor: () => {
          proxyTraps += 1;
          return undefined;
        },
        getPrototypeOf: () => {
          proxyTraps += 1;
          return null;
        },
      },
    );
    const safeIntermediate = Object.create(proxyPrototype) as object;
    const inheritedProxy = withPrototype(installReport, safeIntermediate);
    expect(() => toInstallV1Dto(inheritedProxy)).toThrow('non-proxy legacy report chain');
    expect(proxyTraps).toBe(0);
  });
});
