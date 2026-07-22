import { describe, expect, test } from 'bun:test';
import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LedgerModel } from '../../../packages/core/src/artifacts/ledger-types.ts';
import { type SyncReportV1Dto, syncV1Codec } from '../../../packages/core/src/contracts/v1/sync.ts';
import {
  SYNC_SECRET_CANARIES,
  type SyncFleet,
  createSyncFleet,
  destroySyncFleet,
  readSkillBytes,
  runSyncCli,
} from '../fixtures/p5-sync/fleet.ts';

const report = async (
  fleet: SyncFleet,
  args: readonly string[],
  expectedExit = 0,
): Promise<SyncReportV1Dto> => {
  const product = await runSyncCli(fleet, [...args, '--json']);
  expect(product.exitCode, `${product.stderr}\n${product.stdout}`).toBe(expectedExit);
  const decoded = syncV1Codec.decode(product.stdout);
  expect(decoded.ok, product.stdout).toBeTrue();
  if (!decoded.ok) throw new Error(decoded.error.message);
  for (const canary of SYNC_SECRET_CANARIES) {
    expect(`${product.stdout}${product.stderr}`).not.toContain(canary);
  }
  return decoded.value;
};

const exists = async (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('EWP-P5-TS01', () => {
  test('EWP-P5-TS01 — direct endpoint matrix is bounded and source-read-only', async () => {
    const fleet = await createSyncFleet();
    try {
      const sourcePaths = [
        fleet.skills.userLint,
        fleet.skills.userReview,
        fleet.skills.userClaudeReview,
        fleet.skills.projectALint,
        fleet.skills.projectAReview,
        fleet.skills.projectAClaudeReview,
        fleet.skills.managedClaudePolicy,
      ] as const;
      const sourceBefore = await Promise.all(sourcePaths.map(readSkillBytes));
      expect(await exists(join(fleet.projects.c, '.agents', 'skills', 'lint'))).toBeFalse();

      const endpointMatrix = [
        {
          args: [
            'sync',
            '--from',
            'user',
            '--to',
            fleet.projects.c,
            '--tool',
            'codex',
            '--dry-run',
          ],
          from: { scope: 'user', projectRoot: null },
          to: { scope: 'project', projectRoot: fleet.projects.c },
          source: 'bounded-default',
          outcome: 'selected',
        },
        {
          args: ['sync', '--from', 'project', '--to', 'user', '--tool', 'codex', '--dry-run'],
          from: { scope: 'project', projectRoot: fleet.projects.current },
          to: { scope: 'user', projectRoot: null },
          source: 'bounded-default',
          outcome: 'filter-noop',
        },
        {
          args: [
            'sync',
            '--from',
            'system',
            '--to',
            fleet.projects.c,
            '--tool',
            'codex',
            '--dry-run',
          ],
          from: { scope: 'system', projectRoot: null },
          to: { scope: 'project', projectRoot: fleet.projects.c },
          source: 'bounded-default',
          outcome: 'filter-noop',
        },
        {
          args: [
            'sync',
            'policy',
            '--from',
            'managed',
            '--to',
            fleet.projects.c,
            '--tool',
            'claude-code',
            '--dry-run',
          ],
          from: { scope: 'managed', projectRoot: null },
          to: { scope: 'project', projectRoot: fleet.projects.c },
          source: 'explicit-targets',
          outcome: 'selected',
        },
        {
          args: [
            'sync',
            'lint',
            '--from',
            fleet.projects.a,
            '--to',
            fleet.projects.b,
            '--tool',
            'codex',
            '--dry-run',
          ],
          from: { scope: 'project', projectRoot: fleet.projects.a },
          to: { scope: 'project', projectRoot: fleet.projects.b },
          source: 'explicit-targets',
          outcome: 'selected',
        },
        {
          args: [
            'sync',
            'lint',
            '--from',
            fleet.projects.a,
            '--to',
            fleet.projects.c,
            '--tool',
            'codex',
            '--dry-run',
          ],
          from: { scope: 'project', projectRoot: fleet.projects.a },
          to: { scope: 'project', projectRoot: fleet.projects.c },
          source: 'explicit-targets',
          outcome: 'selected',
        },
        {
          args: [
            'sync',
            'lint',
            '--from',
            fleet.projects.c,
            '--to',
            fleet.projects.a,
            '--tool',
            'codex',
            '--dry-run',
          ],
          from: { scope: 'project', projectRoot: fleet.projects.c },
          to: { scope: 'project', projectRoot: fleet.projects.a },
          source: 'explicit-targets',
          outcome: 'filter-noop',
        },
        {
          args: [
            'sync',
            'review',
            '--from',
            fleet.projects.bAlias,
            '--to',
            fleet.projects.c,
            '--tool',
            'codex',
            '--dry-run',
          ],
          from: { scope: 'project', projectRoot: fleet.projects.b },
          to: { scope: 'project', projectRoot: fleet.projects.c },
          source: 'explicit-targets',
          outcome: 'selected',
        },
      ] as const;

      for (const row of endpointMatrix) {
        const product = await report(fleet, row.args);
        expect(product).toMatchObject({
          mode: 'dry-run',
          endpoints: { from: row.from, to: row.to },
          selection: {
            selectionSource: row.source,
            selectionOutcome: row.outcome,
          },
        });
      }

      const toolMatrix = await report(fleet, [
        'sync',
        'review',
        '--from',
        fleet.projects.a,
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
        '--tool',
        'claude-code',
        '--dry-run',
      ]);
      expect(toolMatrix.selection.tools).toEqual(['claude-code', 'codex']);
      expect(toolMatrix.groups[0]?.pairs.map(({ tool }) => tool)).toEqual(['claude-code', 'codex']);
      for (const tool of ['kilo-code', 'opencode'] as const) {
        const refusal = await report(
          fleet,
          ['sync', 'lint', '--from', 'user', '--to', fleet.projects.c, '--tool', tool, '--dry-run'],
          4,
        );
        expect(refusal).toMatchObject({
          state: 'refused',
          summary: { refusals: 1 },
        });
      }

      const absent = await report(fleet, [
        'sync',
        'absent',
        '--from',
        fleet.projects.a,
        '--to',
        fleet.projects.b,
        '--tool',
        'codex',
        '--force',
        '--delete',
        '--dry-run',
      ]);
      expect(absent).toMatchObject({
        selection: {
          selectionSource: 'explicit-targets',
          selectionOutcome: 'filter-noop',
        },
        summary: { groups: 0, pairs: 0, changed: 0 },
      });
      expect(absent.operations).toHaveLength(0);
      expect(await exists(fleet.skills.projectBExtra)).toBeTrue();

      const savePreview = await report(fleet, [
        'sync',
        'lint',
        '--from',
        fleet.projects.a,
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
        '--save',
        '--file',
        fleet.artifacts.explicitManifest,
        '--lockfile',
        fleet.artifacts.explicitLock,
        '--dry-run',
      ]);
      expect(savePreview).toMatchObject({
        options: { save: true },
        artifactPair: { selectionSource: 'explicit', lockSource: 'explicit' },
      });
      expect(await exists(fleet.artifacts.explicitManifest)).toBeFalse();
      expect(await exists(fleet.artifacts.explicitLock)).toBeFalse();
      const executed = await report(fleet, [
        'sync',
        'lint',
        '--from',
        fleet.projects.a,
        '--to',
        fleet.projects.c,
        '--tool',
        'codex',
        '--yes',
      ]);
      expect(executed).toMatchObject({
        mode: 'execute',
        state: 'completed',
        options: { save: false },
        summary: { changed: 1 },
      });
      expect(await readSkillBytes(join(fleet.projects.c, '.agents', 'skills', 'lint'))).toEqual(
        sourceBefore[3],
      );
      const ledger = JSON.parse(await readFile(fleet.ledger, 'utf8')) as LedgerModel;
      expect(Object.keys(ledger.projects).sort()).toEqual(
        [fleet.projects.a, fleet.projects.c].sort(),
      );
      expect(ledger.projects).not.toHaveProperty(fleet.projects.bAlias);
      expect(ledger.projects).not.toHaveProperty(fleet.projects.current);

      const aliasSame = await runSyncCli(fleet, [
        'sync',
        '--from',
        fleet.projects.b,
        '--to',
        fleet.projects.bAlias,
        '--tool',
        'codex',
        '--dry-run',
        '--json',
      ]);
      expect(aliasSame.exitCode).toBe(2);
      expect(JSON.parse(aliasSame.stdout)).toMatchObject({
        kind: 'error',
        exitCode: 2,
      });
      for (const canary of SYNC_SECRET_CANARIES) {
        expect(`${aliasSame.stdout}${aliasSame.stderr}`).not.toContain(canary);
      }

      const sourceAfter = await Promise.all(sourcePaths.map(readSkillBytes));
      expect(sourceAfter).toEqual(sourceBefore);

      const userDestinationFleet = await createSyncFleet();
      try {
        const projectLintBefore = await readSkillBytes(userDestinationFleet.skills.projectALint);
        const projectClaudeBefore = await readSkillBytes(
          userDestinationFleet.skills.projectAClaudeReview,
        );
        const managedBefore = await readSkillBytes(userDestinationFleet.skills.managedClaudePolicy);

        const systemToUser = await report(userDestinationFleet, [
          'sync',
          '--from',
          'system',
          '--to',
          'user',
          '--tool',
          'codex',
        ]);
        expect(systemToUser).toMatchObject({
          mode: 'execute',
          state: 'completed',
          endpoints: {
            from: { scope: 'system', projectRoot: null },
            to: { scope: 'user', projectRoot: null },
          },
          selection: { selectionOutcome: 'filter-noop' },
          summary: { groups: 0, changed: 0 },
        });

        const unsupportedSystemToUser = await runSyncCli(userDestinationFleet, [
          'sync',
          '--from',
          'system',
          '--to',
          'user',
          '--tool',
          'claude-code',
          '--json',
        ]);
        expect(unsupportedSystemToUser.exitCode).toBe(4);
        expect(JSON.parse(unsupportedSystemToUser.stdout)).toMatchObject({
          kind: 'error',
          code: 'tool-unavailable',
          exitCode: 4,
        });

        const managedToUser = await report(userDestinationFleet, [
          'sync',
          'policy',
          '--from',
          'managed',
          '--to',
          'user',
          '--tool',
          'claude-code',
        ]);
        expect(managedToUser).toMatchObject({
          mode: 'execute',
          state: 'completed',
          endpoints: {
            from: { scope: 'managed', projectRoot: null },
            to: { scope: 'user', projectRoot: null },
          },
          summary: { succeeded: 1, changed: 1 },
        });
        expect(
          await readSkillBytes(join(userDestinationFleet.home, '.claude', 'skills', 'policy')),
        ).toEqual(managedBefore);

        const managedCodexZero = await report(
          userDestinationFleet,
          ['sync', 'policy', '--from', 'managed', '--to', 'user', '--tool', 'codex', '--dry-run'],
          4,
        );
        expect(managedCodexZero).toMatchObject({
          state: 'refused',
          selection: { selectionOutcome: 'filter-noop', tools: ['codex'] },
          summary: { groups: 0, pairs: 0, refusals: 1 },
        });

        await rm(userDestinationFleet.skills.userLint, { recursive: true });
        const projectCodexToUser = await report(userDestinationFleet, [
          'sync',
          'lint',
          '--from',
          userDestinationFleet.projects.a,
          '--to',
          'user',
          '--tool',
          'codex',
        ]);
        expect(projectCodexToUser).toMatchObject({
          state: 'completed',
          summary: { succeeded: 1, changed: 1 },
        });
        expect(await readSkillBytes(userDestinationFleet.skills.userLint)).toEqual(
          projectLintBefore,
        );

        await rm(userDestinationFleet.skills.userClaudeReview, { recursive: true });
        const projectClaudeToUser = await report(userDestinationFleet, [
          'sync',
          'review',
          '--from',
          userDestinationFleet.projects.a,
          '--to',
          'user',
          '--tool',
          'claude-code',
        ]);
        expect(projectClaudeToUser).toMatchObject({
          state: 'completed',
          summary: { succeeded: 1, changed: 1 },
        });
        expect(await readSkillBytes(userDestinationFleet.skills.userClaudeReview)).toEqual(
          projectClaudeBefore,
        );

        const userToProject = await report(userDestinationFleet, [
          'sync',
          'lint',
          '--from',
          'user',
          '--to',
          userDestinationFleet.projects.c,
          '--tool',
          'codex',
        ]);
        expect(userToProject).toMatchObject({
          state: 'completed',
          endpoints: {
            from: { scope: 'user' },
            to: { scope: 'project', projectRoot: userDestinationFleet.projects.c },
          },
          summary: { succeeded: 1 },
        });

        const projectBToC = await report(userDestinationFleet, [
          'sync',
          'review',
          '--from',
          userDestinationFleet.projects.b,
          '--to',
          userDestinationFleet.projects.c,
          '--tool',
          'codex',
        ]);
        expect(projectBToC).toMatchObject({
          state: 'completed',
          endpoints: {
            from: { projectRoot: userDestinationFleet.projects.b },
            to: { projectRoot: userDestinationFleet.projects.c },
          },
          summary: { succeeded: 1 },
        });

        for (const tool of ['kilo-code', 'opencode'] as const) {
          const userRefusal = await report(
            userDestinationFleet,
            [
              'sync',
              'lint',
              '--from',
              userDestinationFleet.projects.a,
              '--to',
              'user',
              '--tool',
              tool,
            ],
            4,
          );
          expect(userRefusal).toMatchObject({
            state: 'refused',
            endpoints: { to: { scope: 'user' } },
            summary: { refusals: 1 },
          });
        }

        expect(await readSkillBytes(userDestinationFleet.skills.projectALint)).toEqual(
          projectLintBefore,
        );
        expect(await readSkillBytes(userDestinationFleet.skills.projectAClaudeReview)).toEqual(
          projectClaudeBefore,
        );
        expect(await readSkillBytes(userDestinationFleet.skills.managedClaudePolicy)).toEqual(
          managedBefore,
        );
        const userLedger = JSON.parse(
          await readFile(userDestinationFleet.ledger, 'utf8'),
        ) as LedgerModel;
        expect(userLedger.skills).toHaveProperty('lint.tools.codex');
        expect(userLedger.skills).toHaveProperty('review.tools.claude-code');
        expect(userLedger.skills).toHaveProperty('policy.tools.claude-code');
        expect(userLedger.projects).toHaveProperty(userDestinationFleet.projects.c);
        expect(userLedger.projects).not.toHaveProperty(userDestinationFleet.projects.bAlias);
      } finally {
        await destroySyncFleet(userDestinationFleet);
      }
    } finally {
      await destroySyncFleet(fleet);
    }
  }, 50_000);
});
