import { basename, dirname, join } from 'node:path';
import { type BuiltInToolId, type ToolRegistry, toolRegistry } from '../agents/registry.ts';
import {
  type SkillSmithError,
  errorMessage,
  genericError,
  invalidArgumentError,
} from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { summarize } from './normalize.ts';
import {
  type ToolVerdict,
  type ToolVerifier,
  VERIFIED_AGAINST,
  VERIFY_TOOLS,
  type VerifyMode,
  type VerifyPorts,
  type VerifyReport,
  type VerifyTool,
} from './types.ts';

export interface VerifyOptions<ToolId extends string = VerifyTool> {
  path: string; // target directory (CLI passes an absolute path)
  tools?: readonly ToolId[]; // explicit --tool list; undefined = all registered verifiers (best-effort)
  deep?: boolean; // --deep => modes {static, deep}; otherwise {static}
  strict?: boolean;
  signal?: AbortSignal;
}

export interface ResolvedTarget {
  path: string; // dir to hand to checkers (the wrapper dir for bare skills)
  kind: 'plugin' | 'skill';
  cleanup: () => Promise<void>; // removes the wrapper temp dir; no-op for plugins
}

type VerifyRegistry<ToolId extends string = string, VerificationId extends ToolId = ToolId> = Pick<
  ToolRegistry<ToolId, VerificationId>,
  'adapters' | 'ids' | 'get' | 'toolsFor'
>;
type VerifyDispatch<ToolId extends string, VerificationId extends ToolId = ToolId> =
  | VerifyRegistry<ToolId, VerificationId>
  | Readonly<Record<VerificationId, ToolVerifier<VerificationId>>>;

const isVerifyRegistry = <ToolId extends string, VerificationId extends ToolId>(
  dispatch: VerifyDispatch<ToolId, VerificationId>,
): dispatch is VerifyRegistry<ToolId, VerificationId> =>
  'adapters' in dispatch &&
  Array.isArray(dispatch.adapters) &&
  typeof dispatch.get === 'function' &&
  typeof dispatch.toolsFor === 'function';

type TargetRegistry = Pick<ToolRegistry, 'adapters'>;

const targetManifestsFor = (registry: TargetRegistry): readonly string[] => [
  ...new Set(registry.adapters.flatMap((adapter) => adapter.verification?.targetManifests ?? [])),
];

const verifiedAgainstFor = <ToolId extends string, VerificationId extends ToolId>(
  registry: VerifyRegistry<ToolId, VerificationId>,
): Record<VerificationId, string> =>
  Object.fromEntries(
    registry.adapters.flatMap((adapter) =>
      adapter.verification
        ? [[adapter.descriptor.id, adapter.verification.verifiedAgainst] as const]
        : [],
    ),
  ) as Record<VerificationId, string>;

export const resolveTarget = async (
  env: VerifyPorts,
  path: string,
  registry: TargetRegistry = toolRegistry,
): Promise<Result<ResolvedTarget, SkillSmithError>> => {
  const targetManifests = targetManifestsFor(registry);
  let isPlugin = false;
  for (const targetManifest of targetManifests) {
    if (await env.fileExists(join(path, targetManifest))) {
      isPlugin = true;
      break;
    }
  }
  if (isPlugin) {
    return ok({ path, kind: 'plugin', cleanup: async () => {} });
  }

  const isBareSkill = await env.fileExists(join(path, 'SKILL.md'));
  if (isBareSkill) {
    const name = basename(path);
    let tmp: string | undefined;
    try {
      tmp = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('verify-wrapper'));
      const wrapperPath = tmp;
      const manifest = JSON.stringify({
        name,
        description: 'skillsmith verify ephemeral wrapper',
        version: '0.0.0',
        author: { name: 'skillsmith' },
      });
      for (const targetManifest of targetManifests) {
        await env.makeDir(join(wrapperPath, dirname(targetManifest)));
        await env.writeTextFile(join(wrapperPath, targetManifest), manifest);
      }
      await env.copyTree(path, join(wrapperPath, 'skills', name));
      return ok({
        path: wrapperPath,
        kind: 'skill',
        cleanup: async () => {
          await env.removeTree(wrapperPath);
        },
      });
    } catch (e) {
      const wrapError = genericError(`failed to wrap bare skill '${path}': ${errorMessage(e)}`);
      if (tmp !== undefined) await env.removeTree(tmp).catch(() => {});
      return err(wrapError);
    }
  }

  return err(
    invalidArgumentError(
      `'${path}' is not a plugin or skill directory (expected ${targetManifests.join(', ')}, or SKILL.md)`,
    ),
  );
};

export function runVerify(
  env: VerifyPorts,
  opts: VerifyOptions<VerifyTool>,
  dispatch?: VerifyDispatch<BuiltInToolId, VerifyTool>,
): Promise<Result<VerifyReport<VerifyTool>, SkillSmithError>>;
export function runVerify<ToolId extends string, VerificationId extends ToolId = ToolId>(
  env: VerifyPorts,
  opts: VerifyOptions<NoInfer<VerificationId>>,
  registry: VerifyRegistry<ToolId, VerificationId>,
): Promise<Result<VerifyReport<VerificationId>, SkillSmithError>>;
export async function runVerify(
  env: VerifyPorts,
  opts: VerifyOptions<string>,
  dispatch: VerifyDispatch<string> = toolRegistry,
): Promise<Result<VerifyReport<string>, SkillSmithError>> {
  if (opts.signal?.aborted) return err(genericError('runVerify aborted'));

  const registry = isVerifyRegistry(dispatch) ? dispatch : null;
  const targetRegistry = registry ?? toolRegistry;
  const resolved = await resolveTarget(env, opts.path, targetRegistry);
  if (!resolved.ok) return resolved;

  try {
    const toolSet = opts.tools ?? registry?.toolsFor('verify-static') ?? VERIFY_TOOLS;
    const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
    const modes: VerifyMode[] = opts.deep ? ['static', 'deep'] : ['static'];
    const strict = opts.strict ?? false;

    const toolVerdicts: ToolVerdict<string>[] = [];
    for (const tool of toolSet) {
      const checker = isVerifyRegistry(dispatch)
        ? dispatch.get(tool)?.verification?.verify
        : dispatch[tool];
      if (checker === undefined) {
        return err(genericError(`no registered verifier for '${tool}'`));
      }
      const result = await checker(env, {
        path: resolved.value.path,
        modes,
        strict,
        kind: resolved.value.kind,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (!result.ok) return result;
      toolVerdicts.push(result.value);
    }

    const report: VerifyReport<string> = {
      schemaVersion: 1,
      target: { path: opts.path, kind: resolved.value.kind },
      requested: { tools: [...toolSet], modes, strict, explicitTools },
      verifiedAgainst: registry ? verifiedAgainstFor(registry) : VERIFIED_AGAINST,
      summary: summarize(toolVerdicts),
      tools: toolVerdicts,
    };
    return ok(report);
  } catch (error) {
    if (opts.signal?.aborted) return err(genericError('runVerify aborted'));
    throw error;
  } finally {
    await resolved.value.cleanup();
  }
}

/** `runVerify` wired to the built-in per-agent checkers. */
export const verifyPlugin = (
  env: VerifyPorts,
  opts: VerifyOptions,
): Promise<Result<VerifyReport, SkillSmithError>> => runVerify(env, opts);
