import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';
import { CURRENT_APPLICATION_SERVICES } from '../../../packages/core/src/application/current-services.ts';
import {
  UPDATE_SECRET_CANARIES,
  type UpdateCliProduct,
  type UpdateFleet,
  createUpdateFleet,
  destroyUpdateFleet,
  pushFactorUpdateCandidate,
  runUpdateCli,
  runUpdateCliWithSignal,
  snapshotUpdateState,
} from '../fixtures/p5-update/fleet.ts';

setDefaultTimeout(90_000);

type UpdateReport = Record<string, unknown>;

const reportOf = (product: UpdateCliProduct, exitCode: number): UpdateReport => {
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(exitCode);
  expect(product.stderr).toBe('');
  const report: unknown = JSON.parse(product.stdout);
  expect(report).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.update',
    command: 'update',
  });
  return report as UpdateReport;
};

const exactPlan = (report: UpdateReport) => ({
  artifactPair: report.artifactPair,
  selection: report.selection,
  candidates: report.candidates,
  operations: report.operations,
  checks: report.checks,
  diagnostics: report.diagnostics,
});

describe('EWP-P5-TS02', () => {
  test('EWP-P5-TS02 — update check, dry-run, and execution share one matrix', async () => {
    const fleets: UpdateFleet[] = [];
    const fleet = async (
      options: Parameters<typeof createUpdateFleet>[0] = {},
    ): Promise<UpdateFleet> => {
      const value = await createUpdateFleet(options);
      fleets.push(value);
      return value;
    };
    const run = async (
      selected: UpdateFleet,
      args: readonly string[],
      exitCode = 0,
    ): Promise<UpdateReport> =>
      reportOf(await runUpdateCli(selected, [...args, '--json']), exitCode);

    try {
      expect(
        {
          commandSpec: CURRENT_COMMAND_SPECS.some((spec) => spec.path === 'skillsmith update'),
          applicationService: Object.hasOwn(CURRENT_APPLICATION_SERVICES, 'update'),
        },
        'update CommandSpec/application service boundary is absent',
      ).toEqual({ commandSpec: true, applicationService: true });

      const base = await fleet();
      const before = await snapshotUpdateState(base);
      const checked = await run(base, ['update', 'factor-scan', '--check'], 7);
      const dry = await run(base, ['update', 'factor-scan', '--dry-run']);
      expect(checked).toMatchObject({
        mode: 'check',
        state: 'changes-available',
        selection: { selectionSource: 'explicit-targets' },
        candidates: [{ skill: 'factor-scan', outcome: 'available', transition: 'preserve' }],
      });
      expect(dry).toMatchObject({ mode: 'dry-run', state: 'ready' });
      expect(exactPlan(dry)).toEqual(exactPlan(checked));
      expect(await snapshotUpdateState(base)).toEqual(before);

      const codexOnly = await run(base, ['update', 'factor-scan', '--tool', 'codex', '--dry-run']);
      expect(codexOnly).toMatchObject({
        groups: [{ skill: 'factor-scan', tools: ['codex'], outcome: 'planned' }],
      });
      const bulk = await run(base, ['update', '--all', '--dry-run']);
      expect(bulk).toMatchObject({
        selection: { selectionSource: 'explicit-all', skills: ['factor-scan', 'review'] },
        candidates: [
          { skill: 'factor-scan', outcome: 'available' },
          { skill: 'review', outcome: 'skipped-fixed' },
        ],
      });
      const explicit = await run(base, [
        'update',
        'factor-scan',
        '--file',
        base.manifest,
        '--lockfile',
        base.lock,
        '--dry-run',
      ]);
      expect(explicit).toMatchObject({
        artifactPair: {
          manifestPath: base.manifest,
          lockPath: base.lock,
          lockSource: 'explicit',
          selectionSource: 'explicit',
        },
      });
      expect(await snapshotUpdateState(base)).toEqual(before);

      const executed = await run(base, ['update', 'factor-scan']);
      expect(executed).toMatchObject({
        mode: 'execute',
        state: 'completed',
        groups: [{ skill: 'factor-scan', outcome: 'succeeded' }],
      });
      expect(exactPlan(executed)).toEqual(exactPlan(dry));
      expect(await snapshotUpdateState(base)).not.toEqual(before);
      expect(await run(base, ['update', 'factor-scan', '--check'])).toMatchObject({
        state: 'current',
        candidates: [{ skill: 'factor-scan', outcome: 'current' }],
        operations: [],
      });
      expect(await run(base, ['update', 'factor-scan'])).toMatchObject({
        state: 'current',
        operations: [],
        approval: { required: false, outcome: 'not-required' },
      });

      const refs = await fleet();
      expect(await run(refs, ['update', 'review', '--ref', 'main', '--dry-run'])).toMatchObject({
        candidates: [
          {
            skill: 'review',
            transition: 'track',
            proposed: { requestedRef: 'main', kind: 'branch' },
          },
        ],
      });
      expect(
        await run(refs, [
          'update',
          'review',
          '--ref',
          refs.remote.multiAnnotatedTag,
          '--pin',
          '--dry-run',
        ]),
      ).toMatchObject({
        candidates: [
          {
            skill: 'review',
            transition: 'pin',
            proposed: {
              requestedRef: refs.remote.multiAnnotatedCommit,
              resolvedSha: refs.remote.multiAnnotatedCommit,
              kind: 'tag',
            },
          },
        ],
      });

      const warning = await fleet();
      await pushFactorUpdateCandidate(warning, 'not frontmatter\n');
      const warningBefore = await snapshotUpdateState(warning);
      expect(await run(warning, ['update', 'factor-scan', '--dry-run'])).toMatchObject({
        state: 'ready',
        groups: [
          {
            verification: [
              { tool: 'claude-code', gate: 'warned' },
              { tool: 'codex', gate: 'passed' },
            ],
          },
        ],
      });
      expect(
        await run(warning, ['update', 'factor-scan', '--strict', '--dry-run'], 1),
      ).toMatchObject({
        state: 'partial',
        groups: [{ outcome: 'failed', failure: { code: 'update-verification-blocked' } }],
      });
      expect(await snapshotUpdateState(warning)).toEqual(warningBefore);

      const partial = await fleet({ reviewMoving: true, reviewSourceMissing: true });
      const partialBefore = await snapshotUpdateState(partial);
      expect(
        await run(partial, ['update', '--all', '--continue-on-error', '--dry-run'], 1),
      ).toMatchObject({
        state: 'partial',
        candidates: [
          { skill: 'factor-scan', outcome: 'available' },
          { skill: 'review', outcome: 'failed' },
        ],
        groups: [
          { skill: 'factor-scan', outcome: 'planned' },
          { skill: 'review', outcome: 'failed' },
        ],
      });
      expect(await snapshotUpdateState(partial)).toEqual(partialBefore);

      const content = await fleet();
      const contentBefore = await run(content, ['update', 'factor-scan', '--check'], 7);
      const oldContentHash = (
        contentBefore.candidates as readonly { proposed: { contentHash: string } }[]
      )[0]?.proposed.contentHash;
      const nextSha = await pushFactorUpdateCandidate(
        content,
        '---\nname: factor-scan\ndescription: phase matrix content change\n---\n\n# changed\n',
      );
      const changedContent = await run(content, ['update', 'factor-scan', '--check'], 7);
      expect(changedContent).toMatchObject({
        candidates: [{ proposed: { resolvedSha: nextSha } }],
      });
      expect(
        (changedContent.candidates as readonly { proposed: { contentHash: string } }[])[0]?.proposed
          .contentHash,
      ).not.toBe(oldContentHash);

      const cancelled = await fleet();
      const cancelledBefore = await snapshotUpdateState(cancelled);
      const cancelledProduct = await runUpdateCliWithSignal(cancelled, [
        'update',
        'factor-scan',
        '--json',
      ]);
      expect(cancelledProduct.exitCode).toBe(130);
      expect(await snapshotUpdateState(cancelled)).toEqual(cancelledBefore);

      for (const product of [
        JSON.stringify(checked),
        JSON.stringify(dry),
        JSON.stringify(executed),
        cancelledProduct.stdout,
        cancelledProduct.stderr,
      ]) {
        for (const canary of UPDATE_SECRET_CANARIES) expect(product).not.toContain(canary);
      }
    } finally {
      await Promise.all(fleets.map(destroyUpdateFleet));
    }
  });
});
