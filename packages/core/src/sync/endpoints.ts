import { dirname, resolve } from 'node:path';
import {
  type BuiltInToolId,
  type RegisteredToolAdapter,
  toolRegistry,
} from '../agents/registry.ts';
import type { CurrentApplicationContext } from '../application/types.ts';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import type { Scope } from '../config/types.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import { safeErrorCode } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type {
  ResolveSyncEndpointsRequest,
  ResolvedSyncEndpoint,
  ResolvedSyncEndpoints,
  SyncEndpointKind,
  SyncEndpointRole,
  SyncEndpointRootFact,
  SyncEndpointScope,
  SyncObservationFailure,
} from './types.ts';

const SCOPE_VALUES = new Set<SyncEndpointScope>(['user', 'project', 'system', 'managed']);

const failure = (
  code: string,
  message: string,
  exitClass: SyncObservationFailure['exitClass'],
): Result<never, SyncObservationFailure> => err(Object.freeze({ code, message, exitClass }));

const canonicalTools = (
  input: readonly string[],
): Result<readonly BuiltInToolId[], SyncObservationFailure> => {
  if (!Array.isArray(input) || input.length === 0) {
    return failure('sync-tools-required', 'sync requires at least one selected tool', 'usage');
  }
  const selected = new Set<string>();
  for (const tool of input) {
    if (typeof tool !== 'string' || toolRegistry.get(tool) === undefined) {
      return failure('sync-tool-unknown', 'sync selected an unknown tool', 'usage');
    }
    selected.add(tool);
  }
  return ok(
    Object.freeze(toolRegistry.ids.filter((tool): tool is BuiltInToolId => selected.has(tool))),
  );
};

const canonicalProject = async (
  context: CurrentApplicationContext,
  project: ProjectContext,
): Promise<Result<Readonly<{ project: ProjectContext; base: string }>, SyncObservationFailure>> => {
  try {
    const selectedBase = project.projectRoot ?? project.effectiveCwd;
    const base = await context.ports.realpath(selectedBase);
    if ((await context.ports.pathKind(base)) !== 'dir') {
      return failure('sync-endpoint-not-directory', 'sync endpoint is not a directory', 'usage');
    }
    return ok(
      Object.freeze({
        base,
        project: Object.freeze({
          ...project,
          effectiveCwd: base,
          projectRoot: base,
          projectIdentity: base,
        }),
      }),
    );
  } catch (error) {
    const code = safeErrorCode(error);
    return failure(
      code === 'EACCES' || code === 'EPERM' || code === 'permission-denied'
        ? 'sync-endpoint-permission'
        : 'sync-endpoint-invalid',
      code === 'EACCES' || code === 'EPERM' || code === 'permission-denied'
        ? 'sync endpoint permission was denied'
        : 'sync endpoint could not be resolved',
      code === 'EACCES' || code === 'EPERM' || code === 'permission-denied'
        ? 'permission'
        : 'usage',
    );
  }
};

const projectForValue = async (
  context: CurrentApplicationContext,
  topProject: ProjectContext,
  value: string,
): Promise<
  Result<
    Readonly<{
      project: ProjectContext;
      base: string | null;
      kind: SyncEndpointKind;
      scope: SyncEndpointScope;
    }>,
    SyncObservationFailure
  >
> => {
  if (value === 'user' || value === 'system' || value === 'managed') {
    try {
      const base = value === 'user' ? await context.ports.realpath(context.ports.homeDir) : null;
      if (base !== null && (await context.ports.pathKind(base)) !== 'dir') {
        return failure('sync-endpoint-not-directory', 'sync endpoint is not a directory', 'usage');
      }
      return ok(
        Object.freeze({
          project: topProject,
          base,
          kind: value,
          scope: value,
        }),
      );
    } catch (error) {
      const code = safeErrorCode(error);
      return failure(
        'sync-endpoint-permission',
        'sync endpoint permission was denied',
        code === 'EACCES' || code === 'EPERM' || code === 'permission-denied'
          ? 'permission'
          : 'usage',
      );
    }
  }
  if (value === 'project') {
    const canonical = await canonicalProject(context, topProject);
    return canonical.ok
      ? ok(
          Object.freeze({
            ...canonical.value,
            kind: 'project' as const,
            scope: 'project' as const,
          }),
        )
      : canonical;
  }

  const resolved = await resolveProjectContext(context.ports, {
    invocationCwd: topProject.effectiveCwd,
    cd: value,
  });
  if (!resolved.ok) {
    return failure('sync-endpoint-invalid', 'sync path endpoint could not be resolved', 'usage');
  }
  const canonical = await canonicalProject(context, resolved.value);
  return canonical.ok
    ? ok(
        Object.freeze({
          ...canonical.value,
          kind: 'path' as const,
          scope: 'project' as const,
        }),
      )
    : canonical;
};

