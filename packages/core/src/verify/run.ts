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

export interface VerifyOptions {
  path: string; // target directory (CLI passes an absolute path)
  tools?: readonly VerifyTool[]; // explicit --tool list; undefined = all of VERIFY_TOOLS (best-effort)
  deep?: boolean; // --deep => modes {static, deep}; otherwise {static}
  strict?: boolean;
  signal?: AbortSignal;
}

export interface ResolvedTarget {
  path: string; // dir to hand to checkers (the wrapper dir for bare skills)
  kind: 'plugin' | 'skill';
  cleanup: () => Promise<void>; // removes the wrapper temp dir; no-op for plugins
}

type VerifyRegistry = Pick<ToolRegistry, 'adapters' | 'ids' | 'get' | 'toolsFor'>;
type VerifyDispatch = VerifyRegistry | Readonly<Record<VerifyTool, ToolVerifier>>;

const isVerifyRegistry = (dispatch: VerifyDispatch): dispatch is VerifyRegistry =>
  'adapters' in dispatch &&
  Array.isArray(dispatch.adapters) &&
  typeof dispatch.get === 'function' &&
  typeof dispatch.toolsFor === 'function';

const targetManifestsFor = (registry: VerifyRegistry): readonly string[] => [
  ...new Set(
    [toolRegistry, registry].flatMap((candidate) =>
      candidate.adapters.flatMap((adapter) => adapter.verification?.targetManifests ?? []),
    ),
  ),
];

const verifiedAgainstFor = (registry: VerifyRegistry): Record<string, string> =>
  Object.fromEntries(
    registry.adapters.flatMap((adapter) =>
      adapter.verification
        ? [[adapter.descriptor.id, adapter.verification.verifiedAgainst] as const]
        : [],
    ),
  );

export const resolveTarget = async (
  env: VerifyPorts,
  path: string,
  registry: VerifyRegistry = toolRegistry,
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
    try {
      const tmp = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('verify-wrapper'));
      const manifest = JSON.stringify({
        name,
        description: 'skillsmith verify ephemeral wrapper',
        version: '0.0.0',
        author: { name: 'skillsmith' },
      });
      for (const targetManifest of targetManifests) {
        await env.makeDir(join(tmp, dirname(targetManifest)));
        await env.writeTextFile(join(tmp, targetManifest), manifest);
      }
      await env.copyTree(path, join(tmp, 'skills', name));
      return ok({
        path: tmp,
        kind: 'skill',
        cleanup: async () => {
          await env.removeTree(tmp);
        },
      });
    } catch (e) {
      return err(genericError(`failed to wrap bare skill '${path}': ${errorMessage(e)}`));
    }
  }

  return err(
    invalidArgumentError(
      `'${path}' is not a plugin or skill directory (expected ${targetManifests.join(', ')}, or SKILL.md)`,
    ),
  );
};

export const runVerify = async (
  env: VerifyPorts,
  opts: VerifyOptions,
  dispatch: VerifyDispatch = toolRegistry,
): Promise<Result<VerifyReport, SkillSmithError>> => {
  if (opts.signal?.aborted) return err(genericError('runVerify aborted'));

  const registry = isVerifyRegistry(dispatch) ? dispatch : null;
  const resolved = await resolveTarget(env, opts.path, registry ?? toolRegistry);
  if (!resolved.ok) return resolved;

  try {
    const toolSet = opts.tools ?? registry?.toolsFor('verify-static') ?? VERIFY_TOOLS;
    const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
    const modes: VerifyMode[] = opts.deep ? ['static', 'deep'] : ['static'];
    const strict = opts.strict ?? false;

    const toolVerdicts: ToolVerdict[] = [];
    for (const tool of toolSet) {
      const checker = registry
        ? registry.get(tool)?.verification?.verify
        : (dispatch as Readonly<Record<VerifyTool, ToolVerifier>>)[tool as VerifyTool];
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

    const report: VerifyReport = {
      schemaVersion: 1,
      target: { path: opts.path, kind: resolved.value.kind },
      requested: { tools: [...toolSet], modes, strict, explicitTools },
      verifiedAgainst: registry ? verifiedAgainstFor(registry) : VERIFIED_AGAINST,
      summary: summarize(toolVerdicts),
      tools: toolVerdicts,
    } as VerifyReport;
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
): Promise<Result<VerifyReport, SkillSmithError>> => runVerify(env, opts, toolRegistry);
