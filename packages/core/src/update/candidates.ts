import type { BuiltInToolId } from '../agents/registry.ts';
import type { PortableLockSkillV1 } from '../artifacts/lock.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import { compileWildcardTarget } from '../selection/wildcard.ts';
import type {
  UpdateCandidateV1,
  UpdateRemoteRefInspectionV1,
  UpdateSelectedDeclarationV1,
  UpdateSelectionSource,
  UpdateSelectionV1,
} from './types.ts';

export interface SelectUpdateDeclarationsRequestV1 {
  readonly manifest: NormalizedManifestV1;
  readonly targets: readonly string[];
  readonly all: boolean;
  readonly tools: readonly string[];
  readonly registryOrder: readonly BuiltInToolId[];
}

const frozenStrings = (values: readonly string[]): readonly string[] => Object.freeze([...values]);

/** Declaration-first selection: target matching is complete before the tool filter is applied. */
export const selectUpdateDeclarationsV1 = (
  request: Readonly<SelectUpdateDeclarationsRequestV1>,
): UpdateSelectionV1 => {
  const selectionSource: UpdateSelectionSource = request.all
    ? 'explicit-all'
    : request.targets.length === 0
      ? 'bounded-default'
      : 'explicit-targets';
  const targets = [...new Set(request.targets)];
  const patterns = targets.map((target) => ({ target, pattern: compileWildcardTarget(target) }));
  const targetMatches = new Map(targets.map((target) => [target, false]));
  const declared = request.manifest.skills.filter((declaration) => {
    if (patterns.length === 0) return true;
    const matched = patterns.some(({ target, pattern }) => {
      if (!pattern.matches(declaration.name)) return false;
      targetMatches.set(target, true);
      return true;
    });
    return matched;
  });
  const requestedTools = new Set(request.tools);
  const filteredNames: string[] = [];
  const declarations: UpdateSelectedDeclarationV1[] = [];
  for (const declaration of declared) {
    const declaredTools = new Set(declaration.tools);
    const tools = request.registryOrder.filter(
      (tool) => declaredTools.has(tool) && (requestedTools.size === 0 || requestedTools.has(tool)),
    );
    if (tools.length === 0) filteredNames.push(declaration.name);
    else declarations.push(Object.freeze({ declaration, tools: Object.freeze(tools) }));
  }
  return Object.freeze({
    selectionSource,
    requestedTargets: frozenStrings(request.targets),
    requestedTools: frozenStrings(request.tools),
    selectedNames: frozenStrings(declarations.map(({ declaration }) => declaration.name)),
    unmatchedTargets: frozenStrings(
      [...targetMatches].filter(([, matched]) => !matched).map(([target]) => target),
    ),
    filteredNames: frozenStrings(filteredNames),
    declarations: Object.freeze(declarations),
  });
};

export interface DeriveUpdateCandidateRequestV1 {
  readonly selected: UpdateSelectedDeclarationV1;
  readonly currentLock: PortableLockSkillV1;
  readonly inspection: UpdateRemoteRefInspectionV1;
  readonly explicitRef: string | null;
  readonly pin: boolean;
}

/** Pure moving/fixed/ref/pin policy. Content comparison is completed after materialization. */
export const deriveUpdateCandidateV1 = (
  request: Readonly<DeriveUpdateCandidateRequestV1>,
): UpdateCandidateV1 => {
  const { declaration } = request.selected;
  const fixed = request.inspection.kind === 'tag' || request.inspection.kind === 'sha';
  const skippedFixed = request.explicitRef === null && fixed;
  const transition = request.pin ? 'pin' : request.explicitRef === null ? 'preserve' : 'track';
  const proposedRequestedRef = skippedFixed
    ? declaration.ref
    : request.pin
      ? request.inspection.resolvedSha
      : request.explicitRef === null
        ? declaration.ref
        : request.explicitRef;
  const available =
    !skippedFixed &&
    (request.currentLock.resolvedSha !== request.inspection.resolvedSha ||
      request.currentLock.requestedRef !== proposedRequestedRef ||
      declaration.ref !== proposedRequestedRef);
  return Object.freeze({
    name: declaration.name,
    tools: Object.freeze([...request.selected.tools]),
    currentRequestedRef: declaration.ref,
    currentResolvedSha: request.currentLock.resolvedSha,
    requestedRef: request.inspection.requestedRef,
    refKind: request.inspection.kind,
    resolvedSha: request.inspection.resolvedSha,
    proposedRequestedRef,
    contentHash: null,
    transition,
    outcome: skippedFixed ? 'skipped-fixed' : available ? 'available' : 'current',
    reason: skippedFixed ? 'fixed declaration requires an explicit --ref' : null,
  });
};
