import type { ToolRegistry } from '../agents/registry.ts';
import { type SkillSmithError, toolUnavailableError } from '../errors.ts';
import type { ObservationBundle } from '../observation/index.ts';
import type { Result } from '../result.ts';
import { type VerificationGate, evaluateVerificationGate } from '../verify/gate.ts';
import { runVerify } from '../verify/run.ts';
import type { SummaryVerdict, ToolVerdict, VerifyPorts } from '../verify/types.ts';

export type UpdateVerificationMode = 'static' | 'static+deep';

export interface UpdateVerificationRequest<ToolId extends string = string> {
  readonly tool: ToolId;
  readonly path: string;
  readonly strict: boolean;
  readonly signal?: AbortSignal;
  readonly observation?: ObservationBundle;
}

export interface UpdateVerificationOutcome<ToolId extends string = string> {
  readonly tool: ToolId;
  readonly mode: UpdateVerificationMode;
  readonly verdict: SummaryVerdict;
  readonly gate: VerificationGate;
  readonly blocked: boolean;
  readonly toolVerdict: ToolVerdict<ToolId>;
}

type UpdateVerificationRegistry<ToolId extends string, VerificationId extends ToolId> = Pick<
  ToolRegistry<ToolId, VerificationId>,
  'adapters' | 'ids' | 'get' | 'toolsFor'
>;

/**
 * Verify one prepared update source using the selected adapter's immutable update policy.
 *
 * Policy selection intentionally has no tool-name cases: the registry owns both the verifier and
 * its static/deep requirement. Verdict reduction remains centralized in evaluateVerificationGate.
 */
export const verifyUpdateCandidate = async <ToolId extends string, VerificationId extends ToolId>(
  env: VerifyPorts,
  request: UpdateVerificationRequest<VerificationId>,
  registry: UpdateVerificationRegistry<ToolId, VerificationId>,
): Promise<Result<UpdateVerificationOutcome<VerificationId>, SkillSmithError>> => {
  const verification = registry.get(request.tool)?.verification;
  if (verification?.gatePolicy.update === undefined) {
    return {
      ok: false,
      error: toolUnavailableError(
        `${request.tool} does not declare the update verification capability`,
      ),
    };
  }

  const mode = verification.gatePolicy.update;
  const verified = await runVerify(
    env,
    {
      path: request.path,
      tools: [request.tool],
      deep: mode === 'static+deep',
      strict: request.strict,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.observation === undefined ? {} : { observation: request.observation }),
    },
    registry,
  );
  if (!verified.ok) return verified;

  const toolVerdict = verified.value.tools.find((entry) => entry.tool === request.tool);
  if (toolVerdict === undefined) {
    throw new Error(`tool registry invariant: ${request.tool} verifier produced no tool verdict`);
  }
  const decision = evaluateVerificationGate({
    verdict: toolVerdict.verdict,
    strict: request.strict,
    requestedMode: mode,
  });

  return {
    ok: true,
    value: Object.freeze({
      tool: request.tool,
      mode,
      verdict: toolVerdict.verdict,
      gate: decision.gate,
      blocked: decision.blocked,
      toolVerdict,
    }),
  };
};
