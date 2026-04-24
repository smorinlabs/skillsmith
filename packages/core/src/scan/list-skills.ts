import { Glob } from 'bun';
import { registry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import { noopLogger } from '../env/logger.ts';
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import { type Result, ok } from '../result.ts';
import type { SkillEntry } from '../skills/types.ts';
import { walkSkillDir } from '../skills/walk.ts';

export interface ListSkillsOpts {
  tools?: readonly SupportedTool[];
  scopes?: readonly Scope[];
  globs?: readonly string[];
  duplicatesOnly?: boolean;
  cwd: string;
  envVars: Record<string, string | undefined>;
  logger?: Logger;
  signal?: AbortSignal;
}

const applyGlobs = (entries: SkillEntry[], globs: readonly string[]): SkillEntry[] => {
  const compiled = globs.map((g) => new Glob(g));
  return entries.filter((e) => compiled.some((g) => g.match(e.name)));
};

const filterCrossScopeDuplicates = (entries: SkillEntry[]): SkillEntry[] => {
  const byName = new Map<string, Set<Scope>>();
  for (const e of entries) {
    if (!byName.has(e.name)) byName.set(e.name, new Set());
    byName.get(e.name)?.add(e.scope);
  }
  const dupNames = new Set<string>();
  for (const [name, scopes] of byName) {
    if (scopes.size > 1) dupNames.add(name);
  }
  return entries.filter((e) => dupNames.has(e.name));
};

const dedupeByRealpath = (entries: SkillEntry[]): SkillEntry[] => {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const e of entries) {
    const key = `${e.tool}|${e.scope}|${e.realpath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
};

export const listSkills = async (
  env: ScanEnv,
  opts: ListSkillsOpts,
): Promise<Result<SkillEntry[], SkillSmithError>> => {
  const logger = opts.logger ?? noopLogger;
  const tools = opts.tools ?? (Object.keys(registry) as readonly SupportedTool[]);
  const scopes = opts.scopes ?? SCOPES;
  const ctx = { cwd: opts.cwd, envVars: opts.envVars };

  const all: SkillEntry[] = [];
  for (const tool of tools) {
    if (opts.signal?.aborted) break;
    for (const scope of scopes) {
      const agent = registry[tool];
      const roots = agent.getSkillRoots(env, scope, ctx);
      for (const root of roots) {
        logger.debug(`scanning ${tool}/${scope}: ${root}`);
        const entries = await walkSkillDir(env, { tool, scope, root });
        all.push(...entries);
      }
    }
  }

  let result = dedupeByRealpath(all);
  if (opts.globs && opts.globs.length > 0) result = applyGlobs(result, opts.globs);
  if (opts.duplicatesOnly) result = filterCrossScopeDuplicates(result);
  return ok(result);
};
