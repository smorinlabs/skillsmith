import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { types as utilTypes } from 'node:util';
import { toolRegistry } from '../agents/registry.ts';
import { SUPPORTED_TOOLS } from '../agents/types.ts';
import { selectReadableArtifactContext } from '../artifacts/discovery.ts';
import { hashCanonicalInput, hashManifestBytes } from '../artifacts/hash.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import { readPortableLockSource, serializePortableLock } from '../artifacts/lock.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import { artifactContractRegistry, resolveLedgerArtifactCodec } from '../artifacts/registry.ts';
import type { ArtifactReadResult, ArtifactRepositoryError } from '../artifacts/repository.ts';
import {
  createLockRepository,
  createManifestRepository,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
} from '../artifacts/repository.ts';
import {
  projectSourceContent,
  serializeSourceContentProjection,
} from '../artifacts/source-content.ts';
import type { SourceContentReadPort } from '../artifacts/source-content.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import { contentHashOf } from '../place/store.ts';
import type { FileMetadata } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { parseSkillFrontmatter } from '../skills/frontmatter.ts';
import { readObservedStateSnapshotV1 } from '../state/read.ts';
import {
  type LedgerRepository,
  type LivePlacementRepository,
  type LogicalRepositoryStageError,
  type LogicalRepositoryStageV1,
  type ObservedStateRepositoriesV1,
  type ProjectStateReaderV1,
  type RepositoryStageRequestV1,
  type StateRepositoryError,
  type StoreRepository,
  createCapabilityStateReaderV1,
} from '../state/repositories.ts';
import {
  type ExpectedRevisionV1,
  type LivePlacementStateV1,
  type ObservedComponentV1,
  type ObservedStateSnapshotV1,
  createExpectedRevisionV1,
  semanticValueRevisionV1,
} from '../state/types.ts';
import {
  type StatusJoinInput,
  type StatusLiveInput,
  type StatusRetentionPlan,
  type StatusRetentionProbeInput,
  joinStatus,
  planStatusRetention,
} from './join.ts';
import type {
  StatusBrokenReason,
  StatusLifecycleHistoryReadRequest,
  StatusLifecycleHistoryReadResult,
  StatusLiveObservation,
  StatusReadError,
  StatusReadPorts,
  StatusReadRequest,
  StatusReport,
} from './types.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const knownTools = new Set<string>(SUPPORTED_TOOLS);
const knownScopes = new Set<string>(SCOPES);

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const ownedStatusErrors = new WeakSet<object>();
const statusError = (
  reason: StatusReadError['reason'],
  exitClass: StatusReadError['exitClass'],
  message: string,
): StatusReadError => {
  const value = deepFreeze({ code: 'status-read' as const, reason, exitClass, message });
  ownedStatusErrors.add(value);
  return value;
};

const isOwnedStatusError = (value: unknown): value is StatusReadError =>
  typeof value === 'object' && value !== null && ownedStatusErrors.has(value);

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

const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const domExceptionName =
  typeof DOMException === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get;
export const isStatusReadCancelled = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && abortSignalAborted?.call(signal) === true;

const nativeDomExceptionName = (value: unknown): string | null => {
  if (
    domExceptionName === undefined ||
    typeof DOMException === 'undefined' ||
    typeof value !== 'object' ||
    value === null ||
    utilTypes.isProxy(value)
  ) {
    return null;
  }
  try {
    return Object.getPrototypeOf(value) === DOMException.prototype
      ? (domExceptionName.call(value) as string)
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
  return ownString(value, 'name') === 'AbortError' || nativeDomExceptionName(value) === 'AbortError'
    ? 'cancelled'
    : 'other';
};

/** One defensive cancellation authority for branded signals and native/owned thrown values. */
export const isStatusReadCancellation = (value: unknown, signal?: AbortSignal): boolean =>
  isStatusReadCancelled(signal) || thrownKind(value) === 'cancelled';

interface CancellationTracker {
  readonly track: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly cancelled: (signal?: AbortSignal) => boolean;
}

/** Track cancellation that nested read authorities may translate into an ordinary result. */
const createCancellationTracker = (): CancellationTracker => {
  let portCancelled = false;
  return {
    track: async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        if (isStatusReadCancellation(error)) portCancelled = true;
        throw error;
      }
    },
    cancelled: (signal?: AbortSignal): boolean => portCancelled || isStatusReadCancelled(signal),
  };
};

const mapThrowable = (value: unknown, signal?: AbortSignal): StatusReadError => {
  if (isStatusReadCancellation(value, signal)) return CANCELLED;
  return thrownKind(value) === 'permission' ? PERMISSION_DENIED : OBSERVATION_FAILED;
};

const artifactError = (value: ArtifactRepositoryError, signal?: AbortSignal): StatusReadError => {
  if (isStatusReadCancelled(signal)) return CANCELLED;
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
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const isNormalizedAbsolute = (value: unknown): value is string =>
  isNonemptyString(value) && isAbsolute(value) && resolve(value) === value;

const isWithin = (root: string, candidate: string): boolean => {
  const offset = relative(resolve(root), resolve(candidate));
  return (
    offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
};

const siblingLockPath = (manifestPath: string): string => {
  const parts = parse(manifestPath);
  return join(parts.dir, `${parts.name}.lock`);
};

type PlainData = Readonly<Record<string, unknown>>;

const plainData = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): PlainData | null => {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return null;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
};

const stringArray = (value: unknown): readonly string[] | null => {
  if (
    typeof value !== 'object' ||
    value === null ||
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)),
    ) ||
    keys.length !== length + 1
  ) {
    return null;
  }
  const snapshot: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    ) {
      return null;
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
};

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || isNonemptyString(value);
const nullableAbsolute = (value: unknown): value is string | null =>
  value === null || (isNonemptyString(value) && isAbsolute(value));
const genuineAbortSignal = (value: unknown): value is AbortSignal => {
  if (
    typeof value !== 'object' ||
    value === null ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== AbortSignal.prototype ||
    Reflect.ownKeys(value).length !== 0 ||
    abortSignalAborted === undefined
  ) {
    return false;
  }
  try {
    return typeof abortSignalAborted.call(value) === 'boolean';
  } catch {
    return false;
  }
};

const snapshotConfigLayer = (
  value: unknown,
): StatusReadRequest['configuration']['configLayer'] | null => {
  const layer = plainData(value, [], ['tool', 'tools', 'scope', 'path', 'registry']);
  if (layer === null) return null;
  if (layer.tool !== undefined && (typeof layer.tool !== 'string' || !knownTools.has(layer.tool))) {
    return null;
  }
  let tools: readonly string[] | undefined;
  if (layer.tools !== undefined) {
    const selected = stringArray(layer.tools);
    if (
      selected === null ||
      selected.length === 0 ||
      !selected.every((tool) => knownTools.has(tool)) ||
      !uniqueStrings(selected)
    ) {
      return null;
    }
    tools = selected;
  }
  if (
    layer.scope !== undefined &&
    (typeof layer.scope !== 'string' || !knownScopes.has(layer.scope))
  ) {
    return null;
  }
  if (layer.path !== undefined && !isNonemptyString(layer.path)) return null;
  let registry: Readonly<{ default?: string }> | undefined;
  if (layer.registry !== undefined) {
    const value = plainData(layer.registry, [], ['default']);
    if (value === null || (value.default !== undefined && !isNonemptyString(value.default))) {
      return null;
    }
    registry = Object.freeze(value.default === undefined ? {} : { default: value.default });
  }
  return Object.freeze({
    ...(layer.tool === undefined ? {} : { tool: layer.tool as (typeof SUPPORTED_TOOLS)[number] }),
    ...(tools === undefined ? {} : { tools: tools as readonly (typeof SUPPORTED_TOOLS)[number][] }),
    ...(layer.scope === undefined ? {} : { scope: layer.scope as Scope }),
    ...(layer.path === undefined ? {} : { path: layer.path as string }),
    ...(registry === undefined ? {} : { registry }),
  });
};

