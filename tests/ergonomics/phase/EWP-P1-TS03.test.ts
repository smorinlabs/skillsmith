import { describe, expect, test } from 'bun:test';
import {
  resolveTargetSelection,
  validateSelectionRequest,
} from '../../../packages/core/src/selection/resolve.ts';

const candidates = [
  {
    name: 'review',
    tool: 'codex',
    scope: 'user',
    path: '/home/alice/.codex/skills/review',
    capabilities: ['read', 'dev', 'promote', 'undo'],
    exists: true,
  },
  {
    name: 'review',
    tool: 'codex',
    scope: 'project',
    path: '/work/acme/.codex/skills/review',
    capabilities: ['read', 'dev', 'promote', 'undo'],
    exists: true,
  },
  {
    name: 'lint',
    tool: 'claude-code',
    scope: 'project',
    path: '/work/acme/.claude/skills/lint',
    capabilities: ['read', 'dev', 'promote', 'undo'],
    exists: true,
  },
  {
    name: 'new-skill',
    tool: 'codex',
    scope: 'project',
    path: '/work/acme/.codex/skills/new-skill',
    capabilities: ['dev'],
    exists: false,
  },
] as const;

const writablePolicy = {
  requiresSelection: true,
  allowBoundedDefault: false,
  allowAbsentCreate: false,
  allowedTools: ['claude-code', 'codex'],
  allowedScopes: ['user', 'project'],
  allowedCapabilities: ['dev', 'promote', 'undo'],
} as const;

const validate = (
  request: Parameters<typeof validateSelectionRequest>[0],
  policy: Parameters<typeof validateSelectionRequest>[1] = writablePolicy,
) => {
  const result = validateSelectionRequest(request, policy);
  if (!result.ok) throw new Error(`unexpected validation failure: ${result.error.code}`);
  return result.value;
};

const selectedPaths = (result: ReturnType<typeof resolveTargetSelection>): readonly string[] => {
  if (!result.ok) throw new Error(`unexpected resolution failure: ${result.error.code}`);
  return result.value.selected.map((candidate) => candidate.path);
};

