import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const checker = resolve(root, 'scripts/check-p17-package.ts');
const catalog = JSON.parse(readFileSync(resolve(root, 'projects/p17/catalog.json'), 'utf8')) as {
  readonly entities: readonly { readonly status: string; readonly tier: string }[];
  readonly groups: readonly {
    readonly id: string;
    readonly phase: string;
    readonly status: string;
    readonly gates: Readonly<Record<string, { readonly status: string }>>;
  }[];
  readonly phases: readonly { readonly id: string; readonly status: string }[];
  readonly finalReview: { readonly status: string };
  readonly finalApproval: { readonly status: string };
  readonly finalSignoff: { readonly status: string };
};

const lifecycleGateNames = [
  'mapped',
  'ready',
  'test-first',
  'minimal-implementation',
  'targeted-green',
  'impacted-green',
  'refactor',
  'adversarial-review',
  'traceability-closure',
  'signed-off',
] as const;

const expectedV1 =
  'structurally valid; preparation/PR/merge readiness was not asserted: 86 prep IDs, 25 local links, valid: 426 entities (419 required, 7 deferred; 244 validation obligations), 45 groups, deterministic checklist';

const run = (version?: '1' | '2' | 'invalid') =>
  Bun.spawnSync(['bun', checker, '--check'], {
    cwd: root,
    env: {
      ...process.env,
      ...(version === undefined ? {} : { P17_CHECK_OUTPUT_VERSION: version }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

describe('P17 package-check output compatibility', () => {
  test('v1 remains an exact one-line compatibility output', () => {
    const result = run('1');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe('');
    const output = result.stdout.toString().trimEnd();
    expect(output.split('\n')).toHaveLength(1);
    expect(output).toBe(expectedV1);
    expect(output).not.toContain('recorded progress:');
  });

  test('the atomic default selects v2 while preserving the complete v1 first line', () => {
    const before = run('1');
    const explicitV2 = run('2');
    const stable = run();
    const after = run('1');
    for (const result of [before, explicitV2, stable, after]) {
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toBe('');
    }

    const v1 = before.stdout.toString().trimEnd();
    const v2 = explicitV2.stdout.toString().trimEnd();
    expect(after.stdout.toString().trimEnd()).toBe(v1);
    expect(stable.stdout.toString().trimEnd()).toBe(v2);
    expect(v2.split('\n')[0]).toBe(v1);

    const requiredEntities = catalog.entities.filter((entity) => entity.tier !== 'deferred');
    const signedEntities = requiredEntities.filter(
      (entity) => entity.status === 'signed-off',
    ).length;
    const requiredGroups = catalog.groups.filter((group) => group.phase !== '7');
    const signedGroups = requiredGroups.filter((group) => group.status === 'signed-off').length;
    const requiredPhases = catalog.phases.filter((phase) => phase.id !== '7');
    const approvedPhases = requiredPhases.filter((phase) => phase.status === 'approved').length;
    expect(v2).toContain('recorded progress:');
    expect(v2).toContain(`phases:   ${approvedPhases}/${requiredPhases.length} approved`);
    expect(v2).toContain(
      `groups:   ${signedGroups}/${requiredGroups.length} required groups signed off`,
    );
    expect(v2).toContain(
      `entities: ${signedEntities}/${requiredEntities.length} required entities signed off`,
    );

    for (const group of requiredGroups.filter(
      (item) => !['planned', 'signed-off', 'deferred'].includes(item.status),
    )) {
      const passed = lifecycleGateNames.filter(
        (name) => group.gates[name]?.status === 'passed',
      ).length;
      const next = lifecycleGateNames.find((name) => group.gates[name]?.status !== 'passed');
      expect(v2).toContain(
        `current:  ${group.id} — ${group.status} — ${passed}/${lifecycleGateNames.length} lifecycle gates passed`,
      );
      if (next) expect(v2).toContain(`next:     ${group.id}:${next}`);
    }
    expect(v2).toContain(
      `final:    review ${catalog.finalReview.status}; approval ${catalog.finalApproval.status}; sign-off ${catalog.finalSignoff.status}`,
    );
  }, 55_000);

  test('an unknown output version fails closed', () => {
    const result = run('invalid');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'unsupported P17_CHECK_OUTPUT_VERSION invalid; use 1 or 2',
    );
  });
});
