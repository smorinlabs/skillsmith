import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { verifyClaudeCode } from '../agents/claude-code/verify.ts';
import { verifyCodex } from '../agents/codex/verify.ts';
import type { ScanEnv } from '../env/types.ts';
import { type SkillSmithError, errorMessage, genericError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { summarize } from './normalize.ts';
import {
  type ToolVerdict,
  type ToolVerifier,
  VERIFIED_AGAINST,
  VERIFY_TOOLS,
  type VerifyMode,
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

export const resolveTarget = async (
  env: ScanEnv,
  path: string,
): Promise<Result<ResolvedTarget, SkillSmithError>> => {
  const isPlugin =
    (await env.fileExists(join(path, '.claude-plugin', 'plugin.json'))) ||
    (await env.fileExists(join(path, '.codex-plugin', 'plugin.json')));
  if (isPlugin) {
    return ok({ path, kind: 'plugin', cleanup: async () => {} });
  }

  const isBareSkill = await env.fileExists(join(path, 'SKILL.md'));
  if (isBareSkill) {
    const name = basename(path);
    try {
      const tmp = await mkdtemp(join(tmpdir(), 'skillsmith-verify-'));
      const manifest = JSON.stringify({
        name,
        description: 'skillsmith verify ephemeral wrapper',
        version: '0.0.0',
        author: { name: 'skillsmith' },
      });
      await mkdir(join(tmp, '.claude-plugin'), { recursive: true });
      await mkdir(join(tmp, '.codex-plugin'), { recursive: true });
      await writeFile(join(tmp, '.claude-plugin', 'plugin.json'), manifest);
      await writeFile(join(tmp, '.codex-plugin', 'plugin.json'), manifest);
      await cp(path, join(tmp, 'skills', name), { recursive: true });
      return ok({
        path: tmp,
        kind: 'skill',
        cleanup: async () => {
          await rm(tmp, { recursive: true, force: true });
        },
      });
    } catch (e) {
      return err(genericError(`failed to wrap bare skill '${path}': ${errorMessage(e)}`));
    }
  }

  return err(
    genericError(
      `'${path}' is not a plugin or skill directory (expected .claude-plugin/plugin.json, .codex-plugin/plugin.json, or SKILL.md)`,
    ),
  );
};

export const runVerify = async (
  env: ScanEnv,
  opts: VerifyOptions,
  checkers: Record<VerifyTool, ToolVerifier>,
): Promise<Result<VerifyReport, SkillSmithError>> => {
  if (opts.signal?.aborted) return err(genericError('runVerify aborted'));

  const resolved = await resolveTarget(env, opts.path);
  if (!resolved.ok) return resolved;

  try {
    const toolSet = opts.tools ?? VERIFY_TOOLS;
    const explicitTools = opts.tools !== undefined && opts.tools.length > 0;
    const modes: VerifyMode[] = opts.deep ? ['static', 'deep'] : ['static'];
    const strict = opts.strict ?? false;

    const toolVerdicts: ToolVerdict[] = [];
    for (const tool of toolSet) {
      const result = await checkers[tool](env, {
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
      verifiedAgainst: VERIFIED_AGAINST,
      summary: summarize(toolVerdicts, { explicitTools }),
      tools: toolVerdicts,
    };
    return ok(report);
  } finally {
    await resolved.value.cleanup();
  }
};

const defaultCheckers: Record<VerifyTool, ToolVerifier> = {
  'claude-code': verifyClaudeCode,
  codex: verifyCodex,
};

/** `runVerify` wired to the built-in per-agent checkers. */
export const verifyPlugin = (
  env: ScanEnv,
  opts: VerifyOptions,
): Promise<Result<VerifyReport, SkillSmithError>> => runVerify(env, opts, defaultCheckers);
