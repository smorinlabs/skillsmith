import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { toolRegistry } from '../agents/registry.ts';
import { SUPPORTED_TOOLS } from '../agents/types.ts';
import { hashCanonicalInput, hashManifestBytes } from '../artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../artifacts/journal-types.ts';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import type { ArtifactRepositoryError } from '../artifacts/repository.ts';
import {
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
} from '../artifacts/repository.ts';
import {
  hashSourceContentV1,
  projectSourceContent,
  serializeSourceContentProjection,
} from '../artifacts/source-content.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import { type Result, err, ok } from '../result.ts';
import { parseSkillFrontmatter } from '../skills/frontmatter.ts';
import { type StatusLiveInput, type StatusRetentionProbeInput, joinStatus } from './join.ts';
import type {
  StatusBrokenReason,
  StatusLiveObservation,
  StatusReadError,
  StatusReadPorts,
  StatusReadRequest,
  StatusReport,
} from './types.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
const knownTools = new Set<string>(SUPPORTED_TOOLS);
const knownScopes = new Set<string>(SCOPES);

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const statusError = (
  reason: StatusReadError['reason'],
  exitClass: StatusReadError['exitClass'],
  message: string,
): StatusReadError => deepFreeze({ code: 'status-read', reason, exitClass, message });

const INVALID_REQUEST = statusError('invalid-request', 'usage', 'status request is invalid');
const UNMATCHED_TARGET = statusError('unmatched-target', 'usage', 'status target was not found');
const OBSERVATION_FAILED = statusError(
  'observation-failed',
  'failure',
  'status observation failed',
);
const PERMISSION_DENIED = statusError(
  'permission-denied',
  'permission',
  'status read permission was denied',
);
const CANCELLED = statusError('cancelled', 'cancelled', 'status read was cancelled');

const ownString = (value: unknown, property: string): string | null => {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
};

const thrownKind = (value: unknown): 'cancelled' | 'permission' | 'not-found' | 'other' => {
  const code = ownString(value, 'code');
  if (code === 'cancelled' || code === 'ABORT_ERR' || code === 'AbortError') return 'cancelled';
  if (code === 'permission' || code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'not-found' || code === 'ENOENT') return 'not-found';
  return ownString(value, 'name') === 'AbortError' ? 'cancelled' : 'other';
};

const mapThrowable = (value: unknown, signal?: AbortSignal): StatusReadError => {
  if (signal?.aborted === true || thrownKind(value) === 'cancelled') return CANCELLED;
  return thrownKind(value) === 'permission' ? PERMISSION_DENIED : OBSERVATION_FAILED;
};

const artifactError = (value: ArtifactRepositoryError, signal?: AbortSignal): StatusReadError => {
  if (signal?.aborted === true) return CANCELLED;
  if (value.reason === 'permission-denied') return PERMISSION_DENIED;
  if (value.reason === 'read-failed') return OBSERVATION_FAILED;
  if (value.reason === 'invalid-request') return INVALID_REQUEST;
  const label = value.artifactId === 'lock' ? 'lock' : value.artifactId;
  return statusError('invalid-artifact', 'state', `status ${label} is invalid`);
};

const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  ![...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0x1f || point === 0x7f;
  });

const uniqueStrings = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;
const isCancelled = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const validRequest = (request: Readonly<StatusReadRequest>): boolean => {
  if (!Array.isArray(request.targets) || !request.targets.every(isNonemptyString)) return false;
  if (!Array.isArray(request.tools) || request.tools.length === 0) return false;
  if (!request.tools.every((tool) => knownTools.has(tool)) || !uniqueStrings(request.tools)) {
    return false;
  }
  if (!Array.isArray(request.scopes) || request.scopes.length === 0) return false;
  if (!request.scopes.every((scope) => knownScopes.has(scope)) || !uniqueStrings(request.scopes)) {
    return false;
  }
  if (
    (request.selectionSource === 'explicit-targets') !== request.targets.length > 0 ||
    !uniqueStrings(request.targets)
  ) {
    return false;
  }
  if (request.projectPlacement.state === 'unselected' && request.scopes.includes('project')) {
    return false;
  }
  if (request.projectPlacement.state === 'selected') {
    if (
      !isNonemptyString(request.projectPlacement.root) ||
      !isAbsolute(request.projectPlacement.root) ||
      !isNonemptyString(request.projectPlacement.identity)
    ) {
      return false;
    }
  }
  if (request.artifactSelection.state === 'selected') {
    if (
      !isNonemptyString(request.artifactSelection.manifestPath) ||
      !isAbsolute(request.artifactSelection.manifestPath) ||
      !isNonemptyString(request.artifactSelection.lockPath) ||
      !isAbsolute(request.artifactSelection.lockPath)
    ) {
      return false;
    }
  }
  return true;
};

