import { dirname, isAbsolute, join, sep } from 'node:path';
import type { FileReadPort } from '../ports/types.ts';

export type PlacementClass = 'dev' | 'pinned' | 'store-linked' | 'absent';

export interface Placement {
  skill: string; // leaf name in the skills root
  root: string; // the skills root it was found in
  path: string; // join(root, skill)
  class: PlacementClass;
  symlinkTarget: string | null; // LITERAL readlink value for 'dev'/'store-linked'; null otherwise
  dangling: boolean; // 'dev' symlink whose resolved target is absent
}

export type PlacementRootClass = 'absent' | 'container' | 'non-directory';

/** Classify only whether a skills root can contain placements. Symlink roots retain followed
 * filesystem behavior so links to directories remain supported and unsafe targets fail closed. */
export const classifyPlacementRoot = async (
  env: FileReadPort,
  root: string,
): Promise<PlacementRootClass> => {
  const kind = await env.pathKind(root);
  if (kind === 'absent') return 'absent';
  if (kind === 'file') return 'non-directory';
  if (kind === 'symlink' && !(await env.fileExists(root))) return 'absent';
  return 'container';
};

const isInsideStoreRoot = (resolvedTarget: string, storeRoot: string): boolean =>
  resolvedTarget === storeRoot ||
  resolvedTarget.startsWith(storeRoot.endsWith(sep) ? storeRoot : `${storeRoot}${sep}`);

/** Classification per spec §2: symlink outside the store → 'dev'; real dir → 'pinned';
 *  symlink inside storeRoot → 'store-linked'; nothing → 'absent'. */
export const classifyPlacement = async (
  env: FileReadPort,
  root: string,
  skill: string,
  storeRoot: string,
): Promise<Placement> => {
  const path = join(root, skill);
  if ((await classifyPlacementRoot(env, root)) !== 'container') {
    return { skill, root, path, class: 'absent', symlinkTarget: null, dangling: false };
  }
  const kind = await env.pathKind(path);

  if (kind === 'absent' || kind === 'file') {
    return { skill, root, path, class: 'absent', symlinkTarget: null, dangling: false };
  }

  if (kind === 'dir') {
    return { skill, root, path, class: 'pinned', symlinkTarget: null, dangling: false };
  }

  const literalTarget = await env.readLink(path);
  const resolvedTarget = isAbsolute(literalTarget)
    ? literalTarget
    : join(dirname(path), literalTarget);
  const resolvedKind = await env.pathKind(resolvedTarget);
  const dangling = resolvedKind === 'absent';
  const cls: PlacementClass = isInsideStoreRoot(resolvedTarget, storeRoot) ? 'store-linked' : 'dev';

  return { skill, root, path, class: cls, symlinkTarget: literalTarget, dangling };
};

/** Every non-dot entry of the root, classified. A missing root yields []. Dot-prefixed entries
 *  (`.system`, `.skillsmith-staging-*`, `.skillsmith-backup-*`) are never placements. */
export const listPlacements = async (
  env: FileReadPort,
  root: string,
  storeRoot: string,
): Promise<Placement[]> => {
  if ((await classifyPlacementRoot(env, root)) !== 'container') return [];
  const entries = await env.listDir(root);
  const names = entries.filter((name) => !name.startsWith('.'));
  return Promise.all(names.map((name) => classifyPlacement(env, root, name, storeRoot)));
};
