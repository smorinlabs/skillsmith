import { types as utilTypes } from 'node:util';
import {
  WIRE_CODEC_IDENTITY,
  type WireCodecIdentity,
  identityForDescriptor,
  identityMatchesDescriptor,
  isFactoryCodecMethod,
  markFactoryCodecMethod,
} from './internal.ts';
import type {
  WireCodec,
  WireCodecDescriptor,
  WireCodecError,
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
  if (!isRecord(value) || utilTypes.isProxy(value) || !hasExactKeys(value, DESCRIPTOR_KEYS)) {
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
  if (
    !isRecord(formattingValue) ||
    utilTypes.isProxy(formattingValue) ||
    !hasExactKeys(formattingValue, FORMATTING_KEYS)
  ) {
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
  if (!Array.isArray(migrationsValue) || utilTypes.isProxy(migrationsValue)) {
    fail('migrations must be an array');
  }
  const migrationArray = migrationsValue as unknown[];
  const migrations: unknown[] = [];
  const migrationCount = migrationArray.length;
  for (let index = 0; index < migrationCount; index++) {
    migrations.push(migrationArray[index]);
  }
  if (
    migrations.some((migration) => !isPositiveVersion(migration) || migration >= version) ||
    new Set(migrations).size !== migrations.length
  ) {
    fail('migration versions must be unique positive safe integers older than the codec version');
  }
  if (embeddedVersion === null && migrations.length > 0) {
    fail('migrations require an embedded schemaVersion');
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

const identityOf = (value: unknown): WireCodecIdentity | undefined => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function')
    return undefined;
  return (value as { readonly [WIRE_CODEC_IDENTITY]?: WireCodecIdentity })[WIRE_CODEC_IDENTITY];
};

const requireFailureIdentity = (
  result: unknown,
  descriptor: WireCodecDescriptor,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(result) || result.ok !== false || !isRecord(result.error)) {
    return fail(`${label} must return a wire failure for an invalid JSON value`);
  }
  if (
    result.error.contractId !== descriptor.id ||
    result.error.requestedVersion !== descriptor.version
  ) {
    return fail(`${label} error identity drifts from its descriptor`);
  }
  return result.error;
};

const probeStructuralCodec = (
  owner: Record<string, unknown>,
  descriptor: WireCodecDescriptor,
  validate: WireCodec['validate'],
  decode: WireCodec['decode'],
): void => {
  let invalidResult: unknown;
  try {
    invalidResult = validate.call(owner, Symbol('wire-contract-registry-probe'));
  } catch {
    fail('codec validate method threw during descriptor identity validation');
  }
  requireFailureIdentity(invalidResult, descriptor, 'codec validate');

  if (descriptor.embeddedVersion === null) {
    let objectResult: unknown;
    try {
      objectResult = validate.call(owner, {});
    } catch {
      fail('codec validate method threw during embedded-version validation');
    }
    if (isRecord(objectResult) && objectResult.ok === false && isRecord(objectResult.error)) {
      const path = objectResult.error.path;
      if (Array.isArray(path) && path[0] === 'schemaVersion') {
        fail('codec behavior requires an undeclared embedded schemaVersion');
      }
    }
    return;
  }

  const currentProbe: Record<string, unknown> = {
    [descriptor.embeddedVersion]: descriptor.version,
  };
  if (descriptor.wireKind !== null) currentProbe.kind = descriptor.wireKind;
  let currentResult: unknown;
  try {
    currentResult = validate.call(owner, currentProbe);
  } catch {
    fail('codec validate method threw during current-version validation');
  }
  if (isRecord(currentResult) && currentResult.ok === false && isRecord(currentResult.error)) {
    requireFailureIdentity(currentResult, descriptor, 'codec validate');
    if (currentResult.error.code === 'unsupported-version') {
      fail('codec behavior rejects its declared current version');
    }
    const path = currentResult.error.path;
    if (
      Array.isArray(path) &&
      (path[0] === descriptor.embeddedVersion ||
        (descriptor.wireKind !== null && path[0] === 'kind'))
    ) {
      fail('codec embedded kind or version behavior drifts from its descriptor');
    }
  }

  const otherVersion = descriptor.version === 1 ? 2 : 1;
  let otherResult: unknown;
  try {
    otherResult = validate.call(owner, {
      [descriptor.embeddedVersion]: otherVersion,
      ...(descriptor.wireKind === null ? {} : { kind: descriptor.wireKind }),
    });
  } catch {
    fail('codec validate method threw during unsupported-version validation');
  }
  if (!isRecord(otherResult) || otherResult.ok !== false || !isRecord(otherResult.error)) {
    fail('codec behavior accepts an undeclared wire version');
  }
  const otherError = (otherResult as { error: Record<string, unknown> }).error;
  if (
    otherError.code !== 'unsupported-version' ||
    otherError.contractId !== descriptor.id ||
    otherError.requestedVersion !== otherVersion
  ) {
    fail('codec unsupported-version behavior drifts from its descriptor');
  }

  for (const sourceVersion of descriptor.migrations) {
    let migrationResult: unknown;
    try {
      migrationResult = decode.call(
        owner,
        JSON.stringify({
          [descriptor.embeddedVersion]: sourceVersion,
          ...(descriptor.wireKind === null ? {} : { kind: descriptor.wireKind }),
        }),
      );
    } catch {
      fail('codec decode method threw during migration validation');
    }
    if (isRecord(migrationResult) && migrationResult.ok === true) continue;
    if (
      !isRecord(migrationResult) ||
      migrationResult.ok !== false ||
      !isRecord(migrationResult.error) ||
      migrationResult.error.code !== 'migration-failed' ||
      migrationResult.error.contractId !== descriptor.id ||
      migrationResult.error.requestedVersion !== sourceVersion
    ) {
      fail('codec does not implement a declared source-version migration');
    }
  }
};

const behaviorFailure = (
  descriptor: WireCodecDescriptor,
  message: string,
): { readonly ok: false; readonly error: WireCodecError } => ({
  ok: false,
  error: Object.freeze({
    code: 'migration-failed',
    contractId: descriptor.id,
    requestedVersion: descriptor.version,
    path: Object.freeze([]),
    message,
  }),
});

const policyFailure = (
  descriptor: WireCodecDescriptor,
  code: WireCodecError['code'],
  requestedVersion: number,
  path: readonly (string | number)[],
): { readonly ok: false; readonly error: WireCodecError } => ({
  ok: false,
  error: Object.freeze({
    code,
    contractId: descriptor.id,
    requestedVersion,
    path: Object.freeze([...path]),
    message: `invalid ${descriptor.id} wire value`,
  }),
});

const structuralPolicyFailure = (
  descriptor: WireCodecDescriptor,
  input: unknown,
): { readonly ok: false; readonly error: WireCodecError } | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  if (utilTypes.isProxy(input)) {
    return policyFailure(descriptor, 'invalid-shape', descriptor.version, []);
  }
  if (descriptor.embeddedVersion === null) {
    if (Object.hasOwn(input, 'schemaVersion')) {
      return policyFailure(descriptor, 'invalid-shape', descriptor.version, ['schemaVersion']);
    }
  } else {
    const property = Object.getOwnPropertyDescriptor(input, descriptor.embeddedVersion);
    if (property !== undefined && ('get' in property || 'set' in property)) {
      return policyFailure(descriptor, 'invalid-shape', descriptor.version, [
        descriptor.embeddedVersion,
      ]);
    }
    const candidate = property?.value;
    if (
      typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate !== descriptor.version
    ) {
      return policyFailure(descriptor, 'unsupported-version', candidate, [
        descriptor.embeddedVersion,
      ]);
    }
  }
  if (descriptor.wireKind === null) {
    if (Object.hasOwn(input, 'kind')) {
      return policyFailure(descriptor, 'invalid-shape', descriptor.version, ['kind']);
    }
  } else {
    const property = Object.getOwnPropertyDescriptor(input, 'kind');
    if (
      property !== undefined &&
      ('get' in property || 'set' in property || property.value !== descriptor.wireKind)
    ) {
      return policyFailure(descriptor, 'invalid-shape', descriptor.version, ['kind']);
    }
  }
  return undefined;
};

const ownCodec = (value: unknown): WireCodec => {
  if (!isRecord(value) || utilTypes.isProxy(value) || !hasExactKeys(value, CODEC_KEYS)) {
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
    if (typeof method !== 'function' || utilTypes.isProxy(method)) {
      fail(`codec ${name} method must be a non-proxy function`);
    }
  }
  const codecAttestation = identityOf(value);
  const methodAttestations = [identityOf(validate), identityOf(decode), identityOf(encode)];
  const attestations = [codecAttestation, ...methodAttestations].filter(
    (identity): identity is WireCodecIdentity => identity !== undefined,
  );
  if (attestations.some((identity) => !identityMatchesDescriptor(identity, descriptor))) {
    fail('codec method identity drifts from its descriptor');
  }
  if (attestations.length > 0 && methodAttestations.some((identity) => identity === undefined)) {
    fail('codec methods must carry a complete descriptor identity attestation');
  }
  const factoryAttested = [validate, decode, encode].every(
    (method) =>
      typeof method === 'function' && isFactoryCodecMethod(method as (...args: never[]) => unknown),
  );
  const methodIdentity = methodAttestations[0];
  if (
    factoryAttested &&
    (methodIdentity === undefined ||
      methodAttestations.some((identity) => identity !== methodIdentity) ||
      (codecAttestation !== undefined && codecAttestation !== methodIdentity))
  ) {
    fail('codec factory methods must share one private codec identity');
  }
  if (!factoryAttested && descriptor.migrations.length > 0) {
    fail('structural codecs cannot declare unverifiable migrations');
  }
  let owned: WireCodec;
  if (factoryAttested) {
    owned = {
      descriptor,
      validate: validate as WireCodec['validate'],
      decode: decode as WireCodec['decode'],
      encode: encode as WireCodec['encode'],
    };
  } else {
    owned = {
      descriptor,
      validate(input: unknown) {
        const policyError = structuralPolicyFailure(descriptor, input);
        if (policyError !== undefined) return policyError;
        return (validate as WireCodec['validate']).call(owned, input);
      },
      decode(text: string) {
        const decoded = (decode as WireCodec['decode']).call(owned, text);
        if (!decoded.ok) return decoded;
        return owned.validate(decoded.value);
      },
      encode(dto: unknown) {
        const validated = owned.validate(dto);
        if (!validated.ok) return validated;
        let canonical: string | undefined;
        try {
          const json = JSON.stringify(
            validated.value,
            null,
            descriptor.formatting.indent === 0 ? undefined : descriptor.formatting.indent,
          );
          canonical = descriptor.formatting.terminalLf ? `${json}\n` : json;
        } catch {
          return behaviorFailure(descriptor, `could not encode ${descriptor.id} wire value`);
        }
        const encoded = (encode as WireCodec['encode']).call(owned, validated.value);
        if (!encoded.ok) return encoded;
        if (encoded.value !== canonical) {
          return behaviorFailure(descriptor, `${descriptor.id} encode behavior drifted`);
        }
        return encoded;
      },
    };
  }
  probeStructuralCodec(
    owned as unknown as Record<string, unknown>,
    descriptor,
    owned.validate,
    owned.decode,
  );
  if (factoryAttested) {
    for (const method of [owned.validate, owned.decode, owned.encode]) {
      markFactoryCodecMethod(method);
    }
  }
  Object.defineProperty(owned, WIRE_CODEC_IDENTITY, {
    value: factoryAttested ? methodIdentity : identityForDescriptor(descriptor),
  });
  return Object.freeze(owned);
};

const ownMapping = (value: unknown): WireContractMapping => {
  if (!isRecord(value) || utilTypes.isProxy(value) || !hasExactKeys(value, MAPPING_KEYS)) {
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