const snapshotConfiguration = (value: unknown): StatusReadRequest['configuration'] | null => {
  const configuration = plainData(value, [
    'configLayer',
    'explicitConfigPath',
    'skillsmithHome',
    'claudeConfigDir',
    'claudePolicySkillsDisabled',
    'claudeManagedSettingsPath',
    'codexHome',
    'kiloExternalSkillsDisabled',
    'opencodeConfigDir',
    'opencodeClaudeSkillsDisabled',
    'forceColor',
    'noColor',
    'journalPause',
  ]);
  if (configuration === null) return null;
  const configLayer = snapshotConfigLayer(configuration.configLayer);
  if (configLayer === null) return null;
  const paths = [
    configuration.explicitConfigPath,
    configuration.skillsmithHome,
    configuration.claudeConfigDir,
    configuration.claudeManagedSettingsPath,
    configuration.codexHome,
    configuration.opencodeConfigDir,
  ];
  if (!paths.every(optionalString)) return null;
  const booleans = [
    configuration.claudePolicySkillsDisabled,
    configuration.kiloExternalSkillsDisabled,
    configuration.opencodeClaudeSkillsDisabled,
    configuration.forceColor,
    configuration.noColor,
  ];
  if (!booleans.every((candidate) => typeof candidate === 'boolean')) return null;
  if (
    configuration.journalPause !== undefined &&
    configuration.journalPause !== 'prepared' &&
    configuration.journalPause !== 'staged' &&
    configuration.journalPause !== 'backed-up' &&
    configuration.journalPause !== 'live' &&
    configuration.journalPause !== 'committed'
  ) {
    return null;
  }
  return Object.freeze({
    configLayer,
    explicitConfigPath: configuration.explicitConfigPath as string | undefined,
    skillsmithHome: configuration.skillsmithHome as string | undefined,
    claudeConfigDir: configuration.claudeConfigDir as string | undefined,
    claudePolicySkillsDisabled: configuration.claudePolicySkillsDisabled as boolean,
    claudeManagedSettingsPath: configuration.claudeManagedSettingsPath as string | undefined,
    codexHome: configuration.codexHome as string | undefined,
    kiloExternalSkillsDisabled: configuration.kiloExternalSkillsDisabled as boolean,
    opencodeConfigDir: configuration.opencodeConfigDir as string | undefined,
    opencodeClaudeSkillsDisabled: configuration.opencodeClaudeSkillsDisabled as boolean,
    forceColor: configuration.forceColor as boolean,
    noColor: configuration.noColor as boolean,
    journalPause: configuration.journalPause as StatusReadRequest['configuration']['journalPause'],
  });
};

const snapshotRequest = (value: unknown): Readonly<StatusReadRequest> | null => {
  const request = plainData(
    value,
    [
      'projectContext',
      'projectPlacement',
      'configuration',
      'targets',
      'tools',
      'toolSelectionSource',
      'scopes',
      'scopeSelectionSource',
      'selectionSource',
      'artifactSelection',
    ],
    ['signal'],
  );
  if (request === null) return null;
  const projectContext = plainData(request.projectContext, [
    'invocationCwd',
    'effectiveCwd',
    'projectRoot',
    'projectIdentity',
    'projectKind',
    'discoveredConfigPath',
    'explicitConfigPath',
  ]);
  const projectPlacement = plainData(
    request.projectPlacement,
    ['state'],
    ['source', 'root', 'identity', 'canonicalCwd'],
  );
  const artifactSelection = plainData(
    request.artifactSelection,
    ['state'],
    ['reason', 'source', 'manifestPath', 'lockPath', 'lockSource'],
  );
  const configuration = snapshotConfiguration(request.configuration);
  const targets = stringArray(request.targets);
  const tools = stringArray(request.tools);
  const scopes = stringArray(request.scopes);
  if (
    projectContext === null ||
    projectPlacement === null ||
    artifactSelection === null ||
    configuration === null ||
    targets === null ||
    tools === null ||
    scopes === null
  ) {
    return null;
  }
  const lifecycleHistory =
    artifactSelection.state === 'unselected' && artifactSelection.reason === 'lifecycle-history';
  if (
    lifecycleHistory &&
    (request.selectionSource !== 'bounded-default' ||
      targets.length !== 0 ||
      request.toolSelectionSource === 'effective-config' ||
      !scopes.every((scope) => scope === 'user' || scope === 'project'))
  ) {
    return null;
  }
  if (
    !isNonemptyString(projectContext.invocationCwd) ||
    !isAbsolute(projectContext.invocationCwd) ||
    !isNonemptyString(projectContext.effectiveCwd) ||
    !isAbsolute(projectContext.effectiveCwd) ||
    !nullableAbsolute(projectContext.projectRoot) ||
    !nullableAbsolute(projectContext.projectIdentity) ||
    projectContext.projectRoot !== projectContext.projectIdentity ||
    (projectContext.projectKind !== 'git' && projectContext.projectKind !== 'non-git') ||
    (projectContext.projectKind === 'git' && projectContext.projectRoot === null) ||
    !nullableAbsolute(projectContext.discoveredConfigPath) ||
    !nullableAbsolute(projectContext.explicitConfigPath) ||
    (projectContext.discoveredConfigPath !== null &&
      (basename(projectContext.discoveredConfigPath) !== 'skillsmith.toml' ||
        projectContext.projectRoot === null ||
        !isWithin(projectContext.projectRoot, projectContext.discoveredConfigPath))) ||
    (projectContext.projectKind === 'non-git' &&
      (projectContext.discoveredConfigPath === null
        ? projectContext.projectRoot !== null
        : projectContext.projectRoot !== dirname(projectContext.discoveredConfigPath)))
  ) {
    return null;
  }
  if (
    (request.toolSelectionSource !== 'explicit' &&
      request.toolSelectionSource !== 'effective-config' &&
      request.toolSelectionSource !== 'unbounded-default') ||
    (request.scopeSelectionSource !== 'explicit' &&
      request.scopeSelectionSource !== 'unbounded-default') ||
    (request.selectionSource !== 'explicit-targets' &&
      request.selectionSource !== 'bounded-default') ||
    tools.length === 0 ||
    !tools.every((tool) => knownTools.has(tool)) ||
    !uniqueStrings(tools) ||
    scopes.length === 0 ||
    !scopes.every((scope) => knownScopes.has(scope)) ||
    !uniqueStrings(scopes) ||
    !targets.every(isNonemptyString) ||
    !uniqueStrings(targets) ||
    (request.selectionSource === 'explicit-targets') !== targets.length > 0
  ) {
    return null;
  }
  let placement: StatusReadRequest['projectPlacement'];
  if (projectPlacement.state === 'unselected') {
    if (
      Reflect.ownKeys(projectPlacement).length !== 1 ||
      scopes.includes('project') ||
      projectContext.projectRoot !== null ||
      projectContext.projectIdentity !== null
    ) {
      return null;
    }
    placement = Object.freeze({ state: 'unselected' });
  } else if (projectPlacement.state === 'selected') {
    if (
      Reflect.ownKeys(projectPlacement).length !== 5 ||
      (projectPlacement.source !== 'shared-project' &&
        projectPlacement.source !== 'explicit-non-git') ||
      !isNormalizedAbsolute(projectPlacement.root) ||
      !isNormalizedAbsolute(projectPlacement.identity) ||
      !isNormalizedAbsolute(projectPlacement.canonicalCwd)
    ) {
      return null;
    }
    if (
      (projectPlacement.source === 'shared-project' &&
        (projectPlacement.root !== projectContext.projectRoot ||
          projectPlacement.identity !== projectContext.projectIdentity ||
          !isWithin(projectPlacement.root, projectPlacement.canonicalCwd) ||
          !isWithin(projectPlacement.identity, projectPlacement.canonicalCwd))) ||
      (projectPlacement.source === 'explicit-non-git' &&
        (projectContext.projectKind !== 'non-git' ||
          projectContext.projectRoot !== null ||
          projectContext.projectIdentity !== null ||
          projectPlacement.root !== projectPlacement.identity ||
          projectPlacement.canonicalCwd !== projectPlacement.root))
    ) {
      return null;
    }
    placement = Object.freeze({
      state: 'selected',
      source: projectPlacement.source,
      root: projectPlacement.root,
      identity: projectPlacement.identity,
      canonicalCwd: projectPlacement.canonicalCwd,
    });
  } else {
    return null;
  }
  const expectedUnboundedScopes = lifecycleHistory
    ? placement.state === 'selected'
      ? (['user', 'project'] as const)
      : (['user'] as const)
    : placement.state === 'selected'
      ? SCOPES
      : SCOPES.filter((scope) => scope !== 'project');
  if (
    (!lifecycleHistory &&
      request.toolSelectionSource === 'unbounded-default' &&
      !sameStrings(tools, SUPPORTED_TOOLS)) ||
    (request.scopeSelectionSource === 'unbounded-default' &&
      !sameStrings(scopes, expectedUnboundedScopes)) ||
    (request.scopeSelectionSource === 'explicit' && scopes.length !== 1) ||
    (placement.state === 'selected' &&
      placement.source === 'explicit-non-git' &&
      (request.scopeSelectionSource !== 'explicit' || !sameStrings(scopes, ['project'])))
  ) {
    return null;
  }
  let artifacts: StatusReadRequest['artifactSelection'];
  if (artifactSelection.state === 'unselected') {
    const validLiveOnly =
      artifactSelection.reason === 'live-only-scope' &&
      request.scopeSelectionSource === 'explicit' &&
      scopes.length === 1 &&
      (scopes[0] === 'system' || scopes[0] === 'managed');
    const validLifecycle =
      artifactSelection.reason === 'lifecycle-history' &&
      request.selectionSource === 'bounded-default' &&
      targets.length === 0 &&
      (request.toolSelectionSource === 'explicit' ||
        request.toolSelectionSource === 'unbounded-default') &&
      (request.scopeSelectionSource === 'explicit' ||
        request.scopeSelectionSource === 'unbounded-default') &&
      scopes.every((scope) => scope === 'user' || scope === 'project') &&
      (!scopes.includes('project') || placement.state === 'selected');
    if (Reflect.ownKeys(artifactSelection).length !== 2 || (!validLiveOnly && !validLifecycle)) {
      return null;
    }
    if (
      artifactSelection.reason !== 'live-only-scope' &&
      artifactSelection.reason !== 'lifecycle-history'
    ) {
      return null;
    }
    artifacts = Object.freeze({ state: 'unselected', reason: artifactSelection.reason });
  } else if (artifactSelection.state === 'selected') {
    if (
      Reflect.ownKeys(artifactSelection).length !== 5 ||
      (artifactSelection.source !== 'explicit' &&
        artifactSelection.source !== 'discovered-project' &&
        artifactSelection.source !== 'project-default' &&
        artifactSelection.source !== 'user-default') ||
      (artifactSelection.lockSource !== 'sibling' && artifactSelection.lockSource !== 'explicit') ||
      !isNormalizedAbsolute(artifactSelection.manifestPath) ||
      !isNormalizedAbsolute(artifactSelection.lockPath) ||
      resolve(artifactSelection.manifestPath) === resolve(artifactSelection.lockPath) ||
      (artifactSelection.source !== 'explicit' && artifactSelection.lockSource !== 'sibling') ||
      (artifactSelection.lockSource === 'sibling' &&
        artifactSelection.lockPath !== siblingLockPath(artifactSelection.manifestPath))
    ) {
      return null;
    }
    artifacts = Object.freeze({
      state: 'selected',
      source: artifactSelection.source,
      manifestPath: artifactSelection.manifestPath,
      lockPath: artifactSelection.lockPath,
      lockSource: artifactSelection.lockSource,
    });
  } else {
    return null;
  }
  const signal = request.signal;
  if (signal !== undefined && !genuineAbortSignal(signal)) return null;
  return Object.freeze({
    projectContext: Object.freeze({
      invocationCwd: projectContext.invocationCwd,
      effectiveCwd: projectContext.effectiveCwd,
      projectRoot: projectContext.projectRoot,
      projectIdentity: projectContext.projectIdentity,
      projectKind: projectContext.projectKind,
      discoveredConfigPath: projectContext.discoveredConfigPath,
      explicitConfigPath: projectContext.explicitConfigPath,
    }),
    projectPlacement: placement,
    configuration,
    targets,
    tools: tools as readonly (typeof SUPPORTED_TOOLS)[number][],
    toolSelectionSource: request.toolSelectionSource,
    scopes: scopes as readonly Scope[],
    scopeSelectionSource: request.scopeSelectionSource,
    selectionSource: request.selectionSource,
    artifactSelection: artifacts,
    ...(signal === undefined ? {} : { signal }),
  });
};