const isWithin = (root: string, candidate: string): boolean => {
  const offset = relative(resolve(root), resolve(candidate));
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
};

interface ObservedSkillFile {
  readonly state: StatusLiveObservation['skillFile'];
  readonly brokenReason: Extract<
    StatusBrokenReason,
    'skill-file-missing' | 'skill-file-invalid'
  > | null;
}

const observeSkillFile = async (
  ports: StatusReadPorts,
  directory: string,
  signal?: AbortSignal,
): Promise<ObservedSkillFile> => {
  const path = join(directory, 'SKILL.md');
  const metadata = await ports.readFileMetadata(path);
  if (metadata.kind === 'absent') {
    return { state: 'missing', brokenReason: 'skill-file-missing' };
  }
  if (metadata.kind === 'symlink') {
    let target: string;
    try {
      target = await ports.realpath(path);
    } catch (error) {
      if (thrownKind(error) === 'not-found') {
        return { state: 'invalid', brokenReason: 'skill-file-invalid' };
      }
      throw error;
    }
    const targetMetadata = await ports.readFileMetadata(target);
    if (targetMetadata.kind !== 'file') {
      return { state: 'invalid', brokenReason: 'skill-file-invalid' };
    }
  } else if (metadata.kind !== 'file') {
    return { state: 'invalid', brokenReason: 'skill-file-invalid' };
  }
  if (isCancelled(signal)) throw CANCELLED;
  const bytes = await ports.readBytes(path);
  if (!(bytes instanceof Uint8Array)) throw OBSERVATION_FAILED;
  let source: string;
  try {
    source = decoder.decode(new Uint8Array(bytes));
  } catch {
    return { state: 'invalid', brokenReason: 'skill-file-invalid' };
  }
  const parsed = parseSkillFrontmatter(source, path);
  return parsed.ok
    ? { state: 'valid', brokenReason: null }
    : { state: 'invalid', brokenReason: 'skill-file-invalid' };
};

const observeLive = async (
  ports: StatusReadPorts,
  tool: string,
  scope: Scope,
  projectIdentity: string | null,
  path: string,
  storeRoot: string,
  signal?: AbortSignal,
): Promise<StatusLiveInput> => {
  const metadata = await ports.readFileMetadata(path);
  let realpath: string | null = null;
  let linkTarget: string | null = null;
  let physicalClass: StatusLiveInput['physicalClass'] = 'broken';
  let brokenReason: StatusLiveInput['brokenReason'] = null;
  let skillFile: StatusLiveObservation['skillFile'] = 'invalid';

  if (metadata.kind === 'symlink') {
    linkTarget = await ports.readLink(path);
    try {
      realpath = await ports.realpath(path);
    } catch (error) {
      if (thrownKind(error) === 'not-found') {
        brokenReason = 'dangling-link';
      } else {
        throw error;
      }
    }
    if (realpath !== null) {
      const targetMetadata = await ports.readFileMetadata(realpath);
      if (targetMetadata.kind !== 'dir') {
        brokenReason = 'wrong-node-kind';
      } else {
        physicalClass = isWithin(storeRoot, realpath) ? 'store-linked' : 'dev';
      }
    }
  } else if (metadata.kind === 'dir') {
    realpath = await ports.realpath(path);
    physicalClass = 'directory';
  } else {
    brokenReason = 'wrong-node-kind';
  }

  if (brokenReason === null) {
    const observed = await observeSkillFile(ports, path, signal);
    skillFile = observed.state;
    if (observed.brokenReason !== null) {
      physicalClass = 'broken';
      brokenReason = observed.brokenReason;
    }
  }

  return {
    name: basename(path),
    tool,
    scope,
    projectIdentity,
    path,
    observation: {
      path,
      realpath,
      nodeKind:
        metadata.kind === 'dir'
          ? 'directory'
          : metadata.kind === 'absent'
            ? 'other'
            : metadata.kind,
      linkTarget,
      skillFile,
    },
    physicalClass,
    brokenReason,
  };
};

