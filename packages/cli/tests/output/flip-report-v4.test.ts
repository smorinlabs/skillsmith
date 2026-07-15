import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FlipReport,
  createOperationExecutionResult,
  createOperationPlan,
} from '@skillsmith/core';
import {
  currentWireCodecs,
  currentWireContractRegistry,
} from '../../src/contracts/wire-contracts.ts';

const V4_GOLDEN_PATH = join(import.meta.dir, '..', 'fixtures', 'flip-report-v4.golden.json');
const V4_GOLDEN_TEXT = readFileSync(V4_GOLDEN_PATH, 'utf8');

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const loadFlipV4Surface = async (): Promise<UnknownRecord | null> => {
  const packageSurface: string = '@skillsmith/core/contracts/v4';
  let loaded: unknown = null;
  let loadError: unknown = null;
  try {
    loaded = await import(packageSurface);
  } catch (error) {
    loadError = error;
  }
  expect(
    loadError,
    'G3B-02 must expose the guarded @skillsmith/core/contracts/v4 package surface',
  ).toBeNull();
  expect(isRecord(loaded)).toBeTrue();
  return isRecord(loaded) ? loaded : null;
};

const createSkippedRuntimeReport = (): FlipReport | null => {
  const golden = JSON.parse(V4_GOLDEN_TEXT) as UnknownRecord;
  const selection = golden.selection;
  const operations = golden.operations;
  const operation = Array.isArray(operations) ? operations[0] : undefined;
  expect(isRecord(selection)).toBeTrue();
  expect(isRecord(operation)).toBeTrue();
  if (!isRecord(selection) || !isRecord(operation)) return null;

  let plan: unknown = null;
  let planError: unknown = null;
  try {
    plan = Reflect.apply(createOperationPlan, undefined, [
      {
        domain: 'skillsmith.operation-plan',
        schemaVersion: 1,
        command: 'promote',
        selection: {
          source: selection.source,
          outcome: selection.outcome,
          targets: selection.targets,
          all: selection.all,
          tools: selection.tools,
          scopes: selection.scopes,
          groupIds: selection.groupIds,
        },
        batchPolicy: selection.batchPolicy,
        operations,
        checks: golden.checks,
        diagnostics: golden.diagnostics,
      },
    ]);
  } catch (error) {
    planError = error;
  }
  expect(planError, 'the mapper fixture must use a constructor-created operation plan').toBeNull();
  if (!isRecord(plan)) return null;

  const unchanged = structuredClone(operation.before);
  let skipped: unknown = null;
  let resultError: unknown = null;
  try {
    skipped = Reflect.apply(createOperationExecutionResult, undefined, [
      {
        operationId: operation.operationId,
        outcome: 'skipped-after-failure',
        actualBefore: unchanged,
        actualAfter: structuredClone(unchanged),
        force: null,
        error: null,
      },
    ]);
  } catch (error) {
    resultError = error;
  }
  expect(
    resultError,
    'createOperationExecutionResult must construct the fifth scheduling outcome',
  ).toBeNull();
  expect(isRecord(skipped)).toBeTrue();
  if (!isRecord(skipped)) return null;
  expect(skipped).toMatchObject({ outcome: 'skipped-after-failure', error: null });
  expect(skipped.actualAfter).toEqual(skipped.actualBefore);

  return {
    op: 'promote',
    dryRun: false,
    requested: {
      targets: ['factor-scan'],
      all: false,
      tools: ['claude-code'],
      explicitTools: true,
    },
    plan: plan as unknown as FlipReport['plan'],
    executionResults: [skipped] as unknown as FlipReport['executionResults'],
    results: [
      {
        skill: 'factor-scan',
        tool: 'claude-code',
        placementPath: '/Users/alice/.claude/skills/factor-scan',
        action: 'skipped',
        reason: 'skipped after an earlier group failed',
        before: null,
        after: null,
        store: null,
        verify: null,
      },
    ],
    summary: {
      flipped: 0,
      updated: 0,
      noop: 0,
      skipped: 1,
      refused: 0,
      failed: 0,
      rolledBack: 0,
      created: 0,
      adopted: 0,
    },
  };
};

