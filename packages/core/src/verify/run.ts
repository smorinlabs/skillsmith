import { basename, dirname, join } from 'node:path';
import { type ToolRegistry, toolRegistry } from '../agents/registry.ts';
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

type VerifyRegistry<ToolId extends string = string> = Pick<
  ToolRegistry<ToolId>,
  'adapters' | 'ids' | 'get' | 'toolsFor'
>;
type VerifyDispatch<ToolId extends string> =
  | VerifyRegistry<ToolId>
  | Readonly<Record<ToolId, ToolVerifier<ToolId>>>;

const isVerifyRegistry = <ToolId extends string>(
  dispatch: VerifyDispatch<ToolId>,
): dispatch is VerifyRegistry<ToolId> =>
  'adapters' in dispatch &&
  Array.isArray(dispatch.adapters) &&
  typeof dispatch.get === 'function' &&
  typeof dispatch.toolsFor === 'function';

const targetManifestsFor = <ToolId extends string>(
  registry: VerifyRegistry<ToolId>,
): readonly string[] => [
  ...new Set(registry.adapters.flatMap((adapter) => adapter.verification?.targetManifests ?? [])),
];

const verifiedAgainstFor = <ToolId extends string>(
  registry: VerifyRegistry<ToolId>,
): Record<ToolId, string> =>
  Object.fromEntries(
    registry.adapters.flatMap((adapter) =>
      adapter.verification
        ? [[adapter.descriptor.id, adapter.verification.verifiedAgainst] as const]
        : [],
    ),
  ) as Record<ToolId, string>;

export const resolveTarget = async <ToolId extends string = VerifyTool>(
  env: VerifyPorts,
  path: string,
  registry: VerifyRegistry<ToolId> = toolRegistry as unknown as VerifyRegistry<ToolId>,
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

export const runVerify = async <ToolId extends string = VerifyTool>(
  env: VerifyPorts,
  opts: VerifyOptions<ToolId>,
  dispatch: VerifyDispatch<ToolId> = toolRegistry as unknown as VerifyRegistry<ToolId>,
): Promise<Result<VerifyReport<ToolId>, SkillSmithError>> => {
  if (opts.signal?.aborted) return err(genericError('runVerify aborted'));

  const registry = isVerifyRegistry(dispatch) ? dispatch : null;
  const targetRegistry = registry ?? (toolRegistry as unknown as VerifyRegistry<ToolId>);
  const resolved = await resolveTarget(env, opts.path, targetRegistry);
  if (!resolved.ok) return resolved;

  try {
    const toolSet =
      opts.tools ??
      registry?.toolsFor('verify-static') ??
      (VERIFY_TOOLS as unknown as readonly ToolId[]);
    const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
    const modes: VerifyMode[] = opts.deep ? ['static', 'deep'] : ['static'];
    const strict = opts.strict ?? false;

    const toolVerdicts: ToolVerdict<ToolId>[] = [];
    for (const tool of toolSet) {
      const checker = registry
        ? registry.get(tool)?.verification?.verify
        : (dispatch as Readonly<Record<ToolId, ToolVerifier<ToolId>>>)[tool];
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

    const report: VerifyReport<ToolId> = {
      schemaVersion: 1,
      target: { path: opts.path, kind: resolved.value.kind },
      requested: { tools: [...toolSet], modes, strict, explicitTools },
      verifiedAgainst: registry
        ? verifiedAgainstFor(registry)
        : (VERIFIED_AGAINST as unknown as Record<ToolId, string>),
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
};

/** `runVerify` wired to the built-in per-agent checkers. */
export const verifyPlugin = (
  env: VerifyPorts,
  opts: VerifyOptions,
): Promise<Result<VerifyReport, SkillSmithError>> => runVerify(env, opts);
