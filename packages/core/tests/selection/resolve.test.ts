import { describe, expect, test } from 'bun:test';
import { resolveTargetSelection, validateSelectionRequest } from '../../src/selection/resolve.ts';

const candidates = [
  {
    name: 'review',
    tool: 'codex',
    scope: 'user',
    path: '/user/review',
    capabilities: ['read', 'dev'],
    exists: true,
  },
  {
    name: 'review',
    tool: 'codex',
    scope: 'project',
    path: '/project/review',
    capabilities: ['read', 'dev'],
    exists: true,
  },
  {
    name: 'new-skill',
    tool: 'codex',
    scope: 'project',
    path: '/project/new-skill',
    capabilities: ['dev'],
    exists: false,
  },
] as const;

const policy = {
  requiresSelection: true,
  allowBoundedDefault: false,
  allowAbsentCreate: false,
  allowedTools: ['codex'],
  allowedScopes: ['user', 'project'],
  allowedCapabilities: ['read', 'dev'],
} as const;

const validate = (targets: readonly string[], scopes: readonly ('user' | 'project')[]) => {
  const result = validateSelectionRequest({ targets, all: false, scopes }, policy);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('target selection', () => {
  test('applies scope before exact-name resolution and preserves explicit provenance', () => {
    const result = resolveTargetSelection(candidates, validate(['review'], ['project']));
    expect(result).toMatchObject({
      ok: true,
      value: {
        selectionSource: 'explicit-targets',
        outcome: 'selected',
        selected: [{ path: '/project/review' }],
      },
    });
  });

  test('never widens an unmatched or absent explicit target into bulk selection', () => {
    const unmatched = resolveTargetSelection(candidates, validate(['missing'], ['project']));
    expect(unmatched).toMatchObject({
      ok: false,
      error: { code: 'unmatched', targets: ['missing'], exitCode: 2 },
    });

    const absent = resolveTargetSelection(candidates, validate(['new-skill'], ['project']));
    expect(absent).toMatchObject({
      ok: false,
      error: { code: 'unmatched', targets: ['new-skill'], exitCode: 2 },
    });
  });

  test('distinguishes unknown tools from known-but-disallowed tools', () => {
    expect(
      validateSelectionRequest({ targets: ['review'], all: false, tools: ['ghost'] }, policy),
    ).toMatchObject({ ok: false, error: { code: 'invalid-enum', exitCode: 2 } });
    expect(
      validateSelectionRequest({ targets: ['review'], all: false, tools: ['claude-code'] }, policy),
    ).toMatchObject({ ok: false, error: { code: 'capability', exitCode: 4 } });
  });
});
