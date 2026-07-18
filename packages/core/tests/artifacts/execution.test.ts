import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactCoordinatorPorts } from '../../src/artifacts/coordinator-types.ts';
import type { ArtifactGroupLockLease } from '../../src/artifacts/coordinator-types.ts';
import {
  artifactManifestImageFromBytesV1,
  createArtifactPairOperationControllerV1,
  withArtifactPairExecutionAuthority,
} from '../../src/artifacts/execution.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import type { ResolvedArtifactPair } from '../../src/artifacts/pair.ts';
import type { ExecutableOperation, OperationDigest } from '../../src/planning/types.ts';

const pairOf = (manifestPath: string, lockPath: string): ResolvedArtifactPair =>
  Object.freeze({
    file: Object.freeze({
      token: null,
      path: manifestPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfile: Object.freeze({
      token: null,
      path: lockPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfileSource: 'explicit' as const,
  });

describe('artifact pair execution authority', () => {
  test('keeps opaque init before-images out of the canonical pair-operation controller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-artifact-opaque-boundary-'));
    try {
      const manifestPath = join(root, 'skillsmith.toml');
      const pair = pairOf(manifestPath, join(root, 'skillsmith.lock'));
      const coordinator = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const candidate = new TextEncoder().encode('version = 1\n');
      const operation: ExecutableOperation = Object.freeze({
        operationId: 'operation:v1:opaque-fixture',
        groupId: 'operation-group:v1:opaque-fixture',
        pairId: null,
        kind: 'write-manifest',
        dependencyMetadata: Object.freeze({
          domain: 'skillsmith.operation-dependency',
          schemaVersion: 1,
          operationIds: Object.freeze([]),
        }),
        skill: null,
        source: null,
        tool: null,
        scope: null,
        before: Object.freeze({
          kind: 'opaque-manifest',
          location: Object.freeze({ kind: 'machine-bound', path: manifestPath }),
          shape: 'malformed',
          byteHash: `sha256:${'a'.repeat(64)}` as OperationDigest,
        }),
        after: artifactManifestImageFromBytesV1(manifestPath, candidate),
        reason: Object.freeze({ code: 'fixture', message: 'fixture' }),
        selectionSource: 'bounded-default',
        preconditionIds: Object.freeze([]),
        requiredCheckIds: Object.freeze([]),
        reversibility: Object.freeze({ kind: 'none', retentionResourceIds: [] as const }),
        mutates: Object.freeze({ live: false, manifest: true, lock: false, ledger: false }),
        conflict: null,
      });
      const controller = createArtifactPairOperationControllerV1({
        lease: Object.freeze({}) as ArtifactGroupLockLease,
        artifactCoordinator: coordinator,
        pair,
      });

      expect(() =>
        controller.bind(operation, {
          role: 'manifest',
          action: { kind: 'replace', bytes: candidate },
        }),
      ).toThrow(/path differs|before image is invalid/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('holds group then exact members then ledger and cleans unused scaffolding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-artifact-execution-'));
    try {
      const pair = pairOf(
        join(root, 'portable', 'nested', 'skillsmith.toml'),
        join(root, 'generated', 'nested', 'skillsmith.lock'),
      );
      const delegate = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const trace: string[] = [];
      const withFileLock: ArtifactCoordinatorPorts['withFileLock'] = async (
        target,
        options,
        operation,
      ) => {
        trace.push(`lock:${options.policy}:${target}`);
        try {
          return await delegate.withFileLock(target, options, operation);
        } finally {
          trace.push(`release:${options.policy}:${target}`);
        }
      };
      const coordinator: ArtifactCoordinatorPorts = Object.freeze({ ...delegate, withFileLock });
      const ledgerPath = join(root, 'state', 'placements.json');
      const value = await withArtifactPairExecutionAuthority(
        {
          artifactCoordinator: coordinator,
          lockPort: Object.freeze({
            withFileLock: async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
              trace.push(`lock:ledger:${path}`);
              try {
                return await operation();
              } finally {
                trace.push(`release:ledger:${path}`);
              }
            },
          }),
          pair,
          ledgerPath,
        },
        async () => {
          trace.push('operation');
          return 'held';
        },
      );

      expect(value).toBe('held');
      const central = trace.findIndex((item) => item.startsWith('lock:central:'));
      const members = trace
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.startsWith('lock:compatibility:'))
        .map(({ index }) => index);
      const ledger = trace.indexOf(`lock:ledger:${ledgerPath}`);
      const operation = trace.indexOf('operation');
      expect(central).toBeGreaterThanOrEqual(0);
      expect(members).toHaveLength(2);
      expect(members.every((index) => index > central && index < ledger)).toBeTrue();
      expect(ledger).toBeLessThan(operation);
      expect(trace.indexOf(`release:ledger:${ledgerPath}`)).toBeGreaterThan(operation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses descriptor alias and ancestor topology before taking any lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-artifact-topology-'));
    try {
      const coordinator = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      let locks = 0;
      await expect(
        withArtifactPairExecutionAuthority(
          {
            artifactCoordinator: coordinator,
            lockPort: Object.freeze({
              withFileLock: async <T>(_path: string, operation: () => Promise<T>): Promise<T> => {
                locks += 1;
                return operation();
              },
            }),
            pair: pairOf(join(root, 'portable'), join(root, 'portable', 'skillsmith.lock')),
            ledgerPath: join(root, 'placements.json'),
          },
          async () => undefined,
        ),
      ).rejects.toThrow('lock topology is unsafe');
      expect(locks).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
