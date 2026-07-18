import type { CurrentApplicationContext } from '../application/types.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import {
  type ArtifactReadResult,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
} from '../artifacts/repository.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import type { ProjectContext } from '../context/types.ts';
import { readSkillInventory } from '../inventory/read.ts';
import type { SkillInventory } from '../inventory/types.ts';
import { ledgerPathOf, resolveDataDir } from '../place/paths.ts';
import { type Result, err, ok } from '../result.ts';
import type { ExportFailure, ExportRequest } from './types.ts';

export interface ExportObservation {
  readonly project: ProjectContext;
  readonly request: ExportRequest;
  readonly pair: ResolvedArtifactPair | null;
  readonly inventory: SkillInventory;
  readonly ledger: ArtifactReadResult<LedgerModel>;
  readonly ledgerPath: string;
  readonly manifest: ArtifactReadResult<NormalizedManifestV1> | null;
  readonly lock: ArtifactReadResult<PortableLockV1> | null;
}

const failure = (
  code: string,
  message: string,
  exitClass: ExportFailure['exitClass'],
): Result<never, ExportFailure> => err(Object.freeze({ code, message, exitClass }));

const repositoryFailure = (
  role: 'manifest' | 'lock' | 'ledger',
  error: Readonly<{ readonly reason: string }>,
): Result<never, ExportFailure> =>
  failure(
    `export-${role}-state`,
    `${role} state is unavailable or invalid`,
    error.reason === 'permission-denied' ? 'permission' : 'state',
  );

export const observeExport = async (
  context: CurrentApplicationContext,
  project: ProjectContext,
  request: ExportRequest,
  pair: ResolvedArtifactPair | null,
): Promise<Result<ExportObservation, ExportFailure>> => {
  try {
    const inventory = await readSkillInventory(context.ports, {
      tools: request.tools,
      scopes: [request.scope],
      cwd: project.projectRoot ?? project.effectiveCwd,
      configuration: context.configuration,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      observation: context.observation,
    });
    if (!inventory.ok) {
      return failure(
        'export-inventory',
        'selected live inventory could not be read',
        inventory.error.code === 'permission-denied' ? 'permission' : 'state',
      );
    }

    const ledgerPath = ledgerPathOf(resolveDataDir(context.ports, context.configuration));
    const ledger = await readLedgerArtifact(context.ports, ledgerPath);
    if (!ledger.ok) return repositoryFailure('ledger', ledger.error);

    let manifest: ArtifactReadResult<NormalizedManifestV1> | null = null;
    let lock: ArtifactReadResult<PortableLockV1> | null = null;
    if (pair !== null) {
      const [manifestRead, lockRead] = await Promise.all([
        readManifestArtifact(context.ports, pair.file.path),
        readLockArtifact(context.ports, pair.lockfile.path),
      ]);
      if (!manifestRead.ok) return repositoryFailure('manifest', manifestRead.error);
      if (!lockRead.ok) return repositoryFailure('lock', lockRead.error);
      manifest = manifestRead.value;
      lock = lockRead.value;
    }

    return ok(
      Object.freeze({
        project,
        request,
        pair,
        inventory: inventory.value,
        ledger: ledger.value,
        ledgerPath,
        manifest,
        lock,
      }),
    );
  } catch (error) {
    if (context.signal?.aborted) {
      return failure('export-cancelled', 'export was cancelled', 'cancelled');
    }
    return failure(
      'export-observation',
      error instanceof Error ? error.message : 'export observation failed',
      'failure',
    );
  }
};
