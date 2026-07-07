import type { ScanEnv } from '../../src/env/types.ts';

/** Thrown at the START of the Nth mutating call by {@link crashingEnv} — simulates a process that
 *  dies before that filesystem action runs. */
export class SimulatedCrash extends Error {
  constructor(
    readonly call: number,
    readonly op: string,
  ) {
    super(`simulated crash at mutating call #${call} (${op})`);
    this.name = 'SimulatedCrash';
  }
}

/** Wraps a real ScanEnv; throws SimulatedCrash at the START of the `crashAtCall`th mutating call.
 *  Mutating primitives (counted, in call order): makeSymlink, rename, copyTree, removeTree, makeDir,
 *  writeTextFile. Read-only + fsync primitives pass through uncounted. `crashAtCall <= 0` disables
 *  crashing (used to count `totalMutations` of a clean run). */
export const crashingEnv = (
  inner: ScanEnv,
  crashAtCall: number,
): { env: ScanEnv; calls: () => number } => {
  let n = 0;
  const gate = (op: string): void => {
    n += 1;
    if (n === crashAtCall) throw new SimulatedCrash(n, op);
  };
  const env: ScanEnv = {
    ...inner,
    makeSymlink: async (target, linkPath) => {
      gate('makeSymlink');
      return inner.makeSymlink(target, linkPath);
    },
    rename: async (from, to) => {
      gate('rename');
      return inner.rename(from, to);
    },
    copyTree: async (from, to) => {
      gate('copyTree');
      return inner.copyTree(from, to);
    },
    removeTree: async (p) => {
      gate('removeTree');
      return inner.removeTree(p);
    },
    makeDir: async (p) => {
      gate('makeDir');
      return inner.makeDir(p);
    },
    writeTextFile: async (p, text) => {
      gate('writeTextFile');
      return inner.writeTextFile(p, text);
    },
  };
  return { env, calls: () => n };
};
