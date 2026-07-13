import { createToolRegistry } from '../../../src/agents/registry.ts';
import type { VerifyPorts } from '../../../src/verify/types.ts';
import { runVerify } from '../../../src/verify/run.ts';
import { readOnlyFixtureAdapter } from '../../../../../tests/ergonomics/fixtures/p1-ts09/read-only-adapter.ts';
import { writeFixtureAdapter } from '../../../../../tests/ergonomics/fixtures/p1-ts09/write-adapter.ts';

/** Compile-only public contract exercised by the repository typecheck. */
export const customRegistryTypeContract = (env: VerifyPorts): void => {
  const registry = createToolRegistry([readOnlyFixtureAdapter, writeFixtureAdapter]);

  // @ts-expect-error custom verifier IDs require the matching registry argument
  void runVerify<'fixture-write'>(env, { path: '/fixture', tools: ['fixture-write'] });

  const automatic = runVerify(env, { path: '/fixture' }, registry);
  void automatic.then((result) => {
    if (!result.ok) return;
    const writeVersion: string = result.value.verifiedAgainst['fixture-write'];
    // @ts-expect-error read-only registry IDs are absent from verification reports
    const readVersion: string = result.value.verifiedAgainst['fixture-read'];
    void writeVersion;
    void readVersion;
  });
};
