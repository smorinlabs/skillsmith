import { createWireContractRegistry } from '@skillsmith/core/contracts';
import type { WireCodec, WireContractMapping } from '@skillsmith/core/contracts';
import {
  agentsV1Codec,
  capabilitySnapshotV1Codec,
  commandsV1Codec,
  configGetV1Codec,
  configListV1Codec,
  configSetV1Codec,
  configUnsetV1Codec,
  errorV1Codec,
  healthV1Codec,
  installV1Codec,
  uninstallV1Codec,
  verifyV1Codec,
} from '@skillsmith/core/contracts/v1';
import { flipV2Codec, listV2Codec } from '@skillsmith/core/contracts/v2';
import { CURRENT_COMMAND_SPECS } from '../spec/registry.ts';

const mapping = (commandPath: string, contractId: string, version: number): WireContractMapping =>
  Object.freeze({ commandPath, contractId, version });

export const currentWireCommandMappings = Object.freeze([
  mapping('skillsmith agents', 'agents', 1),
  mapping('skillsmith check', 'health', 1),
  mapping('skillsmith commands', 'commands', 1),
  mapping('skillsmith config get', 'config-get', 1),
  mapping('skillsmith config list', 'config-list', 1),
  mapping('skillsmith config set', 'config-set', 1),
  mapping('skillsmith config unset', 'config-unset', 1),
  mapping('skillsmith dev', 'flip', 2),
  mapping('skillsmith doctor', 'health', 1),
  mapping('skillsmith install', 'install', 1),
  mapping('skillsmith list', 'list', 2),
  mapping('skillsmith promote', 'flip', 2),
  mapping('skillsmith uninstall', 'uninstall', 1),
  mapping('skillsmith verify', 'verify', 1),
]);

const jsonCommandPaths = (): readonly string[] =>
  CURRENT_COMMAND_SPECS.filter((spec) =>
    spec.options.some(
      (option) =>
        option.long === '--json' ||
        (option.long === '--format' && option.allowedValues.includes('json')),
    ),
  ).map((spec) => spec.path);

export const assertCurrentWireContractClosure = (
  mappings: readonly WireContractMapping[],
): void => {
  const expected = jsonCommandPaths();
  const actual = mappings.map((row) => row.commandPath);
  if (
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((path, index) => actual[index] !== path)
  ) {
    throw new Error('current wire-contract mappings do not close the JSON-capable command catalog');
  }
};

assertCurrentWireContractClosure(currentWireCommandMappings);

export const currentWireContractRegistry = createWireContractRegistry(
  [
    agentsV1Codec,
    healthV1Codec,
    commandsV1Codec,
    configGetV1Codec,
    configListV1Codec,
    configSetV1Codec,
    configUnsetV1Codec,
    flipV2Codec,
    installV1Codec,
    listV2Codec,
    uninstallV1Codec,
    verifyV1Codec,
    errorV1Codec,
    capabilitySnapshotV1Codec,
  ],
  currentWireCommandMappings,
);

const boundCodec = <Id extends string, Version extends number, Dto>(
  commandPath: string,
  expected: WireCodec<Id, Version, Dto>,
): WireCodec<Id, Version, Dto> => {
  const selected = currentWireContractRegistry.forCommand(commandPath);
  if (
    selected === undefined ||
    selected.descriptor.id !== expected.descriptor.id ||
    selected.descriptor.version !== expected.descriptor.version
  ) {
    throw new Error(`current renderer binding drift for ${commandPath}`);
  }
  // The heterogeneous registry intentionally erases DTO types. Identity/version validation above
  // restores the named codec type used by its explicit mapper at the renderer boundary.
  return selected as WireCodec<Id, Version, Dto>;
};

/** Typed runtime bindings: every current JSON renderer resolves through the authoritative map. */
export const currentWireCodecs = Object.freeze({
  agents: boundCodec('skillsmith agents', agentsV1Codec),
  check: boundCodec('skillsmith check', healthV1Codec),
  commands: boundCodec('skillsmith commands', commandsV1Codec),
  configGet: boundCodec('skillsmith config get', configGetV1Codec),
  configList: boundCodec('skillsmith config list', configListV1Codec),
  configSet: boundCodec('skillsmith config set', configSetV1Codec),
  configUnset: boundCodec('skillsmith config unset', configUnsetV1Codec),
  dev: boundCodec('skillsmith dev', flipV2Codec),
  doctor: boundCodec('skillsmith doctor', healthV1Codec),
  install: boundCodec('skillsmith install', installV1Codec),
  list: boundCodec('skillsmith list', listV2Codec),
  promote: boundCodec('skillsmith promote', flipV2Codec),
  uninstall: boundCodec('skillsmith uninstall', uninstallV1Codec),
  verify: boundCodec('skillsmith verify', verifyV1Codec),
});