const supports = (
  adapter: RegisteredToolAdapter,
  operation: 'inventory-skills' | 'sync',
  scope: Scope,
): boolean => {
  const fact = adapter.descriptor.operations[operation];
  return fact.supported && fact.scopes.includes(scope);
};

const canonicalRoot = async (
  context: CurrentApplicationContext,
  tool: BuiltInToolId,
  scope: SyncEndpointScope,
  path: string,
  base: string,
): Promise<Result<SyncEndpointRootFact, SyncObservationFailure>> => {
  try {
    const resolvedPath = resolve(base, path);
    const state = await context.ports.pathKind(resolvedPath);
    if (state === 'absent') {
      return ok(
        Object.freeze({
          tool,
          scope,
          path: resolvedPath,
          canonicalPath: resolvedPath,
          state: 'absent' as const,
        }),
      );
    }
    if (state !== 'dir' && state !== 'symlink') {
      return failure(
        'sync-endpoint-root-invalid',
        'sync endpoint root is not a directory',
        'state',
      );
    }
    const canonicalPath = await context.ports.realpath(resolvedPath);
    if ((await context.ports.pathKind(canonicalPath)) !== 'dir') {
      return failure(
        'sync-endpoint-root-invalid',
        'sync endpoint root is not a directory',
        'state',
      );
    }
    return ok(
      Object.freeze({
        tool,
        scope,
        path: resolvedPath,
        canonicalPath,
        state: 'directory' as const,
      }),
    );
  } catch (error) {
    const code = safeErrorCode(error);
    const permission = code === 'EACCES' || code === 'EPERM' || code === 'permission-denied';
    return failure(
      permission ? 'sync-endpoint-root-permission' : 'sync-endpoint-root-invalid',
      permission
        ? 'sync endpoint root permission was denied'
        : 'sync endpoint root could not be resolved',
      permission ? 'permission' : 'state',
    );
  }
};

const identityOf = (
  scope: SyncEndpointScope,
  canonicalBase: string | null,
  roots: readonly SyncEndpointRootFact[],
): `sync-endpoint:v1:${string}` => {
  const digest = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-sync-endpoint',
      1,
      scope,
      canonicalBase,
      roots.map(({ tool, canonicalPath }) => [tool, canonicalPath]),
    ]),
  );
  if (!digest.ok) throw new TypeError('sync endpoint identity could not be hashed');
  return `sync-endpoint:v1:${digest.value.slice('sha256:'.length)}`;
};

const nearestExistingDirectory = async (
  context: CurrentApplicationContext,
  path: string,
): Promise<string> => {
  let selected = path;
  while ((await context.ports.pathKind(selected)) === 'absent') {
    const parent = dirname(selected);
    if (parent === selected) break;
    selected = parent;
  }
  return selected;
};

