import type { ToolRegistry } from '../agents/registry.ts';
import { SUPPORTED_TOOLS, type SupportedTool } from '../agents/types.ts';
import { SCOPES } from '../config/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  SELECTION_CAPABILITIES,
  type SelectionAmbiguousError,
  type SelectionCandidate,
  type SelectionCapability,
  type SelectionCapabilityError,
  type SelectionInvalidEnumError,
  type SelectionPolicy,
  type SelectionRequest,
  type SelectionSource,
  type SelectionUnmatchedError,
  type SelectionUsageError,
  type SelectionValidationError,
  type TargetSelection,
  type TargetSelectionError,
  type ValidatedSelectionRequest,
} from './types.ts';
import { type CompiledWildcardTarget, compileWildcardTarget } from './wildcard.ts';

const usageError = (message: string): SelectionUsageError => ({
  code: 'usage',
  exitCode: 2,
  message,
});

const invalidEnumError = (
  field: SelectionInvalidEnumError['field'],
  value: string,
): SelectionInvalidEnumError => ({
  code: 'invalid-enum',
  exitCode: 2,
  field,
  value,
  message: `unknown ${field} '${value}'`,
});

const capabilityError = (
  field: SelectionCapabilityError['field'],
  value: string,
): SelectionCapabilityError => ({
  code: 'capability',
  exitCode: 4,
  field,
  value,
  message: `${field} '${value}' is known but unsupported for this operation`,
});

const unique = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

const validateKnownAllowed = <T extends string>(
  values: readonly string[],
  known: readonly T[],
  allowed: readonly T[],
  field: SelectionInvalidEnumError['field'],
): Result<readonly T[], SelectionInvalidEnumError | SelectionCapabilityError> => {
  const allowedSet = new Set<string>(allowed);
  const selected: T[] = [];
  for (const value of values) {
    const knownValue = known.find((candidate) => candidate === value);
    if (knownValue === undefined) return err(invalidEnumError(field, value));
    if (!allowedSet.has(value)) return err(capabilityError(field, value));
    if (!selected.includes(knownValue)) selected.push(knownValue);
  }
  return ok(selected);
};

type SelectionRegistry<ToolId extends string> = Pick<ToolRegistry<ToolId>, 'ids'>;

const validateSelectionRequestWithRegistry = <ToolId extends string>(
  request: SelectionRequest,
  policy: SelectionPolicy<ToolId>,
  registry: SelectionRegistry<ToolId>,
): Result<ValidatedSelectionRequest<ToolId>, SelectionValidationError> => {
  const targets = unique(request.targets);
  if (targets.some((target) => target.trim().length === 0))
    return err(usageError('selection targets must not be empty'));
  if (request.all && targets.length > 0)
    return err(usageError('--all cannot be combined with positional targets'));

  if (!request.all && targets.length === 0) {
    if (policy.requiresSelection)
      return err(usageError('at least one target is required, or pass --all'));
    if (!policy.allowBoundedDefault)
      return err(usageError('this command has no bounded default selection'));
  }

  const tools = validateKnownAllowed(
    request.tools ?? [],
    registry.ids,
    policy.allowedTools,
    'tool',
  );
  if (!tools.ok) return tools;

  const scopes = validateKnownAllowed(request.scopes ?? [], SCOPES, policy.allowedScopes, 'scope');
  if (!scopes.ok) return scopes;

  let capability: SelectionCapability | undefined;
  if (request.capability !== undefined) {
    const validated = validateKnownAllowed(
      [request.capability],
      SELECTION_CAPABILITIES,
      policy.allowedCapabilities,
      'capability',
    );
    if (!validated.ok) return validated;
    capability = validated.value[0];
  }

  const selectionSource: SelectionSource = request.all
    ? 'explicit-all'
    : targets.length > 0
      ? 'explicit-targets'
      : 'bounded-default';

  return ok({
    targets,
    all: request.all,
    tools: tools.value,
    scopes: scopes.value,
    ...(capability === undefined ? {} : { capability }),
    allowAbsentCreate: policy.allowAbsentCreate,
    selectionSource,
  });
};