const validArtifactSelectionProvenance = (
  xdg: StatusReadPorts['xdg'],
  request: Readonly<StatusReadRequest>,
): boolean => {
  const selected = request.artifactSelection;
  if (selected.state === 'unselected' || selected.source === 'explicit') return true;
  const expected = selectReadableArtifactContext({ xdg }, request.projectContext, {
    scope: request.scopeSelectionSource === 'explicit' ? (request.scopes[0] as Scope) : null,
  });
  return (
    expected.state === 'selected' &&
    expected.source === selected.source &&
    expected.file === selected.manifestPath
  );
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
  if (isStatusReadCancelled(signal)) throw CANCELLED;
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
): Promise<StatusLiveInput | null> => {
  const metadata = await ports.readFileMetadata(path);
  if (metadata.kind === 'absent') return null;
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
      nodeKind: metadata.kind === 'dir' ? 'directory' : metadata.kind,
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
      if (isStatusReadCancelled(request.signal)) throw CANCELLED;
      const roots = adapter.inventory.getSkillRoots(ports, scope, {
        cwd,
        configuration: request.configuration,
      });
      for (const root of roots) {
        if (isStatusReadCancelled(request.signal)) throw CANCELLED;
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
          const observed = await observeLive(
            ports,
            tool,
            scope,
            scope === 'project' && request.projectPlacement.state === 'selected'
              ? request.projectPlacement.identity
              : null,
            path,
            storeRoot,
            request.signal,
          );
          if (observed !== null) live.push(observed);
        }
      }
    }
  }
  return live;
};

interface RetainedPhysicalObservation {
  readonly pathState: 'satisfied' | 'missing' | 'unverified';
  readonly repositoryDigest: string | null;
  readonly contentDigest: string | null;
  readonly node: StatusRetentionProbeInput['node'];
}

const observedDigest = (result: ReturnType<typeof hashCanonicalInput>): string | null =>
  result.ok ? result.value : null;

type RetainedContentKind =
  | 'source-content'
  | 'manifest-bytes'
  | 'lock-canonical'
  | 'resource-bytes'
  | null;

interface RetainedObservationNeeds {
  readonly repositoryKind: 'artifact-bytes' | 'resource' | null;
  readonly contentKind: RetainedContentKind;
  readonly structuralNode: boolean;
  readonly followSourceSymlink: boolean;
}

const logicalRetainedContentKind = (
  retained: Readonly<{
    role: 'backup' | 'store';
    sourceRole: 'live' | 'manifest' | 'lock' | 'ledger' | null;
  }>,
): Exclude<RetainedContentKind, null> => {
  if (retained.role === 'store' || retained.sourceRole === 'live') return 'source-content';
  if (retained.sourceRole === 'manifest') return 'manifest-bytes';
  if (retained.sourceRole === 'lock') return 'lock-canonical';
  return 'resource-bytes';
};

const projectRetainedSourceContent = async (
  ports: StatusReadPorts,
  path: string,
  signal?: AbortSignal,
): ReturnType<typeof projectSourceContent> => {
  const tracker = createCancellationTracker();
  const focused: SourceContentReadPort = {
    readFileMetadata: (target) => tracker.track(() => ports.readFileMetadata(target)),
    listDir: (target) => tracker.track(() => ports.listDir(target)),
    readBytes: (target) => tracker.track(() => ports.readBytes(target)),
    readLink: (target) => tracker.track(() => ports.readLink(target)),
  };
  const result = await projectSourceContent(focused, path);
  if (tracker.cancelled(signal)) throw CANCELLED;
  return result;
};