describe('flip report contract v4', () => {
  test('pins the exact two-space, no-terminal-LF flip@4 golden bytes', () => {
    const bytes = readFileSync(V4_GOLDEN_PATH);
    expect(bytes.byteLength).toBe(6235);
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(
      '77415a6f6053deb21a6a3bcb8ffa124726cdae32f014b32b4ce11a28daa26e44',
    );
    expect(V4_GOLDEN_TEXT.endsWith('\n')).toBeFalse();
    expect(JSON.parse(V4_GOLDEN_TEXT)).toMatchObject({
      schemaVersion: 4,
      kind: 'skillsmith.flip',
    });
  });

  test('registers flip@4 without replacing the addressable historical flip@3 codec', () => {
    const historical = currentWireContractRegistry.get('flip', 3);
    const current = currentWireContractRegistry.get('flip', 4);

    expect(historical?.descriptor).toMatchObject({
      id: 'flip',
      version: 3,
      migrations: [],
      compatibility: 'conservative',
    });
    expect(current, 'G3B-02 must register the new flip@4 codec').toBeDefined();
    expect(current?.descriptor).toEqual({
      id: 'flip',
      version: 4,
      wireKind: 'skillsmith.flip',
      embeddedVersion: 'schemaVersion',
      unknownFields: 'reject-recursive',
      formatting: { indent: 2, terminalLf: false },
      migrations: [],
      compatibility: 'conservative',
    });
  });

  test('binds both current flip commands to the same flip@4 codec identity', () => {
    const current = currentWireContractRegistry.get('flip', 4);
    const bindings: readonly unknown[] = [
      currentWireContractRegistry.forCommand('skillsmith dev'),
      currentWireContractRegistry.forCommand('skillsmith promote'),
      currentWireCodecs.dev,
      currentWireCodecs.promote,
      currentWireContractRegistry.latest('flip'),
    ];
    for (const binding of bindings) expect(binding).toBe(current);
  });

  test('round-trips the committed flip@4 golden without byte or framing drift', () => {
    const current = currentWireContractRegistry.get('flip', 4);
    expect(current, 'G3B-02 must register the new flip@4 codec').toBeDefined();
    if (current === undefined) throw new Error('flip@4 codec is unavailable');
    const decoded = current.decode(V4_GOLDEN_TEXT);
    expect(decoded.ok).toBeTrue();
    if (!decoded.ok) throw new Error(decoded.error.message);
    const encoded = current.encode(decoded.value);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(encoded.value).toBe(V4_GOLDEN_TEXT);
  });

  test('accepts the closed skipped result shape while enforcing unchanged images and exact keys', () => {
    const current = currentWireContractRegistry.get('flip', 4);
    expect(current, 'G3B-02 must register the new flip@4 codec').toBeDefined();
    if (current === undefined) throw new Error('flip@4 codec is unavailable');

    const candidate = JSON.parse(V4_GOLDEN_TEXT) as Record<string, unknown>;
    const results = candidate.results as Record<string, unknown>[];
    const result = results[0];
    if (result === undefined) throw new Error('flip@3 golden omitted its execution result');
    result.outcome = 'skipped-after-failure';
    result.actualAfter = structuredClone(result.actualBefore);
    result.error = null;

    const validated = current.validate(candidate);
    expect(validated.ok).toBeTrue();
    if (!validated.ok) throw new Error(validated.error.message);
    expect(Object.keys(validated.value as Record<string, unknown>).sort()).toEqual(
      [
        'checks',
        'diagnostics',
        'dryRun',
        'kind',
        'op',
        'operations',
        'results',
        'schemaVersion',
        'selection',
        'summary',
      ].sort(),
    );
    expect(
      Object.keys(
        (validated.value as { results: Record<string, unknown>[] }).results[0] ?? {},
      ).sort(),
    ).toEqual(['operationId', 'outcome', 'actualBefore', 'actualAfter', 'force', 'error'].sort());

    const encoded = current.encode(validated.value);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    expect(encoded.value.endsWith('\n')).toBeFalse();
    expect(JSON.parse(encoded.value)).toEqual(candidate);

    const changedImage = structuredClone(candidate) as Record<string, unknown>;
    const changedResult = (changedImage.results as Record<string, unknown>[])[0];
    if (changedResult === undefined) throw new Error('changed-image result is unavailable');
    changedResult.actualAfter = {
      ...(changedResult.actualAfter as Record<string, unknown>),
      classification: 'pinned',
    };
    expect(current.validate(changedImage).ok).toBeFalse();

    const unknownField = structuredClone(candidate) as Record<string, unknown>;
    const unknownResult = (unknownField.results as Record<string, unknown>[])[0];
    if (unknownResult === undefined) throw new Error('unknown-field result is unavailable');
    unknownResult.legacy = true;
    expect(current.validate(unknownField).ok).toBeFalse();
  });

  test('maps a constructor-created skipped runtime result through the public flip@4 boundary', async () => {
    const surface = await loadFlipV4Surface();
    if (surface === null) return;
    const mapper = Reflect.get(surface, 'toFlipV4Dto');
    expect(typeof mapper, 'flip@4 must publish toFlipV4Dto').toBe('function');
    if (typeof mapper !== 'function') return;

    const report = createSkippedRuntimeReport();
    if (report === null) return;
    let dto: unknown = null;
    let mapperError: unknown = null;
    try {
      dto = Reflect.apply(mapper, undefined, [report]);
    } catch (error) {
      mapperError = error;
    }
    expect(mapperError, 'toFlipV4Dto must accept the fifth execution outcome').toBeNull();
    expect(isRecord(dto)).toBeTrue();
    if (!isRecord(dto)) return;
    const dtoResults = Array.isArray(dto.results) ? dto.results.filter(isRecord) : [];
    expect(dtoResults).toHaveLength(1);
    expect(dtoResults[0]).toMatchObject({
      outcome: 'skipped-after-failure',
      force: null,
      error: null,
    });
    expect(dtoResults[0]?.actualAfter).toEqual(dtoResults[0]?.actualBefore);
    expect(Object.keys(dtoResults[0] ?? {}).sort()).toEqual(
      ['operationId', 'outcome', 'actualBefore', 'actualAfter', 'force', 'error'].sort(),
    );

    const codec = Reflect.get(surface, 'flipV4Codec');
    expect(isRecord(codec)).toBeTrue();
    if (!isRecord(codec) || typeof codec.validate !== 'function') return;
    expect(Reflect.apply(codec.validate, codec, [dto])).toMatchObject({ ok: true });

    const changed = structuredClone(dto) as UnknownRecord;
    const changedResults = Array.isArray(changed.results) ? changed.results.filter(isRecord) : [];
    const changedResult = changedResults[0];
    expect(changedResult).toBeDefined();
    if (changedResult === undefined || !isRecord(changedResult.actualAfter)) return;
    changedResult.actualAfter.classification = 'pinned';
    expect(Reflect.apply(codec.validate, codec, [changed])).toMatchObject({ ok: false });
  });
});
