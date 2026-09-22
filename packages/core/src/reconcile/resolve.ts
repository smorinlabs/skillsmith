import { join } from 'node:path';
import { resolveRemoteSource } from '../acquire/resolve.ts';
import type { AcquisitionPorts, InstallSourceTransport, SourceSpec } from '../acquire/types.ts';
import type { SupportedTool } from '../agents/types.ts';
import {
  hashManifestSemantics,
  hashSourceContentV1,
  projectSourceContent,
} from '../artifacts/index.ts';
import type { PortableLockSkillV1, PortableLockV1 } from '../artifacts/lock.ts';
import type { NormalizedManifestDeclaration } from '../artifacts/types.ts';
import { errorMessage, safeErrorCode } from '../errors.ts';
import { resolveDataDir, storeRootOf } from '../place/paths.ts';
import type { LedgerFile } from '../place/types.ts';
import { isPortError } from '../ports/errors.ts';
import type { ResolvedRuntimeConfiguration } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type {
  ObservedPlanArtifacts,
  PlanReconcileError,
  PlanSelectionRequest,
  ResolvedPlanDeclaration,
  ResolvedPlanInput,
} from './types.ts';

export interface PlanSourceResolutionRuntime {
  readonly ports: AcquisitionPorts;
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly signal?: AbortSignal;
  readonly transport?: InstallSourceTransport;
}

const EMPTY_LEDGER: LedgerFile = Object.freeze({
  schemaVersion: 1,
  kind: 'skillsmith.placements',
  updatedAt: '1970-01-01T00:00:00.000Z',
  skills: Object.freeze({}),
});

const sortedUnique = <T extends string>(values: readonly T[]): readonly T[] =>
  Object.freeze([...new Set(values)].sort()) as readonly T[];

const lockSource = (declaration: NormalizedManifestDeclaration): string =>
  `${declaration.source.host}/${declaration.source.repository}${
    declaration.source.path === null ? '' : `//${declaration.source.path}`
  }`;

const pinMatches = (
  declaration: NormalizedManifestDeclaration,
  pin: PortableLockSkillV1 | undefined,
): pin is PortableLockSkillV1 =>
  pin !== undefined &&
  pin.source === lockSource(declaration) &&
  (pin.requestedRef === declaration.ref || pin.resolvedSha === declaration.ref) &&
  pin.sourcePath === (declaration.source.path ?? '.');

const sourceSpecFor = (declaration: NormalizedManifestDeclaration): SourceSpec => {
  const canonicalSource = lockSource(declaration);
  return Object.freeze({
    identity: declaration.source,
    canonicalSource,
    canonicalInvocation: `${canonicalSource}${
      declaration.ref === null ? '' : `@${declaration.ref}`
    }`,
    originSource: canonicalSource,
    cloneUrl: `https://${declaration.source.host}/${declaration.source.repository}.git`,
    selector: { kind: 'path', path: declaration.source.path ?? '' } as const,
    ref: declaration.ref,
  });
};

const sourceError = (code: string, message: string): PlanReconcileError => ({
  code,
  message,
  exitClass: 'source',
});

const cancelled = (): PlanReconcileError => ({
  code: 'plan-cancelled',
  message: 'plan source resolution was cancelled',
  exitClass: 'cancelled',
});

const isCancellation = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  const code = safeErrorCode(error);
  if (code === 'cancelled' || code === 'ABORT_ERR') return true;
  if (error === null || typeof error !== 'object') return false;
  const name = Object.getOwnPropertyDescriptor(error, 'name');
  return Boolean(name && 'value' in name && name.value === 'AbortError');
};

const isPermission = (error: unknown): boolean => {
  const code = safeErrorCode(error);
  return (
    code === 'permission' || code === 'permission-denied' || code === 'EACCES' || code === 'EPERM'
  );
};

const sourceContentFailure = (
  error: unknown,
  signal: AbortSignal | undefined,
  message: string,
): PlanReconcileError => {
  if (isCancellation(error, signal)) return cancelled();
  if (isPermission(error)) {
    return {
      code: 'plan-source-permission',
      message: error === null ? message : errorMessage(error),
      exitClass: 'permission',
    };
  }
  return sourceError('plan-source-content', message);
};

const sourceFailure = (
  error: Readonly<{ readonly code: string; readonly message?: string }>,
  signal?: AbortSignal,
): PlanReconcileError => {
  if (signal?.aborted || error.code === 'cancelled') return cancelled();
  if (error.code === 'permission-denied') {
    return {
      code: 'plan-source-permission',
      message: error.message ?? 'source resolution permission denied',
      exitClass: 'permission',
    };
  }
  if (error.code !== 'source-unresolvable') {
    return {
      code: 'plan-source-failed',
      message: error.message ?? 'source resolution failed',
      exitClass: 'failure',
    };
  }
  return sourceError('plan-source-resolution', error.message ?? 'source resolution failed');
};

