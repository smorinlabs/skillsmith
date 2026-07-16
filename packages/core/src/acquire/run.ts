import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ToolCapabilityScope } from '../agents/adapter-types.ts';
import { type Placement, classifyPlacement } from '../agents/placement-shared.ts';
import { type LifecycleToolRegistry, toolRegistry } from '../agents/registry.ts';
import {
  normalizeSourceIdentity,
  validateManifestName,
  validateRequestedRef,
} from '../artifacts/identity.ts';
import type { LedgerModel, LedgerReadState } from '../artifacts/ledger-types.ts';
import {
  type SkillSmithError,
  cancelledError,
  errorMessage,
  flipFailedError,
  flipRefusedError,
  genericError,
  sourceUnresolvableError,
  toolUnavailableError,
} from '../errors.ts';
import { createContentObservationExecutionPrecondition } from '../execution/preconditions.ts';
import type {
  ExecutionPrecondition,
  PreparedExecutionBinding,
  ValidatedExecutionBinding,
} from '../execution/types.ts';
import type { ObservationBundle } from '../observation/index.ts';
import { prepareLedgerMigration } from '../place/ledger-migration.ts';
import {
  getLedgerPairAt,
  getPairAt as getLegacyPairAt,
  ledgerModelForMutation,
  legacyLedgerView,
  readLedgerState,
  withLedgerLock,
  withLedgerPairAt,
  withoutLedgerPairAt,
} from '../place/ledger.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import {
  type SnapshotResult,
  clampStoreNs,
  contentHashOf,
  snapshotToStore,
  sweepStaging,
} from '../place/store.ts';
import type {
  FlipTool,
  LedgerFile,
  PairRecord,
  PinnedRecord,
  Provenance,
  SwapPlan,
} from '../place/types.ts';
import { createBoundedForceEffect, createOperationExecutionResult } from '../planning/create.ts';
import type {
  CurrentMutatorOperationPlan,
  ExecutableOperation,
  OperationDigest,
  OperationExecutionResult,
  OperationImage,
  OperationPlan,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  containsSensitiveMaterial,
  redactSensitiveString,
  redactSensitiveValue,
} from '../safety/redaction.ts';
import { detectTool } from '../scan/index.ts';
import {
  type ContentObservationIdentityV1,
  type ExpectedRevisionV1,
  createContentObservationPreconditionIdV1,
  createStoreSnapshotIdentityV1,
} from '../state/types.ts';
import { evaluateVerificationGate } from '../verify/gate.ts';
import { runVerify, verifyPlugin } from '../verify/run.ts';
import type { ToolVerdict, VerifyReport } from '../verify/types.ts';
import {
  type AcquireContentFacts,
  type AcquireExecutionInput,
  type AcquireLiveSnapshotResourceV1,
  type AcquirePlacementFacts,
  type AcquireStoreSnapshotResourceV1,
  type AcquisitionPlanObservationState,
  type AcquisitionSnapshotAuthorityV1,
  acquireActualBefore,
  acquireContentFacts,
  acquireContentObservationIdentity,
  acquirePlacementFacts,
  acquireStateResourceId,
  acquisitionPreconditionStateChanged,
  acquisitionRevisionPreconditions,
  createAcquireExecutionInput,
  createAcquireExecutionLockPort,
  createAcquisitionLedgerMigrationBinding,
  createAcquisitionOriginRecord,
  createAcquisitionPinnedRecord,
  createAcquisitionRepositoryLifecycleControllerV1,
  destinationSkillRootFor,
  detectAcquireToolWithObservation,
  emitAcquisitionPlanCreated,
  executeAcquirePlanWithObservation,
  executeAcquireReplacementWithObservation,
  executeAcquisitionOperationPlan,
  executeRecordOnlyAcquirePlan,
  placementBundleFor,
  readAcquisitionSnapshotV1,
  recoverAcquireWithObservation,
  recoverCommittedAcquireJournalsWithObservation,
  resolveAcquisitionProjectContextV1,
  resolvePlacementFor,
  runAcquisitionWithObservation,
  skillRootFactsFor,
  verificationRegistryFor,
} from './execute.ts';
import {
  fetchRepo,
  lsTreeSkills,
  resolveRefViaLsRemote,
  sparseCheckoutSkill,
  sweepFetchOrphans,
} from './fetch.ts';
import {
  type AcquisitionInstallIntentV1,
  type AcquisitionUninstallIntentV1,
  createAcquisitionDiagnosticPlan,
  createAcquisitionPlan,
  createInstallCapabilityQueries,
  createInstallPlanning,
  createUninstallCapabilityQueries,
  createUninstallPlanning,
} from './plan.ts';
import { recoveryRefusedMessage } from './recovery.ts';
import { matchCandidates, selectSkill } from './resolve.ts';
import { parseSource } from './source.ts';
import type {
  AcquisitionPorts,
  CandidateSkill,
  InstallAction,
  InstallDeps,
  InstallOptions,
  InstallReport,
  InstallResult,
  InstallScope,
  InstallSourceTransport,
  PlannedInstallReport,
  PlannedUninstallReport,
  SourceSpec,
  UninstallAction,
  UninstallDeps,
  UninstallOptions,
  UninstallReport,
  UninstallResult,
} from './types.ts';
const defaultInstallDetect: InstallDeps['detect'] = (env, tool, signal) =>
  detectTool(env, tool, signal);
export const defaultInstallDeps: Omit<InstallDeps, 'pick' | 'transport'> = {
  verify: verifyPlugin,
  detect: defaultInstallDetect,
};
export const defaultInstallSourceTransport: InstallSourceTransport = Object.freeze({
  resolveRef: resolveRefViaLsRemote,
  fetchRepo,
  listSkills: lsTreeSkills,
  materializeSkill: sparseCheckoutSkill,
});
type AcquireLedger = LedgerFile | LedgerModel;
const getPairAt = (
  ledger: AcquireLedger,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
): PairRecord | null =>
  'schemaVersion' in ledger
    ? getLegacyPairAt(ledger, scopeKey, skill, tool)
    : (getLedgerPairAt(ledger, scopeKey, skill, tool) as PairRecord | null);
const nowOf = (ports: AcquisitionPorts, deps: InstallDeps | UninstallDeps): string =>
  deps.now?.() ?? ports.wallNowIso();
const journalNowOf = (ports: AcquisitionPorts, deps: InstallDeps | UninstallDeps): string => {
  const value = nowOf(ports, deps);
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
};
const txIdOf = (ports: AcquisitionPorts, deps: InstallDeps | UninstallDeps): string =>
  deps.newTxId?.() ?? ports.nextId('acquisition-transaction');
const executionInputOf = (
  env: AcquisitionPorts,
  ledgerPath: string,
  ledger: LedgerModel,
  deps: InstallDeps | UninstallDeps,
  opts: Pick<InstallOptions | UninstallOptions, 'testPauseAt' | 'signal'>,
  logicalOperation: ExecutableOperation | null,
): AcquireExecutionInput =>
  createAcquireExecutionInput(
    env,
    ledgerPath,
    ledger,
    [() => journalNowOf(env, deps), () => txIdOf(env, deps)] as const,
    opts,
    logicalOperation,
  );
const installHintFor = (registry: LifecycleToolRegistry<string>, tool: FlipTool): string => {
  const hint = registry.get(tool)?.inventory.installHint;
  if (hint === undefined) throw new Error(`tool registry invariant: ${tool} has no install hint`);
  return hint;
};
const msg = (e: SkillSmithError): string =>
  redactSensitiveString('message' in e ? e.message : e.code);
const SKILLSMITH_ERROR_CODES = new Set<SkillSmithError['code']>([
  'generic',
  'invalid-argument',
  'unknown-tool',
  'config-error',
  'skill-parse-error',
  'placement-not-found',
  'source-unresolvable',
  'ledger-error',
  'permission-denied',
  'flip-refused',
  'flip-failed',
  'tool-unavailable',
  'cancelled',
]);
const safeError = (error: unknown): SkillSmithError => {
  const redacted = redactSensitiveValue(error);
  if (
    redacted !== null &&
    typeof redacted === 'object' &&
    'code' in redacted &&
    typeof redacted.code === 'string' &&
    SKILLSMITH_ERROR_CODES.has(redacted.code as SkillSmithError['code'])
  ) {
    return redacted as SkillSmithError;
  }
  return genericError('operation failed');
};
type SafeTransportResult =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'error'; readonly error: SkillSmithError }
  | { readonly kind: 'invalid' };
const dataRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
const ownDataValue = (value: Readonly<Record<string, unknown>>, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
const hasExactOwnKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean => {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
};
const safeTransportResult = (input: unknown): SafeTransportResult => {
  const copied = dataRecord(redactSensitiveValue(input));
  if (copied === null) return { kind: 'invalid' };
  const okValue = ownDataValue(copied, 'ok');
  if (okValue === true) {
    if (!hasExactOwnKeys(copied, ['ok', 'value'])) return { kind: 'invalid' };
    const descriptor = Object.getOwnPropertyDescriptor(copied, 'value');
    return descriptor && 'value' in descriptor
      ? { kind: 'ok', value: descriptor.value }
      : { kind: 'invalid' };
  }
  if (okValue === false) {
    if (!hasExactOwnKeys(copied, ['ok', 'error'])) return { kind: 'invalid' };
    const descriptor = Object.getOwnPropertyDescriptor(copied, 'error');
    return descriptor && 'value' in descriptor
      ? { kind: 'error', error: safeError(descriptor.value) }
      : { kind: 'invalid' };
  }
  return { kind: 'invalid' };
};
/**
 * The acquisition entry points accept injectable ports, so even values statically typed as a
 * Result are untrusted at the public boundary. Copy the envelope without invoking accessors or
 * proxy traps and redact every error payload before it can escape.
 */
const safeDependencyResult = <T>(input: unknown): Result<T, SkillSmithError> => {
  const safe = safeTransportResult(input);
  if (safe.kind === 'ok') return ok(safe.value as T);
  if (safe.kind === 'error') return err(safe.error);
  return err(genericError('operation failed'));
};
const safeUnknownMessage = (error: unknown): string => {
  const redacted = redactSensitiveValue(error);
  if (typeof redacted === 'string') return redacted;
  if (redacted !== null && typeof redacted === 'object') {
    const descriptor = Object.getOwnPropertyDescriptor(redacted, 'message');
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
      return descriptor.value;
    }
  }
  return 'operation failed';
};
const lastSegment = (repoPath: string): string =>
  repoPath
    .split('/')
    .filter((s) => s.length > 0)
    .pop() ?? repoPath;
const selectorLabel = (spec: SourceSpec): string => {
  if (spec.selector.kind === 'path') return spec.selector.path;
  if (spec.selector.kind === 'name') return spec.selector.name;
  return spec.identity.repository;
};
const resolveSymlinkAbsolute = (placementPath: string, literalTarget: string): string =>
  isAbsolute(literalTarget) ? literalTarget : join(dirname(placementPath), literalTarget);