const hashRetainedSourceContent = async (
  ports: StatusReadPorts,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  const tracker = createCancellationTracker();
  const focused = {
    listDir: (target: string) => tracker.track(() => ports.listDir(target)),
    pathKind: (target: string) => tracker.track(() => ports.pathKind(target)),
    readLink: (target: string) => tracker.track(() => ports.readLink(target)),
    readBytes: (target: string) => tracker.track(() => ports.readBytes(target)),
    isExecutable: (target: string) => tracker.track(() => ports.isExecutable(target)),
  };
  const result = await contentHashOf(focused, path);
  if (tracker.cancelled(signal)) throw CANCELLED;
  return result.ok ? result.value : null;
};

const observeRetainedPhysical = async (
  ports: StatusReadPorts,
  path: string,
  needs: RetainedObservationNeeds,
  signal?: AbortSignal,
): Promise<RetainedPhysicalObservation> => {
  try {
    const metadata = await ports.readFileMetadata(path);
    if (isStatusReadCancelled(signal)) throw CANCELLED;
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
      if (
        needs.repositoryKind !== null ||
        (needs.contentKind !== null && needs.contentKind !== 'source-content')
      ) {
        const value = await ports.readBytes(path);
        if (!(value instanceof Uint8Array)) {
          return {
            pathState: 'satisfied',
            repositoryDigest: null,
            contentDigest: null,
            node: { state: 'observed', kind: 'file', linkTarget: null },
          };
        }
        bytes = new Uint8Array(value);
        if (needs.repositoryKind !== null) {
          repositoryDigest = observedDigest(hashCanonicalInput('resource', 1, bytes));
        }
      }
    } else if (metadata.kind === 'symlink') {
      if (needs.structuralNode || needs.repositoryKind === 'resource') {
        linkTarget = await ports.readLink(path);
      }
      if (needs.repositoryKind === 'resource' && linkTarget !== null) {
        repositoryDigest = observedDigest(
          hashCanonicalInput('resource', 1, JSON.stringify(['symlink', linkTarget])),
        );
      }
      if (needs.contentKind === 'source-content' && needs.followSourceSymlink) {
        try {
          const resolved = await ports.realpath(path);
          sourceDigest = await hashRetainedSourceContent(ports, resolved, signal);
        } catch (error) {
          if (error === CANCELLED || isStatusReadCancellation(error, signal)) {
            throw CANCELLED;
          }
          sourceDigest = null;
        }
      }
    } else if (metadata.kind === 'dir') {
      if (needs.repositoryKind === 'resource' || needs.contentKind === 'source-content') {
        if (needs.contentKind === 'source-content') {
          sourceDigest = await hashRetainedSourceContent(ports, path, signal);
        } else {
          const projection = await projectRetainedSourceContent(ports, path, signal);
          if (projection.ok && needs.repositoryKind === 'resource') {
            const serialized = serializeSourceContentProjection(projection.value);
            repositoryDigest = serialized.ok
              ? observedDigest(hashCanonicalInput('resource', 1, serialized.value))
              : null;
          }
        }
      }
    }
    if (
      needs.repositoryKind === 'resource' &&
      needs.contentKind === 'source-content' &&
      sourceDigest !== null
    ) {
      repositoryDigest = sourceDigest;
    }
    if (isStatusReadCancelled(signal)) throw CANCELLED;

    let contentDigest: string | null = null;
    if (needs.contentKind === 'source-content') {
      contentDigest = sourceDigest;
    } else if (needs.contentKind === 'manifest-bytes' && bytes !== null) {
      contentDigest = hashManifestBytes(bytes);
    } else if (needs.contentKind === 'resource-bytes' && bytes !== null) {
      contentDigest = observedDigest(hashCanonicalInput('resource', 1, bytes));
    } else if (needs.contentKind === 'lock-canonical' && bytes !== null) {
      const decoded = readPortableLockSource(bytes);
      if (decoded.ok) {
        contentDigest = observedDigest(hashCanonicalInput('lock-canonical', 1, bytes));
      }
    }
    if (isStatusReadCancelled(signal)) throw CANCELLED;
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
    if (error === CANCELLED || isStatusReadCancellation(error, signal)) {
      throw CANCELLED;
    }
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
  plans: readonly StatusRetentionPlan[],
  request: Readonly<StatusReadRequest>,
): Promise<readonly StatusRetentionProbeInput[]> => {
  const correlationKeyAt = (keys: readonly string[], resourceIndex: number): string => {
    const correlationKey = keys[resourceIndex];
    if (correlationKey === undefined) throw OBSERVATION_FAILED;
    return correlationKey;
  };
  const probes: StatusRetentionProbeInput[] = [];
  for (const plan of plans) {
    const resources =
      plan.format === 'logical'
        ? plan.journal.actual.retained.map((retained, resourceIndex) => ({
            correlationKey: correlationKeyAt(plan.retentionCorrelationKeys, resourceIndex),
            resourceId: retained.resourceId,
            path: retained.path,
            repositoryKind: retained.repositoryRevision.kind,
            contentKind: logicalRetainedContentKind({
              role: retained.role,
              sourceRole: retained.role === 'store' ? null : retained.sourceRole,
            }),
            structuralNode: false,
            followSourceSymlink: true,
          }))
        : plan.resources.map((resource, resourceIndex) => ({
            correlationKey: correlationKeyAt(plan.retentionCorrelationKeys, resourceIndex),
            resourceId: null,
            path: resource.path,
            repositoryKind: null,
            contentKind: resource.contentHash === null ? null : ('source-content' as const),
            structuralNode: true,
            followSourceSymlink: false,
          }));
    for (const resource of resources) {
      if (isStatusReadCancelled(request.signal)) throw CANCELLED;
      const observed = await observeRetainedPhysical(
        ports,
        resource.path,
        {
          repositoryKind: resource.repositoryKind,
          contentKind: resource.contentKind,
          structuralNode: resource.structuralNode,
          followSourceSymlink: resource.followSourceSymlink,
        },
        request.signal,
      );
      const missing = observed.pathState === 'missing';
      probes.push({
        correlationKey: resource.correlationKey,
        transactionId: plan.format === 'logical' ? plan.journal.transactionId : plan.journal.txId,
        resourceId: resource.resourceId,
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
  return probes;
};

interface StatusReadObservation {
  readonly report: StatusReport;
  readonly ledgerPath: string;
  readonly ledgerState: LedgerReadState;
}

const exactLedgerReadState = (
  ledger: ArtifactReadResult<LedgerModel>,
  bytes: Uint8Array | null,
): LedgerReadState | null => {
  if (ledger.state === 'absent') {
    return Object.freeze({
      state: 'absent',
      sourceVersion: null,
      bytes: null,
      byteRevision: null,
      semanticRevision: null,
      model: null,
    });
  }
  if (
    bytes === null ||
    (ledger.sourceVersion !== 1 && ledger.sourceVersion !== 2) ||
    ledger.semanticRevision === null
  ) {
    return null;
  }
  return Object.freeze({
    state: 'present',
    sourceVersion: ledger.sourceVersion,
    bytes: new Uint8Array(bytes),
    byteRevision: ledger.byteRevision,
    semanticRevision: ledger.semanticRevision,
    model: ledger.model,
  });
};

const readStatusObservation = async (
  ports: StatusReadPorts,
  rawRequest: Readonly<StatusReadRequest>,
): Promise<Result<StatusReadObservation, StatusReadError>> => {
  let request: Readonly<StatusReadRequest> | null = null;
  try {
    request = snapshotRequest(rawRequest);
  } catch {
    return err(INVALID_REQUEST);
  }
  if (request === null) return err(INVALID_REQUEST);
  if (
    request.artifactSelection.state === 'selected' &&
    request.artifactSelection.source !== 'explicit' &&
    !validArtifactSelectionProvenance(ports.xdg, request)
  ) {
    return err(INVALID_REQUEST);
  }
  if (isStatusReadCancelled(request.signal)) return err(CANCELLED);

  try {
    const tracker = createCancellationTracker();
    const dataDir = resolveDataDir({ xdg: ports.xdg }, request.configuration);
    const ledgerPath = ledgerPathOf(dataDir);
    let ledgerBytes: Uint8Array | null = null;
    const artifactPorts = {
      pathKind: (path: string) => tracker.track(() => ports.pathKind(path)),
      readBytes: (path: string) =>
        tracker.track(async () => {
          const bytes = await ports.readBytes(path);
          if (path === ledgerPath && ledgerBytes === null) ledgerBytes = new Uint8Array(bytes);
          return bytes;
        }),
    };
    if (request.projectPlacement.state === 'selected') {
      const canonicalEffectiveCwd = await tracker.track(() =>
        ports.realpath(request.projectContext.effectiveCwd),
      );
      if (tracker.cancelled(request.signal)) return err(CANCELLED);
      if (canonicalEffectiveCwd !== request.projectPlacement.canonicalCwd) {
        return err(INVALID_REQUEST);
      }
    }
    let manifest = null;
    let lock = null;
    if (request.artifactSelection.state === 'selected') {
      const manifestRead = await readManifestArtifact(
        artifactPorts,
        request.artifactSelection.manifestPath,
      );
      if (tracker.cancelled(request.signal)) return err(CANCELLED);
      if (!manifestRead.ok) return err(artifactError(manifestRead.error, request.signal));
      manifest = manifestRead.value;
      if (isStatusReadCancelled(request.signal)) return err(CANCELLED);

      const lockRead = await readLockArtifact(artifactPorts, request.artifactSelection.lockPath);
      if (tracker.cancelled(request.signal)) return err(CANCELLED);
      if (!lockRead.ok) return err(artifactError(lockRead.error, request.signal));
      lock = lockRead.value;
      if (isStatusReadCancelled(request.signal)) return err(CANCELLED);
    }

    const ledgerRead = await readLedgerArtifact(artifactPorts, ledgerPath);
    if (tracker.cancelled(request.signal)) return err(CANCELLED);
    if (!ledgerRead.ok) return err(artifactError(ledgerRead.error, request.signal));
    if (isStatusReadCancelled(request.signal)) return err(CANCELLED);
    const ledgerState = exactLedgerReadState(ledgerRead.value, ledgerBytes);
    if (ledgerState === null) return err(OBSERVATION_FAILED);

    const complete = (
      report: Result<StatusReport, StatusReadError>,
    ): Result<StatusReadObservation, StatusReadError> =>
      report.ok ? ok(Object.freeze({ report: report.value, ledgerPath, ledgerState })) : report;

    const live = await observeSelectedRoots(ports, request, storeRootOf(dataDir));
    if (isStatusReadCancelled(request.signal)) return err(CANCELLED);
    const retentionPlan = planStatusRetention({
      homeDir: ports.homeDir,
      request,
      manifest,
      lock,
      ledger: ledgerRead.value,
      ledgerPath,
      live,
    });
    const retention = await observeRetention(ports, retentionPlan, request);
    if (isStatusReadCancelled(request.signal)) return err(CANCELLED);
    const facts = {
      homeDir: ports.homeDir,
      manifest,
      lock,
      ledger: ledgerRead.value,
      ledgerPath,
      live,
      retention,
    } as const;
    const artifactSelection = request.artifactSelection;
    if (
      artifactSelection.state === 'unselected' ||
      facts.live.some(
        (input) =>
          input.observation.nodeKind !== 'directory' &&
          input.observation.nodeKind !== 'symlink' &&
          input.observation.nodeKind !== 'file',
      )
    ) {
      return complete(createStatusReportFromFacts(request, facts));
    }
    const snapshotParentPaths = [
      ...(facts.manifest?.state === 'present' ? [dirname(artifactSelection.manifestPath)] : []),
      ...(facts.lock?.state === 'present' ? [dirname(artifactSelection.lockPath)] : []),
      ...(facts.ledger.state === 'present' ? [dirname(facts.ledgerPath)] : []),
      ...facts.live.map((input) => dirname(input.path)),
    ];
    for (const path of new Set(snapshotParentPaths)) {
      const metadata = await tracker.track(() => ports.readFileMetadata(path));
      if (metadata.kind !== 'dir') return complete(createStatusReportFromFacts(request, facts));
    }
    const reobserveFacts = async (): Promise<Readonly<Omit<StatusJoinInput, 'request'>>> => {
      const manifestRead = await readManifestArtifact(
        artifactPorts,
        artifactSelection.manifestPath,
      );
      if (!manifestRead.ok) throw artifactError(manifestRead.error, request.signal);
      const lockRead = await readLockArtifact(artifactPorts, artifactSelection.lockPath);
      if (!lockRead.ok) throw artifactError(lockRead.error, request.signal);
      const nextLedger = await readLedgerArtifact(artifactPorts, ledgerPath);
      if (!nextLedger.ok) throw artifactError(nextLedger.error, request.signal);
      const nextLive = await observeSelectedRoots(ports, request, storeRootOf(dataDir));
      const nextRetentionPlan = planStatusRetention({
        homeDir: ports.homeDir,
        request,
        manifest: manifestRead.value,
        lock: lockRead.value,
        ledger: nextLedger.value,
        ledgerPath,
        live: nextLive,
      });
      const nextRetention = await observeRetention(ports, nextRetentionPlan, request);
      return {
        homeDir: ports.homeDir,
        manifest: manifestRead.value,
        lock: lockRead.value,
        ledger: nextLedger.value,
        ledgerPath,
        live: nextLive,
        retention: nextRetention,
      };
    };
    const prepared = await createSharedStatusSnapshotV1(
      ports,
      request,
      facts,
      reobserveFacts,
      (path) => tracker.track(() => ports.readFileMetadata(path)),
    );
    if (tracker.cancelled(request.signal)) return err(CANCELLED);
    return complete(createStatusReportFromSnapshot(request, prepared.snapshot, prepared.adjunct));
  } catch (error) {
    if (
      error === CANCELLED ||
      error === OBSERVATION_FAILED ||
      error === PERMISSION_DENIED ||
      isOwnedStatusError(error)
    ) {
      return err(error as StatusReadError);
    }
    return err(mapThrowable(error, request.signal));
  }
};

export const readStatus = async (
  ports: StatusReadPorts,
  request: Readonly<StatusReadRequest>,
): Promise<Result<StatusReport, StatusReadError>> => {
  const observed = await readStatusObservation(ports, request);
  return observed.ok ? ok(observed.value.report) : observed;
};

/**
 * Private lifecycle history observation. The report and exact ledger read state come from one
 * ledger read; lifecycle-history validation also guarantees no manifest or lock artifact reads.
 */
export const readLifecycleHistoryStatus = async (
  ports: StatusReadPorts,
  request: StatusLifecycleHistoryReadRequest,
): Promise<Result<StatusLifecycleHistoryReadResult, StatusReadError>> => {
  const observed = await readStatusObservation(ports, request);
  return observed.ok ? ok(observed.value) : observed;
};

export interface StatusSnapshotAdjunctV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: ObservedStateSnapshotV1['snapshotId'];
  readonly revisionDigest: `sha256:${string}`;
  readonly facts: Readonly<Omit<StatusJoinInput, 'request'>>;
}

const statusAdjunctRevision = (
  projectContext: StatusReadRequest['projectContext'],
  facts: Readonly<Omit<StatusJoinInput, 'request'>>,
): `sha256:${string}` => {
  const identity = {
    domain: 'skillsmith.status-snapshot-adjunct',
    schemaVersion: 1,
    projectContext,
    facts,
  } as const;
  const hashed = hashCanonicalInput('resource', 1, JSON.stringify(identity));
  if (!hashed.ok) throw OBSERVATION_FAILED;
  return hashed.value as `sha256:${string}`;
};

const statusMetadataIdentity = (path: string, metadata: FileMetadata): string => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-status-metadata',
      1,
      resolve(path),
      metadata.kind,
      metadata.mode,
      metadata.identity,
      metadata.linkCount ?? null,
    ]),
  );
  if (!hashed.ok) throw OBSERVATION_FAILED;
  return `metadata:v1:${hashed.value.slice('sha256:'.length)}`;
};

