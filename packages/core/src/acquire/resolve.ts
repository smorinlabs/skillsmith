import { basename, join } from 'node:path';
import { normalizeSourceIdentity, validateManifestName } from '../artifacts/identity.ts';
import { type SkillSmithError, genericError, sourceUnresolvableError } from '../errors.ts';
import { clampStoreNs } from '../place/store.ts';
import type { FlipTool, LedgerFile } from '../place/types.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial, redactSensitiveValue } from '../safety/redaction.ts';
import { fetchRepo, lsTreeSkills, resolveRefViaLsRemote, sparseCheckoutSkill } from './fetch.ts';
import type {
  AcquisitionPorts,
  CandidateSkill,
  InstallSourceTransport,
  Selection,
  SourceSpec,
} from './types.ts';

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

export const safeError = (error: unknown): SkillSmithError => {
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

/** Copy an injected Result envelope without invoking accessors or proxy traps. */
export const safeDependencyResult = <T>(input: unknown): Result<T, SkillSmithError> => {
  const safe = safeTransportResult(input);
  if (safe.kind === 'ok') return ok(safe.value as T);
  if (safe.kind === 'error') return err(safe.error);
  return err(genericError('operation failed'));
};

export const safeUnknownMessage = (error: unknown): string => {
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

export const defaultInstallSourceTransport: InstallSourceTransport = Object.freeze({
  resolveRef: resolveRefViaLsRemote,
  fetchRepo,
  listSkills: lsTreeSkills,
  materializeSkill: sparseCheckoutSkill,
});

/** Filter scanned candidates by the parsed source selector.
 *  whole-repo → all; name → candidates whose `name` equals it (case-sensitive);
 *  path → the candidate whose `path` equals it exactly ([] when absent). */
export const matchCandidates = (
  all: readonly CandidateSkill[],
  selector: SourceSpec['selector'],
): CandidateSkill[] => {
  if (selector.kind === 'whole-repo') return [...all];
  if (selector.kind === 'name') return all.filter((candidate) => candidate.name === selector.name);
  return all.filter((candidate) => candidate.path === selector.path);
};

/** Resolve matches without guessing when no picker is available. */
export const selectSkill = async (
  matches: readonly CandidateSkill[],
  scanned: number,
  pick?: (candidates: readonly CandidateSkill[]) => Promise<CandidateSkill | null>,
): Promise<Selection> => {
  if (matches.length === 0) return { kind: 'none', searched: scanned };
  const [first] = matches;
  if (matches.length === 1 && first) return { kind: 'chosen', skill: first };
  if (pick) {
    const chosen = await pick(matches);
    if (chosen) return { kind: 'chosen', skill: chosen };
  }
  return { kind: 'ambiguous', candidates: [...matches] };
};

export interface ResolvedSourceMaterialization {
  readonly sha: string;
  readonly skillName: string;
  readonly skillPath: string;
  readonly materializedDir: string;
}

export type ResolveRemoteSourceOutcome =
  | {
      readonly kind: 'resolved';
      readonly materialization: ResolvedSourceMaterialization;
      readonly cleanupDirectory: string | null;
    }
  | {
      readonly kind: 'no-match';
      readonly resolvedSha: string;
      readonly searched: number;
      readonly cleanupDirectory: string;
    }
  | {
      readonly kind: 'ambiguous';
      readonly candidates: readonly string[];
      readonly cleanupDirectory: string;
    }
  | {
      readonly kind: 'source-failure';
      readonly error: SkillSmithError;
      readonly cleanupDirectory: string | null;
    };

export interface ResolveRemoteSourceInput {
  readonly ports: AcquisitionPorts;
  readonly source: SourceSpec;
  readonly transport?: InstallSourceTransport;
  readonly ledger: LedgerFile;
  readonly scopeKey: string | null;
  readonly storeRoot: string;
  readonly signal?: AbortSignal;
  readonly pick?: (candidates: readonly CandidateSkill[]) => Promise<CandidateSkill | null>;
  readonly createFetchDirectory: () => string;
}

const lastSegment = (repoPath: string): string =>
  repoPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .pop() ?? repoPath;

const sourcePathIsValid = (path: string): boolean => {
  if (path === '') return true;
  const normalized = normalizeSourceIdentity(
    `https://fixture.invalid/acme/repository//${path}`,
    'install.candidate.path',
  );
  return normalized.ok && normalized.value.path === path;
};

const tryElide = async (
  input: ResolveRemoteSourceInput,
  transport: InstallSourceTransport,
): Promise<ResolvedSourceMaterialization | null> => {
  const { ports, source, storeRoot, ledger, scopeKey, signal } = input;
  let rawProbe: unknown;
  try {
    rawProbe = await transport.resolveRef(ports, source.cloneUrl, source.ref, signal);
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
  if (source.selector.kind === 'path') {
    path = source.selector.path;
    name = basename(source.selector.path);
  } else {
    const tree = scopeKey === null ? ledger.skills : (ledger.projects?.[scopeKey]?.skills ?? {});
    const matches: { name: string; path: string }[] = [];
    for (const skill of Object.keys(tree)) {
      const tools = tree[skill]?.tools ?? {};
      for (const tool of Object.keys(tools) as FlipTool[]) {
        const origin = tools[tool]?.origin;
        if (origin && origin.repo === source.identity.repository && origin.refResolved === sha) {
          if (source.selector.kind === 'name' && skill !== source.selector.name) continue;
          matches.push({ name: skill, path: origin.skillPath });
        }
      }
    }
    const unique = matches.filter(
      (match, index) =>
        matches.findIndex(
          (candidate) => candidate.name === match.name && candidate.path === match.path,
        ) === index,
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
  const { ns, name: nsName } = clampStoreNs(source.identity.repository);
  const storeEntry = join(storeRoot, ns, `${nsName}@${sha.slice(0, 12)}`, name);
  if ((await ports.pathKind(storeEntry)) === 'absent') return null;
  return { sha, skillName: name, skillPath: path, materializedDir: storeEntry };
};

export const resolveRemoteSource = async (
  input: ResolveRemoteSourceInput,
): Promise<ResolveRemoteSourceOutcome> => {
  const { ports, source, signal, pick } = input;
  const transport = input.transport ?? defaultInstallSourceTransport;
  const elided = await tryElide(input, transport);
  if (elided) return { kind: 'resolved', materialization: elided, cleanupDirectory: null };

  const fetchDirectory = input.createFetchDirectory();
  const failure = (error: SkillSmithError): ResolveRemoteSourceOutcome => ({
    kind: 'source-failure',
    error,
    cleanupDirectory: fetchDirectory,
  });
  let rawFetchResult: unknown;
  try {
    rawFetchResult = await transport.fetchRepo(ports, {
      cloneUrl: source.cloneUrl,
      ref: source.ref,
      fetchDir: fetchDirectory,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    rawFetchResult = err(
      sourceUnresolvableError(`source transport failed: ${safeUnknownMessage(error)}`),
    );
  }
  const fetchResult = safeTransportResult(rawFetchResult);
  if (fetchResult.kind !== 'ok') {
    return failure(
      fetchResult.kind === 'error'
        ? fetchResult.error
        : sourceUnresolvableError('source transport returned invalid result metadata'),
    );
  }
  const fetchValue = dataRecord(fetchResult.value);
  if (fetchValue !== null && !hasExactOwnKeys(fetchValue, ['sha'])) {
    return failure(sourceUnresolvableError('source transport returned invalid result metadata'));
  }
  const sha = fetchValue === null ? undefined : ownDataValue(fetchValue, 'sha');
  if (typeof sha !== 'string') {
    return failure(sourceUnresolvableError('source transport returned invalid result metadata'));
  }
  if (!/^[0-9a-f]{40}$/u.test(sha) || containsSensitiveMaterial(sha)) {
    return failure(sourceUnresolvableError('remote source produced invalid ref metadata'));
  }

  let rawListResult: unknown;
  try {
    rawListResult = await transport.listSkills(ports, fetchDirectory, signal);
  } catch (error) {
    rawListResult = err(
      sourceUnresolvableError(`source listing failed: ${safeUnknownMessage(error)}`),
    );
  }
  const listResult = safeTransportResult(rawListResult);
  if (listResult.kind !== 'ok') {
    return failure(
      listResult.kind === 'error'
        ? listResult.error
        : sourceUnresolvableError('source transport returned invalid candidate metadata'),
    );
  }
  const candidateFailure = (): ResolveRemoteSourceOutcome =>
    failure(sourceUnresolvableError('remote source produced invalid or sensitive skill metadata'));
  const listValue = dataRecord(listResult.value);
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
    if (typeof path !== 'string' || typeof candidateName !== 'string') return candidateFailure();
    const name = path === '' ? lastSegment(source.identity.repository) : candidateName;
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

  const selection = await selectSkill(matchCandidates(candidates, source.selector), scanned, pick);
  if (selection.kind === 'none') {
    return {
      kind: 'no-match',
      resolvedSha: sha,
      searched: selection.searched,
      cleanupDirectory: fetchDirectory,
    };
  }
  if (selection.kind === 'ambiguous') {
    const ambiguousCandidates = selection.candidates.map(
      (candidate) => `${source.identity.repository}//${candidate.path}`,
    );
    if (ambiguousCandidates.some(containsSensitiveMaterial)) return candidateFailure();
    return {
      kind: 'ambiguous',
      candidates: ambiguousCandidates,
      cleanupDirectory: fetchDirectory,
    };
  }

  const skillPath = selection.skill.path;
  const skillName =
    skillPath === '' ? lastSegment(source.identity.repository) : selection.skill.name;
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
    rawMaterializeResult = await transport.materializeSkill(
      ports,
      fetchDirectory,
      skillPath,
      signal,
    );
  } catch (error) {
    rawMaterializeResult = err(
      sourceUnresolvableError(`source materialization failed: ${safeUnknownMessage(error)}`),
    );
  }
  const materialization = safeTransportResult(rawMaterializeResult);
  if (materialization.kind !== 'ok') {
    return failure(
      materialization.kind === 'error'
        ? materialization.error
        : sourceUnresolvableError('source transport returned invalid materialization metadata'),
    );
  }
  if (
    typeof materialization.value !== 'string' ||
    containsSensitiveMaterial(materialization.value)
  ) {
    return failure(
      sourceUnresolvableError('source transport returned invalid materialization metadata'),
    );
  }
  return {
    kind: 'resolved',
    materialization: { sha, skillName, skillPath, materializedDir: materialization.value },
    cleanupDirectory: fetchDirectory,
  };
};
