// Exercise the production command graph and services with account coordination confined to
// the fixture. Production coordination intentionally ignores HOME/XDG; tests must not write it.
import { join } from 'node:path';
import { defaultRuntimePorts, resolveRuntimeConfiguration } from '@skillsmith/core';
import { createTestNodeArtifactCoordinatorPorts } from '../../../core/src/artifacts/node-coordinator.ts';
import { buildProgram } from '../../src/program.ts';

const program = buildProgram(undefined, {
  createContext: async (command, options) => ({
    observation: options.observation,
    ports: await defaultRuntimePorts(),
    artifactCoordinator: await createTestNodeArtifactCoordinatorPorts(
      join(process.cwd(), '.test-coordination'),
    ),
    configuration: resolveRuntimeConfiguration(process.env),
    interaction: {
      mode: 'noninteractive',
      choose: async () => ({ status: 'refused', reason: 'noninteractive' }),
      confirm: async () => ({ status: 'refused', reason: 'noninteractive' }),
    },
    invocationCwd: process.cwd(),
    globalOptions: command.optsWithGlobals(),
    ...(options.signal ? { signal: options.signal } : {}),
  }),
});
await program.parseAsync(process.argv);