const statusExpectedRevision = (input: unknown): ExpectedRevisionV1 => {
  const revision = createExpectedRevisionV1(input);
  if (!revision.ok) throw OBSERVATION_FAILED;
  return revision.value;
};

const statusArtifactComponent = async <Model>(
  artifact: 'manifest' | 'lock' | 'ledger',
  resourceId: string,
  path: string,
  value: ArtifactReadResult<Model>,
  readMetadata: (path: string) => Promise<FileMetadata>,
): Promise<ObservedComponentV1<Model>> => {
  const target = await readMetadata(path);
  const parentPath = dirname(path);
  const parent = await readMetadata(parentPath);
  if (value.state === 'absent') {
    if (target.kind !== 'absent' || (parent.kind !== 'dir' && parent.kind !== 'absent')) {
      throw OBSERVATION_FAILED;
    }
    return {
      revision: statusExpectedRevision({
        schemaVersion: 1,
        domain: artifact,
        resourceId,
        state: 'absent',
        targetIdentity: path,
        targetKind: 'absent',
        parentIdentity: parentPath,
        parentKind: parent.kind === 'dir' ? 'directory' : 'absent',
        parentMetadataIdentity: statusMetadataIdentity(parentPath, parent),
      }),
      value: null,
    };
  }
  if (target.kind !== 'file' || parent.kind !== 'dir' || value.semanticRevision === null) {
    throw OBSERVATION_FAILED;
  }
  return {
    revision: statusExpectedRevision({
      schemaVersion: 1,
      domain: artifact,
      resourceId,
      state: 'present',
      targetIdentity: path,
      targetKind: 'file',
      targetMetadataIdentity: statusMetadataIdentity(path, target),
      parentIdentity: parentPath,
      parentKind: 'directory',
      parentMetadataIdentity: statusMetadataIdentity(parentPath, parent),
      byteRevision: value.byteRevision,
      semanticRevision: value.semanticRevision,
    }),
    value: value.model,
  };
};

