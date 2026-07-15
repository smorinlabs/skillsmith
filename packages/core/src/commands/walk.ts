import { join } from 'node:path';
import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import {
  rethrowInventoryReadFailure,
  tagInventoryRootOrdinal,
  throwIfInventoryCancelled,
} from '../inventory-control.ts';
import type { FileReadPort } from '../ports/types.ts';
import { parseSkillFrontmatter } from '../skills/frontmatter.ts';
import type { EnabledState, Origin } from '../skills/types.ts';
import type { CommandEntry } from './types.ts';

export interface WalkCommandDirOpts {
  tool: SupportedTool;
  scope: Scope;
  root: string;
  origin: Origin;
  enabled: EnabledState;
  /** Internal adapter-root order used by inventory identity projection. */
  rootOrdinal?: number;
  signal?: AbortSignal;
}

export const walkCommandDir = async (
  env: FileReadPort,
  opts: WalkCommandDirOpts,
): Promise<CommandEntry[]> => {
  throwIfInventoryCancelled(opts.signal);
  const rootExists = await env.fileExists(opts.root);
  throwIfInventoryCancelled(opts.signal);
  if (!rootExists) return [];

  throwIfInventoryCancelled(opts.signal);
  const entries = await env.listDir(opts.root);
  throwIfInventoryCancelled(opts.signal);
  const out: CommandEntry[] = [];

  for (const filename of entries) {
    throwIfInventoryCancelled(opts.signal);
    if (filename.startsWith('.')) continue;
    if (!filename.endsWith('.md')) continue;
    const path = join(opts.root, filename);
    const commandExists = await env.fileExists(path);
    throwIfInventoryCancelled(opts.signal);
    if (!commandExists) continue;

    throwIfInventoryCancelled(opts.signal);
    const text = await env.readText(path).catch((failure: unknown) => {
      throwIfInventoryCancelled(opts.signal);
      return rethrowInventoryReadFailure(failure, path);
    });
    throwIfInventoryCancelled(opts.signal);
    let frontmatter: CommandEntry['frontmatter'] = null;
    const parsed = parseSkillFrontmatter(text, path);
    if (parsed.ok) frontmatter = parsed.value;

    throwIfInventoryCancelled(opts.signal);
    const realpath = await env.realpath(path).catch((failure: unknown) => {
      throwIfInventoryCancelled(opts.signal);
      return rethrowInventoryReadFailure(failure, path);
    });
    throwIfInventoryCancelled(opts.signal);
    const name = filename.slice(0, -'.md'.length);
    out.push(
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
  return out;
};
