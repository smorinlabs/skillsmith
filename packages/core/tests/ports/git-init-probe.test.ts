import { describe, expect, test } from 'bun:test';
import { type GitInitProbeFs, createGitInitProbe } from '../../src/ports/git-init-probe.ts';

const coded = (code: string): NodeJS.ErrnoException => {
  const error = new Error(`${code}: stub`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

interface StubCalls {
  created: string[];
  removedDirs: string[];
  removedTrees: string[];
}

const stubFs = (
  overrides: Partial<GitInitProbeFs> = {},
): { fs: GitInitProbeFs; calls: StubCalls } => {
  const calls: StubCalls = { created: [], removedDirs: [], removedTrees: [] };
  const fs: GitInitProbeFs = {
    createDir: async (path) => {
      calls.created.push(path);
    },
    removeDir: async (path) => {
      calls.removedDirs.push(path);
    },
    removeTree: async (path) => {
      calls.removedTrees.push(path);
    },
    randomHex: (byteCount) => 'f'.repeat(byteCount * 2),
    ...overrides,
  };
  return { fs, calls };
};

describe('createGitInitProbe', () => {
  test('existing writable leaf probes clean with no residue and no fallback', async () => {
    const { fs, calls } = stubFs();
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBeNull();
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toStartWith('/repo/.skillsmith-init-probe-');
    expect(calls.removedDirs).toEqual(calls.created);
    expect(calls.removedTrees).toHaveLength(0);
  });

  test('leaf EACCES converts to a denial without any removal', async () => {
    const { fs, calls } = stubFs({ createDir: async () => Promise.reject(coded('EACCES')) });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBe('EACCES');
    expect(calls.removedDirs).toHaveLength(0);
    expect(calls.removedTrees).toHaveLength(0);
  });

  test('leaf EPERM converts to a denial', async () => {
    const { fs } = stubFs({ createDir: async () => Promise.reject(coded('EPERM')) });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBe('EPERM');
  });

  test('absent leaf falls through to a writable parent probe with cleanup', async () => {
    const { fs, calls } = stubFs({
      createDir: async (path) => {
        calls.created.push(path);
        if (path.startsWith('/repo/')) throw coded('ENOENT');
      },
    });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBeNull();
    // Leaf ENOENT redirected into the parent; the parent probe child is cleaned up.
    expect(calls.created).toHaveLength(2);
    const parentChild = calls.created[1];
    if (parentChild === undefined) throw new Error('expected a parent probe child');
    expect(parentChild).toStartWith('/.skillsmith-init-probe-');
    expect(calls.removedDirs).toEqual([parentChild]);
  });

  test('absent leaf with denied parent converts the parent denial', async () => {
    const { fs } = stubFs({
      createDir: async (path) => {
        if (path.startsWith('/repo/')) throw coded('ENOENT');
        throw coded('EACCES');
      },
    });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBe('EACCES');
  });

  test('absent leaf with otherwise-failing parent never invents permission', async () => {
    const { fs } = stubFs({
      createDir: async (path) => {
        if (path.startsWith('/repo/')) throw coded('ENOENT');
        throw coded('EROFS');
      },
    });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBeNull();
  });

  test('leaf ENOTDIR is a nonpermission cause that never probes the parent', async () => {
    const { fs, calls } = stubFs();
    const probeFs: GitInitProbeFs = {
      ...fs,
      createDir: async (path) => {
        calls.created.push(path);
        throw coded('ENOTDIR');
      },
    };
    const result = await createGitInitProbe(probeFs).probeInitDenied('/repo');
    expect(result).toBeNull();
    expect(calls.created).toHaveLength(1);
    expect(calls.removedDirs).toHaveLength(0);
  });

  test('leaf EEXIST collision is never removed (not ours)', async () => {
    const { fs, calls } = stubFs({ createDir: async () => Promise.reject(coded('EEXIST')) });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBeNull();
    expect(calls.removedDirs).toHaveLength(0);
    expect(calls.removedTrees).toHaveLength(0);
  });

  test('blank repository root short-circuits without touching the filesystem', async () => {
    const { fs, calls } = stubFs();
    const result = await createGitInitProbe(fs).probeInitDenied('   ');
    expect(result).toBeNull();
    expect(calls.created).toHaveLength(0);
  });

  test('cleanup race (ENOTEMPTY) never recursively deletes foreign content', async () => {
    const { fs, calls } = stubFs({ removeDir: async () => Promise.reject(coded('ENOTEMPTY')) });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBeNull();
    expect(calls.removedTrees).toHaveLength(0);
  });

  test('already-removed child (ENOENT) skips the recursive fallback', async () => {
    const { fs, calls } = stubFs({ removeDir: async () => Promise.reject(coded('ENOENT')) });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBeNull();
    expect(calls.removedTrees).toHaveLength(0);
  });

  test('transient cleanup failure still runs the recursive residue fallback', async () => {
    const { fs, calls } = stubFs({ removeDir: async () => Promise.reject(coded('EBUSY')) });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBeNull();
    expect(calls.removedTrees).toEqual(calls.created);
  });

  test('total cleanup failure never throws and never converts', async () => {
    const { fs } = stubFs({
      removeDir: async () => Promise.reject(coded('EBUSY')),
      removeTree: async () => Promise.reject(coded('EACCES')),
    });
    const result = await createGitInitProbe(fs).probeInitDenied('/repo');
    expect(result).toBeNull();
  });
});