const resolveEndpoint = async (
  context: CurrentApplicationContext,
  topProject: ProjectContext,
  role: SyncEndpointRole,
  selectedInput: string,
  tools: readonly BuiltInToolId[],
): Promise<Result<ResolvedSyncEndpoint, SyncObservationFailure>> => {
  if (typeof selectedInput !== 'string' || selectedInput.trim() === '') {
    return failure(`sync-${role}-required`, `sync ${role} endpoint is required`, 'usage');
  }
  const selected = selectedInput;
  const projected = await projectForValue(context, topProject, selected);
  if (!projected.ok) return projected;
  if (
    role === 'destination' &&
    (projected.value.scope === 'system' || projected.value.scope === 'managed')
  ) {
    return failure(
      'sync-destination-read-only',
      'sync destination must be user or project scoped',
      'usage',
    );
  }

  const roots: SyncEndpointRootFact[] = [];
  const skillContext = {
    cwd: projected.value.base ?? topProject.effectiveCwd,
    configuration: context.configuration,
  };
  for (const tool of tools) {
    const adapter = toolRegistry.get(tool);
    if (adapter === undefined || !supports(adapter, 'inventory-skills', projected.value.scope)) {
      return failure(
        'sync-source-inventory-unsupported',
        'selected tool cannot inventory the sync endpoint',
        'capability',
      );
    }
    if (role === 'destination' && !supports(adapter, 'sync', projected.value.scope)) {
      return failure(
        'sync-destination-capability',
        'selected tool cannot write the sync destination',
        'capability',
      );
    }
    const selectedRoots = adapter.inventory.getSkillRoots(
      context.ports,
      projected.value.scope,
      skillContext,
    );
    if (
      role === 'source' &&
      (projected.value.scope === 'system' || projected.value.scope === 'managed') &&
      selectedRoots.length === 0
    ) {
      return failure(
        'sync-source-scope-unsupported',
        'selected tool exposes no readable roots for the sync source scope',
        'capability',
      );
    }
    for (const path of selectedRoots) {
      const root = await canonicalRoot(
        context,
        tool,
        projected.value.scope,
        path,
        skillContext.cwd,
      );
      if (!root.ok) return root;
      roots.push(root.value);
    }
  }

  if (role === 'destination') {
    const writableBase = projected.value.base ?? context.ports.homeDir;
    try {
      await context.ports.assertWritableDirectory(writableBase);
      for (const root of roots) {
        const writableRoot =
          root.state === 'directory'
            ? root.canonicalPath
            : await nearestExistingDirectory(context, root.path);
        await context.ports.assertWritableDirectory(writableRoot);
      }
    } catch (error) {
      const code = safeErrorCode(error);
      const permission = code === 'EACCES' || code === 'EPERM' || code === 'permission-denied';
      return failure(
        permission ? 'sync-destination-permission' : 'sync-destination-not-writable',
        'sync destination is not writable',
        permission ? 'permission' : 'state',
      );
    }
  }

  const frozenRoots = Object.freeze(roots);
  return ok(
    Object.freeze({
      role,
      selectedInput,
      kind: projected.value.kind,
      scope: projected.value.scope,
      canonicalBase: projected.value.base,
      project: projected.value.project,
      roots: frozenRoots,
      identity: identityOf(projected.value.scope, projected.value.base, frozenRoots),
    }),
  );
};

const endpointsAlias = (from: ResolvedSyncEndpoint, to: ResolvedSyncEndpoint): boolean => {
  if (from.identity === to.identity) return true;
  if (from.canonicalBase !== null && from.canonicalBase === to.canonicalBase) return true;
  const sourceRoots = new Set(from.roots.map(({ canonicalPath }) => canonicalPath));
  return to.roots.some(({ canonicalPath }) => sourceRoots.has(canonicalPath));
};

export const resolveSyncEndpoints = async (
  context: CurrentApplicationContext,
  topProject: ProjectContext,
  request: ResolveSyncEndpointsRequest,
): Promise<Result<ResolvedSyncEndpoints, SyncObservationFailure>> => {
  try {
    const tools = canonicalTools(request.tools);
    if (!tools.ok) return tools;
    const from = await resolveEndpoint(context, topProject, 'source', request.from, tools.value);
    if (!from.ok) return from;
    const to = await resolveEndpoint(context, topProject, 'destination', request.to, tools.value);
    if (!to.ok) return to;
    if (endpointsAlias(from.value, to.value)) {
      return failure(
        'sync-endpoint-alias',
        'sync source and destination resolve to the same live location',
        'usage',
      );
    }
    return ok(Object.freeze({ tools: tools.value, from: from.value, to: to.value }));
  } catch (error) {
    if (context.signal?.aborted || safeErrorCode(error) === 'cancelled') {
      return failure(
        'sync-endpoint-cancelled',
        'sync endpoint resolution was cancelled',
        'cancelled',
      );
    }
    const code = safeErrorCode(error);
    const permission = code === 'EACCES' || code === 'EPERM' || code === 'permission-denied';
    return failure(
      permission ? 'sync-endpoint-permission' : 'sync-endpoint-resolution',
      permission ? 'sync endpoint permission was denied' : 'sync endpoint resolution failed',
      permission ? 'permission' : 'failure',
    );
  }
};

export const isSyncScopeToken = (value: string): value is SyncEndpointScope =>
  SCOPE_VALUES.has(value as SyncEndpointScope);