export function validateSelectionRequest(
  request: SelectionRequest,
  policy: SelectionPolicy<SupportedTool>,
): Result<ValidatedSelectionRequest<SupportedTool>, SelectionValidationError>;
export function validateSelectionRequest<ToolId extends string>(
  request: SelectionRequest,
  policy: SelectionPolicy<ToolId>,
  registry: SelectionRegistry<ToolId>,
): Result<ValidatedSelectionRequest<ToolId>, SelectionValidationError>;
export function validateSelectionRequest(
  request: SelectionRequest,
  policy: SelectionPolicy<string>,
  registry: SelectionRegistry<string> = { ids: SUPPORTED_TOOLS },
): Result<ValidatedSelectionRequest<string>, SelectionValidationError> {
  return validateSelectionRequestWithRegistry(request, policy, registry);
}

const matchesTarget = (
  candidate: SelectionCandidate<string>,
  target: CompiledWildcardTarget,
): boolean => target.matches(candidate.name) || target.matches(candidate.path);

const isExisting = (candidate: SelectionCandidate<string>): boolean => candidate.exists !== false;

const matchesTool = (
  candidate: SelectionCandidate<string>,
  request: ValidatedSelectionRequest<string>,
): boolean => request.tools.length === 0 || request.tools.includes(candidate.tool);

const matchesCapability = (
  candidate: SelectionCandidate<string>,
  request: ValidatedSelectionRequest<string>,
): boolean =>
  request.capability === undefined || candidate.capabilities.includes(request.capability);

const unmatchedError = (targets: readonly string[]): SelectionUnmatchedError => ({
  code: 'unmatched',
  exitCode: 2,
  targets,
  message: `no target matched: ${targets.join(', ')}`,
});

const ambiguousError = <C extends SelectionCandidate<string>>(
  target: string,
  candidates: readonly C[],
): SelectionAmbiguousError<C> => ({
  code: 'ambiguous',
  exitCode: 2,
  target,
  targets: [target],
  candidates,
  message: `target '${target}' is ambiguous; select a scope or exact path`,
});

const success = <C extends SelectionCandidate<string>>(
  selected: readonly C[],
  selectionSource: SelectionSource,
): TargetSelection<C> =>
  selected.length > 0
    ? { selected, selectionSource, outcome: 'selected' }
    : {
        selected,
        selectionSource,
        outcome: 'filter-noop',
        reason: 'valid selection was reduced to zero by active filters',
      };

/**
 * Resolve only a validated request. Scope and tool bounds are applied before target matching;
 * pre-tool matches are retained solely to distinguish a valid filter-to-zero from an unmatched
 * explicit target. At no point can an empty explicit match widen into a bulk selection.
 */
export const resolveTargetSelection = <C extends SelectionCandidate<string>>(
  candidates: readonly C[],
  request: ValidatedSelectionRequest<string>,
): Result<TargetSelection<C>, TargetSelectionError<C>> => {
  const scoped =
    request.scopes.length === 0
      ? candidates
      : candidates.filter((candidate) => request.scopes.includes(candidate.scope));
  const toolFiltered = scoped.filter(
    (candidate) => matchesTool(candidate, request) && matchesCapability(candidate, request),
  );

  if (request.selectionSource !== 'explicit-targets') {
    // Bulk and bounded-default selection never invent absent placements.
    return ok(success(toolFiltered.filter(isExisting), request.selectionSource));
  }

  const selected: C[] = [];
  const unmatched: string[] = [];
  let filteredMatch = false;

  for (const target of request.targets) {
    const compiledTarget = compileWildcardTarget(target);
    const preToolMatches = scoped.filter(
      (candidate) =>
        matchesTarget(candidate, compiledTarget) &&
        (isExisting(candidate) || (request.allowAbsentCreate && request.scopes.length === 1)),
    );
    const matches = preToolMatches.filter(
      (candidate) => matchesTool(candidate, request) && matchesCapability(candidate, request),
    );

    if (matches.length === 0) {
      if (preToolMatches.length > 0) filteredMatch = true;
      else unmatched.push(target);
      continue;
    }
    if (matches.length > 1) return err(ambiguousError(target, matches));
    const match = matches[0];
    if (match && !selected.includes(match)) selected.push(match);
  }

  if (unmatched.length > 0) return err(unmatchedError(unmatched));
  if (selected.length === 0 && !filteredMatch) return err(unmatchedError(request.targets));
  return ok(success(selected, request.selectionSource));
};