describe('EWP-P1-TS03', () => {
  test('unknown enums are usage errors while known unsupported capabilities are exit 4', () => {
    const cases = [
      {
        label: 'unknown tool',
        request: { targets: ['review'], all: false, tools: ['ghost-tool'] },
        code: 'invalid-enum',
        exitCode: 2,
      },
      {
        label: 'known read-only tool used for mutation',
        request: { targets: ['review'], all: false, tools: ['kilo-code'] },
        code: 'capability',
        exitCode: 4,
      },
      {
        label: 'unknown scope',
        request: { targets: ['review'], all: false, scopes: ['workspace'] },
        code: 'invalid-enum',
        exitCode: 2,
      },
      {
        label: 'known read-only scope used for mutation',
        request: { targets: ['review'], all: false, scopes: ['managed'] },
        code: 'capability',
        exitCode: 4,
      },
      {
        label: 'unknown capability',
        request: { targets: ['review'], all: false, capability: 'teleport' },
        code: 'invalid-enum',
        exitCode: 2,
      },
      {
        label: 'known but unsupported capability',
        request: { targets: ['review'], all: false, capability: 'read' },
        code: 'capability',
        exitCode: 4,
      },
    ] as const;

    for (const { label, request, code, exitCode } of cases) {
      const result = validateSelectionRequest(request, writablePolicy);
      expect(result.ok, label).toBeFalse();
      if (result.ok) throw new Error(`${label} unexpectedly passed`);
      expect(result.error).toMatchObject({ code, exitCode });
    }
  });

  test('each command family uses typed policy validation instead of string casts', () => {
    const families = [
      {
        commands: ['agents', 'list', 'commands', 'status', 'doctor', 'check'],
        policy: {
          ...writablePolicy,
          requiresSelection: false,
          allowBoundedDefault: true,
          allowedTools: ['claude-code', 'codex', 'kilo-code', 'opencode'],
          allowedScopes: ['user', 'project', 'system', 'managed'],
          allowedCapabilities: ['read'],
        },
        request: { targets: [], all: false, tools: ['opencode'], capability: 'read' },
      },
      {
        commands: ['install', 'uninstall', 'dev', 'promote'],
        policy: writablePolicy,
        request: { targets: ['review'], all: false, tools: ['codex'], scopes: ['project'] },
      },
      {
        // These Phase-2+ commands remain declarative coverage obligations here. Their parsers and
        // handlers are intentionally not introduced by this Phase-1 shared-policy test.
        commands: ['init', 'export', 'plan', 'apply', 'sync', 'update', 'undo', 'gc'],
        policy: writablePolicy,
        request: { targets: ['review'], all: false, tools: ['codex'], scopes: ['project'] },
      },
    ] as const;

    for (const family of families) {
      for (const command of family.commands) {
        const result = validateSelectionRequest(family.request, family.policy);
        expect(result.ok, command).toBeTrue();
      }
    }
  });

  test('scope filtering precedes name and path resolution', () => {
    const projectByName = resolveTargetSelection(
      candidates,
      validate({ targets: ['review'], all: false, scopes: ['project'] }),
    );
    expect(selectedPaths(projectByName)).toEqual(['/work/acme/.codex/skills/review']);

    const contradictoryPath = resolveTargetSelection(
      candidates,
      validate({
        targets: ['/home/alice/.codex/skills/review'],
        all: false,
        scopes: ['project'],
      }),
    );
    expect(contradictoryPath.ok).toBeFalse();
    if (contradictoryPath.ok) throw new Error('scope/path disagreement unexpectedly passed');
    expect(contradictoryPath.error).toMatchObject({ code: 'unmatched', exitCode: 2 });
  });

  test('an unscoped same-name user/project target is ambiguous with stable candidates', () => {
    const result = resolveTargetSelection(
      candidates,
      validate({ targets: ['review'], all: false }),
    );
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('same-name cross-scope target unexpectedly passed');
    expect(result.error).toMatchObject({ code: 'ambiguous', exitCode: 2 });
    expect(result.error.candidates.map((candidate) => candidate.path)).toEqual([
      '/home/alice/.codex/skills/review',
      '/work/acme/.codex/skills/review',
    ]);
  });

  test('explicit scope and exact path identify the same canonical placement', () => {
    const scoped = resolveTargetSelection(
      candidates,
      validate({ targets: ['review'], all: false, scopes: ['project'] }),
    );
    const byPath = resolveTargetSelection(
      candidates,
      validate({ targets: ['/work/acme/.codex/skills/review'], all: false }),
    );
    expect(selectedPaths(scoped)).toEqual(['/work/acme/.codex/skills/review']);
    expect(selectedPaths(byPath)).toEqual(selectedPaths(scoped));
  });

  test('absent creation is accepted only by an explicit create policy and scope', () => {
    const request = {
      targets: ['new-skill'],
      all: false,
      tools: ['codex'],
      scopes: ['project'],
      capability: 'dev',
    } as const;

    const rejected = resolveTargetSelection(candidates, validate(request));
    expect(rejected.ok).toBeFalse();
    if (rejected.ok)
      throw new Error('absent candidate unexpectedly selected without create policy');
    expect(rejected.error).toMatchObject({ code: 'unmatched', exitCode: 2 });

    const accepted = resolveTargetSelection(
      candidates,
      validate(request, { ...writablePolicy, allowAbsentCreate: true }),
    );
    expect(selectedPaths(accepted)).toEqual(['/work/acme/.codex/skills/new-skill']);
    if (!accepted.ok) throw new Error('explicit absent create unexpectedly failed');
    expect(accepted.value.selected[0]).toMatchObject({
      name: 'new-skill',
      tool: 'codex',
      scope: 'project',
      exists: false,
    });
  });

  test('dev, promote, and downstream undo share exact name, path, and bulk selection', () => {
    const scenarios = [
      { request: { targets: ['lint'], all: false }, expected: ['/work/acme/.claude/skills/lint'] },
      {
        request: { targets: ['/work/acme/.codex/skills/review'], all: false },
        expected: ['/work/acme/.codex/skills/review'],
      },
      {
        request: { targets: [], all: true, scopes: ['project'] },
        expected: ['/work/acme/.codex/skills/review', '/work/acme/.claude/skills/lint'],
      },
    ] as const;

    for (const command of ['dev', 'promote', 'undo'] as const) {
      for (const scenario of scenarios) {
        const result = resolveTargetSelection(candidates, validate(scenario.request));
        expect(selectedPaths(result), `${command}: ${JSON.stringify(scenario.request)}`).toEqual(
          scenario.expected,
        );
        if (!result.ok) throw new Error(`${command} selection unexpectedly failed`);
        expect(result.value.selectionSource).toBe(
          scenario.request.all ? 'explicit-all' : 'explicit-targets',
        );
      }
    }
  });
});