const observeSelectedRoots = async (
  ports: StatusReadPorts,
  request: Readonly<StatusReadRequest>,
  storeRoot: string,
): Promise<readonly StatusLiveInput[]> => {
  const live: StatusLiveInput[] = [];
  const seen = new Set<string>();
  const cwd =
    request.projectPlacement.state === 'selected'
      ? request.projectPlacement.root
      : request.projectContext.effectiveCwd;
  for (const tool of request.tools) {
    const adapter = toolRegistry.get(tool);
    if (adapter === undefined)
      throw statusError(
        'read-capability-unavailable',
        'capability',
        'status read capability is unavailable',
      );
    const capability = adapter.descriptor.operations['inventory-skills'];
    if (!capability.supported) {
      throw statusError(
        'read-capability-unavailable',
        'capability',
        'status read capability is unavailable',
      );
    }
    for (const scope of request.scopes) {
      if (!capability.scopes.includes(scope)) {
        throw statusError(
          'read-capability-unavailable',
          'capability',
          'status read capability is unavailable',
        );
      }
      if (isCancelled(request.signal)) throw CANCELLED;
      const roots = adapter.inventory.getSkillRoots(ports, scope, {
        cwd,
        configuration: request.configuration,
      });
      for (const root of roots) {
        if (isCancelled(request.signal)) throw CANCELLED;
        const kind = await ports.pathKind(root);
        if (kind === 'absent') continue;
        const canonicalRoot = await ports.realpath(root);
        if ((await ports.pathKind(canonicalRoot)) !== 'dir') throw OBSERVATION_FAILED;
        const names = await ports.listDir(canonicalRoot);
        if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
          throw OBSERVATION_FAILED;
        }
        for (const name of [...new Set(names)].sort()) {
          if (name.startsWith('.') || name.length === 0 || basename(name) !== name) continue;
          const path = join(canonicalRoot, name);
          const key = JSON.stringify([tool, scope, path]);
          if (seen.has(key)) continue;
          seen.add(key);
          live.push(
            await observeLive(
              ports,
              tool,
              scope,
              scope === 'project' && request.projectPlacement.state === 'selected'
                ? request.projectPlacement.identity
                : null,
              path,
              storeRoot,
              request.signal,
            ),
          );
        }
      }
    }
  }
  return live;
};

const journalPlacementPath = (journal: LogicalJournalV1Dto): string | null => {
  const paths = new Set(
    [...journal.actual.before, ...journal.actual.after]
      .filter((resource) => resource.role === 'live')
      .map((resource) => resource.placementPath),
  );
  return paths.size === 1 ? ([...paths][0] ?? null) : null;
};

const journalProjectIdentity = (journal: LogicalJournalV1Dto): string | null | undefined => {
  const roots = new Set<string | null>();
  for (const image of [journal.intent.before, journal.intent.after]) {
    if ((image.kind === 'placement' || image.kind === 'absent') && image.resource.kind === 'live') {
      const root = image.resource.projectRoot;
      if (root !== null && root.kind !== 'machine-bound') return undefined;
      roots.add(root === null ? null : root.path);
    }
  }
  return roots.size === 1 ? [...roots][0] : undefined;
};

const selectedJournal = (
  journal: LogicalJournalV1Dto,
  request: Readonly<StatusReadRequest>,
): boolean => {
  if (
    journal.intent.skill === null ||
    journal.intent.tool === null ||
    journal.intent.scope === null ||
    !request.tools.includes(journal.intent.tool) ||
    !request.scopes.includes(journal.intent.scope)
  ) {
    return false;
  }
  if (journal.intent.scope === 'project') {
    if (request.projectPlacement.state === 'unselected') return false;
    if (journalProjectIdentity(journal) !== request.projectPlacement.identity) return false;
  }
  if (request.selectionSource !== 'explicit-targets') return true;
  const path = journalPlacementPath(journal);
  return (
    request.targets.includes(journal.intent.skill) ||
    (path !== null && request.targets.includes(path))
  );
};

interface RetainedPhysicalObservation {
  readonly pathState: 'satisfied' | 'missing' | 'unverified';
  readonly repositoryDigest: string | null;
  readonly contentDigest: string | null;
  readonly node: StatusRetentionProbeInput['node'];
}

const observedDigest = (result: ReturnType<typeof hashCanonicalInput>): string | null =>
  result.ok ? result.value : null;