// ---------------------------------------------------------------------------------------------
// result builders
// ---------------------------------------------------------------------------------------------
const emptyResult = (
  source: string,
  scope: InstallScope,
  action: InstallAction,
  requestIndex?: number,
): InstallResult => ({
  source,
  skill: null,
  tool: null,
  scope,
  placementPath: null,
  action,
  reason: null,
  placement: null,
  store: null,
  origin: null,
  verify: null,
  candidates: null,
  ...(requestIndex === undefined ? {} : { requestIndex }),
});
// ---------------------------------------------------------------------------------------------
// verify gate (D11 mirror; install-specific --deep wiring)
// ---------------------------------------------------------------------------------------------
interface Gate {
  blocked: SkillSmithError | null;
  gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
  verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
  mode: 'static' | 'static+deep' | null;
  notice: string | null;
}
const summarizeFindings = (tv: ToolVerdict<string> | undefined): string => {
  if (!tv) return 'no verdict produced';
  const findings = tv.modes
    .flatMap((m) => m.findings)
    .filter((fnd) => fnd.normalizedSeverity !== 'info');
  if (findings.length === 0) return `verdict ${tv.verdict}`;
  return findings.map((fnd) => `${fnd.checkId}: ${fnd.message}`).join('; ');
};
const runInstallVerifyGate = async (
  env: AcquisitionPorts,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
  tool: FlipTool,
  path: string,
  opts: InstallOptions,
  observation?: ObservationBundle,
): Promise<Gate> => {
  if (opts.noVerify) {
    return { blocked: null, gate: 'skipped', verdict: null, mode: null, notice: null };
  }
  const verification = registry.get(tool)?.verification;
  if (verification === undefined) {
    const blocked = genericError(`tool registry invariant: ${tool} has no verifier`);
    return { blocked, gate: 'failed', verdict: 'fail', mode: 'static', notice: null };
  }
  const deep = verification.gatePolicy.installDeep && opts.deep === true;
  const mode: 'static' | 'static+deep' = deep ? 'static+deep' : 'static';
  let untrustedVerification: unknown;
  try {
    const request = {
      path,
      tools: [tool],
      deep,
      strict: opts.strict ?? false,
      ...(observation === undefined ? {} : { observation }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    untrustedVerification =
      deps.verify === verifyPlugin
        ? await runVerify(env, request, verificationRegistryFor(registry))
        : await deps.verify(env, request);
  } catch (error) {
    const blocked = sourceUnresolvableError(`verification failed: ${safeUnknownMessage(error)}`);
    return { blocked, gate: 'failed', verdict: 'fail', mode, notice: null };
  }
  const vr = safeDependencyResult<VerifyReport<string>>(untrustedVerification);
  if (!vr.ok) {
    return {
      blocked: safeError(vr.error),
      gate: 'failed',
      verdict: 'fail',
      mode,
      notice: null,
    };
  }
  const tv = vr.value.tools.find((t) => t.tool === tool);
  const verdict = tv?.verdict ?? vr.value.summary.verdict;
  const outcome = evaluateVerificationGate({
    verdict,
    strict: opts.strict ?? false,
    requestedMode: mode,
  });
  let blocked: SkillSmithError | null = null;
  if (outcome.blocked) {
    if (verdict === 'fail') {
      blocked = flipFailedError(
        `installation blocked: '${path}' failed verification for ${tool}: ${summarizeFindings(tv)}`,
      );
    } else if (verdict === 'warn') {
      blocked = flipFailedError(`verify warnings blocked under --strict for ${tool}`);
    } else {
      blocked = flipFailedError(`verify gate inconclusive under --strict for ${tool}`);
    }
  }
  return {
    blocked,
    gate: outcome.gate,
    verdict,
    mode,
    notice:
      outcome.gate === 'inconclusive'
        ? `verify gate was inconclusive for ${tool}; proceeding unverified`
        : null,
  };
};
// ---------------------------------------------------------------------------------------------
// source resolution and remote acquisition (once per source)
// ---------------------------------------------------------------------------------------------
interface Resolved {
  sha: string;
  skillName: string;
  skillPath: string; // repo-relative git tree path ('' for a root skill)
  materializedDir: string; // fetched skill dir OR store entry (verify + snapshot source)
  fetchDir: string | null; // for cleanup (null when elided)
}
type ResolveOutcome =
  | { kind: 'resolved'; r: Resolved }
  | { kind: 'result'; result: InstallResult; fetchDir: string | null };
const sourcePathIsValid = (path: string): boolean => {
  if (path === '') return true;
  const normalized = normalizeSourceIdentity(
    `https://fixture.invalid/acme/repository//${path}`,
    'install.candidate.path',
  );
  return normalized.ok && normalized.value.path === path;
};
// Elision (F-fetch): a full-SHA-resolvable ref whose skill path is known without a tree scan and
// whose store entry already exists — skip the clone entirely (restricted to //path or a
// ledger-recorded origin so R2's never-guess is not bypassed).
const tryElide = async (
  env: AcquisitionPorts,
  transport: InstallSourceTransport,
  spec: SourceSpec,
  storeRoot: string,
  ledger: LedgerFile,
  scopeKey: string | null,
  signal: AbortSignal | undefined,
): Promise<Resolved | null> => {
  let rawProbe: unknown;
  try {
    rawProbe = await transport.resolveRef(env, spec.cloneUrl, spec.ref, signal);
  } catch {
    return null;
  }
  const probe = safeTransportResult(rawProbe);
  if (probe.kind !== 'ok' || (probe.value !== null && typeof probe.value !== 'string')) return null;
  if (probe.value === null) return null;
  const sha = probe.value;
  if (!/^[0-9a-f]{40}$/u.test(sha) || containsSensitiveMaterial(sha)) return null;
  let name: string | null = null;
  let path: string | null = null;
  if (spec.selector.kind === 'path') {
    path = spec.selector.path;
    name = basename(spec.selector.path);
  } else {
    // a ledger origin matching (repo, refResolved=SHA) that pins skillPath + skill name
    const tree = scopeKey === null ? ledger.skills : (ledger.projects?.[scopeKey]?.skills ?? {});
    const matches: { name: string; path: string }[] = [];
    for (const skill of Object.keys(tree)) {
      const tools = tree[skill]?.tools ?? {};
      for (const tool of Object.keys(tools) as FlipTool[]) {
        const origin = tools[tool]?.origin;
        if (origin && origin.repo === spec.identity.repository && origin.refResolved === sha) {
          if (spec.selector.kind === 'name' && skill !== spec.selector.name) continue;
          matches.push({ name: skill, path: origin.skillPath });
        }
      }
    }
    const unique = matches.filter(
      (m, i) => matches.findIndex((x) => x.name === m.name && x.path === m.path) === i,
    );
    if (unique.length === 1 && unique[0]) {
      if (
        validateManifestName(unique[0].name, 'install.skill.name').ok &&
        sourcePathIsValid(unique[0].path) &&
        !containsSensitiveMaterial(unique[0].name) &&
        !containsSensitiveMaterial(unique[0].path)
      ) {
        name = unique[0].name;
        path = unique[0].path;
      }
    }
  }
  if (name === null || path === null) return null;
  if (
    !validateManifestName(name, 'install.skill.name').ok ||
    !sourcePathIsValid(path) ||
    containsSensitiveMaterial(name) ||
    containsSensitiveMaterial(path)
  ) {
    return null;
  }
  const { ns, name: nsName } = clampStoreNs(spec.identity.repository);
  const storeEntry = join(storeRoot, ns, `${nsName}@${sha.slice(0, 12)}`, name);
  if ((await env.pathKind(storeEntry)) === 'absent') return null;
  return { sha, skillName: name, skillPath: path, materializedDir: storeEntry, fetchDir: null };
};
const resolveSource = async (
  env: AcquisitionPorts,
  deps: InstallDeps,
  spec: SourceSpec,
  scope: InstallScope,
  scopeKey: string | null,
  storeRoot: string,
  dataDir: string,
  ledger: LedgerFile,
  opts: InstallOptions,
): Promise<ResolveOutcome> => {
  const transport = deps.transport ?? defaultInstallSourceTransport;
  const elided = await tryElide(env, transport, spec, storeRoot, ledger, scopeKey, opts.signal);
  if (elided) return { kind: 'resolved', r: elided };
  const fetchDir = join(dataDir, '.fetch', txIdOf(env, deps));
  let rawFetchResult: unknown;
  try {
    rawFetchResult = await transport.fetchRepo(env, {
      cloneUrl: spec.cloneUrl,
      ref: spec.ref,
      fetchDir,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    rawFetchResult = err(
      sourceUnresolvableError(`source transport failed: ${safeUnknownMessage(error)}`),
    );
  }
  const fr = safeTransportResult(rawFetchResult);
  if (fr.kind !== 'ok') {
    const error =
      fr.kind === 'error'
        ? fr.error
        : sourceUnresolvableError('source transport returned invalid result metadata');
    const result = {
      ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
      reason: msg(error),
      error,
    };
    return { kind: 'result', result, fetchDir };
  }
  const fetchValue = dataRecord(fr.value);
  if (fetchValue !== null && !hasExactOwnKeys(fetchValue, ['sha'])) {
    const error = sourceUnresolvableError('source transport returned invalid result metadata');
    return {
      kind: 'result',
      result: {
        ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
        reason: msg(error),
        error,
      },
      fetchDir,
    };
  }
  const sha = fetchValue === null ? undefined : ownDataValue(fetchValue, 'sha');
  if (typeof sha !== 'string') {
    const error = sourceUnresolvableError('source transport returned invalid result metadata');
    return {
      kind: 'result',
      result: {
        ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
        reason: msg(error),
        error,
      },
      fetchDir,
    };
  }
  if (!/^[0-9a-f]{40}$/u.test(sha) || containsSensitiveMaterial(sha)) {
    const error = sourceUnresolvableError('remote source produced invalid ref metadata');
    return {
      kind: 'result',
      result: {
        ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
        reason: msg(error),
        error,
      },
      fetchDir,
    };
  }
  let rawListResult: unknown;
  try {
    rawListResult = await transport.listSkills(env, fetchDir, opts.signal);
  } catch (error) {
    rawListResult = err(
      sourceUnresolvableError(`source listing failed: ${safeUnknownMessage(error)}`),
    );
  }
  const lst = safeTransportResult(rawListResult);
  if (lst.kind !== 'ok') {
    const error =
      lst.kind === 'error'
        ? lst.error
        : sourceUnresolvableError('source transport returned invalid candidate metadata');
    const result = {
      ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
      reason: msg(error),
      error,
    };
    return { kind: 'result', result, fetchDir };
  }
  const candidateFailure = (): ResolveOutcome => {
    const error = sourceUnresolvableError(
      'remote source produced invalid or sensitive skill metadata',
    );
    return {
      kind: 'result',
      result: {
        ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
        reason: msg(error),
        error,
      },
      fetchDir,
    };
  };
  const listValue = dataRecord(lst.value);
  if (listValue !== null && !hasExactOwnKeys(listValue, ['candidates', 'scanned'])) {
    return candidateFailure();
  }
  const candidateValues = listValue === null ? undefined : ownDataValue(listValue, 'candidates');
  const scanned = listValue === null ? undefined : ownDataValue(listValue, 'scanned');
  if (
    !Array.isArray(candidateValues) ||
    typeof scanned !== 'number' ||
    !Number.isSafeInteger(scanned) ||
    scanned < 0 ||
    scanned !== candidateValues.length
  ) {
    return candidateFailure();
  }
  const candidates: CandidateSkill[] = [];
  for (const candidateValue of candidateValues) {
    const candidate = dataRecord(candidateValue);
    if (candidate !== null && !hasExactOwnKeys(candidate, ['path', 'name'])) {
      return candidateFailure();
    }
    const path = candidate === null ? undefined : ownDataValue(candidate, 'path');
    const candidateName = candidate === null ? undefined : ownDataValue(candidate, 'name');
    if (typeof path !== 'string' || typeof candidateName !== 'string') {
      return candidateFailure();
    }
    const name = path === '' ? lastSegment(spec.identity.repository) : candidateName;
    if (
      !sourcePathIsValid(path) ||
      !validateManifestName(name, 'install.candidate.name').ok ||
      containsSensitiveMaterial(path) ||
      containsSensitiveMaterial(name)
    ) {
      return candidateFailure();
    }
    candidates.push(Object.freeze({ path, name }));
  }
  const matches = matchCandidates(candidates, spec.selector);
  const selection = await selectSkill(matches, scanned, deps.pick);
  if (selection.kind === 'none') {
    const e = {
      code: 'source-unresolvable' as const,
      message: `'${selectorLabel(spec)}' matched no skills in ${spec.identity.repository} @ ${sha.slice(0, 12)}: searched ${selection.searched} SKILL.md directories`,
    };
    return {
      kind: 'result',
      result: {
        ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
        reason: e.message,
        error: e,
      },
      fetchDir,
    };
  }
  if (selection.kind === 'ambiguous') {
    const cands = selection.candidates.map((m) => `${spec.identity.repository}//${m.path}`);
    if (cands.some(containsSensitiveMaterial)) return candidateFailure();
    const reason = `'${selectorLabel(spec)}' matches ${selection.candidates.length} skills — re-run with one of the exact paths above`;
    return {
      kind: 'result',
      result: {
        ...emptyResult(spec.canonicalInvocation, scope, 'refused'),
        reason,
        candidates: cands,
        error: flipRefusedError(reason),
      },
      fetchDir,
    };
  }
  const skillPath = selection.skill.path;
  const skillName = skillPath === '' ? lastSegment(spec.identity.repository) : selection.skill.name;
  if (
    !sourcePathIsValid(skillPath) ||
    !validateManifestName(skillName, 'install.skill.name').ok ||
    containsSensitiveMaterial(skillPath) ||
    containsSensitiveMaterial(skillName)
  ) {
    return candidateFailure();
  }
  let rawMaterializeResult: unknown;
  try {
    rawMaterializeResult = await transport.materializeSkill(env, fetchDir, skillPath, opts.signal);
  } catch (error) {
    rawMaterializeResult = err(
      sourceUnresolvableError(`source materialization failed: ${safeUnknownMessage(error)}`),
    );
  }
  const co = safeTransportResult(rawMaterializeResult);
  if (co.kind !== 'ok') {
    const error =
      co.kind === 'error'
        ? co.error
        : sourceUnresolvableError('source transport returned invalid materialization metadata');
    const result = {
      ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
      reason: msg(error),
      error,
    };
    return { kind: 'result', result, fetchDir };
  }
  if (typeof co.value !== 'string' || containsSensitiveMaterial(co.value)) {
    const error = sourceUnresolvableError(
      'source transport returned invalid materialization metadata',
    );
    return {
      kind: 'result',
      result: {
        ...emptyResult(spec.canonicalInvocation, scope, 'failed'),
        reason: msg(error),
        error,
      },
      fetchDir,
    };
  }
  return {
    kind: 'resolved',
    r: { sha, skillName, skillPath, materializedDir: co.value, fetchDir },
  };
};
// ---------------------------------------------------------------------------------------------
// placement (per tool, scope)
// ---------------------------------------------------------------------------------------------
interface PlaceCtx {
  env: AcquisitionPorts;
  registry: LifecycleToolRegistry<string>;
  deps: InstallDeps;
  opts: InstallOptions;
  ledger: LedgerModel;
  ledgerPath: string;
  storeRoot: string;
  scope: InstallScope;
  scopeKey: string | null;
  projectRoot: string | null;
  logicalOperation: ExecutableOperation | null;
  operationObservation: ObservationBundle | undefined;
}
const placeExecutionInput = (p: PlaceCtx): AcquireExecutionInput =>
  executionInputOf(p.env, p.ledgerPath, p.ledger, p.deps, p.opts, p.logicalOperation);
// dir→dir routing: the swap engine rejects a same-kind copy-over-copy replace, so a copy re-install
// over a real dir is routed as two kind changes (dir→store-symlink, then store-symlink→dir). Every
// other transition (symlink→symlink re-pin, dir→symlink, symlink→dir) is a single swap the engine
// handles directly.
const replaceSwap = async (
  p: PlaceCtx,
  plan: SwapPlan,
  build: 'symlink' | 'copy',
  live: Placement,
  snap: SnapshotResult,
  sha: string,
  gate: Gate,
): Promise<Result<void, SkillSmithError>> => {
  const intermediatePinned =
    build === 'copy' && live.class === 'pinned'
      ? createAcquisitionPinnedRecord(snap, sha, 'symlink', gate.gate, nowOf(p.env, p.deps))
      : null;
  const executed = await executeAcquireReplacementWithObservation(
    placeExecutionInput(p),
    plan,
    intermediatePinned,
    p.operationObservation,
  );
  p.ledger = executed.state.ledger;
  if (!executed.ok) return err(executed.error);
  return ok(undefined);
};
const placePair = async (
  p: PlaceCtx,
  spec: SourceSpec,
  resolved: Resolved,
  tool: FlipTool,
  snap: SnapshotResult,
  gate: Gate,
  storeReused: boolean,
): Promise<InstallResult> => {
  const { env, opts } = p;
  const skill = resolved.skillName;
  const sha = resolved.sha;
  const build: 'symlink' | 'copy' = opts.direct ? 'copy' : 'symlink';
  const rootsCtx = {
    cwd: p.scope === 'project' ? (p.scopeKey as string) : opts.cwd,
    configuration: opts.configuration,
  };
  const installRoot = destinationSkillRootFor(p.registry, tool, env, p.scope, rootsCtx);
  const placementPath = join(installRoot, skill);
  const resultVerify =
    gate.gate === 'skipped' ? null : { gate: gate.gate, verdict: gate.verdict, mode: gate.mode };
  const originOut = {
    host: spec.identity.host,
    repo: spec.identity.repository,
    skillPath: resolved.skillPath,
    refRequested: spec.ref,
    refResolved: sha,
    pin: opts.pin ?? false,
  };
  const storeOut = {
    path: snap.storePath,
    rev: sha.slice(0, 12),
    gitSha: sha,
    reused: storeReused,
  };
  const base: InstallResult = {
    source: spec.canonicalInvocation,
    skill,
    tool,
    scope: p.scope,
    placementPath,
    action: 'installed',
    reason: null,
    placement: build,
    store: storeOut,
    origin: originOut,
    verify: resultVerify,
    candidates: null,
  };
  const refuse = (reason: string): InstallResult => ({
    ...base,
    action: 'refused',
    reason,
    placement: null,
    store: null,
    origin: null,
    error: flipRefusedError(reason),
  });
  const fail = (e: SkillSmithError): InstallResult => ({
    ...base,
    ...(e.code === 'cancelled' || (opts.signal?.aborted && msg(e) === 'interrupted')
      ? {
          action: 'skipped' as const,
          reason: 'interrupted',
          placement: null,
          store: null,
          origin: null,
          error: cancelledError('interrupted'),
        }
      : {
          action: 'failed' as const,
          reason: msg(e),
          placement: null,
          store: null,
          origin: null,
          error: safeError(e),
        }),
  });
  const currentResolution = await resolvePlacementFor(
    p.registry,
    tool,
    env,
    p.scope,
    rootsCtx,
    p.storeRoot,
    skill,
  );
  if (currentResolution.duplicateReason !== null) {
    return refuse(currentResolution.duplicateReason);
  }
  if (
    currentResolution.placement.class !== 'absent' &&
    currentResolution.placement.root !== installRoot
  ) {
    const notice =
      currentResolution.notices.length === 0 ? '' : ` ${currentResolution.notices.join('; ')}`;
    return refuse(
      `'${skill}' already exists at ${currentResolution.placement.path}.${notice} Remove it first: skillsmith uninstall ${skill} --tool ${tool}`,
    );
  }
  try {
    await env.makeDir(installRoot);
  } catch (e) {
    return fail(genericError(`cannot create skills root ${installRoot}: ${errorMessage(e)}`));
  }
  // F5: cross-scope shadowing (project shadows user for this repo).
  let shadowWarning: string | null = null;
  const otherScope: InstallScope = p.scope === 'project' ? 'user' : 'project';
  const otherKey = otherScope === 'project' ? p.projectRoot : null;
  if (!(otherScope === 'project' && otherKey === null)) {
    const otherCtx = {
      cwd: otherScope === 'project' ? (otherKey as string) : opts.cwd,
      configuration: opts.configuration,
    };
    const otherResolution = await resolvePlacementFor(
      p.registry,
      tool,
      env,
      otherScope,
      otherCtx,
      p.storeRoot,
      skill,
    );
    const hasPair = getPairAt(p.ledger, otherKey, skill, tool) !== null;
    if (
      otherResolution.duplicateReason !== null ||
      otherResolution.placement.class !== 'absent' ||
      hasPair
    ) {
      const reason = `project-scope skills shadow user-scope skills of the same name for this repo: ${placementPath} vs ${otherResolution.placement.path}`;
      if (!opts.force) return refuse(reason);
      shadowWarning = `proceeding despite shadow (--force): ${reason}`;
    }
  }
  const existing = getPairAt(p.ledger, p.scopeKey, skill, tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    // Global Constraint #6: an unresolved journal refuses every operation EXCEPT a same-op re-run
    // (which RESUMES it to completion) and --rollback. A same-op install re-run drives the recorded
    // swap forward via the generic resumeSwap; a DIFFERENT interrupted op still refuses, naming that
    // journal's op for the same-op-re-run / --rollback recovery.
    if (existing.journal.op === 'install') {
      const wasFresh = existing.journal.before.mode === 'absent';
      const resumed = await recoverAcquireWithObservation(
        placeExecutionInput(p),
        { skill, tool, scopeKey: p.scopeKey },
        p.operationObservation,
      );
      p.ledger = resumed.state.ledger;
      if (!resumed.ok) {
        return fail(
          resumed.error.code === 'ledger-error'
            ? flipFailedError(msg(resumed.error))
            : resumed.error,
        );
      }
      const after = getPairAt(p.ledger, p.scopeKey, skill, tool);
      return {
        ...base,
        action: wasFresh ? 'installed' : 'updated',
        reason: resumed.value.warning ?? shadowWarning ?? gate.notice,
        placement: after?.pinned?.placement ?? base.placement,
        store: after?.pinned
          ? {
              path: after.pinned.storePath,
              rev: after.pinned.rev,
              gitSha: after.pinned.gitSha ?? sha,
              reused: true,
            }
          : base.store,
      };
    }
    return refuse(recoveryRefusedMessage(existing.journal.op, skill, spec.canonicalInvocation));
  }
  const live = currentResolution.placement;
  // Does the live placement already materialize THIS resolved store entry?
  let liveKind: 'symlink' | 'copy' | null = null;
  if (live.class === 'store-linked' && live.symlinkTarget === snap.storePath) {
    liveKind = 'symlink';
  } else if (live.class === 'pinned') {
    const h = await contentHashOf(env, live.path);
    if (h.ok && h.value === snap.contentHash) liveKind = 'copy';
  }
  const finalize = (action: InstallAction): InstallResult => ({
    ...base,
    action,
    reason: shadowWarning ?? gate.notice,
  });
  // Idempotence / repair (F7 / D14) — only when not forcing.
  if (liveKind !== null && !opts.force) {
    const recordMatches =
      existing?.origin?.refResolved === sha &&
      existing.pinned?.storePath === snap.storePath &&
      (existing.pinned?.placement ?? 'copy') === liveKind;
    if (recordMatches) {
      return { ...finalize('noop'), reason: `already installed at ${sha.slice(0, 12)}` };
    }
    // Placement intact + matching the resolved store entry but the record is missing/stale →
    // rewrite the pair record only (no filesystem change).
    const pinned = createAcquisitionPinnedRecord(
      snap,
      sha,
      liveKind,
      gate.gate,
      nowOf(p.env, p.deps),
    );
    const origin = createAcquisitionOriginRecord(
      spec,
      sha,
      resolved.skillPath,
      opts.pin ?? false,
      nowOf(p.env, p.deps),
    );
    const repaired: PairRecord = {
      placementPath,
      mode: 'pinned',
      dev: existing?.dev ?? null,
      pinned,
      origin,
      journal: null,
    };
    if (p.logicalOperation === null) {
      return fail(
        flipFailedError('record-only install repair requires logical operation identity'),
      );
    }
    const persisted = await executeRecordOnlyAcquirePlan(
      placeExecutionInput(p),
      p.logicalOperation,
      repaired,
      p.scopeKey,
    );
    p.ledger = persisted.state.ledger;
    if (!persisted.ok) return fail(persisted.error);
    return { ...finalize('repaired'), placement: liveKind };
  }
  const pinned = createAcquisitionPinnedRecord(snap, sha, build, gate.gate, nowOf(p.env, p.deps));
  const origin = createAcquisitionOriginRecord(
    spec,
    sha,
    resolved.skillPath,
    opts.pin ?? false,
    nowOf(p.env, p.deps),
  );
  // Adopt a genuine dev symlink (points outside the store) so nothing is lost on rollback.
  const adoptedDev =
    live.class === 'dev' && live.symlinkTarget !== null
      ? {
          sourcePath: live.symlinkTarget,
          resolvedPath: resolveSymlinkAbsolute(placementPath, live.symlinkTarget),
          repoRoot: null,
          sourceRelPath: null,
          remote: null,
          recordedAt: nowOf(p.env, p.deps),
        }
      : null;
  const plan: SwapPlan = {
    op: 'install',
    skill,
    tool,
    skillsRoot: installRoot,
    placementPath,
    scopeKey: p.scopeKey,
    install: {
      build,
      storePath: snap.storePath,
      contentHash: snap.contentHash,
      pinned,
      origin,
      adoptedDev,
    },
  };
  // Fresh install: the slot is empty. Clear any stale records so the engine lands on an empty slot.
  if (live.class === 'absent') {
    if (existing && (existing.pinned || existing.dev)) {
      const cleared = withoutLedgerPairAt(p.ledger, p.scopeKey, skill, tool);
      if (!cleared.ok) return fail(cleared.error);
      p.ledger = cleared.value;
    }
    const r = await executeAcquirePlanWithObservation(
      placeExecutionInput(p),
      plan,
      p.operationObservation,
    );
    p.ledger = r.state.ledger;
    if (!r.ok)
      return fail(r.error.code === 'ledger-error' ? flipFailedError(msg(r.error)) : r.error);
    if (r.value.warning)
      shadowWarning = shadowWarning ? `${shadowWarning}; ${r.value.warning}` : r.value.warning;
    return { ...finalize('installed'), store: { ...storeOut, reused: storeReused } };
  }
  // Replace. A managed pair for this same repo may update freely; anything else needs --force.
  const managed = existing?.origin?.repo === spec.identity.repository;
  if (!managed && !opts.force) {
    const recorded = existing?.origin ? existing.origin.repo : 'unmanaged';
    return refuse(
      `'${skill}' (${tool}) already exists at ${placementPath} (recorded origin: ${recorded}); re-run with --force to overwrite`,
    );
  }
  const swapRes = await replaceSwap(p, plan, build, live, snap, sha, gate);
  if (!swapRes.ok) {
    return fail(
      swapRes.error.code === 'ledger-error' ? flipFailedError(msg(swapRes.error)) : swapRes.error,
    );
  }
  return { ...finalize('updated'), store: { ...storeOut, reused: storeReused } };
};
// ---------------------------------------------------------------------------------------------
// dry-run prediction (read-only)
// ---------------------------------------------------------------------------------------------
const predictPair = async (
  p: PlaceCtx,
  spec: SourceSpec,
  resolved: Resolved,
  tool: FlipTool,
): Promise<InstallResult> => {
  const { env, opts } = p;
  const skill = resolved.skillName;
  const sha = resolved.sha;
  const build: 'symlink' | 'copy' = opts.direct ? 'copy' : 'symlink';
  const rootsCtx = {
    cwd: p.scope === 'project' ? (p.scopeKey as string) : opts.cwd,
    configuration: opts.configuration,
  };
  const installRoot = destinationSkillRootFor(p.registry, tool, env, p.scope, rootsCtx);
  const placementPath = join(installRoot, skill);
  const { ns, name } = clampStoreNs(spec.identity.repository);
  const expectedStorePath = join(p.storeRoot, ns, `${name}@${sha.slice(0, 12)}`, skill);
  const base: InstallResult = {
    source: spec.canonicalInvocation,
    skill,
    tool,
    scope: p.scope,
    placementPath,
    action: 'installed',
    reason: null,
    placement: build,
    store: { path: expectedStorePath, rev: sha.slice(0, 12), gitSha: sha, reused: false },
    origin: {
      host: spec.identity.host,
      repo: spec.identity.repository,
      skillPath: resolved.skillPath,
      refRequested: spec.ref,
      refResolved: sha,
      pin: opts.pin ?? false,
    },
    verify: null,
    candidates: null,
  };
  const refuse = (reason: string): InstallResult => ({
    ...base,
    action: 'refused',
    reason,
    placement: null,
    store: null,
    origin: null,
    error: flipRefusedError(reason),
  });
  const currentResolution = await resolvePlacementFor(
    p.registry,
    tool,
    env,
    p.scope,
    rootsCtx,
    p.storeRoot,
    skill,
  );
  if (currentResolution.duplicateReason !== null) {
    return refuse(currentResolution.duplicateReason);
  }
  if (
    currentResolution.placement.class !== 'absent' &&
    currentResolution.placement.root !== installRoot
  ) {
    const notice =
      currentResolution.notices.length === 0 ? '' : ` ${currentResolution.notices.join('; ')}`;
    return refuse(
      `'${skill}' already exists at ${currentResolution.placement.path}.${notice} Remove it first: skillsmith uninstall ${skill} --tool ${tool}`,
    );
  }
  const otherScope: InstallScope = p.scope === 'project' ? 'user' : 'project';
  const otherKey = otherScope === 'project' ? p.projectRoot : null;
  if (!(otherScope === 'project' && otherKey === null)) {
    const otherCtx = {
      cwd: otherScope === 'project' ? (otherKey as string) : opts.cwd,
      configuration: opts.configuration,
    };
    const otherResolution = await resolvePlacementFor(
      p.registry,
      tool,
      env,
      otherScope,
      otherCtx,
      p.storeRoot,
      skill,
    );
    const shadowed =
      otherResolution.duplicateReason !== null ||
      otherResolution.placement.class !== 'absent' ||
      getPairAt(p.ledger, otherKey, skill, tool) !== null;
    if (shadowed && !opts.force) {
      return refuse(
        `project-scope skills shadow user-scope skills of the same name for this repo: ${placementPath} vs ${otherResolution.placement.path}`,
      );
    }
  }
  const existing = getPairAt(p.ledger, p.scopeKey, skill, tool);
  if (existing?.journal && existing.journal.phase !== 'committed') {
    // A same-op install re-run would RESUME to completion (#6); a different op still refuses.
    if (existing.journal.op === 'install') {
      return {
        ...base,
        action: existing.journal.before.mode === 'absent' ? 'installed' : 'updated',
      };
    }
    return refuse(recoveryRefusedMessage(existing.journal.op, skill, spec.canonicalInvocation));
  }
  const live = currentResolution.placement;
  if (live.class === 'absent') return { ...base, action: 'installed' };
  const matchesResolved =
    (live.class === 'store-linked' && live.symlinkTarget === expectedStorePath) ||
    live.class === 'pinned';
  if (matchesResolved && !opts.force) {
    if (existing?.origin?.refResolved === sha) {
      return { ...base, action: 'noop', reason: `already installed at ${sha.slice(0, 12)}` };
    }
    return { ...base, action: 'repaired', placement: null };
  }
  const managed = existing?.origin?.repo === spec.identity.repository;
  if (!managed && !opts.force) {
    const recorded = existing?.origin ? existing.origin.repo : 'unmanaged';
    return refuse(
      `'${skill}' (${tool}) already exists at ${placementPath} (recorded origin: ${recorded}); re-run with --force to overwrite`,
    );
  }
  return { ...base, action: 'updated' };
};
// ---------------------------------------------------------------------------------------------
// report assembly
// ---------------------------------------------------------------------------------------------
const closedPlanningText = (value: string | null, fallback: string): string =>
  value !== null && value.length > 0 && !containsSensitiveMaterial(value) ? value : fallback;
const createInstallExecutionResult = (
  operation: ExecutableOperation,
  result: InstallResult | undefined,
  requested: InstallReport['requested'],
  actualBefore: OperationImage = operation.before,
): OperationExecutionResult => {
  const cancelled =
    result?.action === 'skipped' &&
    (result.reason === 'interrupted' || result.error?.code === 'cancelled');
  const skippedAfterFailure = result?.action === 'skipped' && result.reason === 'fail-fast';
  const succeeded =
    result?.action === 'installed' || result?.action === 'updated' || result?.action === 'repaired';
  const actualAfter = succeeded ? operation.after : actualBefore;
  const common = {
    operationId: operation.operationId,
    actualBefore,
    actualAfter,
    force: createBoundedForceEffect({
      supported: true,
      requested: requested.force,
      conflict: null,
    }),
  } as const;
  if (cancelled) {
    return createOperationExecutionResult({ ...common, outcome: 'cancelled', error: null });
  }
  if (skippedAfterFailure) {
    return createOperationExecutionResult({
      ...common,
      outcome: 'skipped-after-failure',
      error: null,
    });
  }
  if (!succeeded) {
    return createOperationExecutionResult({
      ...common,
      outcome: 'failed',
      error: {
        code: result?.error?.code ?? 'install-failed',
        message: closedPlanningText(result?.reason ?? null, 'prepared install binding failed'),
        remediation: 'Resolve the reported condition and retry the same selection.',
      },
    });
  }
  return createOperationExecutionResult({ ...common, outcome: 'succeeded', error: null });
};
const installSummary = (results: readonly InstallResult[]): InstallReport['summary'] => {
  const summary = {
    installed: 0,
    updated: 0,
    repaired: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
  };
  for (const result of results) summary[result.action]++;
  return summary;
};
const assembleInstallReport = (
  dryRun: boolean,
  requested: InstallReport['requested'],
  results: InstallResult[],
  plan: OperationPlan<'install'>,
  executionResults: readonly OperationExecutionResult[],
): PlannedInstallReport => ({
  dryRun,
  requested,
  results,
  summary: installSummary(results),
  plan,
  executionResults,
});
const createInstallDiagnosticReport = (
  dryRun: boolean,
  requested: InstallReport['requested'],
  results: InstallResult[],
  continueOnError: boolean,
  registry: LifecycleToolRegistry<string>,
): PlannedInstallReport => {
  const planningContext = { registry, toolOrder: registry.ids };
  const compatibility = createInstallPlanning(
    requested,
    results,
    continueOnError,
    null,
    planningContext,
  );
  const planned = createAcquisitionDiagnosticPlan(
    {
      schemaVersion: 1,
      command: 'install',
      selection: {
        source: 'explicit-targets',
        skills: [...new Set(results.flatMap(({ skill }) => (skill === null ? [] : [skill])))],
        tools: [...new Set(results.flatMap(({ tool }) => (tool === null ? [] : [tool])))],
        scopes: [requested.scope],
      },
      batchPolicy: continueOnError ? 'continue-on-error' : 'fail-fast',
      diagnostics: compatibility.plan.diagnostics,
    },
    planningContext,
  );
  if (!planned.ok) throw new Error(planned.error.message);
  return assembleInstallReport(dryRun, requested, results, planned.value, []);
};
const rejectedSourceLabel = (input: string): string => {
  const safe = redactSensitiveString(input);
  return safe === input ? '[REJECTED_SOURCE]' : safe;
};
const rejectedRefLabel = (input: string): string => {
  const safe = redactSensitiveString(input);
  return safe === input ? '[REJECTED_REF]' : safe;
};
// ---------------------------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------------------------
const runInstallInternal = async (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
  planObservation?: AcquisitionPlanObservationState,
): Promise<Result<PlannedInstallReport, SkillSmithError>> => {
  const dataDir = resolveDataDir(env, opts.configuration);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
  // ---- Phase 0: pure pre-flight (no I/O) ----
  const overrideAllowed = opts.ref !== undefined && opts.sources.length === 1;
  const parsed = opts.sources.map((input, requestIndex) => {
    const baseRes = parseSource(input);
    const res = overrideAllowed ? parseSource(input, { overrideRef: opts.ref as string }) : baseRes;
    return { input, requestIndex, baseRes, res };
  });
  const sourceLabel = (
    input: string,
    baseRes: (typeof parsed)[number]['baseRes'],
    res: (typeof parsed)[number]['res'],
  ): string =>
    res.ok
      ? res.value.canonicalInvocation
      : baseRes.ok
        ? baseRes.value.canonicalInvocation
        : rejectedSourceLabel(input);
  const sourceLabels = parsed.map(({ input, baseRes, res }) => sourceLabel(input, baseRes, res));
  const fallbackScope: InstallScope = opts.scope ?? 'user';
  const requestedRef =
    opts.ref === undefined
      ? null
      : containsSensitiveMaterial(opts.ref) || !validateRequestedRef(opts.ref, 'install.ref').ok
        ? rejectedRefLabel(opts.ref)
        : opts.ref;
  const requestedBase = {
    sources: sourceLabels,
    explicitTools,
    ref: requestedRef,
    pin: opts.pin ?? false,
    direct: opts.direct ?? false,
    force: opts.force ?? false,
    verify: (opts.noVerify ? 'skipped' : 'static') as 'static' | 'skipped',
    deep: Boolean(opts.deep),
  };
  const anyParseFail = parsed.some((x) => !x.res.ok);
  if (anyParseFail) {
    // Resolution 3: whole invocation refuses before any I/O.
    const results: InstallResult[] = parsed.map(({ input, requestIndex, baseRes, res }) => {
      const label = sourceLabel(input, baseRes, res);
      if (!res.ok) {
        return {
          ...emptyResult(label, fallbackScope, 'refused', requestIndex),
          reason: msg(res.error),
          error: safeError(res.error),
        };
      }
      return {
        ...emptyResult(label, fallbackScope, 'skipped', requestIndex),
        reason: 'fail-fast',
      };
    });
    return ok(
      createInstallDiagnosticReport(
        false,
        {
          ...requestedBase,
          tools: [],
          scope: fallbackScope,
          explicitScope: opts.scope !== undefined,
        },
        results,
        Boolean(opts.continueOnError),
        registry,
      ),
    );
  }
  // --ref rules.
  if (opts.ref !== undefined && opts.sources.length > 1) {
    const results = parsed.map(({ input, requestIndex, baseRes, res }) => ({
      ...emptyResult(sourceLabel(input, baseRes, res), fallbackScope, 'refused', requestIndex),
      reason: '--ref is only valid with exactly one <source>',
      error: flipRefusedError('--ref is only valid with exactly one <source>'),
    }));
    return ok(
      createInstallDiagnosticReport(
        false,
        {
          ...requestedBase,
          tools: [],
          scope: fallbackScope,
          explicitScope: opts.scope !== undefined,
        },
        results,
        Boolean(opts.continueOnError),
        registry,
      ),
    );
  }
  const specs: { source: string; spec: SourceSpec; requestIndex: number }[] = parsed.map(
    ({ requestIndex, res }) => {
      const spec = (res as { ok: true; value: SourceSpec }).value;
      return { source: spec.canonicalInvocation, spec, requestIndex };
    },
  );
  // ---- Phase 1: target planning (local I/O only) ----
  const projectContext = await resolveAcquisitionProjectContextV1({
    env,
    cwd: opts.cwd,
    ...(opts.configuration.explicitConfigPath === undefined
      ? {}
      : { explicitConfigPath: opts.configuration.explicitConfigPath }),
  });
  const projectRoot = projectContext.projectRoot;
  const scope: InstallScope = opts.scope ?? (projectRoot ? 'project' : 'user');
  const scopeKey = scope === 'project' ? (projectRoot ?? (await env.realpath(opts.cwd))) : null;
  const explicitScope = opts.scope !== undefined;
  const installTools = registry.toolsFor('install') as readonly FlipTool[];
  const candidateTools = explicitTools
    ? [...(opts.tools as readonly FlipTool[])]
    : [...installTools];
  const detectedTools: FlipTool[] = [];
  const undetectedExplicit: FlipTool[] = [];
  for (const tool of candidateTools) {
    const d = safeDependencyResult<readonly unknown[]>(
      await detectAcquireToolWithObservation(
        env,
        tool,
        opts.signal,
        deps,
        defaultInstallDetect,
        registry,
        observation,
      ),
    );
    if (!d.ok) return d;
    if (!Array.isArray(d.value)) return err(genericError('tool detection failed'));
    if (d.value.length > 0) detectedTools.push(tool);
    else if (explicitTools) undetectedExplicit.push(tool);
  }
  const requested: InstallReport['requested'] = {
    ...requestedBase,
    tools: detectedTools,
    scope,
    explicitScope,
  };
  // Planning refusals: explicitly named but undetected tools → exit-4 per source.
  const planningRefusals: InstallResult[] = [];
  for (const tool of undetectedExplicit) {
    const e = toolUnavailableError(
      `${tool} is not detected; install it first: ${installHintFor(registry, tool)}`,
    );
    for (const { source, requestIndex } of specs) {
      planningRefusals.push({
        ...emptyResult(source, scope, 'refused', requestIndex),
        tool,
        reason: msg(e),
        error: safeError(e),
      });
    }
  }
  if (detectedTools.length === 0) {
    if (!explicitTools) {
      const e = toolUnavailableError(`no supported tool detected (${installTools.join(', ')})`);
      const results = specs.map(({ source, requestIndex }) => ({
        ...emptyResult(source, scope, 'refused', requestIndex),
        reason: msg(e),
        error: safeError(e),
      }));
      return ok(
        createInstallDiagnosticReport(
          false,
          requested,
          results,
          Boolean(opts.continueOnError),
          registry,
        ),
      );
    }
    return ok(
      createInstallDiagnosticReport(
        false,
        requested,
        planningRefusals,
        Boolean(opts.continueOnError),
        registry,
      ),
    );
  }
  interface PreparedInstallPairBinding {
    readonly kind: 'pair';
    readonly preview: InstallResult;
    readonly reportPreviews: readonly InstallResult[];
    readonly actualBefore: OperationImage;
    readonly liveResourceId: string;
    readonly storeResourceId: string;
    observe(): Promise<InstallPreconditionFacts>;
    execute(
      operation: ExecutableOperation,
      operationObservation?: ObservationBundle,
    ): Promise<InstallResult>;
  }
  interface PreparedInstallMigrationBinding {
    readonly kind: 'migrate-ledger';
    readonly expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
    onMigrated(model: LedgerModel): void;
  }
  type PreparedInstallBinding = PreparedInstallPairBinding | PreparedInstallMigrationBinding;
  interface PreparedInstallBatch {
    readonly preview: PlannedInstallReport;
    readonly bindings: ReadonlyMap<string, PreparedInstallBinding>;
    readonly preconditions: readonly ExecutionPrecondition[];
    readonly snapshotAuthority: AcquisitionSnapshotAuthorityV1;
    readonly expectedRevisions: readonly ExpectedRevisionV1[];
    readonly snapshotId: `snapshot:v1:${string}`;
    cleanup(): Promise<void>;
  }
  interface InstallPreconditionFacts {
    readonly projectRoot: string | null;
    readonly selectedPair: PairRecord | null;
    readonly live: AcquirePlacementFacts;
    readonly alternates: readonly AcquirePlacementFacts[];
    readonly shadow: Readonly<{
      pair: PairRecord | null;
      live: readonly AcquirePlacementFacts[];
    }> | null;
    readonly source: Readonly<{
      canonicalSource: string;
      repository: string;
      resolvedSha: string;
      skillPath: string;
      content: Readonly<{
        pathKind: AcquireContentFacts['pathKind'];
        contentHash: string | null;
      }>;
    }>;
    readonly store: AcquireContentFacts;
  }
  interface InstallBindingSeed {
    readonly preview: InstallResult;
    readonly spec: SourceSpec;
    readonly resolved: Resolved;
    readonly tool: FlipTool;
    execute(): Promise<InstallResult>;
  }
  const observeInstallState = async (
    seed: InstallBindingSeed,
  ): Promise<Readonly<{ ledger: LedgerModel; facts: InstallPreconditionFacts }>> => {
    const { preview, spec, resolved: resolvedSource, tool } = seed;
    if (preview.skill === null || preview.placementPath === null || preview.store === null) {
      throw new Error('prepared install facts require an executable result');
    }
    const rootsCtx = {
      cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
      configuration: opts.configuration,
    };
    const installRoot = destinationSkillRootFor(registry, tool, env, scope, rootsCtx);
    const ledgerResult = await readLedgerState(env, ledgerPath);
    if (!ledgerResult.ok) throw ledgerResult.error;
    const ledger = ledgerModelForMutation(ledgerResult.value, nowOf(env, deps));
    const selectedPair = getPairAt(ledger, scopeKey, preview.skill, tool);
    const live = await acquirePlacementFacts(env, installRoot, preview.skill, storeRoot);
    const alternates = await Promise.all(
      skillRootFactsFor(registry, tool, env, scope, rootsCtx)
        .filter((fact) => fact.role === 'alternate')
        .map((fact) => acquirePlacementFacts(env, fact.path, preview.skill as string, storeRoot)),
    );
    const otherScope: InstallScope = scope === 'project' ? 'user' : 'project';
    const otherKey = otherScope === 'project' ? projectRoot : null;
    let shadow: InstallPreconditionFacts['shadow'] = null;
    if (!(otherScope === 'project' && otherKey === null)) {
      const otherCtx = {
        cwd: otherScope === 'project' ? (otherKey as string) : opts.cwd,
        configuration: opts.configuration,
      };
      shadow = {
        pair: structuredClone(getPairAt(ledger, otherKey, preview.skill, tool)),
        live: await Promise.all(
          skillRootFactsFor(registry, tool, env, otherScope, otherCtx).map((fact) =>
            acquirePlacementFacts(env, fact.path, preview.skill as string, storeRoot),
          ),
        ),
      };
    }
    const sourceContent = await acquireContentFacts(env, resolvedSource.materializedDir);
    return {
      ledger,
      facts: {
        projectRoot,
        selectedPair: structuredClone(selectedPair),
        live,
        alternates,
        shadow,
        source: {
          canonicalSource: spec.canonicalSource,
          repository: spec.identity.repository,
          resolvedSha: resolvedSource.sha,
          skillPath: resolvedSource.skillPath,
          content: {
            pathKind: sourceContent.pathKind,
            contentHash: sourceContent.contentHash,
          },
        },
        store: await acquireContentFacts(env, preview.store.path),
      },
    };
  };
  // Resolve and verify the whole selection into immutable work before any store/placement binding
  // can run. Fetch materialization remains inside the existing outer lock for normal execution.
  const prepareAll = async (ledgerState: LedgerReadState): Promise<PreparedInstallBatch> => {
    const ledger = ledgerModelForMutation(ledgerState, nowOf(env, deps));
    const legacyLedger = legacyLedgerView(ledger);
    const results: InstallResult[] = [...planningRefusals];
    const candidateBindings = new Map<InstallResult, InstallBindingSeed>();
    const cleanupDirs = new Set<string>();
    const placeCtx: PlaceCtx = {
      env,
      registry,
      deps,
      opts,
      ledger,
      ledgerPath,
      storeRoot,
      scope,
      scopeKey,
      projectRoot,
      logicalOperation: null,
      operationObservation: undefined,
    };
    let planningFailFast = false;
    for (const { source, spec, requestIndex } of specs) {
      if (opts.signal?.aborted) {
        results.push({
          ...emptyResult(source, scope, 'skipped', requestIndex),
          reason: 'interrupted',
        });
        continue;
      }
      if (planningFailFast) {
        results.push({
          ...emptyResult(source, scope, 'skipped', requestIndex),
          reason: 'fail-fast',
        });
        continue;
      }
      const resolved = await resolveSource(
        env,
        deps,
        spec,
        scope,
        scopeKey,
        storeRoot,
        dataDir,
        legacyLedger,
        opts,
      );
      if (resolved.kind === 'result') {
        results.push({ ...resolved.result, requestIndex });
        if (resolved.fetchDir) cleanupDirs.add(resolved.fetchDir);
        if (resolved.result.error && !opts.continueOnError) planningFailFast = true;
        continue;
      }
      const r = resolved.r;
      if (r.fetchDir) cleanupDirs.add(r.fetchDir);
      if (
        [dataDir, storeRoot, r.materializedDir, r.skillName, r.skillPath].some(
          containsSensitiveMaterial,
        )
      ) {
        const error = sourceUnresolvableError(
          'remote source produced invalid or sensitive derived metadata',
        );
        results.push({
          ...emptyResult(source, scope, 'failed', requestIndex),
          reason: msg(error),
          error,
        });
        if (!opts.continueOnError) planningFailFast = true;
        continue;
      }
      const sourceResults: InstallResult[] = [];
      let snap: SnapshotResult | null = null;
      let snapErr: SkillSmithError | null = null;
      let snapConsumed = false;
      for (const tool of detectedTools) {
        if (opts.signal?.aborted) {
          sourceResults.push({
            ...emptyResult(source, scope, 'skipped', requestIndex),
            skill: r.skillName,
            tool,
            reason: 'interrupted',
          });
          continue;
        }
        const derivedRootsContext = {
          cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
          configuration: opts.configuration,
        };
        const derivedPlacementPath = join(
          destinationSkillRootFor(registry, tool, env, scope, derivedRootsContext),
          r.skillName,
        );
        if (containsSensitiveMaterial(derivedPlacementPath)) {
          const error = sourceUnresolvableError(
            'remote source produced invalid or sensitive derived metadata',
          );
          sourceResults.push({
            ...emptyResult(source, scope, 'failed', requestIndex),
            skill: r.skillName,
            tool,
            reason: msg(error),
            error,
          });
          continue;
        }
        const gate = await runInstallVerifyGate(
          env,
          deps,
          registry,
          tool,
          r.materializedDir,
          opts,
          observation,
        );
        if (gate.blocked) {
          const rootsCtx = {
            cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
            configuration: opts.configuration,
          };
          const installRoot = destinationSkillRootFor(registry, tool, env, scope, rootsCtx);
          sourceResults.push({
            ...emptyResult(source, scope, 'failed', requestIndex),
            skill: r.skillName,
            tool,
            placementPath: join(installRoot, r.skillName),
            reason: msg(gate.blocked),
            verify: { gate: gate.gate, verdict: gate.verdict, mode: gate.mode },
            error: safeError(gate.blocked),
          });
          continue;
        }
        let preview = { ...(await predictPair(placeCtx, spec, r, tool)), requestIndex };
        if (preview.action === 'noop' && preview.store !== null) {
          const [fetchedHash, storedHash] = await Promise.all([
            contentHashOf(env, r.materializedDir),
            contentHashOf(env, preview.store.path),
          ]);
          const integrityError = !fetchedHash.ok
            ? fetchedHash.error
            : !storedHash.ok
              ? storedHash.error
              : fetchedHash.value !== storedHash.value
                ? flipFailedError(
                    `store integrity violation: ${preview.store.path} exists with different content`,
                  )
                : null;
          if (integrityError !== null) {
            preview = {
              ...preview,
              action: 'failed',
              reason: msg(integrityError),
              store: null,
              error: safeError(integrityError),
            };
          }
        }
        sourceResults.push(preview);
        if (
          preview.action !== 'installed' &&
          preview.action !== 'updated' &&
          preview.action !== 'repaired' &&
          preview.action !== 'noop'
        ) {
          continue;
        }
        candidateBindings.set(preview, {
          preview,
          spec,
          resolved: r,
          tool,
          execute: async (): Promise<InstallResult> => {
            if (snap === null && snapErr === null) {
              const { ns, name } = clampStoreNs(spec.identity.repository);
              const provenance: Provenance = {
                kind: 'git-clean',
                gitSha: r.sha,
                ns,
                name,
                repoRoot: null,
                sourceRelPath: null,
                remote: spec.identity.repository,
                dirtySummary: null,
              };
              const snapshot = await snapshotToStore(env, {
                sourceDir: r.materializedDir,
                skill: r.skillName,
                storeRoot,
                provenance,
                txId: txIdOf(env, deps),
              });
              if (!snapshot.ok) snapErr = snapshot.error;
              else snap = snapshot.value;
            }
            if (snapErr !== null) {
              return {
                ...preview,
                action: 'failed',
                reason: msg(snapErr),
                store: null,
                error: safeError(snapErr),
              };
            }
            const storeReused = snapConsumed ? true : (snap as SnapshotResult).reused;
            const placed = await placePair(
              placeCtx,
              spec,
              r,
              tool,
              snap as SnapshotResult,
              gate,
              storeReused,
            );
            snapConsumed = true;
            return { ...placed, requestIndex };
          },
        });
      }
      results.push(...sourceResults);
      if (!opts.continueOnError && sourceResults.some((x) => x.error)) {
        planningFailFast = true;
      }
    }
    const preparedIntents: Array<
      Readonly<{
        seed: InstallBindingSeed;
        expectedFacts: InstallPreconditionFacts;
        intent: AcquisitionInstallIntentV1;
      }>
    > = [];
    const liveResourcesByPath = new Map<string, AcquireLiveSnapshotResourceV1>();
    const storeResourcesByPath = new Map<string, AcquireStoreSnapshotResourceV1>();
    const addLiveResource = (resource: AcquireLiveSnapshotResourceV1): void => {
      const existing = liveResourcesByPath.get(resource.placementPath);
      if (
        existing !== undefined &&
        (existing.skill !== resource.skill ||
          existing.tool !== resource.tool ||
          existing.scope !== resource.scope ||
          existing.projectIdentity !== resource.projectIdentity)
      ) {
        throw new Error('acquisition live resource path is ambiguous');
      }
      liveResourcesByPath.set(resource.placementPath, existing ?? resource);
    };
    for (const seed of candidateBindings.values()) {
      if (
        seed.preview.skill === null ||
        seed.preview.placementPath === null ||
        seed.preview.store === null
      ) {
        throw new Error('prepared install intent requires an executable result');
      }
      const expectedFacts = (await observeInstallState(seed)).facts;
      const requestIndex = seed.preview.requestIndex;
      if (!Number.isSafeInteger(requestIndex) || (requestIndex as number) < 0) {
        throw new Error('prepared install request occurrence is invalid');
      }
      const sourceResourceId = acquireStateResourceId('store', [
        'materialized-source',
        requestIndex,
        seed.spec.identity.host,
        seed.spec.identity.repository,
        seed.resolved.sha,
        seed.resolved.skillPath,
      ]);
      const sourceContent = acquireContentObservationIdentity(
        sourceResourceId,
        await acquireContentFacts(env, seed.resolved.materializedDir),
      );
      const livePath = resolve(seed.preview.placementPath);
      const liveResourceId = acquireStateResourceId('live', [livePath]);
      addLiveResource({
        resourceId: liveResourceId,
        skill: seed.preview.skill,
        tool: seed.tool,
        scope,
        projectIdentity: scope === 'project' ? scopeKey : null,
        placementPath: livePath,
        storeRoot,
      });
      for (const alternate of expectedFacts.alternates) {
        addLiveResource({
          resourceId: acquireStateResourceId('live', [alternate.canonicalPath]),
          skill: seed.preview.skill,
          tool: seed.tool,
          scope,
          projectIdentity: scope === 'project' ? scopeKey : null,
          placementPath: alternate.canonicalPath,
          storeRoot,
        });
      }
      if (expectedFacts.shadow !== null) {
        const shadowScope: InstallScope = scope === 'project' ? 'user' : 'project';
        for (const shadow of expectedFacts.shadow.live) {
          addLiveResource({
            resourceId: acquireStateResourceId('live', [shadow.canonicalPath]),
            skill: seed.preview.skill,
            tool: seed.tool,
            scope: shadowScope,
            projectIdentity: shadowScope === 'project' ? projectRoot : null,
            placementPath: shadow.canonicalPath,
            storeRoot,
          });
        }
      }
      const storePath = resolve(seed.preview.store.path);
      const storeResourceId = acquireStateResourceId('store', [storePath]);
      const existingStore = storeResourcesByPath.get(storePath);
      if (
        existingStore !== undefined &&
        existingStore.contentHash !== sourceContent.contentRevision
      ) {
        throw new Error('acquisition store resource content is ambiguous');
      }
      storeResourcesByPath.set(
        storePath,
        existingStore ?? {
          resource: { resourceId: storeResourceId, storePath },
          contentHash: sourceContent.contentRevision,
        },
      );
      preparedIntents.push({
        seed,
        expectedFacts,
        intent: {
          kind: 'install',
          skill: seed.preview.skill,
          tool: seed.tool,
          scope,
          projectRoot:
            scope === 'project' && scopeKey !== null
              ? { kind: 'machine-bound', path: scopeKey }
              : null,
          liveResourceId,
          storeResourceId,
          force: Boolean(opts.force),
          sourceContent,
          sourcePreconditionId: createContentObservationPreconditionIdV1(sourceContent),
          source: {
            kind: 'portable',
            identity: {
              host: seed.spec.identity.host,
              repository: seed.spec.identity.repository,
              path: seed.resolved.skillPath.length === 0 ? null : seed.resolved.skillPath,
            },
            requestedRef: seed.spec.ref,
            resolvedSha: seed.resolved.sha,
            sourcePath: seed.resolved.skillPath.length === 0 ? '.' : seed.resolved.skillPath,
            contentHash: sourceContent.contentRevision,
          },
          placement: {
            classification: 'pinned',
            representation: opts.direct ? 'copy' : 'symlink',
            location: { kind: 'machine-bound', path: livePath },
          },
          store: {
            location: { kind: 'machine-bound', path: storePath },
            contentHash: sourceContent.contentRevision,
            snapshotIdentity: createStoreSnapshotIdentityV1(
              storeResourceId,
              sourceContent.contentRevision,
            ),
          },
        },
      });
    }
    const migration = prepareLedgerMigration(
      env,
      'install',
      'explicit-targets',
      ledgerPath,
      ledgerState,
    );
    const compatibilityPlanning = createInstallPlanning(
      requested,
      results,
      Boolean(opts.continueOnError),
      scopeKey,
      { registry, toolOrder: registry.ids },
    );
    const snapshotAuthority = await readAcquisitionSnapshotV1({
      env,
      registry,
      capabilityQueries: createInstallCapabilityQueries(
        registry,
        preparedIntents.map(({ intent }) => intent),
        opts,
      ),
      projectContext,
      artifactScope: scope,
      ledgerPath,
      liveResources: [...liveResourcesByPath.values()],
      storeResources: [...storeResourcesByPath.values()],
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    const boundPlanning = createAcquisitionPlan(
      {
        schemaVersion: 1,
        command: 'install',
        selection: {
          source: 'explicit-targets',
          skills: [...new Set(preparedIntents.map(({ intent }) => intent.skill))],
          tools: [...new Set(preparedIntents.map(({ intent }) => intent.tool))],
          scopes: [scope],
        },
        batchPolicy: opts.continueOnError ? 'continue-on-error' : 'fail-fast',
        diagnostics: compatibilityPlanning.plan.diagnostics,
        compatibilityOperations: migration === null ? [] : [migration.operation],
        intents: preparedIntents.map(({ intent }) => intent),
      },
      snapshotAuthority.snapshot,
      { registry, toolOrder: registry.ids },
    );
    if (!boundPlanning.ok) {
      throw new Error(boundPlanning.error.message);
    }
    const plan = boundPlanning.value.plan;
    const canonicalOperations = plan.operations.filter(
      (operation) =>
        migration === null || operation.operationId !== migration.operation.operationId,
    );
    const operationByLivePath = new Map<string, ExecutableOperation>();
    for (const operation of canonicalOperations) {
      if (operation.before.kind !== 'absent' && operation.before.kind !== 'placement') {
        throw new Error('acquisition install operation does not target live state');
      }
      if (
        operation.before.resource.kind !== 'live' ||
        operation.before.resource.location.kind !== 'machine-bound' ||
        operationByLivePath.has(operation.before.resource.location.path)
      ) {
        throw new Error('acquisition install operation binding is ambiguous');
      }
      operationByLivePath.set(operation.before.resource.location.path, operation);
    }
    const canonicalPreviewByOriginal = new Map<InstallResult, InstallResult>();
    const preparedIntentsByOperationId = new Map<string, Array<(typeof preparedIntents)[number]>>();
    for (const prepared of preparedIntents) {
      const placementPath = resolve(prepared.seed.preview.placementPath as string);
      const operation = operationByLivePath.get(placementPath);
      const action: InstallAction =
        operation === undefined
          ? 'noop'
          : operation.kind === 'install'
            ? 'installed'
            : operation.kind === 'update'
              ? 'updated'
              : 'repaired';
      const canonicalPreview = {
        ...prepared.seed.preview,
        action,
        reason:
          operation === undefined
            ? `already installed at ${prepared.seed.resolved.sha.slice(0, 12)}`
            : prepared.seed.preview.reason,
      };
      canonicalPreviewByOriginal.set(prepared.seed.preview, canonicalPreview);
      if (operation !== undefined) {
        const operationIntents = preparedIntentsByOperationId.get(operation.operationId);
        if (operationIntents === undefined) {
          preparedIntentsByOperationId.set(operation.operationId, [prepared]);
        } else {
          operationIntents.push(prepared);
        }
      }
    }
    const canonicalResults = results.map(
      (result) => canonicalPreviewByOriginal.get(result) ?? result,
    );
    const preparedBindings = new Map<string, PreparedInstallBinding>();
    const preconditions: ExecutionPrecondition[] = [
      ...acquisitionRevisionPreconditions(snapshotAuthority, plan.operations),
    ];
    const sourcePreconditionGroups = new Map<
      string,
      Readonly<{
        expectedContent: ContentObservationIdentityV1;
        operations: ExecutableOperation[];
        seed: InstallBindingSeed;
      }>
    >();
    for (const operation of canonicalOperations) {
      const operationIntents = preparedIntentsByOperationId.get(operation.operationId);
      if (operationIntents === undefined || operationIntents[0] === undefined) {
        throw new Error('prepared install operation binding is missing');
      }
      const prepared = operationIntents[0];
      for (const occurrence of operationIntents) {
        const currentGroup = sourcePreconditionGroups.get(occurrence.intent.sourcePreconditionId);
        if (currentGroup === undefined) {
          sourcePreconditionGroups.set(occurrence.intent.sourcePreconditionId, {
            expectedContent: occurrence.intent.sourceContent,
            operations: [operation],
            seed: occurrence.seed,
          });
        } else {
          if (
            JSON.stringify(currentGroup.expectedContent) !==
              JSON.stringify(occurrence.intent.sourceContent) ||
            currentGroup.seed.resolved.materializedDir !== occurrence.seed.resolved.materializedDir
          ) {
            throw new Error('acquisition source precondition identity collision');
          }
          currentGroup.operations.push(operation);
        }
      }
      const resource =
        operation.before.kind === 'absent' || operation.before.kind === 'placement'
          ? operation.before.resource
          : null;
      if (resource === null || resource.kind !== 'live') {
        throw new Error('prepared install resource is not live');
      }
      const actualBefore = acquireActualBefore(
        resource,
        prepared.expectedFacts.live,
        prepared.expectedFacts.selectedPair,
      );
      const canonicalPreview = canonicalPreviewByOriginal.get(prepared.seed.preview);
      if (canonicalPreview === undefined) {
        throw new Error('prepared install canonical preview is missing');
      }
      preparedBindings.set(operation.operationId, {
        kind: 'pair',
        preview: canonicalPreview,
        reportPreviews: operationIntents.map(
          ({ seed }) => canonicalPreviewByOriginal.get(seed.preview) ?? seed.preview,
        ),
        actualBefore,
        liveResourceId: prepared.intent.liveResourceId,
        storeResourceId: prepared.intent.storeResourceId,
        observe: async () => {
          const current = await observeInstallState(prepared.seed);
          // Preparation and approval may be separated from execution by another completed
          // ledger mutation. Rebind the mutation closure to the whole current under-lock ledger;
          // the exact approved operation and its expected selected/live facts remain unchanged.
          placeCtx.ledger = current.ledger;
          return current.facts;
        },
        execute: async (logicalOperation, operationObservation) => {
          placeCtx.logicalOperation = logicalOperation;
          placeCtx.operationObservation = operationObservation;
          try {
            return await prepared.seed.execute();
          } finally {
            placeCtx.operationObservation = undefined;
          }
        },
      });
    }
    for (const group of sourcePreconditionGroups.values()) {
      preconditions.push(
        createContentObservationExecutionPrecondition({
          operationIds: group.operations.map(({ operationId }) => operationId),
          resource: {
            kind: 'store',
            contentHash: group.expectedContent.contentRevision,
          },
          expectedContent: group.expectedContent,
          observeContent: async () => {
            const observed = acquireContentObservationIdentity(
              group.expectedContent.resourceId,
              await acquireContentFacts(env, group.seed.resolved.materializedDir),
            );
            return observed;
          },
        }),
      );
    }
    if (migration !== null) {
      preconditions.unshift(migration.precondition);
      preparedBindings.set(migration.operation.operationId, {
        kind: 'migrate-ledger',
        expectedState: migration.expectedState,
        onMigrated: (model) => {
          placeCtx.ledger = model;
        },
      });
    }
    const bindings = new Map<string, PreparedInstallBinding>();
    for (const operation of plan.operations) {
      const binding = preparedBindings.get(operation.operationId);
      if (binding === undefined || bindings.has(operation.operationId)) {
        throw new Error('prepared install operation binding is not one-to-one');
      }
      bindings.set(operation.operationId, binding);
    }
    if (
      bindings.size !== plan.operations.length ||
      plan.operations.some((operation) => !bindings.has(operation.operationId))
    ) {
      throw new Error('prepared install plan has no exact execution binding');
    }
    const preview = assembleInstallReport(true, requested, canonicalResults, plan, []);
    emitAcquisitionPlanCreated(observation, plan, planObservation);
    deps.observePreparedPlan?.(plan);
    return {
      preview,
      bindings,
      preconditions: Object.freeze(preconditions),
      snapshotAuthority,
      expectedRevisions: boundPlanning.value.expectedRevisions,
      snapshotId: boundPlanning.value.snapshotId,
      cleanup: async (): Promise<void> => {
        for (const dir of cleanupDirs) await env.removeTree(dir).catch(() => {});
      },
    };
  };
  const executePrepared = async (prepared: PreparedInstallBatch): Promise<PlannedInstallReport> => {
    const actualByPreview = new Map<InstallResult, InstallResult>();
    const actualByOperation = new Map<string, InstallResult>();
    const projectActual = (binding: PreparedInstallPairBinding, actual: InstallResult): void => {
      for (const preview of binding.reportPreviews) {
        const projected = { ...actual };
        if (preview.requestIndex === undefined) Reflect.deleteProperty(projected, 'requestIndex');
        else projected.requestIndex = preview.requestIndex;
        actualByPreview.set(preview, projected);
      }
    };
    const lifecycle = createAcquisitionRepositoryLifecycleControllerV1({
      authority: prepared.snapshotAuthority,
      snapshotId: prepared.snapshotId,
      expectedRevisions: prepared.expectedRevisions,
    });
    const schedulerBindings: PreparedExecutionBinding[] = prepared.preview.plan.operations.map(
      (operation) => {
        const binding = prepared.bindings.get(operation.operationId);
        if (binding === undefined) throw new Error('prepared install operation binding is missing');
        if (binding.kind === 'migrate-ledger') {
          return lifecycle.bind(
            operation,
            createAcquisitionLedgerMigrationBinding({
              env,
              ledgerPath,
              operation,
              expectedState: binding.expectedState,
              startedAt: journalNowOf(env, deps),
              ...(opts.signal === undefined ? {} : { signal: opts.signal }),
              onMigrated: binding.onMigrated,
            }),
            [prepared.snapshotAuthority.ledgerResourceId],
          );
        }
        if (operation.pairId === null)
          throw new Error('prepared install operation pair is missing');
        let compatibilityBefore = binding.actualBefore;
        return lifecycle.bind(
          operation,
          {
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: operation.pairId,
            unstartedForce: createBoundedForceEffect({
              supported: true,
              requested: requested.force,
              conflict: null,
            }),
            observeActualBefore: async (): Promise<OperationImage> => {
              const facts = await binding.observe();
              const resource =
                operation.before.kind === 'absent' || operation.before.kind === 'placement'
                  ? operation.before.resource
                  : null;
              if (resource === null || resource.kind !== 'live') {
                throw new Error('prepared install actual-before resource is not live');
              }
              compatibilityBefore = acquireActualBefore(resource, facts.live, facts.selectedPair);
              return operation.before;
            },
            execute: async (
              validatedBinding: ValidatedExecutionBinding,
              operationObservation?: ObservationBundle,
            ): Promise<OperationExecutionResult> => {
              const actual = await binding.execute(
                { ...operation, before: compatibilityBefore },
                operationObservation,
              );
              projectActual(binding, actual);
              actualByOperation.set(operation.operationId, actual);
              return createInstallExecutionResult(
                operation,
                actual,
                requested,
                validatedBinding.actualBefore,
              );
            },
          },
          [
            prepared.snapshotAuthority.ledgerResourceId,
            binding.liveResourceId,
            binding.storeResourceId,
          ],
        );
      },
    );
    let executionResults: readonly OperationExecutionResult[];
    try {
      executionResults = await executeAcquisitionOperationPlan(
        {
          plan: prepared.preview.plan as CurrentMutatorOperationPlan,
          bindings: schedulerBindings,
          preconditions: prepared.preconditions,
          locks: [{ rank: 'ledger', key: 'placements-ledger', path: ledgerPath }],
          lockPort: createAcquireExecutionLockPort(env, ledgerPath, safeError, msg),
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        },
        observation,
      );
    } catch (error) {
      if (!acquisitionPreconditionStateChanged(error)) throw error;
      const reason = 'prepared placement state changed before execution';
      for (const operation of prepared.preview.plan.operations) {
        const binding = prepared.bindings.get(operation.operationId);
        if (binding === undefined) throw new Error('prepared install operation binding is missing');
        if (binding.kind === 'migrate-ledger') continue;
        const actual: InstallResult = {
          ...binding.preview,
          action: 'refused',
          reason,
          store: null,
          error: flipRefusedError(reason),
        };
        projectActual(binding, actual);
        actualByOperation.set(operation.operationId, actual);
      }
      executionResults = prepared.preview.plan.operations.map((operation) =>
        createInstallExecutionResult(
          operation,
          actualByOperation.get(operation.operationId),
          requested,
        ),
      );
    }
    for (const [index, operation] of prepared.preview.plan.operations.entries()) {
      if (actualByOperation.has(operation.operationId)) continue;
      const binding = prepared.bindings.get(operation.operationId);
      const execution = executionResults[index];
      if (binding === undefined || execution === undefined) {
        throw new Error('prepared install result projection is missing');
      }
      if (binding.kind === 'migrate-ledger') continue;
      if (execution.outcome === 'skipped-after-failure') {
        const actual = {
          ...binding.preview,
          action: 'skipped' as const,
          reason: 'fail-fast',
          store: null,
        };
        projectActual(binding, actual);
        actualByOperation.set(operation.operationId, actual);
      } else if (execution.outcome === 'cancelled') {
        const actual = {
          ...binding.preview,
          action: 'skipped' as const,
          reason: 'interrupted',
          store: null,
          error: cancelledError('interrupted'),
        };
        projectActual(binding, actual);
        actualByOperation.set(operation.operationId, actual);
      }
    }
    const results = prepared.preview.results.map(
      (previewResult) => actualByPreview.get(previewResult) ?? previewResult,
    );
    return assembleInstallReport(
      false,
      requested,
      results,
      prepared.preview.plan,
      executionResults,
    );
  };
  // ---- dry-run: no lock, no writes ----
  if (opts.dryRun) {
    const ledgerRes = await readLedgerState(env, ledgerPath);
    if (!ledgerRes.ok) return err(safeError(ledgerRes.error));
    const prepared = await prepareAll(ledgerRes.value);
    await prepared.cleanup();
    return ok(prepared.preview);
  }
  // ---- Phase 2: compatibility recovery/preparation, followed by final coordinator validation ----
  const prepareLocked = async (): Promise<Result<PreparedInstallBatch, SkillSmithError>> => {
    await sweepStaging(env, storeRoot);
    await sweepFetchOrphans(env, dataDir);
    const ledgerRes = await readLedgerState(env, ledgerPath);
    if (!ledgerRes.ok) return err(safeError(ledgerRes.error));
    if (ledgerRes.value.state === 'present' && ledgerRes.value.sourceVersion === 1) {
      return ok(await prepareAll(ledgerRes.value));
    }
    const ledger = ledgerModelForMutation(ledgerRes.value, nowOf(env, deps));
    const sweepPlaceCtx: PlaceCtx = {
      env,
      registry,
      deps,
      opts,
      ledger,
      ledgerPath,
      storeRoot,
      scope,
      scopeKey,
      projectRoot,
      logicalOperation: null,
      operationObservation: undefined,
    };
    const swept = await recoverCommittedAcquireJournalsWithObservation(
      placeExecutionInput(sweepPlaceCtx),
      observation,
    );
    sweepPlaceCtx.ledger = swept.state.ledger;
    if (!swept.ok) {
      const sweepError = safeError(swept.error);
      return err(
        sweepError.code === 'ledger-error' ? flipFailedError(msg(sweepError)) : sweepError,
      );
    }
    const current = await readLedgerState(env, ledgerPath);
    if (!current.ok) return err(safeError(current.error));
    return ok(await prepareAll(current.value));
  };
  const completed = Symbol('install-prepare-lock-completed');
  let preparedResult: Result<PreparedInstallBatch, SkillSmithError> | undefined;
  const locked = await withLedgerLock(
    env,
    ledgerPath,
    async (): Promise<typeof completed> => {
      preparedResult = await prepareLocked();
      return completed;
    },
    opts.signal === undefined ? undefined : { signal: opts.signal },
  );

  if (!locked.ok) return err(safeError(locked.error));
  const settled = preparedResult;
  if (locked.value !== completed || settled === undefined) {
    return err(genericError('operation failed'));
  }
  if (!settled.ok) return err(safeError(settled.error));
  try {
    return ok(await executePrepared(settled.value));
  } finally {
    await settled.value.cleanup();
  }
};

const runInstallWithRegistryInternal = async (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
): Promise<Result<PlannedInstallReport, SkillSmithError>> =>
  runAcquisitionWithObservation(
    (state) => runInstallInternal(env, opts, deps, registry, observation, state),
    safeError,
    observation,
  );

export const runInstallWithRegistry = (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
): Promise<Result<PlannedInstallReport, SkillSmithError>> =>
  runInstallWithRegistryInternal(env, opts, deps, registry);

export const runInstallWithRegistryObserved = (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation: ObservationBundle,
): Promise<Result<PlannedInstallReport, SkillSmithError>> =>
  runInstallWithRegistryInternal(env, opts, deps, registry, observation);

export const runInstall = (
  env: AcquisitionPorts,
  opts: InstallOptions,
  deps: InstallDeps = { ...defaultInstallDeps },
): Promise<Result<PlannedInstallReport, SkillSmithError>> =>
  runInstallWithRegistry(env, opts, deps, toolRegistry);

// ---------------------------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------------------------

export const defaultUninstallDeps: UninstallDeps = {};

// A resolved (skill, tool, scope) candidate for removal. 'stale' = ledger pair with no live
// placement anywhere; 'duplicate' = codex current+legacy both non-absent (unresolvable without
// disambiguation, mirrors place/plan.ts's resolveCodex).
interface UMatch {
  scope: InstallScope;
  scopeKey: string | null;
  tool: FlipTool;
  kind: 'live' | 'stale' | 'duplicate';
  placement: Placement | null; // null for 'stale'
  existing: PairRecord | null;
  notice: string | null; // legacy-root notice
  duplicatePaths?: string[];
  duplicateReason?: string;
}

const matchPathOf = (m: UMatch): string | null => {
  if (m.kind === 'duplicate') return m.duplicatePaths?.[0] ?? null;
  if (m.kind === 'stale') return m.existing?.placementPath ?? null;
  return m.placement?.path ?? null;
};

const emptyUninstallResult = (
  skill: string,
  tool: FlipTool | null,
  scope: InstallScope | null,
  action: UninstallAction,
): UninstallResult => ({
  skill,
  tool,
  scope,
  placementPath: null,
  action,
  reason: null,
  before: null,
  storeRetained: null,
  backupKept: null,
});
const notInstalledResult = (skill: string): UninstallResult => ({
  ...emptyUninstallResult(skill, null, null, 'noop'),
  reason: `'${skill}' is not installed anywhere skillsmith manages`,
});
// D12: before.placement/storePath come straight off the ledger record; symlinkTarget is populated
// only for dev (the recorded dev source) or a store-linked pinned record (a plain 'copy' placement
// has no symlink to report) — per the brief, "symlinkTarget for dev/store-linked".
const uninstallBeforeFromRecord = (
  mode: 'dev' | 'pinned',
  pinned: PinnedRecord | null | undefined,
  dev: PairRecord['dev'],
): UninstallResult['before'] => ({
  mode,
  placement: pinned?.placement ?? null,
  storePath: pinned?.storePath ?? null,
  symlinkTarget:
    mode === 'dev'
      ? (dev?.sourcePath ?? null)
      : pinned && pinned.placement === 'symlink'
        ? pinned.storePath
        : null,
});
// Search-set resolution for a NAME target (U2): every (scope, tool) in the requested search set,
// each classified against every root that tool owns at that scope (codex/user owns two: current +
// legacy). "Found" = a non-absent placement OR a ledger pair (spec's convergent definition).
const collectUninstallMatches = async (
  env: AcquisitionPorts,
  registry: LifecycleToolRegistry<string>,
  opts: UninstallOptions,
  ledger: LedgerFile,
  storeRoot: string,
  name: string,
  scopesToSearch: readonly InstallScope[],
  toolsToSearch: readonly FlipTool[],
  scopeKeyFor: (scope: InstallScope) => Promise<string | null>,
): Promise<UMatch[]> => {
  const matches: UMatch[] = [];
  for (const scope of scopesToSearch) {
    const scopeKey = await scopeKeyFor(scope);
    for (const tool of toolsToSearch) {
      const ctx = {
        cwd: scope === 'project' ? (scopeKey as string) : opts.cwd,
        configuration: opts.configuration,
      };
      const bundle = placementBundleFor(registry, tool);
      const roots = bundle.rootFacts(env, scope, ctx).map(({ path }) => path);
      const existing = getPairAt(ledger, scopeKey, name, tool);
      const resolution = await bundle.resolveScoped(env, ctx, storeRoot, name, scope);
      if (resolution.duplicateReason !== null) {
        const inventory = await bundle.listScoped(env, ctx, storeRoot, scope);
        const duplicatePaths = inventory.placements
          .filter((placement) => placement.skill === name && placement.class !== 'absent')
          .map((placement) => placement.path);
        matches.push({
          scope,
          scopeKey,
          tool,
          kind: 'duplicate',
          placement: resolution.placement,
          existing,
          notice: null,
          duplicatePaths,
          duplicateReason: resolution.duplicateReason,
        });
        continue;
      }
      if (resolution.placement.class !== 'absent') {
        const notice = resolution.notices.length === 0 ? null : resolution.notices.join('; ');
        matches.push({
          scope,
          scopeKey,
          tool,
          kind: 'live',
          placement: resolution.placement,
          existing,
          notice,
        });
        continue;
      }
      // BF-1(d): a custom-location placement (a `dev --source --dest` create) lives outside every
      // standard root, so the scan above finds nothing — but the ledger records exactly where it is.
      // Classify at the recorded placementPath so uninstall REMOVES the live symlink, not just the
      // record (a 'stale' match would orphan the symlink).
      if (existing?.placementPath) {
        const recordedRoot = dirname(existing.placementPath);
        if (!roots.includes(recordedRoot)) {
          const custom = await classifyPlacement(env, recordedRoot, name, storeRoot);
          if (custom.class !== 'absent') {
            matches.push({
              scope,
              scopeKey,
              tool,
              kind: 'live',
              placement: custom,
              existing,
              notice: null,
            });
            continue;
          }
        }
      }
      if (existing) {
        matches.push({
          scope,
          scopeKey,
          tool,
          kind: 'stale',
          placement: null,
          existing,
          notice: null,
        });
      }
    }
  }
  return matches;
};
interface PathTargetMatch {
  name: string;
  scope: InstallScope;
  scopeKey: string | null;
  tool: FlipTool;
  root: string;
  notice: string | null;
}
// A path target (contains '/', or absolute) resolves to exactly one (tool, scope, root) by
// dirname match — claude-code user/project, codex current user/project, codex legacy. No
// ambiguity concept applies (one path, one owning root); outside every root is a hard refusal.
const resolveUninstallPathTarget = async (
  env: AcquisitionPorts,
  registry: LifecycleToolRegistry<string>,
  opts: UninstallOptions,
  target: string,
  projectRoot: string | null,
  storeRoot: string,
  toolsToSearch: readonly FlipTool[],
  explicitTools: boolean,
): Promise<Result<PathTargetMatch, SkillSmithError>> => {
  const resolved = resolve(opts.cwd, target);
  const parent = dirname(resolved);
  const name = basename(resolved);
  const ctxUser = { cwd: opts.cwd, configuration: opts.configuration };
  const candidates: Omit<PathTargetMatch, 'name'>[] = [];
  const uninstallTools = registry.toolsFor('uninstall') as readonly FlipTool[];
  for (const tool of uninstallTools) {
    const bundle = placementBundleFor(registry, tool);
    const resolution = await bundle.resolveScoped(env, ctxUser, storeRoot, name, 'user');
    for (const { path: root } of bundle.rootFacts(env, 'user', ctxUser)) {
      candidates.push({
        scope: 'user',
        scopeKey: null,
        tool,
        root,
        notice:
          resolution.placement.root === root && resolution.notices.length > 0
            ? resolution.notices.join('; ')
            : null,
      });
    }
  }
  if (projectRoot !== null) {
    const ctxProj = { cwd: projectRoot, configuration: opts.configuration };
    for (const tool of uninstallTools) {
      const bundle = placementBundleFor(registry, tool);
      const resolution = await bundle.resolveScoped(env, ctxProj, storeRoot, name, 'project');
      for (const { path: root } of bundle.rootFacts(env, 'project', ctxProj)) {
        candidates.push({
          scope: 'project',
          scopeKey: projectRoot,
          tool,
          root,
          notice:
            resolution.placement.root === root && resolution.notices.length > 0
              ? resolution.notices.join('; ')
              : null,
        });
      }
    }
  }
  const match = candidates.find((c) => c.root === parent);
  if (!match) {
    const roots = candidates.map((c) => c.root).join(', ');
    return err(flipRefusedError(`'${target}' is outside every known skills root (${roots})`));
  }
  if (opts.scope !== undefined && opts.scope !== match.scope) {
    return err(
      flipRefusedError(
        `'${target}' resolves to ${match.scope} scope, which is not the requested --scope`,
      ),
    );
  }
  if (explicitTools && !toolsToSearch.includes(match.tool)) {
    return err(
      flipRefusedError(
        `'${target}' resolves to ${match.tool}, which is not in the requested --tool set`,
      ),
    );
  }
  return ok({ name, ...match });
};
// Decide + (unless dry-run) execute the removal for one resolved (skill, tool, scope) match.
// Refusals happen before any journal write; a managed removal drives the already-recorded pair
// through the engine's 'uninstall' swap directly, an unmanaged --force removal first synthesizes
// a minimal PairRecord so the SAME engine path (backup rename, hash-guarded reclaim, terminal
// pair deletion) applies uniformly — the engine never deletes a store entry either way.
const processUninstallMatch = async (
  env: AcquisitionPorts,
  ledgerCtx: { ledger: LedgerModel },
  ledgerPath: string,
  opts: UninstallOptions,
  deps: UninstallDeps,
  name: string,
  match: UMatch,
  dryRun: boolean,
  logicalOperation: ExecutableOperation | null,
  operationObservation?: ObservationBundle,
): Promise<UninstallResult> => {
  const { scope, scopeKey, tool, existing, notice } = match;
  const executionInput = (): AcquireExecutionInput =>
    executionInputOf(env, ledgerPath, ledgerCtx.ledger, deps, opts, logicalOperation);
  const midSwap = (e: SkillSmithError): SkillSmithError =>
    e.code === 'ledger-error' ? flipFailedError(msg(e)) : e;
  const failed = (e: SkillSmithError, placementPath: string | null): UninstallResult => ({
    skill: name,
    tool,
    scope,
    placementPath,
    action: 'failed',
    reason: msg(e),
    before: null,
    storeRetained: null,
    backupKept: null,
    error: safeError(e),
  });
  // Constraint #6: an uncommitted journal on the pair refuses every op except a same-op re-run
  // (which resumes it to completion) — checked first, ahead of the stale-pair shortcut and the
  // dev/unmanaged gates below, since a crash window can leave the live placement absent or in an
  // unexpected class regardless of what this match's own classification found.
  if (existing?.journal && existing.journal.phase !== 'committed') {
    const placementPath = existing.placementPath;
    const before = uninstallBeforeFromRecord(existing.mode, existing.pinned, existing.dev);
    const storeRetained = existing.pinned?.storePath ?? null;
    if (existing.journal.op === 'uninstall') {
      if (dryRun) {
        return {
          skill: name,
          tool,
          scope,
          placementPath,
          action: 'removed',
          reason: notice,
          before,
          storeRetained,
          backupKept: null,
        };
      }
      const resumed = await recoverAcquireWithObservation(
        executionInput(),
        { skill: name, tool, scopeKey },
        operationObservation,
      );
      ledgerCtx.ledger = resumed.state.ledger;
      if (!resumed.ok) return failed(midSwap(resumed.error), placementPath);
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason: resumed.value.warning ?? notice,
        before,
        storeRetained,
        backupKept: resumed.value.backupKept,
      };
    }
    const reason = recoveryRefusedMessage(existing.journal.op, name);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }
  if (match.kind === 'duplicate') {
    const paths = match.duplicatePaths ?? [];
    const reason =
      match.duplicateReason ??
      `found in multiple adapter roots: ${paths.join(', ')}; resolve the duplicate first`;
    return {
      skill: name,
      tool,
      scope,
      placementPath: paths[0] ?? null,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }
  if (match.kind === 'stale') {
    const ex = existing as PairRecord;
    const placementPath = ex.placementPath;
    const before = uninstallBeforeFromRecord(ex.mode, ex.pinned, ex.dev);
    const storeRetained = ex.pinned?.storePath ?? null;
    const reason = 'placement was already gone';
    if (dryRun) {
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason,
        before,
        storeRetained,
        backupKept: null,
      };
    }
    if (logicalOperation === null) {
      return failed(
        flipFailedError('record-only stale uninstall requires logical operation identity'),
        placementPath,
      );
    }
    const persisted = await executeRecordOnlyAcquirePlan(
      executionInput(),
      logicalOperation,
      ex,
      scopeKey,
    );
    ledgerCtx.ledger = persisted.state.ledger;
    if (!persisted.ok) return failed(persisted.error, placementPath);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason,
      before,
      storeRetained,
      backupKept: null,
    };
  }
  // match.kind === 'live'
  const placement = match.placement as Placement;
  const placementPath = placement.path;
  if (existing) {
    // P13: a dev-mode pair with a RETAINED pin (installed/promoted then demoted) still refuses
    // without --force — the pin is precious and promote/dev --rollback can restore it. A dev-CREATED
    // pair (`dev --source`, no pinned record) has nothing to restore, so uninstall removes just the
    // symlink + ledger record (the checkout is never touched).
    // BF-2: `!= null` (not `!== null`) so a RAW dev-only record whose `pinned` key is OMITTED
    // (undefined, not explicit null) is not mistaken for a retained pin and made to demand --force.
    if (existing.mode === 'dev' && existing.pinned != null && !opts.force) {
      const reason = `'${name}' (${tool}) is in dev mode — a live symlink into a working checkout. Run 'skillsmith promote ${name}' to pin it first, or 'skillsmith dev --rollback ${name}' to restore the pinned copy, or pass --force to remove the symlink — the checkout itself is never touched.`;
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'refused',
        reason,
        before: null,
        storeRetained: null,
        backupKept: null,
        error: flipRefusedError(reason),
      };
    }
    const before = uninstallBeforeFromRecord(existing.mode, existing.pinned, existing.dev);
    const storeRetained = existing.pinned?.storePath ?? null;
    if (dryRun) {
      return {
        skill: name,
        tool,
        scope,
        placementPath,
        action: 'removed',
        reason: notice,
        before,
        storeRetained,
        backupKept: null,
      };
    }
    const plan: SwapPlan = {
      op: 'uninstall',
      skill: name,
      tool,
      skillsRoot: dirname(placement.path),
      placementPath: placement.path,
      scopeKey,
    };
    const swapRes = await executeAcquirePlanWithObservation(
      executionInput(),
      plan,
      operationObservation,
    );
    ledgerCtx.ledger = swapRes.state.ledger;
    if (!swapRes.ok) return failed(midSwap(swapRes.error), placementPath);
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason: swapRes.value.warning ?? notice,
      before,
      storeRetained,
      backupKept: swapRes.value.backupKept,
    };
  }
  // unmanaged (no ledger pair)
  if (!opts.force) {
    const reason = `'${name}' (${tool}) has no skillsmith record; pass --force to remove it anyway`;
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'refused',
      reason,
      before: null,
      storeRetained: null,
      backupKept: null,
      error: flipRefusedError(reason),
    };
  }
  const mode: 'dev' | 'pinned' = placement.class === 'dev' ? 'dev' : 'pinned';
  const before: UninstallResult['before'] = {
    mode,
    placement: null,
    storePath: null,
    symlinkTarget: placement.symlinkTarget ?? null,
  };
  if (dryRun) {
    return {
      skill: name,
      tool,
      scope,
      placementPath,
      action: 'removed',
      reason: notice,
      before,
      storeRetained: null,
      backupKept: null,
    };
  }
  const synth: PairRecord = {
    placementPath: placement.path,
    mode,
    dev: null,
    pinned: null,
    journal: null,
  };
  const staged = withLedgerPairAt(ledgerCtx.ledger, scopeKey, name, tool, synth);
  if (!staged.ok) return failed(staged.error, placementPath);
  ledgerCtx.ledger = staged.value;
  const plan: SwapPlan = {
    op: 'uninstall',
    skill: name,
    tool,
    skillsRoot: dirname(placement.path),
    placementPath: placement.path,
    scopeKey,
  };
  const swapRes = await executeAcquirePlanWithObservation(
    executionInput(),
    plan,
    operationObservation,
  );
  ledgerCtx.ledger = swapRes.state.ledger;
  if (!swapRes.ok) return failed(midSwap(swapRes.error), placementPath);
  return {
    skill: name,
    tool,
    scope,
    placementPath,
    action: 'removed',
    reason: swapRes.value.warning ?? notice,
    before,
    storeRetained: null,
    backupKept: swapRes.value.backupKept,
  };
};
const isUninstallPathTarget = (target: string): boolean =>
  target.includes('/') || isAbsolute(target);
// Resolve one CLI target (name or path) to zero or more UninstallResults. A name target searches
// the whole (scope x tool) search set and applies U2 ambiguity; a path target pins exactly one
// (scope, tool) by dirname match and skips the ambiguity question entirely.
const processUninstallTarget = async (
  env: AcquisitionPorts,
  registry: LifecycleToolRegistry<string>,
  ledger: LedgerFile,
  ledgerCtx: { ledger: LedgerModel },
  ledgerPath: string,
  storeRoot: string,
  opts: UninstallOptions,
  deps: UninstallDeps,
  target: string,
  projectRoot: string | null,
  scopesToSearch: readonly InstallScope[],
  toolsToSearch: readonly FlipTool[],
  explicitTools: boolean,
  scopeKeyFor: (scope: InstallScope) => Promise<string | null>,
  dryRun: boolean,
  bind?: (preview: UninstallResult, name: string, match: UMatch) => void,
): Promise<UninstallResult[]> => {
  if (isUninstallPathTarget(target)) {
    const resolved = await resolveUninstallPathTarget(
      env,
      registry,
      opts,
      target,
      projectRoot,
      storeRoot,
      toolsToSearch,
      explicitTools,
    );
    if (!resolved.ok) {
      const name = basename(resolve(opts.cwd, target));
      return [
        {
          ...emptyUninstallResult(name, null, null, 'refused'),
          reason: msg(resolved.error),
          error: safeError(resolved.error),
        },
      ];
    }
    const { name, scope, scopeKey, tool, root, notice } = resolved.value;
    const existing = getPairAt(ledger, scopeKey, name, tool);
    const placement = await classifyPlacement(env, root, name, storeRoot);
    let match: UMatch;
    if (placement.class !== 'absent') {
      match = { scope, scopeKey, tool, kind: 'live', placement, existing, notice };
    } else if (existing) {
      match = { scope, scopeKey, tool, kind: 'stale', placement: null, existing, notice: null };
    } else {
      return [notInstalledResult(name)];
    }
    const preview = await processUninstallMatch(
      env,
      ledgerCtx,
      ledgerPath,
      opts,
      deps,
      name,
      match,
      dryRun,
      null,
    );
    if (dryRun && preview.action === 'removed') bind?.(preview, name, match);
    return [preview];
  }
  const matches = await collectUninstallMatches(
    env,
    registry,
    opts,
    ledger,
    storeRoot,
    target,
    scopesToSearch,
    toolsToSearch,
    scopeKeyFor,
  );
  if (matches.length === 0) return [notInstalledResult(target)];
  const distinctScopes = new Set(matches.map((m) => m.scope));
  if (distinctScopes.size > 1 && opts.scope === undefined && !opts.allScopes) {
    const list = matches
      .map((m) => `${m.scope} (${m.tool} at ${matchPathOf(m) ?? '<unknown>'})`)
      .join(', ');
    const reason = `'${target}' is installed in multiple scopes: ${list}; disambiguate with --scope, --tool, or --all-scopes`;
    return [
      {
        ...emptyUninstallResult(target, null, null, 'refused'),
        reason,
        error: flipRefusedError(reason),
      },
    ];
  }

  const results: UninstallResult[] = [];
  for (const match of matches) {
    const preview = await processUninstallMatch(
      env,
      ledgerCtx,
      ledgerPath,
      opts,
      deps,
      target,
      match,
      dryRun,
      null,
    );
    if (dryRun && preview.action === 'removed') bind?.(preview, target, match);
    results.push(preview);
  }
  return results;
};

const uninstallSummary = (results: readonly UninstallResult[]): UninstallReport['summary'] => {
  const summary = { removed: 0, noop: 0, refused: 0, failed: 0 };
  for (const result of results) summary[result.action]++;
  return summary;
};

const assembleUninstallReport = (
  dryRun: boolean,
  requested: UninstallReport['requested'],
  results: UninstallResult[],
  plan: OperationPlan<'uninstall'>,
  executionResults: readonly OperationExecutionResult[],
): PlannedUninstallReport => ({
  dryRun,
  requested,
  results,
  summary: uninstallSummary(results),
  plan,
  executionResults,
});

const createUninstallExecutionResult = (
  operation: ExecutableOperation,
  result: UninstallResult | undefined,
  requested: UninstallReport['requested'],
): OperationExecutionResult => {
  const cancelled = result?.reason === 'interrupted';
  const succeeded = result?.action === 'removed';
  const common = {
    operationId: operation.operationId,
    actualBefore: operation.before,
    actualAfter: succeeded ? operation.after : operation.before,
    force: createBoundedForceEffect({
      supported: true,
      requested: requested.force,
      conflict: null,
    }),
  } as const;
  if (cancelled) {
    return createOperationExecutionResult({ ...common, outcome: 'cancelled', error: null });
  }
  if (!succeeded) {
    return createOperationExecutionResult({
      ...common,
      outcome: 'failed',
      error: {
        code: result?.error?.code ?? 'uninstall-failed',
        message: closedPlanningText(result?.reason ?? null, 'prepared uninstall binding failed'),
        remediation: 'Resolve the reported condition and retry the same selection.',
      },
    });
  }
  return createOperationExecutionResult({ ...common, outcome: 'succeeded', error: null });
};

const runUninstallInternal = async (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
  planObservation?: AcquisitionPlanObservationState,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> => {
  const dataDir = resolveDataDir(env, opts.configuration);
  const storeRoot = storeRootOf(dataDir);
  const ledgerPath = ledgerPathOf(dataDir);
  const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
  const toolsToSearch: FlipTool[] = explicitTools
    ? [...(opts.tools as FlipTool[])]
    : [...(registry.toolsFor('uninstall') as readonly FlipTool[])];

  const requested: UninstallReport['requested'] = {
    targets: [...opts.targets],
    tools: toolsToSearch,
    explicitTools,
    scope: opts.scope ?? null,
    allScopes: Boolean(opts.allScopes),
    force: Boolean(opts.force),
  };

  // U2 search set: user scope + the current project's scope (Task 7 phase-1 rule) unless --scope
  // restricts to one. --all-scopes doesn't change the search set (both are already searched) — it
  // only changes the ambiguity POLICY below (act on every match instead of refusing).
  const projectContext = await resolveAcquisitionProjectContextV1({
    env,
    cwd: opts.cwd,
    ...(opts.configuration.explicitConfigPath === undefined
      ? {}
      : { explicitConfigPath: opts.configuration.explicitConfigPath }),
  });
  const projectRoot = projectContext.projectRoot;
  const scopesToSearch: InstallScope[] =
    opts.scope !== undefined ? [opts.scope] : projectRoot !== null ? ['user', 'project'] : ['user'];
  const scopeKeyFor = async (scope: InstallScope): Promise<string | null> =>
    scope === 'project' ? (projectRoot ?? (await env.realpath(opts.cwd))) : null;

  interface PreparedUninstallPairBinding {
    readonly kind: 'pair';
    readonly preview: UninstallResult;
    readonly actualBefore: OperationImage;
    readonly liveResourceId: string;
    observe(): Promise<UninstallPreconditionFacts>;
    execute(
      operation: ExecutableOperation,
      operationObservation?: ObservationBundle,
    ): Promise<UninstallResult>;
  }
  interface PreparedUninstallMigrationBinding {
    readonly kind: 'migrate-ledger';
    readonly expectedState: Extract<LedgerReadState, { readonly state: 'present' }>;
    onMigrated(model: LedgerModel): void;
  }
  type PreparedUninstallBinding = PreparedUninstallPairBinding | PreparedUninstallMigrationBinding;
  interface PreparedUninstallBatch {
    readonly preview: PlannedUninstallReport;
    readonly bindings: ReadonlyMap<string, PreparedUninstallBinding>;
    readonly preconditions: readonly ExecutionPrecondition[];
    readonly snapshotAuthority: AcquisitionSnapshotAuthorityV1;
    readonly expectedRevisions: readonly ExpectedRevisionV1[];
    readonly snapshotId: `snapshot:v1:${string}`;
  }
  interface UninstallPreconditionFacts {
    readonly projectRoot: string | null;
    readonly selectedPair: PairRecord | null;
    readonly live: AcquirePlacementFacts;
    readonly store: AcquireContentFacts | null;
    readonly selectionKind: 'live' | 'stale' | 'absent';
    readonly selection: readonly Readonly<{
      scope: InstallScope;
      scopeKey: string | null;
      tool: FlipTool;
      kind: UMatch['kind'];
      paths: readonly string[];
      pair: PairRecord | null;
    }>[];
  }
  interface UninstallBindingSeed {
    readonly preview: UninstallResult;
    readonly target: string;
    readonly name: string;
    readonly match: UMatch;
    execute(
      operation: ExecutableOperation,
      operationObservation?: ObservationBundle,
    ): Promise<UninstallResult>;
  }

  const observeUninstallFacts = async (
    seed: UninstallBindingSeed,
  ): Promise<UninstallPreconditionFacts> => {
    const expectedPath = seed.preview.placementPath;
    if (expectedPath === null) throw new Error('prepared uninstall facts require a live path');
    const ledgerResult = await readLedgerState(env, ledgerPath);
    if (!ledgerResult.ok) throw ledgerResult.error;
    const ledger = ledgerModelForMutation(ledgerResult.value, nowOf(env, deps));
    const selectedPair = getPairAt(ledger, seed.match.scopeKey, seed.name, seed.match.tool);
    const live = await acquirePlacementFacts(env, dirname(expectedPath), seed.name, storeRoot);
    const storePath = selectedPair?.pinned?.storePath ?? null;
    const selectionMatches = isUninstallPathTarget(seed.target)
      ? [
          {
            scope: seed.match.scope,
            scopeKey: seed.match.scopeKey,
            tool: seed.match.tool,
            kind:
              live.placement.class === 'absent'
                ? selectedPair === null
                  ? ('stale' as const)
                  : ('stale' as const)
                : ('live' as const),
            placement: live.placement.class === 'absent' ? null : live.placement,
            existing: selectedPair,
            notice: seed.match.notice,
          } satisfies UMatch,
        ]
      : await collectUninstallMatches(
          env,
          registry,
          opts,
          legacyLedgerView(ledger),
          storeRoot,
          seed.target,
          scopesToSearch,
          toolsToSearch,
          scopeKeyFor,
        );
    return {
      projectRoot,
      selectedPair: structuredClone(selectedPair),
      live,
      store: storePath === null ? null : await acquireContentFacts(env, storePath),
      selectionKind:
        live.placement.class === 'absent' ? (selectedPair === null ? 'absent' : 'stale') : 'live',
      selection: selectionMatches.map((match) => ({
        scope: match.scope,
        scopeKey: match.scopeKey,
        tool: match.tool,
        kind: match.kind,
        paths:
          match.kind === 'duplicate'
            ? [...(match.duplicatePaths ?? [])]
            : [matchPathOf(match)].filter((path): path is string => path !== null),
        pair: structuredClone(match.existing),
      })),
    };
  };

  const prepareAll = async (ledgerState: LedgerReadState): Promise<PreparedUninstallBatch> => {
    const ledger = ledgerModelForMutation(ledgerState, nowOf(env, deps));
    const legacyLedger = legacyLedgerView(ledger);
    const ledgerCtx = { ledger };
    const results: UninstallResult[] = [];
    const candidateBindings = new Map<UninstallResult, UninstallBindingSeed>();
    for (const target of opts.targets) {
      results.push(
        ...(await processUninstallTarget(
          env,
          registry,
          legacyLedger,
          ledgerCtx,
          ledgerPath,
          storeRoot,
          opts,
          deps,
          target,
          projectRoot,
          scopesToSearch,
          toolsToSearch,
          explicitTools,
          scopeKeyFor,
          true,
          (preview, name, match) => {
            candidateBindings.set(preview, {
              preview,
              target,
              name,
              match,
              execute: (operation, operationObservation) =>
                processUninstallMatch(
                  env,
                  ledgerCtx,
                  ledgerPath,
                  opts,
                  deps,
                  name,
                  match,
                  false,
                  operation,
                  operationObservation,
                ),
            });
          },
        )),
      );
    }
    const migration = prepareLedgerMigration(
      env,
      'uninstall',
      'explicit-targets',
      ledgerPath,
      ledgerState,
    );
    const compatibilityPlanning = createUninstallPlanning(requested, results, projectRoot, {
      registry,
      toolOrder: registry.ids,
    });
    const preparedIntents: Array<
      Readonly<{
        seed: UninstallBindingSeed;
        expectedFacts: UninstallPreconditionFacts;
        intent: AcquisitionUninstallIntentV1;
        capabilityScope: ToolCapabilityScope;
      }>
    > = [];
    const liveResourcesByPath = new Map<string, AcquireLiveSnapshotResourceV1>();
    const storeResourcesByPath = new Map<string, AcquireStoreSnapshotResourceV1>();
    const addLiveResource = (resource: AcquireLiveSnapshotResourceV1): void => {
      const existing = liveResourcesByPath.get(resource.placementPath);
      if (
        existing !== undefined &&
        (existing.skill !== resource.skill ||
          existing.tool !== resource.tool ||
          existing.scope !== resource.scope ||
          existing.projectIdentity !== resource.projectIdentity)
      ) {
        throw new Error('acquisition uninstall live resource path is ambiguous');
      }
      liveResourcesByPath.set(resource.placementPath, existing ?? resource);
    };
    for (const seed of candidateBindings.values()) {
      if (seed.preview.placementPath === null) {
        throw new Error('prepared uninstall intent requires a live path');
      }
      const expectedFacts = await observeUninstallFacts(seed);
      const livePath = resolve(seed.preview.placementPath);
      const rootsCtx = {
        cwd: seed.match.scopeKey ?? opts.cwd,
        configuration: opts.configuration,
      };
      const placementRoot = seed.match.placement?.root ?? dirname(livePath);
      const capabilityScope = skillRootFactsFor(
        registry,
        seed.match.tool,
        env,
        seed.match.scope,
        rootsCtx,
      ).some((fact) => fact.path === placementRoot)
        ? seed.match.scope
        : 'custom';
      const liveResourceId = acquireStateResourceId('live', [livePath]);
      addLiveResource({
        resourceId: liveResourceId,
        skill: seed.name,
        tool: seed.match.tool,
        scope: seed.match.scope,
        projectIdentity: seed.match.scope === 'project' ? seed.match.scopeKey : null,
        placementPath: livePath,
        storeRoot,
      });
      for (const selection of expectedFacts.selection) {
        for (const path of selection.paths) {
          const placementPath = resolve(path);
          addLiveResource({
            resourceId: acquireStateResourceId('live', [placementPath]),
            skill: seed.name,
            tool: selection.tool,
            scope: selection.scope,
            projectIdentity: selection.scope === 'project' ? selection.scopeKey : null,
            placementPath,
            storeRoot,
          });
        }
      }
      let storeResourceId: string | null = null;
      const pinned = expectedFacts.selectedPair?.pinned ?? null;
      if (pinned !== null) {
        const storePath = resolve(pinned.storePath);
        storeResourceId = acquireStateResourceId('store', [storePath]);
        const existingStore = storeResourcesByPath.get(storePath);
        if (existingStore !== undefined && existingStore.contentHash !== pinned.contentHash) {
          throw new Error('acquisition uninstall store resource content is ambiguous');
        }
        storeResourcesByPath.set(
          storePath,
          existingStore ?? {
            resource: { resourceId: storeResourceId, storePath },
            contentHash: pinned.contentHash as OperationDigest,
          },
        );
      }
      preparedIntents.push({
        seed,
        expectedFacts,
        capabilityScope,
        intent: {
          kind: 'remove',
          skill: seed.name,
          tool: seed.match.tool,
          scope: seed.match.scope,
          projectRoot:
            seed.match.scope === 'project' && seed.match.scopeKey !== null
              ? { kind: 'machine-bound', path: seed.match.scopeKey }
              : null,
          liveResourceId,
          storeResourceId,
        },
      });
    }
    const artifactScope: InstallScope = opts.scope ?? (projectRoot === null ? 'user' : 'project');
    const snapshotAuthority = await readAcquisitionSnapshotV1({
      env,
      registry,
      capabilityQueries: createUninstallCapabilityQueries(preparedIntents),
      projectContext,
      artifactScope,
      ledgerPath,
      liveResources: [...liveResourcesByPath.values()],
      storeResources: [...storeResourcesByPath.values()],
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    const boundPlanning = createAcquisitionPlan(
      {
        schemaVersion: 1,
        command: 'uninstall',
        selection: {
          source: 'explicit-targets',
          skills: [...new Set(preparedIntents.map(({ intent }) => intent.skill))],
          tools: [...new Set(preparedIntents.map(({ intent }) => intent.tool))],
          scopes: [...new Set(preparedIntents.map(({ intent }) => intent.scope))],
        },
        batchPolicy: 'continue-on-error',
        diagnostics: compatibilityPlanning.plan.diagnostics,
        compatibilityOperations: migration === null ? [] : [migration.operation],
        intents: preparedIntents.map(({ intent }) => intent),
      },
      snapshotAuthority.snapshot,
      { registry, toolOrder: registry.ids },
    );
    if (!boundPlanning.ok) throw new Error(boundPlanning.error.message);
    const plan = boundPlanning.value.plan;
    const canonicalOperations = plan.operations.filter(
      (operation) =>
        migration === null || operation.operationId !== migration.operation.operationId,
    );
    const operationByLivePath = new Map<string, ExecutableOperation>();
    for (const operation of canonicalOperations) {
      if (
        (operation.before.kind !== 'absent' && operation.before.kind !== 'placement') ||
        operation.before.resource.kind !== 'live' ||
        operation.before.resource.location.kind !== 'machine-bound' ||
        operationByLivePath.has(operation.before.resource.location.path)
      ) {
        throw new Error('acquisition uninstall operation binding is ambiguous');
      }
      operationByLivePath.set(operation.before.resource.location.path, operation);
    }
    const preparedBindings = new Map<string, PreparedUninstallBinding>();
    const preconditions: ExecutionPrecondition[] = [
      ...acquisitionRevisionPreconditions(snapshotAuthority, plan.operations),
    ];
    for (const prepared of preparedIntents) {
      const operation = operationByLivePath.get(
        resolve(prepared.seed.preview.placementPath as string),
      );
      if (operation === undefined)
        throw new Error('prepared uninstall operation binding is missing');
      const resource =
        operation.before.kind === 'absent' || operation.before.kind === 'placement'
          ? operation.before.resource
          : null;
      if (resource === null || resource.kind !== 'live') {
        throw new Error('prepared uninstall resource is not live');
      }
      const actualBefore = acquireActualBefore(
        resource,
        prepared.expectedFacts.live,
        prepared.expectedFacts.selectedPair,
      );
      preparedBindings.set(operation.operationId, {
        kind: 'pair',
        preview: prepared.seed.preview,
        actualBefore,
        liveResourceId: prepared.intent.liveResourceId,
        observe: () => observeUninstallFacts(prepared.seed),
        execute: (logicalOperation, operationObservation) =>
          prepared.seed.execute(logicalOperation, operationObservation),
      });
    }
    if (migration !== null) {
      preconditions.unshift(migration.precondition);
      preparedBindings.set(migration.operation.operationId, {
        kind: 'migrate-ledger',
        expectedState: migration.expectedState,
        onMigrated: (model) => {
          ledgerCtx.ledger = model;
        },
      });
    }
    const bindings = new Map<string, PreparedUninstallBinding>();
    for (const operation of plan.operations) {
      const binding = preparedBindings.get(operation.operationId);
      if (binding === undefined || bindings.has(operation.operationId)) {
        throw new Error('prepared uninstall operation binding is not one-to-one');
      }
      bindings.set(operation.operationId, binding);
    }
    if (
      bindings.size !== plan.operations.length ||
      plan.operations.some((operation) => !bindings.has(operation.operationId))
    ) {
      throw new Error('prepared uninstall plan has no exact execution binding');
    }
    const preview = assembleUninstallReport(true, requested, results, plan, []);
    emitAcquisitionPlanCreated(observation, plan, planObservation);
    deps.observePreparedPlan?.(plan);
    return {
      preview,
      bindings,
      preconditions: Object.freeze(preconditions),
      snapshotAuthority,
      expectedRevisions: boundPlanning.value.expectedRevisions,
      snapshotId: boundPlanning.value.snapshotId,
    };
  };

  const executePrepared = async (
    prepared: PreparedUninstallBatch,
  ): Promise<PlannedUninstallReport> => {
    const actualByPreview = new Map<UninstallResult, UninstallResult>();
    const actualByOperation = new Map<string, UninstallResult>();
    const lifecycle = createAcquisitionRepositoryLifecycleControllerV1({
      authority: prepared.snapshotAuthority,
      snapshotId: prepared.snapshotId,
      expectedRevisions: prepared.expectedRevisions,
    });
    const schedulerBindings: PreparedExecutionBinding[] = prepared.preview.plan.operations.map(
      (operation) => {
        const binding = prepared.bindings.get(operation.operationId);
        if (binding === undefined)
          throw new Error('prepared uninstall operation binding is missing');
        if (binding.kind === 'migrate-ledger') {
          return lifecycle.bind(
            operation,
            createAcquisitionLedgerMigrationBinding({
              env,
              ledgerPath,
              operation,
              expectedState: binding.expectedState,
              startedAt: journalNowOf(env, deps),
              ...(opts.signal === undefined ? {} : { signal: opts.signal }),
              onMigrated: binding.onMigrated,
            }),
            [prepared.snapshotAuthority.ledgerResourceId],
          );
        }
        if (operation.pairId === null)
          throw new Error('prepared uninstall operation pair is missing');
        let compatibilityBefore = binding.actualBefore;
        return lifecycle.bind(
          operation,
          {
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: operation.pairId,
            unstartedForce: createBoundedForceEffect({
              supported: true,
              requested: requested.force,
              conflict: null,
            }),
            observeActualBefore: async (): Promise<OperationImage> => {
              const facts = await binding.observe();
              const resource =
                operation.before.kind === 'absent' || operation.before.kind === 'placement'
                  ? operation.before.resource
                  : null;
              if (resource === null || resource.kind !== 'live') {
                throw new Error('prepared uninstall actual-before resource is not live');
              }
              compatibilityBefore = acquireActualBefore(resource, facts.live, facts.selectedPair);
              return operation.before;
            },
            execute: async (
              _validatedBinding: ValidatedExecutionBinding,
              operationObservation?: ObservationBundle,
            ): Promise<OperationExecutionResult> => {
              const actual = await binding.execute(
                compatibilityBefore.kind === 'absent' && operation.before.kind === 'placement'
                  ? operation
                  : { ...operation, before: compatibilityBefore },
                operationObservation,
              );
              actualByPreview.set(binding.preview, actual);
              actualByOperation.set(operation.operationId, actual);
              return createUninstallExecutionResult(operation, actual, requested);
            },
          },
          [prepared.snapshotAuthority.ledgerResourceId, binding.liveResourceId],
        );
      },
    );
    let executionResults: readonly OperationExecutionResult[];
    try {
      executionResults = await executeAcquisitionOperationPlan(
        {
          plan: prepared.preview.plan as CurrentMutatorOperationPlan,
          bindings: schedulerBindings,
          preconditions: prepared.preconditions,
          locks: [{ rank: 'ledger', key: 'placements-ledger', path: ledgerPath }],
          lockPort: createAcquireExecutionLockPort(env, ledgerPath, safeError, msg),
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        },
        observation,
      );
    } catch (error) {
      if (!acquisitionPreconditionStateChanged(error)) throw error;
      const reason = 'prepared placement state changed before execution';
      for (const operation of prepared.preview.plan.operations) {
        const binding = prepared.bindings.get(operation.operationId);
        if (binding === undefined)
          throw new Error('prepared uninstall operation binding is missing');
        if (binding.kind === 'migrate-ledger') continue;
        const actual: UninstallResult = {
          ...binding.preview,
          action: 'refused',
          reason,
          error: flipRefusedError(reason),
        };
        actualByPreview.set(binding.preview, actual);
        actualByOperation.set(operation.operationId, actual);
      }
      executionResults = prepared.preview.plan.operations.map((operation) =>
        operation.pairId === null
          ? createOperationExecutionResult({
              operationId: operation.operationId,
              outcome: 'failed',
              actualBefore: operation.before,
              actualAfter: operation.before,
              force: null,
              error: {
                code: 'flip-refused',
                message: 'prepared ledger migration source changed before execution',
                remediation: 'Re-run the command to prepare the current ledger state.',
              },
            })
          : createUninstallExecutionResult(
              operation,
              actualByOperation.get(operation.operationId),
              requested,
            ),
      );
    }
    for (const [index, operation] of prepared.preview.plan.operations.entries()) {
      if (actualByOperation.has(operation.operationId)) continue;
      const binding = prepared.bindings.get(operation.operationId);
      const execution = executionResults[index];
      if (binding === undefined || execution === undefined) {
        throw new Error('prepared uninstall result projection is missing');
      }
      if (binding.kind === 'migrate-ledger') continue;
      const actual =
        execution.outcome === 'cancelled'
          ? {
              ...binding.preview,
              action: 'failed' as const,
              reason: 'interrupted',
              error: genericError('operation interrupted'),
            }
          : {
              ...binding.preview,
              action: 'failed' as const,
              reason: 'ledger migration failed before placement execution',
              error: genericError('ledger migration failed before placement execution'),
            };
      actualByPreview.set(binding.preview, actual);
      actualByOperation.set(operation.operationId, actual);
    }
    const results = prepared.preview.results.map(
      (previewResult) => actualByPreview.get(previewResult) ?? previewResult,
    );
    return assembleUninstallReport(
      false,
      requested,
      results,
      prepared.preview.plan,
      executionResults,
    );
  };

  // Uninstall needs no binary detection and no fetch/verify — dry-run only needs a ledger read.
  if (opts.dryRun) {
    const ledgerRes = await readLedgerState(env, ledgerPath);
    if (!ledgerRes.ok) return err(safeError(ledgerRes.error));
    const prepared = await prepareAll(ledgerRes.value);
    return ok(prepared.preview);
  }

  const prepareLocked = async (): Promise<Result<PreparedUninstallBatch, SkillSmithError>> => {
    await sweepStaging(env, storeRoot);
    await sweepFetchOrphans(env, dataDir);
    const ledgerRes = await readLedgerState(env, ledgerPath);
    if (!ledgerRes.ok) return err(safeError(ledgerRes.error));
    if (ledgerRes.value.state === 'present' && ledgerRes.value.sourceVersion === 1) {
      return ok(await prepareAll(ledgerRes.value));
    }
    const ledger = ledgerModelForMutation(ledgerRes.value, nowOf(env, deps));

    const swept = await recoverCommittedAcquireJournalsWithObservation(
      executionInputOf(env, ledgerPath, ledger, deps, opts, null),
      observation,
    );
    if (!swept.ok) {
      const sweepError = safeError(swept.error);
      return err(
        sweepError.code === 'ledger-error' ? flipFailedError(msg(sweepError)) : sweepError,
      );
    }

    const current = await readLedgerState(env, ledgerPath);
    if (!current.ok) return err(safeError(current.error));
    return ok(await prepareAll(current.value));
  };
  const completed = Symbol('uninstall-prepare-lock-completed');
  let preparedResult: Result<PreparedUninstallBatch, SkillSmithError> | undefined;
  const locked = await withLedgerLock(
    env,
    ledgerPath,
    async (): Promise<typeof completed> => {
      preparedResult = await prepareLocked();
      return completed;
    },
    opts.signal === undefined ? undefined : { signal: opts.signal },
  );

  if (!locked.ok) return err(safeError(locked.error));
  const settled = preparedResult;
  if (locked.value !== completed || settled === undefined) {
    return err(genericError('operation failed'));
  }
  if (!settled.ok) return err(safeError(settled.error));
  return ok(await executePrepared(settled.value));
};

const runUninstallWithRegistryInternal = async (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation?: ObservationBundle,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runAcquisitionWithObservation(
    (state) => runUninstallInternal(env, opts, deps, registry, observation, state),
    safeError,
    observation,
  );

export const runUninstallWithRegistry = (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps,
  registry: LifecycleToolRegistry<string>,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runUninstallWithRegistryInternal(env, opts, deps, registry);

export const runUninstallWithRegistryObserved = (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps,
  registry: LifecycleToolRegistry<string>,
  observation: ObservationBundle,
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runUninstallWithRegistryInternal(env, opts, deps, registry, observation);

export const runUninstall = (
  env: AcquisitionPorts,
  opts: UninstallOptions,
  deps: UninstallDeps = { ...defaultUninstallDeps },
): Promise<Result<PlannedUninstallReport, SkillSmithError>> =>
  runUninstallWithRegistry(env, opts, deps, toolRegistry);
