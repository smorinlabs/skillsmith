import { join } from 'node:path';
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { ScanEnv } from '../env/types.ts';
import { parseSkillFrontmatter } from '../skills/frontmatter.ts';
import type { EnabledState, Origin } from '../skills/types.ts';
import type { CommandEntry } from './types.ts';

export interface WalkCommandDirOpts {
  tool: SupportedTool;
  scope: Scope;
  root: string;
  origin: Origin;
  enabled: EnabledState;
}

export const walkCommandDir = async (
  env: ScanEnv,
  opts: WalkCommandDirOpts,
): Promise<CommandEntry[]> => {
  if (!(await env.fileExists(opts.root))) return [];

  const entries = await env.listDir(opts.root);
  const out: CommandEntry[] = [];

  for (const filename of entries) {
    if (filename.startsWith('.')) continue;
    if (!filename.endsWith('.md')) continue;
    const path = join(opts.root, filename);
    if (!(await env.fileExists(path))) continue;

    let frontmatter: CommandEntry['frontmatter'] = null;
    try {
      const text = await env.readText(path);
      const parsed = parseSkillFrontmatter(text, path);
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

    const name = filename.slice(0, -'.md'.length);
    out.push({
      name,
      path,
      realpath,
      tool: opts.tool,
      scope: opts.scope,
      root: opts.root,
      frontmatter,
      origin: opts.origin,
      enabled: opts.enabled,
    });
  }

  return out;
};
