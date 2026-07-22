import { createWireContractRegistry } from '@skillsmith/core/contracts';
import type { WireCodec, WireContractMapping } from '@skillsmith/core/contracts';
import {
  agentsV1Codec,
  applyV1Codec,
  capabilitySnapshotV1Codec,
  commandsV1Codec,
  configGetV1Codec,
  configListV1Codec,
  configSetV1Codec,
  configUnsetV1Codec,
  errorV1Codec,
  exportV1Codec,
  healthV1Codec,
  initV1Codec,
  installV1Codec,
  planV1Codec,
  statusV1Codec,
  syncV1Codec,
  undoV1Codec,
  uninstallV1Codec,
  updateV1Codec,
  verifyV1Codec,
} from '@skillsmith/core/contracts/v1';
import {
  agentsV2Codec,
  commandsV2Codec,
  flipV2Codec,
  healthV2Codec,
  installV2Codec,
  listV2Codec,
  uninstallV2Codec,
} from '@skillsmith/core/contracts/v2';
import { flipV3Codec, listV3Codec } from '@skillsmith/core/contracts/v3';
import { flipV4Codec } from '@skillsmith/core/contracts/v4';
import { CURRENT_COMMAND_SPECS } from '../spec/registry.ts';

const mapping = (commandPath: string, contractId: string, version: number): WireContractMapping =>
  Object.freeze({ commandPath, contractId, version });

export const currentWireCommandMappings = Object.freeze([
  mapping('skillsmith agents', 'agents', 2),
  mapping('skillsmith apply', 'apply-report', 1),
  mapping('skillsmith check', 'health', 1),
  mapping('skillsmith commands', 'commands', 2),
  mapping('skillsmith config get', 'config-get', 1),
  mapping('skillsmith config list', 'config-list', 1),
  mapping('skillsmith config set', 'config-set', 1),
  mapping('skillsmith config unset', 'config-unset', 1),
  mapping('skillsmith dev', 'flip', 4),
  mapping('skillsmith doctor', 'health', 2),
  mapping('skillsmith export', 'export', 1),
  mapping('skillsmith init', 'init', 1),
  mapping('skillsmith install', 'install', 2),
  mapping('skillsmith list', 'list', 3),
  mapping('skillsmith plan', 'plan-report', 1),
  mapping('skillsmith promote', 'flip', 4),
  mapping('skillsmith status', 'status', 1),
  mapping('skillsmith sync', 'sync', 1),
  mapping('skillsmith uninstall', 'uninstall', 2),
  mapping('skillsmith update', 'update', 1),
  mapping('skillsmith undo', 'undo', 1),
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
    agentsV2Codec,
    applyV1Codec,
    healthV1Codec,
    healthV2Codec,
    commandsV1Codec,
    commandsV2Codec,
    configGetV1Codec,
    configListV1Codec,
    configSetV1Codec,
    configUnsetV1Codec,
    flipV2Codec,
    flipV3Codec,
    flipV4Codec,
    installV1Codec,
    initV1Codec,
    installV2Codec,
    listV2Codec,
    listV3Codec,
    planV1Codec,
    statusV1Codec,
    syncV1Codec,
    updateV1Codec,
    uninstallV1Codec,
    uninstallV2Codec,
    undoV1Codec,
    verifyV1Codec,
    errorV1Codec,
    exportV1Codec,
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
  agents: boundCodec('skillsmith agents', agentsV2Codec),
  apply: boundCodec('skillsmith apply', applyV1Codec),
  check: boundCodec('skillsmith check', healthV1Codec),
  commands: boundCodec('skillsmith commands', commandsV2Codec),
  configGet: boundCodec('skillsmith config get', configGetV1Codec),
  configList: boundCodec('skillsmith config list', configListV1Codec),
  configSet: boundCodec('skillsmith config set', configSetV1Codec),
  configUnset: boundCodec('skillsmith config unset', configUnsetV1Codec),
  dev: boundCodec('skillsmith dev', flipV4Codec),
  doctor: boundCodec('skillsmith doctor', healthV2Codec),
  export: boundCodec('skillsmith export', exportV1Codec),
  install: boundCodec('skillsmith install', installV2Codec),
  init: boundCodec('skillsmith init', initV1Codec),
  list: boundCodec('skillsmith list', listV3Codec),
  plan: boundCodec('skillsmith plan', planV1Codec),
  promote: boundCodec('skillsmith promote', flipV4Codec),
  status: boundCodec('skillsmith status', statusV1Codec),
  sync: boundCodec('skillsmith sync', syncV1Codec),
  undo: boundCodec('skillsmith undo', undoV1Codec),
  update: boundCodec('skillsmith update', updateV1Codec),
  uninstall: boundCodec('skillsmith uninstall', uninstallV2Codec),
  verify: boundCodec('skillsmith verify', verifyV1Codec),
});
