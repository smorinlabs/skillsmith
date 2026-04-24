import { join } from 'node:path';
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { ScanEnv } from '../env/types.ts';
import { parseSkillFrontmatter } from './frontmatter.ts';
import type { SkillEntry } from './types.ts';

export interface WalkSkillDirOpts {
  tool: SupportedTool;
  scope: Scope;
  root: string;
}

export const walkSkillDir = async (env: ScanEnv, opts: WalkSkillDirOpts): Promise<SkillEntry[]> => {
  if (!(await env.fileExists(opts.root))) return [];

  const entries = await env.listDir(opts.root);
  const results: SkillEntry[] = [];

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const path = join(opts.root, name);
    const skillMd = join(path, 'SKILL.md');
    if (!(await env.fileExists(skillMd))) continue;

    let frontmatter: SkillEntry['frontmatter'] = null;
    try {
      const text = await env.readText(skillMd);
      const parsed = parseSkillFrontmatter(text, skillMd);
      if (parsed.ok) frontmatter = parsed.value;
    } catch {
      frontmatter = null;
    }

    let realpath = path;
    try {
      realpath = await env.realpath(path);
    } catch {
      // keep logical path
    }

    results.push({
      name,
      path,
      realpath,
      tool: opts.tool,
      scope: opts.scope,
      root: opts.root,
      frontmatter,
    });
  }

  return results;
};
