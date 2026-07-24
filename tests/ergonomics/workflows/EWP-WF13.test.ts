import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  type CurrentMutatorCommand,
  type ExecutableOperation,
  type OperationPlan,
  createOperationExecutionResult,
  scheduleOperationPlan,
} from '../../../packages/core/src/index.ts';
import {
  createBatchFleet,
  destroyBatchFleet,
  parseBatchJson,
  runBatchCli,
  snapshotBatchState,
} from '../fixtures/p5-batch/fleet.ts';

setDefaultTimeout(90_000);

describe('EWP-WF13', () => {
  test('EWP-WF13 — continuation preserves independent group truth and no-write preview', async () => {
    const matrixFleet = await createBatchFleet();
    try {
      const preview = parseBatchJson(
        await runBatchCli(matrixFleet, ['update', 'factor-scan', '--dry-run', '--json']),
      );
      const normalizeImage = (image: ExecutableOperation['before']) =>
        image.kind === 'placement' && image.source === null
          ? Object.freeze({ ...image, contentHash: null })
          : image;
      const operations: readonly ExecutableOperation[] = (
        preview.operations as readonly ExecutableOperation[]
      ).map(
        (operation) =>
          Object.freeze({
            ...operation,
            before: normalizeImage(operation.before),
            after: normalizeImage(operation.after),
            dependencyMetadata: Object.freeze({
              domain: 'skillsmith.operation-dependency' as const,
              schemaVersion: 1 as const,
              operationIds: operation.dependsOn,
            }),
          }) as ExecutableOperation,
      );
      const pairOperations = operations.filter(({ pairId }) => pairId !== null);
      expect(pairOperations.map(({ tool }) => tool)).toEqual(['claude-code', 'codex']);
      const commands = ['install', 'apply', 'sync', 'update', 'promote'] as const;
      const directions = ['claude-code', 'codex'] as const;
      const plan = (
        command: CurrentMutatorCommand,
        batchPolicy: OperationPlan['batchPolicy'],
      ): OperationPlan => ({
        domain: 'skillsmith.operation-plan',
        schemaVersion: 1,
        command,
        selection: {
          source: 'explicit-all',
          outcome: 'selected',
          targets: [],
          all: true,
          skills: ['factor-scan'],
          tools: ['claude-code', 'codex'],
          scopes: ['project'],
          groupIds: [...new Set(operations.map(({ groupId }) => groupId))],
        },
        batchPolicy,
        operations,
        checks: [],
        diagnostics: [],
      });
      const bindings = (failingTool: (typeof directions)[number] | null) =>
        operations.map((operation) => ({
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: operation.pairId,
          actualBefore: operation.before,
          unstartedForce: null,
          execute: async () => {
            const failed = operation.pairId !== null && operation.tool === failingTool;
            return createOperationExecutionResult({
              operationId: operation.operationId,
              outcome: failed ? 'failed' : 'succeeded',
              actualBefore: operation.before,
              actualAfter: failed ? operation.before : operation.after,
              force: null,
              error: failed
                ? {
                    code: `injected-${operation.tool}-failure`,
                    message: `deterministic ${operation.tool} matrix failure`,
                    remediation: 'rerun the same selection after correcting the failed tool',
                  }
                : null,
            });
          },
        }));

      for (const command of commands) {
        for (const failingTool of directions) {
          const continued = await scheduleOperationPlan(
            plan(command, 'continue-on-error'),
            bindings(failingTool),
          );
          const pairOutcomes = new Map(
            continued.flatMap((result) => {
              const operation = pairOperations.find(
                ({ operationId }) => operationId === result.operationId,
              );
              return operation?.tool === null || operation?.tool === undefined
                ? []
                : [[operation.tool, result.outcome] as const];
            }),
          );
          expect(pairOutcomes, `${command}/${failingTool}/continued`).toEqual(
            new Map([
              ['claude-code', failingTool === 'claude-code' ? 'failed' : 'succeeded'],
              ['codex', failingTool === 'codex' ? 'failed' : 'succeeded'],
            ]),
          );
          expect(continued.some(({ outcome }) => outcome === 'failed')).toBeTrue();

          const rerun = await scheduleOperationPlan(
            plan(command, 'continue-on-error'),
            bindings(null),
          );
          expect(rerun.every(({ outcome }) => outcome === 'succeeded')).toBeTrue();
        }
      }
    } finally {
      await destroyBatchFleet(matrixFleet);
    }

    const fleet = await createBatchFleet({ reviewMoving: true, reviewSourceMissing: true });
    try {
      const before = await snapshotBatchState(fleet);
      const report = parseBatchJson(
        await runBatchCli(fleet, ['update', '--all', '--continue-on-error', '--dry-run', '--json']),
        1,
      );
      expect(report).toMatchObject({
        state: 'partial',
        options: { continueOnError: true },
        groups: [
          { skill: 'factor-scan', outcome: 'planned' },
          { skill: 'review', outcome: 'failed' },
        ],
      });
      expect(await snapshotBatchState(fleet)).toEqual(before);
    } finally {
      await destroyBatchFleet(fleet);
    }
  });
});
