import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import type { Scope } from '../config/types.ts';
import type { FileMetadataReadPort, FileReadPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { parseSkillFrontmatter } from '../skills/frontmatter.ts';
import {
  type LivePlacementRepository,
  type LogicalRepositoryStageError,
  type LogicalRepositoryStageV1,
  type RepositoryStageRequestV1,
  type StateRepositoryError,
  stageLogicalRepositoryEditV1,
} from '../state/repositories.ts';
import {
  type ExpectedRevisionV1,
  type LivePlacementStateV1,
  createExpectedRevisionV1,
  createFilesystemMetadataIdentityV1,
} from '../state/types.ts';
import { contentHashOf } from './store.ts';

type LiveReadPorts = Pick<
  FileReadPort,
  'isExecutable' | 'listDir' | 'pathKind' | 'readBytes' | 'readLink' | 'realpath'
> &
  FileMetadataReadPort;

export interface LivePlacementResourceV1 {
  readonly resourceId: string;
  readonly skill: string;
  readonly tool: string;
  readonly scope: Scope;
  readonly projectIdentity: string | null;
  readonly placementPath: string;
  readonly storeRoot: string;
}

export interface LivePlacementRepositoryOptions {
  readonly resources: readonly LivePlacementResourceV1[];
  readonly ports: LiveReadPorts;
}

interface NormalizedLivePlacementResourceV1 extends LivePlacementResourceV1 {
  readonly placementPath: string;
  readonly storeRoot: string;
}

interface ObservedSkillFileV1 {
  readonly state: LivePlacementStateV1['skillFile'];
  readonly brokenReason: Extract<
    LivePlacementStateV1['brokenReason'],
    'skill-file-missing' | 'skill-file-invalid'
  > | null;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const scopes = new Set<Scope>(['system', 'user', 'project', 'managed']);

const repositoryError = (reason: StateRepositoryError['reason']): StateRepositoryError =>
  Object.freeze({ code: 'state-repository', domain: 'live', reason });

const mapUnknownError = (error: unknown): StateRepositoryError => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  return repositoryError(
    code === 'EACCES' || code === 'EPERM' || code === 'permission' || code === 'permission-denied'
      ? 'permission-denied'
      : 'observation-failed',
  );
};

const digest = (label: string, value: unknown): string => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-live-repository', label, 1, value]),
  );
  if (!hashed.ok) throw new Error('live repository hash invariant failed');
  return hashed.value;
};

const ownRevision = (input: unknown): Result<ExpectedRevisionV1, StateRepositoryError> => {
  const revision = createExpectedRevisionV1(input);
  return revision.ok ? revision : err(repositoryError('observation-failed'));
};

const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const normalizeResources = (
  resources: readonly LivePlacementResourceV1[],
): readonly NormalizedLivePlacementResourceV1[] | null => {
  if (!Array.isArray(resources)) return null;
  const normalized: NormalizedLivePlacementResourceV1[] = [];
  const resourceIds = new Set<string>();
  const paths = new Set<string>();
  for (const resource of resources) {
    if (
      resource === null ||
      typeof resource !== 'object' ||
      !isNonemptyString(resource.resourceId) ||
      !isNonemptyString(resource.skill) ||
      !isNonemptyString(resource.tool) ||
      !scopes.has(resource.scope) ||
      (resource.projectIdentity !== null && !isNonemptyString(resource.projectIdentity)) ||
      !isNonemptyString(resource.placementPath) ||
      !isNonemptyString(resource.storeRoot)
    ) {
      return null;
    }
    const placementPath = resolve(resource.placementPath);
    const storeRoot = resolve(resource.storeRoot);
    if (resourceIds.has(resource.resourceId) || paths.has(placementPath)) return null;
    resourceIds.add(resource.resourceId);
    paths.add(placementPath);
    normalized.push(
      Object.freeze({
        resourceId: resource.resourceId,
        skill: resource.skill,
        tool: resource.tool,
        scope: resource.scope,
        projectIdentity: resource.projectIdentity,
        placementPath,
        storeRoot,
      }),
    );
  }
  return Object.freeze(normalized);
};