const resolvePin = async (
  declaration: NormalizedManifestDeclaration,
  runtime: PlanSourceResolutionRuntime,
): Promise<Result<PortableLockSkillV1, PlanReconcileError>> => {
  if (runtime.signal?.aborted) return err(cancelled());
  const dataDir = resolveDataDir(runtime.ports, runtime.configuration);
  const resolved = await resolveRemoteSource({
    ports: runtime.ports,
    source: sourceSpecFor(declaration),
    ...(runtime.transport === undefined ? {} : { transport: runtime.transport }),
    ledger: EMPTY_LEDGER,
    scopeKey: null,
    storeRoot: storeRootOf(dataDir),
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    createFetchDirectory: () =>
      join(
        runtime.ports.homeDir,
        `.skillsmith-plan-fetch-${runtime.ports.nextId('plan-source-resolution')}`,
      ),
  });

  let pin: Result<PortableLockSkillV1, PlanReconcileError>;
  if (runtime.signal?.aborted) {
    pin = err(cancelled());
  } else if (
    resolved.kind === 'resolved' &&
    resolved.materialization.skillPath !== (declaration.source.path ?? '')
  ) {
    pin = err(
      sourceError(
        'plan-source-mismatch',
        'resolved source path differs from the saved declaration',
      ),
    );
  } else if (resolved.kind === 'resolved') {
    let readFailure: unknown = null;
    const track = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        readFailure ??= error;
        throw error;
      }
    };
    const projection = await projectSourceContent(
      {
        listDir: (path) => track(() => runtime.ports.listDir(path)),
        readBytes: (path) => track(() => runtime.ports.readBytes(path)),
        readLink: (path) => track(() => runtime.ports.readLink(path)),
        readFileMetadata: (path) => track(() => runtime.ports.readFileMetadata(path)),
      },
      resolved.materialization.materializedDir,
    );
    if (runtime.signal?.aborted) {
      pin = err(cancelled());
    } else if (!projection.ok) {
      pin = err(sourceContentFailure(readFailure, runtime.signal, projection.error.message));
    } else {
      const contentHash = hashSourceContentV1(projection.value);
      pin = contentHash.ok
        ? ok(
            Object.freeze({
              name: declaration.name,
              source: lockSource(declaration),
              requestedRef: declaration.ref,
              resolvedSha: resolved.materialization.sha,
              sourcePath: declaration.source.path ?? '.',
              contentHash: contentHash.value,
            }),
          )
        : err(sourceError('plan-source-content', contentHash.error.message));
    }
  } else if (resolved.kind === 'no-match') {
    pin = err(
      sourceError(
        'plan-source-no-match',
        `selected declaration '${declaration.name}' matched no remote skill`,
      ),
    );
  } else if (resolved.kind === 'ambiguous') {
    pin = err(
      sourceError(
        'plan-source-ambiguous',
        `selected declaration '${declaration.name}' resolved ambiguously`,
      ),
    );
  } else {
    pin = err(
      sourceFailure(
        {
          code: resolved.error.code,
          message: errorMessage(resolved.error),
        },
        runtime.signal,
      ),
    );
  }

  if (resolved.cleanupDirectory !== null) {
    try {
      await runtime.ports.removeTree(resolved.cleanupDirectory);
    } catch (error) {
      if (
        (!pin.ok && pin.error.exitClass === 'cancelled') ||
        isCancellation(error, runtime.signal)
      ) {
        return err(cancelled());
      }
      if (!pin.ok && pin.error.exitClass === 'permission') return pin;
      return err({
        code: 'plan-source-cleanup',
        message: 'temporary source resolution state could not be removed',
        exitClass: isPortError(error) && error.code === 'permission' ? 'permission' : 'failure',
      });
    }
  }
  return pin;
};