const statusLiveResourceId = (input: StatusLiveInput): string => {
  const resourceHash = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-status-live-resource',
      1,
      input.tool,
      input.scope,
      input.projectIdentity,
      input.path,
    ]),
  );
  if (!resourceHash.ok) throw OBSERVATION_FAILED;
  return `status-live:${resourceHash.value.slice('sha256:'.length)}`;
};

const statusAbsentLiveComponent = async (
  resourceId: string,
  path: string,
  readMetadata: (path: string) => Promise<FileMetadata>,
): Promise<ObservedComponentV1<LivePlacementStateV1>> => {
  const target = await readMetadata(path);
  const parentPath = dirname(path);
  const parent = await readMetadata(parentPath);
  if (target.kind !== 'absent' || (parent.kind !== 'dir' && parent.kind !== 'absent')) {
    throw OBSERVATION_FAILED;
  }
  return {
    revision: statusExpectedRevision({
      schemaVersion: 1,
      domain: 'live',
      resourceId,
      state: 'absent',
      targetIdentity: path,
      targetKind: 'absent',
      parentIdentity: parentPath,
      parentKind: parent.kind === 'dir' ? 'directory' : 'absent',
      parentMetadataIdentity: statusMetadataIdentity(parentPath, parent),
    }),
    value: null,
  };
};

const statusLiveComponent = async (
  resourceId: string,
  input: StatusLiveInput,
  readMetadata: (path: string) => Promise<FileMetadata>,
): Promise<ObservedComponentV1<LivePlacementStateV1> | null> => {
  const representation =
    input.observation.nodeKind === 'directory' ||
    input.observation.nodeKind === 'symlink' ||
    input.observation.nodeKind === 'file'
      ? input.observation.nodeKind
      : null;
  if (representation === null) return null;
  const target = await readMetadata(input.path);
  const parentPath = dirname(input.path);
  const parent = await readMetadata(parentPath);
  const expectedTargetKind = representation === 'directory' ? 'dir' : representation;
  if (target.kind !== expectedTargetKind || parent.kind !== 'dir') throw OBSERVATION_FAILED;
  const resourceRevision = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-status-live-observation', 1, input]),
  );
  if (!resourceRevision.ok) throw OBSERVATION_FAILED;
  const value: LivePlacementStateV1 = {
    skill: input.name,
    tool: input.tool,
    scope: input.scope,
    projectIdentity: input.projectIdentity,
    representation,
    path: input.path,
    realpath: input.observation.realpath,
    linkTarget: input.observation.linkTarget,
    dangling: input.brokenReason === 'dangling-link',
    placementClass:
      input.physicalClass === 'directory'
        ? 'pinned'
        : input.physicalClass === 'broken'
          ? 'absent'
          : input.physicalClass,
    skillFile: input.observation.skillFile,
    brokenReason: input.brokenReason,
    contentRevision: null,
  };
  return {
    revision: statusExpectedRevision({
      schemaVersion: 1,
      domain: 'live',
      resourceId,
      state: 'present',
      targetIdentity: input.path,
      targetKind: representation,
      targetMetadataIdentity: statusMetadataIdentity(input.path, target),
      parentIdentity: parentPath,
      parentKind: 'directory',
      parentMetadataIdentity: statusMetadataIdentity(parentPath, parent),
      resourceRevision: resourceRevision.value,
      contentRevision: null,
    }),
    value,
  };
};

const statusRepositoryError = (
  domain: 'project' | 'manifest' | 'lock' | 'ledger' | 'live' | 'store' | 'capabilities',
  reason: 'invalid-request' | 'observation-failed' | 'permission-denied',
) => Object.freeze({ code: 'state-repository' as const, domain, reason });

const invalidStatusStage = async (
  _request: RepositoryStageRequestV1,
): Promise<Result<LogicalRepositoryStageV1, LogicalRepositoryStageError>> =>
  err({ code: 'invalid-logical-stage' as const });

const observeStatusArtifact = async <Model>(
  domain: 'ledger',
  resourceId: string,
  requestedResourceId: string,
  path: string,
  readArtifact: () => Promise<Result<ArtifactReadResult<Model>, ArtifactRepositoryError>>,
  readMetadata: (path: string) => Promise<FileMetadata>,
): Promise<Result<ObservedComponentV1<Model>, StateRepositoryError>> => {
  if (requestedResourceId !== resourceId) {
    return err(statusRepositoryError(domain, 'invalid-request'));
  }
  try {
    const artifact = await readArtifact();
    if (!artifact.ok) {
      return err(
        statusRepositoryError(
          domain,
          artifact.error.reason === 'permission-denied'
            ? 'permission-denied'
            : 'observation-failed',
        ),
      );
    }
    return ok(
      await statusArtifactComponent(domain, resourceId, path, artifact.value, readMetadata),
    );
  } catch {
    return err(statusRepositoryError(domain, 'observation-failed'));
  }
};

const statusLedgerReadRepository = (
  resourceId: string,
  path: string,
  readArtifact: () => Promise<Result<ArtifactReadResult<LedgerModel>, ArtifactRepositoryError>>,
  readMetadata: (path: string) => Promise<FileMetadata>,
): LedgerRepository => {
  const observe = (requestedResourceId: string) =>
    observeStatusArtifact(
      'ledger',
      resourceId,
      requestedResourceId,
      path,
      readArtifact,
      readMetadata,
    );
  return {
    observe,
    observeRevision: async (requestedResourceId: string) => {
      const observed = await observe(requestedResourceId);
      return observed.ok ? ok(observed.value.revision) : observed;
    },
    stage: invalidStatusStage,
  };
};

