import type {
  WireCodec,
  WireCodecDescriptor,
  WireContractMapping,
  WireContractRegistry,
} from './types.ts';

const DESCRIPTOR_KEYS = [
  'id',
  'version',
  'wireKind',
  'embeddedVersion',
  'unknownFields',
  'formatting',
  'migrations',
  'compatibility',
] as const;
const FORMATTING_KEYS = ['indent', 'terminalLf'] as const;
const CODEC_KEYS = ['descriptor', 'validate', 'decode', 'encode'] as const;
const MAPPING_KEYS = ['commandPath', 'contractId', 'version'] as const;

const fail = (message: string): never => {
  throw new Error(`wire contract registry: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const isPositiveVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const requireNonemptyString: (value: unknown, label: string) => asserts value is string = (
  value,
  label,
) => {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) {
    fail(`${label} must be a normalized non-empty string`);
  }
};

const ownDescriptor = (value: unknown): WireCodecDescriptor => {
  if (!isRecord(value) || !hasExactKeys(value, DESCRIPTOR_KEYS)) {
    return fail('codec descriptor must contain exactly the supported descriptor keys');
  }
  const id = value.id;
  const version = value.version;
  const wireKind = value.wireKind;
  const embeddedVersion = value.embeddedVersion;
  const unknownFields = value.unknownFields;
  const formattingValue = value.formatting;
  const migrationsValue = value.migrations;
  const compatibility = value.compatibility;

  requireNonemptyString(id, 'codec id');
  if (!isPositiveVersion(version)) return fail('codec version must be a positive safe integer');
  if (wireKind !== null && (typeof wireKind !== 'string' || wireKind.trim() === '')) {
    fail('wireKind must be null or a non-empty string');
  }
  if (embeddedVersion !== null && embeddedVersion !== 'schemaVersion') {
    fail('embeddedVersion must be null or schemaVersion');
  }
  if (unknownFields !== 'reject-recursive') {
    fail('unknownFields must be reject-recursive');
  }
  if (!isRecord(formattingValue) || !hasExactKeys(formattingValue, FORMATTING_KEYS)) {
    return fail('formatting must contain exactly indent and terminalLf');
  }
  const indent = formattingValue.indent;
  const terminalLf = formattingValue.terminalLf;
  if (indent !== 0 && indent !== 2) {
    fail('formatting indent must be 0 or 2');
  }
  if (typeof terminalLf !== 'boolean') {
    fail('formatting terminalLf must be boolean');
  }
  if (!Array.isArray(migrationsValue)) fail('migrations must be an array');
  const migrations = Array.from(migrationsValue as unknown[]);
  if (
    migrations.some((migration) => !isPositiveVersion(migration) || migration >= version) ||
    new Set(migrations).size !== migrations.length
  ) {
    fail('migration versions must be unique positive safe integers older than the codec version');
  }
  if (compatibility !== 'conservative') {
    fail('compatibility must be conservative');
  }
  return Object.freeze({
    id,
    version,
    wireKind,
    embeddedVersion,
    unknownFields,
    formatting: Object.freeze({ indent, terminalLf }),
    migrations: Object.freeze(migrations as number[]),
    compatibility,
  }) as WireCodecDescriptor;
};

const ownCodec = (value: unknown): WireCodec => {
  if (!isRecord(value) || !hasExactKeys(value, CODEC_KEYS)) {
    return fail('codec must contain exactly descriptor, validate, decode, and encode');
  }
  const descriptorValue = value.descriptor;
  const validate = value.validate;
  const decode = value.decode;
  const encode = value.encode;
  const descriptor = ownDescriptor(descriptorValue);
  for (const [name, method] of [
    ['validate', validate],
    ['decode', decode],
    ['encode', encode],
  ] as const) {
    if (typeof method !== 'function') fail(`codec ${name} method must be a function`);
  }
  return Object.freeze({
    descriptor,
    validate: validate as WireCodec['validate'],
    decode: decode as WireCodec['decode'],
    encode: encode as WireCodec['encode'],
  });
};

const ownMapping = (value: unknown): WireContractMapping => {
  if (!isRecord(value) || !hasExactKeys(value, MAPPING_KEYS)) {
    return fail('command mapping must contain exactly the supported mapping keys');
  }
  const commandPath = value.commandPath;
  const contractId = value.contractId;
  const version = value.version;
  requireNonemptyString(commandPath, 'command path');
  requireNonemptyString(contractId, 'mapping contract id');
  if (!isPositiveVersion(version)) {
    return fail('mapping version must be a positive safe integer');
  }
  return Object.freeze({
    commandPath,
    contractId,
    version,
  });
};

const identity = (id: string, version: number): string => `${id}@${version}`;

export const createWireContractRegistry = (
  sourceCodecs: readonly WireCodec[],
  sourceMappings: readonly WireContractMapping[],
): WireContractRegistry => {
  if (!Array.isArray(sourceCodecs)) fail('codecs must be an array');
  if (!Array.isArray(sourceMappings)) fail('command mappings must be an array');

  const ownedCodecs: WireCodec[] = [];
  const codecCount = sourceCodecs.length;
  for (let index = 0; index < codecCount; index++) {
    ownedCodecs.push(ownCodec(sourceCodecs[index]));
  }
  const codecs = Object.freeze(ownedCodecs);
  const byIdentity = new Map<string, WireCodec>();
  for (const codec of codecs) {
    const key = identity(codec.descriptor.id, codec.descriptor.version);
    if (byIdentity.has(key)) fail(`duplicate codec identity ${key}`);
    byIdentity.set(key, codec);
  }

  const ownedMappings: WireContractMapping[] = [];
  const mappingCount = sourceMappings.length;
  for (let index = 0; index < mappingCount; index++) {
    ownedMappings.push(ownMapping(sourceMappings[index]));
  }
  const commandMappings = Object.freeze(ownedMappings);
  const byCommand = new Map<string, WireCodec>();
  for (const mapping of commandMappings) {
    if (byCommand.has(mapping.commandPath)) {
      fail(`duplicate command mapping ${mapping.commandPath}`);
    }
    const codec = byIdentity.get(identity(mapping.contractId, mapping.version));
    if (codec === undefined) {
      return fail(`unknown mapped contract ${mapping.contractId}@${mapping.version}`);
    }
    byCommand.set(mapping.commandPath, codec);
  }

  const registry: WireContractRegistry = {
    codecs,
    commandMappings,
    get(id: string, version: number) {
      return byIdentity.get(identity(id, version));
    },
    latest(id: string) {
      let selected: WireCodec | undefined;
      for (const codec of codecs) {
        if (
          codec.descriptor.id === id &&
          (selected === undefined || codec.descriptor.version > selected.descriptor.version)
        ) {
          selected = codec;
        }
      }
      return selected;
    },
    forCommand(commandPath: string) {
      return byCommand.get(commandPath);
    },
  };
  return Object.freeze(registry);
};
