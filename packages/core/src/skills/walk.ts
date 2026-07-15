import { join } from 'node:path';
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import { throwIfInventoryCancelled } from '../inventory/cancellation.ts';
import { tagInventoryRootOrdinal } from '../inventory/types.ts';
import type { FileReadPort } from '../ports/types.ts';
import { parseSkillFrontmatter } from './frontmatter.ts';
import type { EnabledState, Origin, SkillEntry } from './types.ts';

export interface WalkSkillDirOpts {
  tool: SupportedTool;
  scope: Scope;
  root: string;
  origin: Origin;
  enabled: EnabledState;
  /** Internal adapter-root order used by inventory identity/precedence projection. */
  rootOrdinal?: number;
  signal?: AbortSignal;
}

export const walkSkillDir = async (
  env: FileReadPort,
  opts: WalkSkillDirOpts,
): Promise<SkillEntry[]> => {
  throwIfInventoryCancelled(opts.signal);
  const rootExists = await env.fileExists(opts.root);
  throwIfInventoryCancelled(opts.signal);
  if (!rootExists) return [];

  throwIfInventoryCancelled(opts.signal);
  const entries = await env.listDir(opts.root);
  throwIfInventoryCancelled(opts.signal);
  const results: SkillEntry[] = [];

  for (const name of entries) {
    throwIfInventoryCancelled(opts.signal);
    if (name.startsWith('.')) continue;
    const path = join(opts.root, name);
    const skillMd = join(path, 'SKILL.md');
    const skillExists = await env.fileExists(skillMd);
    throwIfInventoryCancelled(opts.signal);
    if (!skillExists) continue;

    let frontmatter: SkillEntry['frontmatter'] = null;
    try {
      throwIfInventoryCancelled(opts.signal);
      const text = await env.readText(skillMd);
      throwIfInventoryCancelled(opts.signal);
      const parsed = parseSkillFrontmatter(text, skillMd);
      if (parsed.ok) frontmatter = parsed.value;
    } catch {
      throwIfInventoryCancelled(opts.signal);
      frontmatter = null;
    }

    let realpath = path;
    try {
      throwIfInventoryCancelled(opts.signal);
      realpath = await env.realpath(path);
      throwIfInventoryCancelled(opts.signal);
    } catch {
      throwIfInventoryCancelled(opts.signal);
      // keep logical path
    }

    throwIfInventoryCancelled(opts.signal);
    results.push(
      tagInventoryRootOrdinal(
        {
          name,
          path,
          realpath,
          tool: opts.tool,
          scope: opts.scope,
          root: opts.root,
          frontmatter,
          origin: opts.origin,
          enabled: opts.enabled,
        },
        opts.rootOrdinal ?? 0,
      ),
    );
  }

  throwIfInventoryCancelled(opts.signal);
  return results;
};