const statusProjectReadRepository = (
  resourceId: string,
  context: StatusReadRequest['projectContext'],
): ProjectStateReaderV1 => {
  const observe = async (requestedResourceId: string) => {
    if (requestedResourceId !== resourceId) {
      return err(statusRepositoryError('project', 'invalid-request'));
    }
    const value = deepFreeze({ ...context });
    return ok({
      revision: statusExpectedRevision({
        schemaVersion: 1,
        domain: 'project',
        resourceId,
        state: 'present',
        targetKind: 'semantic',
        semanticRevision: semanticValueRevisionV1('project', value),
      }),
      value,
    });
  };
  return {
    observe,
    observeRevision: async (requestedResourceId: string) => {
      const observed = await observe(requestedResourceId);
      return observed.ok ? ok(observed.value.revision) : observed;
    },
  };
};

const statusLiveReadRepository = (
  ports: StatusReadPorts,
  resources: ReadonlyMap<string, StatusLiveInput>,
  storeRoot: string,
  signal: AbortSignal | undefined,
  readMetadata: (path: string) => Promise<FileMetadata>,
): LivePlacementRepository => {
  const observe = async (resourceId: string) => {
    const resource = resources.get(resourceId);
    if (resource === undefined) return err(statusRepositoryError('live', 'invalid-request'));
    try {
      const observed = await observeLive(
        ports,
        resource.tool,
        resource.scope,
        resource.projectIdentity,
        resource.path,
        storeRoot,
        signal,
      );
      if (observed === null) {
        return ok(await statusAbsentLiveComponent(resourceId, resource.path, readMetadata));
      }
      const component = await statusLiveComponent(resourceId, observed, readMetadata);
      return component === null
        ? err(statusRepositoryError('live', 'observation-failed'))
        : ok(component);
    } catch {
      return err(statusRepositoryError('live', 'observation-failed'));
    }
  };
  return {
    observe,
    observeRevision: async (resourceId: string) => {
      const observed = await observe(resourceId);
      return observed.ok ? ok(observed.value.revision) : observed;
    },
    stage: invalidStatusStage,
  };
};

const statusEmptyStoreReadRepository = (): StoreRepository => ({
  observe: async () => err(statusRepositoryError('store', 'invalid-request')),
  observeRevision: async () => err(statusRepositoryError('store', 'invalid-request')),
  stage: invalidStatusStage,
});

const createSharedStatusSnapshotV1 = async (
  ports: StatusReadPorts,
  request: Readonly<StatusReadRequest>,
  facts: Readonly<Omit<StatusJoinInput, 'request'>>,
  reobserveFacts: () => Promise<Readonly<Omit<StatusJoinInput, 'request'>>>,
  readMetadata: (path: string) => Promise<FileMetadata>,
): Promise<Readonly<{ snapshot: ObservedStateSnapshotV1; adjunct: StatusSnapshotAdjunctV1 }>> => {
  const artifactSelection = request.artifactSelection;
  if (artifactSelection.state !== 'selected') throw OBSERVATION_FAILED;
  const projectResourceId = `status-project:${request.projectContext.projectIdentity ?? request.projectContext.effectiveCwd}`;
  const manifestResourceId = `status-manifest:${artifactSelection.manifestPath}`;
  const lockResourceId = `status-lock:${artifactSelection.lockPath}`;
  const ledgerResourceId = `status-ledger:${facts.ledgerPath}`;
  const liveResources = new Map(
    facts.live.map((input) => [statusLiveResourceId(input), input] as const),
  );
  const capabilitiesResourceId = 'status-capabilities:current';
  const adjunctRevision = statusAdjunctRevision(request.projectContext, facts);
  const artifactPorts = {
    pathKind: (path: string) => ports.pathKind(path),
    readBytes: (path: string) => ports.readBytes(path),
    readFileMetadata: readMetadata,
  };
  const repositories = {
    project: statusProjectReadRepository(projectResourceId, request.projectContext),
    manifest: createManifestRepository({
      resourceId: manifestResourceId,
      path: artifactSelection.manifestPath,
      ports: artifactPorts,
    }),
    lock: createLockRepository({
      resourceId: lockResourceId,
      path: artifactSelection.lockPath,
      ports: artifactPorts,
    }),
    ledger: statusLedgerReadRepository(
      ledgerResourceId,
      facts.ledgerPath,
      () => readLedgerArtifact(artifactPorts, facts.ledgerPath),
      readMetadata,
    ),
    live: statusLiveReadRepository(
      ports,
      liveResources,
      storeRootOf(resolveDataDir({ xdg: ports.xdg }, request.configuration)),
      request.signal,
      readMetadata,
    ),
    store: statusEmptyStoreReadRepository(),
    capabilities: createCapabilityStateReaderV1(capabilitiesResourceId),
  } satisfies ObservedStateRepositoriesV1;
  const observed = await readObservedStateSnapshotV1(
    {
      schemaVersion: 1,
      projectResourceId,
      manifestResourceId,
      lockResourceId,
      ledgerResourceId,
      liveResourceIds: [...liveResources.keys()],
      storeResourceIds: [],
      capabilitiesResourceId,
      statusRevision: adjunctRevision,
    },
    repositories,
  );
  if (!observed.ok) throw OBSERVATION_FAILED;
  const reobservedFacts = await reobserveFacts();
  const reobservedRevision = statusAdjunctRevision(request.projectContext, reobservedFacts);
  if (reobservedRevision !== adjunctRevision) throw OBSERVATION_FAILED;
  return deepFreeze({
    snapshot: observed.value,
    adjunct: {
      schemaVersion: 1,
      snapshotId: observed.value.snapshotId,
      revisionDigest: adjunctRevision,
      facts: reobservedFacts,
    },
  });
};

const canonicalSnapshotArtifact = <Model>(
  artifact: 'manifest' | 'lock' | 'ledger',
  component:
    | ObservedStateSnapshotV1['manifest']
    | ObservedStateSnapshotV1['lock']
    | ObservedStateSnapshotV1['ledger'],
): ArtifactReadResult<Model> | null => {
  if (component.revision.domain !== artifact) return null;
  if (component.revision.state === 'absent') {
    return component.value === null ? { state: 'absent', artifact, migration: null } : null;
  }
  if (component.value === null) return null;
  let bytes: Uint8Array;
  if (artifact === 'manifest') {
    const codec = artifactContractRegistry.get('manifest', 1);
    if (codec === undefined) return null;
    const encoded = codec.encode(component.value as NormalizedManifestV1);
    if (!encoded.ok) return null;
    bytes = encoded.value;
  } else if (artifact === 'lock') {
    const encoded = serializePortableLock(component.value as PortableLockV1);
    if (!encoded.ok) return null;
    bytes = encoder.encode(encoded.value);
  } else {
    const encoded = resolveLedgerArtifactCodec(2).encode(component.value as LedgerModel);
    if (!encoded.ok) return null;
    bytes = encoded.value;
  }
  const canonicalByteRevision = hashCanonicalInput('resource', 1, bytes);
  if (
    !canonicalByteRevision.ok ||
    canonicalByteRevision.value !== component.revision.byteRevision
  ) {
    return null;
  }
  return {
    state: 'present',
    artifact,
    sourceVersion: artifact === 'ledger' ? 2 : 1,
    currentVersion: artifact === 'ledger' ? 2 : 1,
    source: decoder.decode(bytes),
    byteLength: bytes.byteLength,
    byteRevision: component.revision.byteRevision,
    semanticRevision: component.revision.semanticRevision,
    model: component.value as Model,
    canonical: true,
    migration: null,
  } as ArtifactReadResult<Model>;
};

const ledgerNeedsRetentionCompatibility = (ledger: LedgerModel): boolean => {
  if (Object.keys(ledger.transactions).length > 0 || ledger.history.length > 0) return true;
  const containsPairJournal = (skills: LedgerModel['skills']): boolean =>
    Object.values(skills).some((skill) =>
      Object.values(skill.tools).some((pair) => pair.journal != null),
    );
  return (
    containsPairJournal(ledger.skills) ||
    Object.values(ledger.projects).some((project) => containsPairJournal(project.skills))
  );
};

