import { dirname, join } from 'node:path';

/** Raw filesystem primitives the init probe needs. Implemented by the runtime
 *  capability adapter (`ports/default.ts`); errors must be raw Node errors
 *  carrying the kernel `code` (EACCES/EPERM/ENOENT/...) — never PortErrors,
 *  whose normalization would erase the errno this probe measures. */
export interface GitInitProbeFs {
  /** Non-recursive directory creation (single leaf, no parents). */
  createDir(path: string): Promise<void>;
  /** Remove exactly one empty directory; must fail when any child exists. */
  removeDir(path: string): Promise<void>;
  /** Recursive force-remove; residue fallback only, never a first resort. */
  removeTree(path: string): Promise<void>;
  randomHex(byteCount: number): string;
}

/** Post-failure kernel probe for the `initializeFetch` init step (SC-I60-MF2B
 *  option A). Returns the denial errno when the kernel refuses creation at
 *  the init destination, else null. Never throws: any unexpected failure
 *  returns null so the caller falls through to the original error. */
export interface GitInitProbe {
  probeInitDenied(repositoryRoot: string): Promise<'EACCES' | 'EPERM' | null>;
}

const nodeCode = (error: unknown): string | null =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;

const isDenial = (code: string | null): code is 'EACCES' | 'EPERM' =>
  code === 'EACCES' || code === 'EPERM';

/** Best-effort removal of a throwaway child this probe created. Never throws;
 *  the recursive fallback runs only when the empty-dir removal fails for a
 *  reason other than foreign content or a missing child. */
const removeProbeChild = async (fs: GitInitProbeFs, childPath: string): Promise<void> => {
  try {
    await fs.removeDir(childPath);
    return;
  } catch (error) {
    // ENOTEMPTY means a third party raced our cleanup and the child now
    // holds entries the probe did not create: never recursively delete them.
    // ENOENT means the child is already gone: nothing left to remove.
    const code = nodeCode(error);
    if (code === 'ENOTEMPTY' || code === 'ENOENT') return;
    // Any other failure (transient errors, ...) falls through to the
    // recursive residue fallback below.
  }
  try {
    await fs.removeTree(childPath);
  } catch {
    // Nothing further can be done; the child stays as residue.
  }
};

/** Probe writability of one directory via an owned throwaway child that is
 *  always removed. Residue contract: a failed creation leaves nothing, a
 *  success is always followed by removal, and a pre-existing colliding name
 *  is never removed (not ours). When cleanup itself fails, foreign content
 *  is never deleted; the owned child may remain as residue. */
const probeDirDenied = async (
  fs: GitInitProbeFs,
  dirPath: string,
  childName: string,
): Promise<'EACCES' | 'EPERM' | null> => {
  const childPath = join(dirPath, childName);
  try {
    await fs.createDir(childPath);
  } catch (error) {
    // Only a real kernel denial converts; every other probe error (ENOENT
    // races, EEXIST collisions, EROFS read-only filesystems, ENOTDIR, ...)
    // falls through to the original error — never invent permission.
    const code = nodeCode(error);
    return isDenial(code) ? code : null;
  }
  await removeProbeChild(fs, childPath);
  return null;
};

export const createGitInitProbe = (fs: GitInitProbeFs): GitInitProbe => ({
  probeInitDenied: async (repositoryRoot: string): Promise<'EACCES' | 'EPERM' | null> => {
    try {
      if (repositoryRoot.trim().length === 0) return null;
      const childName = `.skillsmith-init-probe-${fs.randomHex(8)}`;
      // Mirror what `git init -- <leaf>` attempted: when the leaf exists, git
      // writes inside it; when absent, git creates it inside its parent. A
      // file collision (ENOTDIR) is a nonpermission cause — fall through
      // without probing the parent, whose writability is irrelevant to it.
      const leafChild = join(repositoryRoot, childName);
      try {
        await fs.createDir(leafChild);
      } catch (error) {
        const code = nodeCode(error);
        if (isDenial(code)) return code;
        if (code === 'ENOENT') return probeDirDenied(fs, dirname(repositoryRoot), childName);
        return null;
      }
      await removeProbeChild(fs, leafChild);
      return null;
    } catch {
      return null;
    }
  },
});