const isWithin = (root: string, candidate: string): boolean => {
  const offset = relative(root, candidate);
  return (
    offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
};

const thrownCode = (error: unknown): string | null =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;

const observeSkillFile = async (
  ports: LiveReadPorts,
  directory: string,
): Promise<ObservedSkillFileV1> => {
  const path = join(directory, 'SKILL.md');
  const metadata = await ports.readFileMetadata(path);
  if (metadata.kind === 'absent') {
    return Object.freeze({ state: 'missing', brokenReason: 'skill-file-missing' });
  }
  if (metadata.kind === 'symlink') {
    let target: string;
    try {
      target = await ports.realpath(path);
    } catch (error) {
      if (thrownCode(error) === 'ENOENT' || thrownCode(error) === 'not-found') {
        return Object.freeze({ state: 'invalid', brokenReason: 'skill-file-invalid' });
      }
      throw error;
    }
    if ((await ports.readFileMetadata(target)).kind !== 'file') {
      return Object.freeze({ state: 'invalid', brokenReason: 'skill-file-invalid' });
    }
  } else if (metadata.kind !== 'file') {
    return Object.freeze({ state: 'invalid', brokenReason: 'skill-file-invalid' });
  }
  const bytes = await ports.readBytes(path);
  if (!(bytes instanceof Uint8Array)) {
    return Object.freeze({ state: 'invalid', brokenReason: 'skill-file-invalid' });
  }
  let source: string;
  try {
    source = decoder.decode(new Uint8Array(bytes));
  } catch {
    return Object.freeze({ state: 'invalid', brokenReason: 'skill-file-invalid' });
  }
  return parseSkillFrontmatter(source, path).ok
    ? Object.freeze({ state: 'valid', brokenReason: null })
    : Object.freeze({ state: 'invalid', brokenReason: 'skill-file-invalid' });
};

const contentRevision = async (
  ports: LiveReadPorts,
  path: string,
  kind: 'file' | 'dir',
): Promise<Result<string, StateRepositoryError>> => {
  if (kind === 'file') {
    try {
      const bytes = await ports.readBytes(path);
      return ok(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    } catch (error) {
      return err(mapUnknownError(error));
    }
  }
  const hashed = await contentHashOf(ports, path);
  return hashed.ok ? ok(hashed.value) : err(mapUnknownError(hashed.error));
};

const observePlacement = async (
  resource: NormalizedLivePlacementResourceV1,
  ports: LiveReadPorts,
): Promise<
  Result<
    Readonly<{ revision: ExpectedRevisionV1; value: LivePlacementStateV1 | null }>,
    StateRepositoryError
  >
> => {
  const placementPath = resource.placementPath;
  const parentPath = dirname(placementPath);
  try {
    const kind = await ports.pathKind(placementPath);
    const target = await ports.readFileMetadata(placementPath);
    const parent = await ports.readFileMetadata(parentPath);
    if (
      (kind === 'absent' && target.kind !== 'absent') ||
      (kind !== 'absent' && target.kind !== kind) ||
      (parent.kind !== 'dir' && parent.kind !== 'absent')
    ) {
      return err(repositoryError('observation-failed'));
    }
    if (kind === 'absent') {
      const revision = ownRevision({
        schemaVersion: 1,
        domain: 'live',
        resourceId: resource.resourceId,
        state: 'absent',
        targetIdentity: placementPath,
        targetKind: 'absent',
        parentIdentity: parentPath,
        parentKind: parent.kind === 'dir' ? 'directory' : 'absent',
        parentMetadataIdentity: createFilesystemMetadataIdentityV1(parentPath, parent, 'parent'),
      });
      return revision.ok ? ok(Object.freeze({ revision: revision.value, value: null })) : revision;
    }
    if (parent.kind !== 'dir' || (kind !== 'file' && kind !== 'dir' && kind !== 'symlink')) {
      return err(repositoryError('observation-failed'));
    }
    let observedContentRevision: string | null = null;
    if (kind === 'file' || kind === 'dir') {
      const content = await contentRevision(ports, placementPath, kind);
      if (!content.ok) return content;
      observedContentRevision = content.value;
    }
    let realpath: string | null = null;
    let linkTarget: string | null = null;
    let dangling = false;
    let placementClass: LivePlacementStateV1['placementClass'] =
      kind === 'dir' ? 'pinned' : 'absent';
    let skillFile: LivePlacementStateV1['skillFile'] = 'invalid';
    let brokenReason: LivePlacementStateV1['brokenReason'] =
      kind === 'file' ? 'wrong-node-kind' : null;

    if (kind === 'dir') {
      realpath = resolve(await ports.realpath(placementPath));
      const observedSkillFile = await observeSkillFile(ports, placementPath);
      skillFile = observedSkillFile.state;
      brokenReason = observedSkillFile.brokenReason;
    } else if (kind === 'symlink') {
      linkTarget = await ports.readLink(placementPath);
      const resolvedTarget = resolve(dirname(placementPath), linkTarget);
      placementClass = isWithin(resource.storeRoot, resolvedTarget) ? 'store-linked' : 'dev';
      const resolvedKind = await ports.pathKind(resolvedTarget);
      dangling = resolvedKind === 'absent';
      if (dangling) {
        brokenReason = 'dangling-link';
      } else {
        try {
          realpath = resolve(await ports.realpath(placementPath));
        } catch (error) {
          if (thrownCode(error) === 'ENOENT' || thrownCode(error) === 'not-found') {
            dangling = true;
            brokenReason = 'dangling-link';
          } else {
            throw error;
          }
        }
        if (!dangling && realpath !== null) {
          if ((await ports.readFileMetadata(realpath)).kind !== 'dir') {
            return err(repositoryError('observation-failed'));
          }
          const content = await contentHashOf(ports, realpath);
          if (!content.ok) return err(mapUnknownError(content.error));
          observedContentRevision = content.value;
          const observedSkillFile = await observeSkillFile(ports, placementPath);
          skillFile = observedSkillFile.state;
          brokenReason = observedSkillFile.brokenReason;
        }
      }
    }
    const resourceRevision = digest('resource', [
      resource.skill,
      resource.tool,
      resource.scope,
      resource.projectIdentity,
      placementPath,
      kind,
      createFilesystemMetadataIdentityV1(placementPath, target, 'target'),
      realpath,
      linkTarget,
      dangling,
      placementClass,
      skillFile,
      brokenReason,
      observedContentRevision,
    ]);
    const representation =
      kind === 'dir' ? ('directory' as const) : kind === 'file' ? ('file' as const) : kind;
    const revision = ownRevision({
      schemaVersion: 1,
      domain: 'live',
      resourceId: resource.resourceId,
      state: 'present',
      targetIdentity: placementPath,
      targetKind: representation,
      targetMetadataIdentity: createFilesystemMetadataIdentityV1(placementPath, target, 'target'),
      parentIdentity: parentPath,
      parentKind: 'directory',
      parentMetadataIdentity: createFilesystemMetadataIdentityV1(parentPath, parent, 'parent'),
      resourceRevision,
      contentRevision: observedContentRevision,
    });
    return revision.ok
      ? ok(
          Object.freeze({
            revision: revision.value,
            value: Object.freeze({
              skill: resource.skill,
              tool: resource.tool,
              scope: resource.scope,
              projectIdentity: resource.projectIdentity,
              representation,
              path: placementPath,
              realpath,
              linkTarget,
              dangling,
              placementClass,
              skillFile,
              brokenReason,
              contentRevision: observedContentRevision,
            }),
          }),
        )
      : revision;
  } catch (error) {
    return err(mapUnknownError(error));
  }
};

export const createLivePlacementRepository = (
  options: LivePlacementRepositoryOptions,
): LivePlacementRepository => {
  const resources = normalizeResources(options.resources);
  const resourceFor = (resourceId: string) =>
    resources?.find((resource) => resource.resourceId === resourceId);
  const observeRevision = async (
    resourceId: string,
  ): Promise<Result<ExpectedRevisionV1, StateRepositoryError>> => {
    const resource = resourceFor(resourceId);
    const observed =
      resource === undefined
        ? err(repositoryError('invalid-request'))
        : await observePlacement(resource, options.ports);
    return observed.ok ? ok(observed.value.revision) : observed;
  };
  return Object.freeze({
    observe: async (resourceId: string) => {
      const resource = resourceFor(resourceId);
      return resource === undefined
        ? err(repositoryError('invalid-request'))
        : observePlacement(resource, options.ports);
    },
    observeRevision,
    stage: async (
      request: RepositoryStageRequestV1,
    ): Promise<Result<LogicalRepositoryStageV1, LogicalRepositoryStageError>> => {
      if (request.domain !== 'live' || resourceFor(request.resourceId) === undefined) {
        return err(Object.freeze({ code: 'invalid-logical-stage' as const }));
      }
      const observed = await observeRevision(request.resourceId);
      return observed.ok
        ? stageLogicalRepositoryEditV1({ ...request, observedRevision: observed.value })
        : observed;
    },
  });
};