const snapshotLiveInputs = (
  snapshot: ObservedStateSnapshotV1,
): readonly StatusLiveInput[] | null => {
  const live: StatusLiveInput[] = [];
  for (const observation of snapshot.live) {
    const revision = observation.revision;
    if (revision.domain !== 'live') return null;
    if (revision.state === 'absent') {
      if (observation.value !== null) return null;
      continue;
    }
    const value = observation.value;
    if (
      value === null ||
      revision.targetIdentity !== value.path ||
      revision.contentRevision !== value.contentRevision ||
      revision.targetKind !== value.representation ||
      (value.placementClass === 'absent' && value.brokenReason === null)
    ) {
      return null;
    }
    const physicalClass: StatusLiveInput['physicalClass'] =
      value.brokenReason !== null
        ? 'broken'
        : value.placementClass === 'absent'
          ? 'broken'
          : value.placementClass === 'pinned'
            ? 'directory'
            : value.placementClass;
    live.push({
      name: value.skill,
      tool: value.tool,
      scope: value.scope,
      projectIdentity: value.projectIdentity,
      path: value.path,
      observation: {
        path: value.path,
        realpath: value.realpath,
        nodeKind: value.representation,
        linkTarget: value.linkTarget,
        skillFile: value.skillFile,
      },
      physicalClass,
      brokenReason: value.brokenReason,
    });
  }
  return Object.freeze(live);
};

const sameProjectContext = (
  left: StatusReadRequest['projectContext'],
  right: StatusReadRequest['projectContext'],
): boolean =>
  left.invocationCwd === right.invocationCwd &&
  left.effectiveCwd === right.effectiveCwd &&
  left.projectRoot === right.projectRoot &&
  left.projectIdentity === right.projectIdentity &&
  left.projectKind === right.projectKind &&
  left.discoveredConfigPath === right.discoveredConfigPath &&
  left.explicitConfigPath === right.explicitConfigPath;

const createStatusReportFromFacts = (
  request: Readonly<StatusReadRequest>,
  facts: Readonly<Omit<StatusJoinInput, 'request'>>,
): Result<StatusReport, StatusReadError> => {
  const joined = joinStatus({ ...facts, request });
  return joined.ok ? ok(joined.value) : err(UNMATCHED_TARGET);
};

const snapshotArtifactMatchesFact = <Model>(
  component:
    | ObservedStateSnapshotV1['manifest']
    | ObservedStateSnapshotV1['lock']
    | ObservedStateSnapshotV1['ledger'],
  fact: ArtifactReadResult<Model> | null,
): boolean => {
  if (fact === null) return false;
  if (fact.state === 'absent') {
    return component.revision.state === 'absent' && component.value === null;
  }
  return (
    component.revision.state === 'present' &&
    'byteRevision' in component.revision &&
    'semanticRevision' in component.revision &&
    component.value !== null &&
    component.revision.byteRevision === fact.byteRevision &&
    component.revision.semanticRevision === fact.semanticRevision &&
    JSON.stringify(component.value) === JSON.stringify(fact.model)
  );
};

const statusLiveKey = (input: StatusLiveInput): string =>
  `${input.tool}\u0000${input.scope}\u0000${input.projectIdentity ?? ''}\u0000${input.path}`;

const snapshotMatchesStatusAdjunct = (
  snapshot: ObservedStateSnapshotV1,
  adjunct: StatusSnapshotAdjunctV1,
): boolean => {
  if (
    !snapshotArtifactMatchesFact(snapshot.manifest, adjunct.facts.manifest) ||
    !snapshotArtifactMatchesFact(snapshot.lock, adjunct.facts.lock) ||
    !snapshotArtifactMatchesFact(snapshot.ledger, adjunct.facts.ledger)
  ) {
    return false;
  }
  if (
    !('targetIdentity' in snapshot.ledger.revision) ||
    snapshot.ledger.revision.targetIdentity !== adjunct.facts.ledgerPath
  ) {
    return false;
  }
  const snapshotLive = snapshotLiveInputs(snapshot);
  if (snapshotLive === null) return false;
  const canonical = (values: readonly StatusLiveInput[]): string =>
    JSON.stringify(
      [...values].sort((left, right) => statusLiveKey(left).localeCompare(statusLiveKey(right))),
    );
  return canonical(snapshotLive) === canonical(adjunct.facts.live);
};

/**
 * Pure snapshot projection used by new read services. `readStatus` remains the bounded
 * compatibility observation shell while migration provenance and selected retention probes are
 * not yet carried by `ObservedStateSnapshotV1`; this path therefore accepts only byte-proven
 * canonical artifacts and journal-free ledgers instead of inventing a generic retention reader.
 */
export const createStatusReportFromSnapshot = (
  rawRequest: Readonly<StatusReadRequest>,
  snapshot: ObservedStateSnapshotV1,
  adjunct?: StatusSnapshotAdjunctV1,
): Result<StatusReport, StatusReadError> => {
  let request: Readonly<StatusReadRequest> | null = null;
  try {
    const requestWithSnapshotPlacement =
      rawRequest.projectPlacement.state === 'unselected' &&
      rawRequest.projectContext.projectRoot !== null &&
      rawRequest.projectContext.projectIdentity !== null
        ? {
            ...rawRequest,
            projectPlacement: {
              state: 'selected' as const,
              source: 'shared-project' as const,
              canonicalCwd: rawRequest.projectContext.effectiveCwd,
              root: rawRequest.projectContext.projectRoot,
              identity: rawRequest.projectContext.projectIdentity,
            },
          }
        : rawRequest;
    request = snapshotRequest(requestWithSnapshotPlacement);
  } catch {
    return err(INVALID_REQUEST);
  }
  if (request === null || snapshot.schemaVersion !== 1) return err(INVALID_REQUEST);
  if (
    snapshot.project.value === null ||
    !sameProjectContext(snapshot.project.value, request.projectContext)
  ) {
    return err(INVALID_REQUEST);
  }
  if (adjunct !== undefined) {
    if (
      adjunct.schemaVersion !== 1 ||
      adjunct.snapshotId !== snapshot.snapshotId ||
      snapshot.statusRevision !== adjunct.revisionDigest ||
      statusAdjunctRevision(request.projectContext, adjunct.facts) !== adjunct.revisionDigest ||
      !snapshotMatchesStatusAdjunct(snapshot, adjunct)
    ) {
      return err(INVALID_REQUEST);
    }
    return createStatusReportFromFacts(request, adjunct.facts);
  }
  const live = snapshotLiveInputs(snapshot);
  if (live === null) return err(INVALID_REQUEST);
  const manifest =
    request.artifactSelection.state === 'unselected'
      ? null
      : canonicalSnapshotArtifact<NormalizedManifestV1>('manifest', snapshot.manifest);
  const lock =
    request.artifactSelection.state === 'unselected'
      ? null
      : canonicalSnapshotArtifact<PortableLockV1>('lock', snapshot.lock);
  const ledger = canonicalSnapshotArtifact<LedgerModel>('ledger', snapshot.ledger);
  if (
    (request.artifactSelection.state === 'selected' && (manifest === null || lock === null)) ||
    ledger === null ||
    !('targetIdentity' in snapshot.ledger.revision) ||
    (ledger.state === 'present' && ledgerNeedsRetentionCompatibility(ledger.model)) ||
    (manifest !== null &&
      manifest.state === 'present' &&
      manifest.model.skills.some((skill) => skill.scope === 'user' && skill.path !== null))
  ) {
    return err(INVALID_REQUEST);
  }
  return createStatusReportFromFacts(request, {
    homeDir: request.projectContext.effectiveCwd,
    manifest,
    lock,
    ledger,
    ledgerPath: snapshot.ledger.revision.targetIdentity,
    live,
    retention: [],
  });
};