const observeRetainedPhysical = async (
  ports: StatusReadPorts,
  retained: Readonly<{
    path: string;
    role: 'backup' | 'store';
    sourceRole: 'live' | 'manifest' | 'lock' | 'ledger' | null;
  }>,
  signal?: AbortSignal,
): Promise<RetainedPhysicalObservation> => {
  try {
    const metadata = await ports.readFileMetadata(retained.path);
    if (isCancelled(signal)) throw CANCELLED;
    if (metadata.kind === 'absent') {
      return {
        pathState: 'missing',
        repositoryDigest: null,
        contentDigest: null,
        node: { state: 'observed', kind: 'absent', linkTarget: null },
      };
    }

    let bytes: Uint8Array | null = null;
    let repositoryDigest: string | null = null;
    let sourceDigest: string | null = null;
    let linkTarget: string | null = null;
    if (metadata.kind === 'file') {
      const value = await ports.readBytes(retained.path);
      if (!(value instanceof Uint8Array)) {
        return {
          pathState: 'satisfied',
          repositoryDigest: null,
          contentDigest: null,
          node: { state: 'observed', kind: 'file', linkTarget: null },
        };
      }
      bytes = new Uint8Array(value);
      repositoryDigest = observedDigest(hashCanonicalInput('resource', 1, bytes));
    } else if (metadata.kind === 'symlink') {
      const target = await ports.readLink(retained.path);
      linkTarget = target;
      repositoryDigest = observedDigest(
        hashCanonicalInput('resource', 1, JSON.stringify(['symlink', target])),
      );
      try {
        const resolved = await ports.realpath(retained.path);
        const projection = await projectSourceContent(ports, resolved);
        if (projection.ok) {
          const source = hashSourceContentV1(projection.value);
          sourceDigest = source.ok ? source.value : null;
        }
      } catch {
        sourceDigest = null;
      }
    } else if (metadata.kind === 'dir') {
      const projection = await projectSourceContent(ports, retained.path);
      if (projection.ok) {
        const serialized = serializeSourceContentProjection(projection.value);
        repositoryDigest = serialized.ok
          ? observedDigest(hashCanonicalInput('resource', 1, serialized.value))
          : null;
        const source = hashSourceContentV1(projection.value);
        sourceDigest = source.ok ? source.value : null;
      }
    }
    if (isCancelled(signal)) throw CANCELLED;

    let contentDigest: string | null = null;
    if (retained.role === 'store' || retained.sourceRole === 'live') {
      contentDigest = sourceDigest;
    } else if (retained.sourceRole === 'manifest' && bytes !== null) {
      contentDigest = hashManifestBytes(bytes);
    } else if (retained.sourceRole === 'ledger' && bytes !== null) {
      contentDigest = observedDigest(hashCanonicalInput('resource', 1, bytes));
    } else if (retained.sourceRole === 'lock' && bytes !== null) {
      const decoded = await readLockArtifact(ports, retained.path);
      if (decoded.ok && decoded.value.state === 'present' && decoded.value.canonical) {
        contentDigest = observedDigest(hashCanonicalInput('lock-canonical', 1, bytes));
      }
    }
    if (isCancelled(signal)) throw CANCELLED;
    return {
      pathState: 'satisfied',
      repositoryDigest,
      contentDigest,
      node: {
        state: 'observed',
        kind:
          metadata.kind === 'dir'
            ? 'directory'
            : metadata.kind === 'symlink'
              ? 'symlink'
              : metadata.kind,
        linkTarget,
      },
    };
  } catch (error) {
    if (error === CANCELLED || isCancelled(signal)) throw CANCELLED;
    return {
      pathState: 'unverified',
      repositoryDigest: null,
      contentDigest: null,
      node: { state: 'unverified', kind: null, linkTarget: null },
    };
  }
};