export const resolvePlanInput = async (
  observed: ObservedPlanArtifacts,
  request: PlanSelectionRequest,
  runtime: PlanSourceResolutionRuntime,
): Promise<Result<ResolvedPlanInput, PlanReconcileError>> => {
  const requestedTools = new Set<SupportedTool>(request.tools);
  const requestedSkills = new Set(request.skills ?? []);
  const selectedRows: Array<
    Readonly<{ declaration: NormalizedManifestDeclaration; tool: SupportedTool }>
  > = [];
  const selectedSkills: string[] = [];
  const selectedTools: SupportedTool[] = [];
  const selectedScopes: ('user' | 'project')[] = [];

  for (const declaration of observed.manifest.model.skills) {
    if (requestedSkills.size > 0 && !requestedSkills.has(declaration.name)) continue;
    if (request.scope !== null && declaration.scope !== request.scope) continue;
    for (const tool of declaration.tools) {
      if (requestedTools.size > 0 && !requestedTools.has(tool)) continue;
      selectedRows.push(Object.freeze({ declaration, tool }));
      selectedSkills.push(declaration.name);
      selectedTools.push(tool);
      selectedScopes.push(declaration.scope);
    }
  }

  const explicitFilter = request.tools.length > 0 || request.scope !== null;
  const selectionOutcome =
    explicitFilter && selectedRows.length === 0 ? ('filter-noop' as const) : ('selected' as const);
  const existingPins = new Map(
    observed.lock.state === 'present'
      ? observed.lock.model.skills.map((skill) => [skill.name, skill] as const)
      : [],
  );
  const pins = new Map<string, PortableLockSkillV1>();
  const resolvedPinNames = new Set<string>();
  for (const declaration of observed.manifest.model.skills) {
    const existing = existingPins.get(declaration.name);
    if (pinMatches(declaration, existing)) pins.set(declaration.name, existing);
  }

  if (request.locked && observed.relationship.state !== 'current') {
    return err({
      code: 'plan-locked-state',
      message: `--locked requires a current complete lock; observed ${observed.relationship.state}`,
      exitClass: 'state',
    });
  }

  if (selectionOutcome !== 'filter-noop') {
    for (const name of sortedUnique(selectedSkills)) {
      if (pins.has(name)) continue;
      const declaration = observed.manifest.model.skills.find((skill) => skill.name === name);
      if (declaration === undefined) continue;
      if (request.locked) {
        return err({
          code: 'plan-locked-state',
          message: `--locked requires a current selected pin for '${name}'`,
          exitClass: 'state',
        });
      }
      const resolved = await resolvePin(declaration, runtime);
      if (!resolved.ok) return resolved;
      pins.set(name, resolved.value);
      resolvedPinNames.add(name);
    }
  }

  const declarations: ResolvedPlanDeclaration[] = [];
  for (const row of selectedRows) {
    const pin = pins.get(row.declaration.name);
    if (pin === undefined) {
      return err({
        code: 'plan-source-resolution-required',
        message: `selected declaration '${row.declaration.name}' has no resolved source pin`,
        exitClass: request.locked ? 'state' : 'source',
      });
    }
    declarations.push(Object.freeze({ ...row, lock: pin }));
  }

  let replacementLock: PortableLockV1 | null = null;
  if (observed.relationship.state !== 'current' && selectionOutcome !== 'filter-noop') {
    const boundedSelection = request.tools.length > 0 || request.scope !== null;
    const manifestNames = new Set(observed.manifest.model.skills.map((skill) => skill.name));
    const retainedPinNames = [...existingPins.keys()]
      .filter((name) => !manifestNames.has(name))
      .sort();
    const wouldDropRetainedPins = retainedPinNames.length > 0;
    const requiresWholeLockWrite =
      observed.lock.state === 'absent' ||
      resolvedPinNames.size > 0 ||
      (!boundedSelection && !wouldDropRetainedPins);
    if (!request.locked && requiresWholeLockWrite) {
      if (resolvedPinNames.size > 0 && wouldDropRetainedPins) {
        return err({
          code: 'plan-lock-retained-pins',
          message: `cannot rewrite the lock after resolving selected pins while retaining undeclared pins: ${retainedPinNames.join(
            ', ',
          )}`,
          exitClass: 'state',
        });
      }
      const missing = observed.manifest.model.skills.filter((skill) => !pins.has(skill.name));
      if (missing.length > 0) {
        return err({
          code: 'plan-lock-bounded-resolution',
          message: `cannot rewrite the lock while unselected declarations lack current pins: ${missing
            .map((skill) => skill.name)
            .join(', ')}`,
          exitClass: 'state',
        });
      }
      replacementLock = Object.freeze({
        version: 1,
        hashSchemaVersion: 1,
        manifestHash: hashManifestSemantics(observed.manifest.model),
        skills: Object.freeze(
          observed.manifest.model.skills
            .map((skill) => pins.get(skill.name) as PortableLockSkillV1)
            .sort((left, right) => left.name.localeCompare(right.name)),
        ),
      });
    }
  }

  return ok(
    Object.freeze({
      observed,
      request,
      declarations: Object.freeze(declarations),
      selectedSkills: sortedUnique(selectedSkills),
      selectedTools: Object.freeze(
        request.tools.length > 0
          ? [...request.tools]
          : (sortedUnique(selectedTools) as readonly SupportedTool[]),
      ),
      selectedScopes: Object.freeze(
        request.scope === null
          ? (sortedUnique(selectedScopes) as readonly ('user' | 'project')[])
          : [request.scope],
      ),
      selectionOutcome,
      replacementLock,
    }),
  );
};