const observeRetention = async (
  ports: StatusReadPorts,
  ledger: LedgerModel,
  request: Readonly<StatusReadRequest>,
): Promise<readonly StatusRetentionProbeInput[]> => {
  const probes: StatusRetentionProbeInput[] = [];
  const journals = [...Object.values(ledger.transactions), ...ledger.history];
  for (const journal of journals) {
    if (!selectedJournal(journal, request)) continue;
    for (const retained of journal.actual.retained) {
      if (isCancelled(request.signal)) throw CANCELLED;
      const observed = await observeRetainedPhysical(
        ports,
        {
          path: retained.path,
          role: retained.role,
          sourceRole: retained.role === 'store' ? null : retained.sourceRole,
        },
        request.signal,
      );
      const missing = observed.pathState === 'missing';
      probes.push({
        transactionId: journal.transactionId,
        resourceId: retained.resourceId,
        path: retained.path,
        pathState: observed.pathState,
        repositoryRevision:
          observed.repositoryDigest === null
            ? { state: missing ? 'missing' : 'unverified', digest: null }
            : { state: 'observed', digest: observed.repositoryDigest },
        contentHash:
          observed.contentDigest === null
            ? { state: missing ? 'missing' : 'unverified', digest: null }
            : { state: 'observed', digest: observed.contentDigest },
        node: observed.node,
      });
    }
  }
  const appendLegacy = async (
    skills: LedgerModel['skills'],
    scope: 'user' | 'project',
  ): Promise<void> => {
    if (!request.scopes.includes(scope)) return;
    for (const [name, skill] of Object.entries(skills)) {
      for (const [tool, pair] of Object.entries(skill.tools)) {
        const journal = pair.journal;
        if (
          journal === undefined ||
          journal === null ||
          !request.tools.includes(tool as (typeof request.tools)[number]) ||
          (request.selectionSource === 'explicit-targets' &&
            !request.targets.includes(name) &&
            !request.targets.includes(pair.placementPath))
        ) {
          continue;
        }
        const resources: Array<
          Readonly<{
            path: string;
            role: 'backup' | 'store';
            sourceRole: 'live' | null;
          }>
        > = [{ path: journal.backupPath, role: 'backup', sourceRole: 'live' }];
        if (
          journal.phase === 'committed' &&
          journal.op === 'dev' &&
          journal.before.mode === 'pinned' &&
          journal.before.storePath !== null
        ) {
          resources.push({
            path: journal.before.storePath,
            role: 'store',
            sourceRole: null,
          });
        }
        for (const resource of resources) {
          if (isCancelled(request.signal)) throw CANCELLED;
          const observed = await observeRetainedPhysical(ports, resource, request.signal);
          const missing = observed.pathState === 'missing';
          probes.push({
            transactionId: journal.txId,
            resourceId: null,
            path: resource.path,
            pathState: observed.pathState,
            repositoryRevision:
              observed.repositoryDigest === null
                ? { state: missing ? 'missing' : 'unverified', digest: null }
                : { state: 'observed', digest: observed.repositoryDigest },
            contentHash:
              observed.contentDigest === null
                ? { state: missing ? 'missing' : 'unverified', digest: null }
                : { state: 'observed', digest: observed.contentDigest },
            node: observed.node,
          });
        }
      }
    }
  };
  await appendLegacy(ledger.skills, 'user');
  if (request.projectPlacement.state === 'selected') {
    const project = ledger.projects[request.projectPlacement.identity];
    if (project !== undefined) await appendLegacy(project.skills, 'project');
  }
  return probes;
};

export const readStatus = async (
  ports: StatusReadPorts,
  request: Readonly<StatusReadRequest>,
): Promise<Result<StatusReport, StatusReadError>> => {
  if (!validRequest(request)) return err(INVALID_REQUEST);
  if (isCancelled(request.signal)) return err(CANCELLED);

  try {
    let manifest = null;
    let lock = null;
    if (request.artifactSelection.state === 'selected') {
      const manifestRead = await readManifestArtifact(
        ports,
        request.artifactSelection.manifestPath,
      );
      if (!manifestRead.ok) return err(artifactError(manifestRead.error, request.signal));
      manifest = manifestRead.value;
      if (isCancelled(request.signal)) return err(CANCELLED);

      const lockRead = await readLockArtifact(ports, request.artifactSelection.lockPath);
      if (!lockRead.ok) return err(artifactError(lockRead.error, request.signal));
      lock = lockRead.value;
      if (isCancelled(request.signal)) return err(CANCELLED);
    }

    const dataDir = resolveDataDir({ xdg: ports.xdg }, request.configuration);
    const ledgerPath = ledgerPathOf(dataDir);
    const ledgerRead = await readLedgerArtifact(ports, ledgerPath);
    if (!ledgerRead.ok) return err(artifactError(ledgerRead.error, request.signal));
    if (isCancelled(request.signal)) return err(CANCELLED);

    const live = await observeSelectedRoots(ports, request, storeRootOf(dataDir));
    if (isCancelled(request.signal)) return err(CANCELLED);
    const retention =
      ledgerRead.value.state === 'present'
        ? await observeRetention(ports, ledgerRead.value.model, request)
        : [];
    if (isCancelled(request.signal)) return err(CANCELLED);
    const joined = joinStatus({
      homeDir: ports.homeDir,
      request,
      manifest,
      lock,
      ledger: ledgerRead.value,
      ledgerPath,
      live,
      retention,
    });
    return joined.ok ? ok(joined.value) : err(UNMATCHED_TARGET);
  } catch (error) {
    if (
      error === CANCELLED ||
      error === OBSERVATION_FAILED ||
      error === PERMISSION_DENIED ||
      (typeof error === 'object' &&
        error !== null &&
        Object.isFrozen(error) &&
        ownString(error, 'code') === 'status-read')
    ) {
      return err(error as StatusReadError);
    }
    return err(mapThrowable(error, request.signal));
  }
};
