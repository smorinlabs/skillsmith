import { types as utilTypes } from 'node:util';
import { z } from 'zod';
import { WIRE_CODEC_IDENTITY, identityForDescriptor, markFactoryCodecMethod } from './internal.ts';
import type {
  WireCodec,
  WireCodecDescriptor,
  WireCodecError,
  WireCodecErrorCode,
} from './types.ts';

export type JsonWireMigration = (input: unknown) => unknown;
export type JsonWireMigrations = Readonly<Record<number, JsonWireMigration>>;

const freezeError = (
  descriptor: WireCodecDescriptor,
  code: WireCodecErrorCode,
  requestedVersion: number,
  path: readonly (string | number)[],
  message: string,
): WireCodecError =>
  Object.freeze({
    code,
    contractId: descriptor.id,
    requestedVersion,
    path: Object.freeze([...path]),
    message,
  });

const issuePath = (issue: z.ZodIssue): readonly (string | number)[] => {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return [...issue.path, ...(issue.keys[0] === undefined ? [] : [issue.keys[0]])];
  }
  if (issue.code === z.ZodIssueCode.invalid_union) {
    const nested = issue.unionErrors.flatMap((error) => error.issues);
    const mostSpecific = nested.find(
      (candidate) => candidate.code === z.ZodIssueCode.unrecognized_keys,
    );
    return mostSpecific === undefined ? issue.path : issuePath(mostSpecific);
  }
  return issue.path;
};

interface PrototypeSnapshot {
  readonly extensible: boolean;
  readonly properties: readonly (readonly [PropertyKey, PropertyDescriptor])[];
  readonly prototype: object | null;
}

const snapshotPrototype = (prototype: object): PrototypeSnapshot => ({
  extensible: Object.isExtensible(prototype),
  properties: Reflect.ownKeys(prototype).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(prototype, key) as PropertyDescriptor,
  ]),
  prototype: Object.getPrototypeOf(prototype),
});

const OBJECT_PROTOTYPE_SNAPSHOT = snapshotPrototype(Object.prototype);
const ARRAY_PROTOTYPE_SNAPSHOT = snapshotPrototype(Array.prototype);

const prototypeMatchesSnapshot = (prototype: object, snapshot: PrototypeSnapshot): boolean => {
  const keys = Reflect.ownKeys(prototype);
  if (
    keys.length !== snapshot.properties.length ||
    Object.getPrototypeOf(prototype) !== snapshot.prototype ||
    Object.isExtensible(prototype) !== snapshot.extensible
  ) {
    return false;
  }
  return snapshot.properties.every(([key, expected], index) => {
    if (keys[index] !== key) return false;
    const actual = Object.getOwnPropertyDescriptor(prototype, key);
    return (
      actual !== undefined &&
      actual.configurable === expected.configurable &&
      actual.enumerable === expected.enumerable &&
      actual.writable === expected.writable &&
      Object.is(actual.value, expected.value) &&
      actual.get === expected.get &&
      actual.set === expected.set
    );
  });
};

const unsafeInputPath = (input: unknown): readonly (string | number)[] | undefined => {
  if (
    !prototypeMatchesSnapshot(Object.prototype, OBJECT_PROTOTYPE_SNAPSHOT) ||
    !prototypeMatchesSnapshot(Array.prototype, ARRAY_PROTOTYPE_SNAPSHOT)
  ) {
    return [];
  }
  const seen = new WeakSet<object>();
  const visit = (
    value: unknown,
    path: readonly (string | number)[],
  ): readonly (string | number)[] | undefined => {
    if (
      typeof value === 'bigint' ||
      typeof value === 'function' ||
      typeof value === 'symbol' ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      return path;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    if (utilTypes.isProxy(value)) return path;
    if (seen.has(value)) return undefined;
    seen.add(value);

    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      return path;
    }

    const keys = Reflect.ownKeys(value);
    if (array) {
      const lengthProperty = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthProperty?.value;
      let expectedIndex = 0;
      for (const key of keys) {
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) continue;
        const index = Number(key);
        if (index >= 2 ** 32 - 1) continue;
        if (index !== expectedIndex) return [...path, expectedIndex];
        expectedIndex++;
      }
      if (typeof length !== 'number' || expectedIndex !== length) {
        return [...path, expectedIndex];
      }
    }

    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined) continue;
      const segment =
        array && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : String(key);
      const propertyPath = [...path, segment];
      if (typeof key === 'symbol') return propertyPath;
      if ('get' in property || 'set' in property) return propertyPath;
      if (!property.enumerable) {
        if (array && key === 'length') continue;
        return propertyPath;
      }
      const nested = visit(property.value, propertyPath);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };

  return visit(input, []);
};

const createInputFingerprint = (): ((input: unknown) => string | undefined) => {
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;

  return (input: unknown): string | undefined => {
    const active = new WeakSet<object>();
    const references = new WeakMap<object, number>();
    let nextReference = 0;
    const visit = (value: unknown): unknown => {
      if (value === null) return ['null'];
      if (typeof value === 'number') {
        return ['number', Object.is(value, -0) ? '-0' : String(value)];
      }
      if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'undefined') {
        return [typeof value, value];
      }
      if (typeof value !== 'object') throw new Error('non-JSON wire value');
      if (active.has(value)) throw new Error('cyclic wire value');
      const priorReference = references.get(value);
      if (priorReference !== undefined) return ['reference', priorReference];
      const reference = nextReference++;
      references.set(value, reference);
      let identity = identities.get(value);
      if (identity === undefined) {
        identity = nextIdentity++;
        identities.set(value, identity);
      }
      active.add(value);
      try {
        const entries: unknown[] = [];
        for (const key of Reflect.ownKeys(value)) {
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (property === undefined || typeof key === 'symbol') continue;
          if (!property.enumerable && !(Array.isArray(value) && key === 'length')) continue;
          entries.push([
            key,
            property.enumerable,
            property.configurable,
            property.writable,
            visit(property.value),
          ]);
        }
        const prototype = Object.getPrototypeOf(value);
        const container = Array.isArray(value)
          ? 'array'
          : prototype === null
            ? 'null-object'
            : 'object';
        return [container, identity, reference, Object.isExtensible(value), entries];
      } finally {
        active.delete(value);
      }
    };

    try {
      return JSON.stringify(visit(input));
    } catch {
      return undefined;
    }
  };
};

const ownDescriptor = <Id extends string, Version extends number>(
  descriptor: WireCodecDescriptor<Id, Version>,
): WireCodecDescriptor<Id, Version> => {
  const id = descriptor.id;
  const version = descriptor.version;
  const wireKind = descriptor.wireKind;
  const embeddedVersion = descriptor.embeddedVersion;
  const unknownFields = descriptor.unknownFields;
  const formatting = descriptor.formatting;
  const indent = formatting.indent;
  const terminalLf = formatting.terminalLf;
  const migrationSource = descriptor.migrations;
  const compatibility = descriptor.compatibility;

  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error('wire codec version must be a positive safe integer');
  }
  if (!Array.isArray(migrationSource)) {
    throw new Error('wire codec migrations must be an array');
  }
  const migrations: number[] = [];
  const migrationCount = migrationSource.length;
  for (let index = 0; index < migrationCount; index++) {
    migrations.push(migrationSource[index] as number);
  }
  if (
    migrations.some(
      (migration) => !Number.isSafeInteger(migration) || migration <= 0 || migration >= version,
    ) ||
    new Set(migrations).size !== migrations.length
  ) {
    throw new Error(
      'wire codec migration versions must be unique positive safe integers older than the current version',
    );
  }
  if (migrations.length > 0 && embeddedVersion === null) {
    throw new Error('wire codec migrations require an embedded schemaVersion');
  }
  return Object.freeze({
    id,
    version,
    wireKind,
    embeddedVersion,
    unknownFields,
    formatting: Object.freeze({
      indent,
      terminalLf,
    }),
    migrations: Object.freeze(migrations),
    compatibility,
  });
};

const ownMigrationHandlers = (
  descriptor: WireCodecDescriptor,
  source: JsonWireMigrations,
): ReadonlyMap<number, JsonWireMigration> => {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('wire codec migrations must be an object');
  }
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('wire codec migrations must be an ordinary object');
  }
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== 'string' || !/^[1-9]\d*$/.test(key))) {
    throw new Error('wire codec migration keys must be positive integer versions');
  }
  const handlers = new Map<number, JsonWireMigration>();
  for (const key of keys as string[]) {
    const version = Number(key);
    const handler = source[version];
    if (!Number.isSafeInteger(version) || typeof handler !== 'function') {
      throw new Error('wire codec migration handlers must be functions at safe-integer versions');
    }
    handlers.set(version, handler);
  }
  if (
    handlers.size !== descriptor.migrations.length ||
    descriptor.migrations.some((version) => !handlers.has(version))
  ) {
    throw new Error('wire codec migration handlers must exactly match declared migrations');
  }
  if (handlers.size > 0 && descriptor.embeddedVersion === null) {
    throw new Error('wire codec migrations require an embedded schemaVersion');
  }
  return handlers;
};

const objectBranches = (schema: z.ZodTypeAny): readonly z.AnyZodObject[] | undefined => {
  if (schema instanceof z.ZodObject) return [schema];
  if (schema instanceof z.ZodUnion) {
    const options = schema.options as readonly z.ZodTypeAny[];
    const branchSets = options.map((option) => objectBranches(option));
    if (branchSets.some((branches) => branches === undefined)) return undefined;
    return branchSets.flatMap((branches) => branches ?? []);
  }
  if (schema instanceof z.ZodEffects) return objectBranches(schema.innerType());
  return undefined;
};

const assertRecursiveUnknownFieldRejection = (
  schema: z.ZodTypeAny,
  seen = new Set<z.ZodTypeAny>(),
): void => {
  if (seen.has(schema)) return;
  seen.add(schema);
  if (schema instanceof z.ZodObject) {
    if (schema._def.unknownKeys !== 'strict' || !(schema._def.catchall instanceof z.ZodNever)) {
      throw new Error('wire codec schema objects must recursively reject unknown fields');
    }
    for (const nested of Object.values(schema.shape) as z.ZodTypeAny[]) {
      assertRecursiveUnknownFieldRejection(nested, seen);
    }
    return;
  }
  if (schema instanceof z.ZodArray) {
    assertRecursiveUnknownFieldRejection(schema.element, seen);
    return;
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) assertRecursiveUnknownFieldRejection(option, seen);
    return;
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    for (const option of schema.options.values())
      assertRecursiveUnknownFieldRejection(option, seen);
    return;
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    assertRecursiveUnknownFieldRejection(schema.unwrap(), seen);
    return;
  }
  if (schema instanceof z.ZodDefault) {
    assertRecursiveUnknownFieldRejection(schema.removeDefault(), seen);
    return;
  }
  if (schema instanceof z.ZodCatch) {
    assertRecursiveUnknownFieldRejection(schema.removeCatch(), seen);
    return;
  }
  if (schema instanceof z.ZodBranded || schema instanceof z.ZodReadonly) {
    assertRecursiveUnknownFieldRejection(schema.unwrap(), seen);
    return;
  }
  if (schema instanceof z.ZodEffects) {
    assertRecursiveUnknownFieldRejection(schema.innerType(), seen);
    return;
  }
  if (schema instanceof z.ZodRecord) {
    assertRecursiveUnknownFieldRejection(schema.valueSchema, seen);
    return;
  }
  if (schema instanceof z.ZodTuple) {
    for (const item of schema.items) assertRecursiveUnknownFieldRejection(item, seen);
    if (schema._def.rest !== null) assertRecursiveUnknownFieldRejection(schema._def.rest, seen);
    return;
  }
  if (schema instanceof z.ZodIntersection) {
    assertRecursiveUnknownFieldRejection(schema._def.left, seen);
    assertRecursiveUnknownFieldRejection(schema._def.right, seen);
    return;
  }
  if (schema instanceof z.ZodLazy) {
    assertRecursiveUnknownFieldRejection(schema.schema, seen);
    return;
  }
  if (schema instanceof z.ZodPipeline) {
    assertRecursiveUnknownFieldRejection(schema._def.in, seen);
    assertRecursiveUnknownFieldRejection(schema._def.out, seen);
  }
};

const assertSchemaDescriptor = (descriptor: WireCodecDescriptor, schema: z.ZodTypeAny): void => {
  const branches = objectBranches(schema);
  if (branches === undefined || branches.length === 0) {
    throw new Error('wire codec schema must expose object-shaped wire branches');
  }
  for (const branch of branches) {
    const shape = branch.shape;
    for (const [key, expected] of [
      [descriptor.embeddedVersion, descriptor.version],
      [descriptor.wireKind === null ? null : 'kind', descriptor.wireKind],
    ] as const) {
      if (key === null) continue;
      const field = shape[key];
      if (!(field instanceof z.ZodLiteral) || field.value !== expected) {
        throw new Error(`wire codec descriptor ${key} drifts from its schema`);
      }
    }
    if (descriptor.embeddedVersion === null && Object.hasOwn(shape, 'schemaVersion')) {
      throw new Error('wire codec descriptor omits a schemaVersion present in its schema');
    }
    if (descriptor.wireKind === null && Object.hasOwn(shape, 'kind')) {
      throw new Error('wire codec descriptor omits a wire kind present in its schema');
    }
  }
  assertRecursiveUnknownFieldRejection(schema);
};

export const createJsonWireCodec = <
  const Id extends string,
  const Version extends number,
  Schema extends z.ZodTypeAny,
>(
  sourceDescriptor: WireCodecDescriptor<Id, Version>,
  schema: Schema,
  sourceMigrations: JsonWireMigrations = {},
): WireCodec<Id, Version, z.infer<Schema>> => {
  const descriptor = ownDescriptor(sourceDescriptor);
  const migrations = ownMigrationHandlers(descriptor, sourceMigrations);
  assertSchemaDescriptor(descriptor, schema);
  const inputFingerprint = createInputFingerprint();
  const encodedByInput = new WeakMap<
    object,
    { readonly fingerprint: string; readonly value: string }
  >();

  const failure = (
    code: WireCodecErrorCode,
    requestedVersion: number,
    path: readonly (string | number)[],
    message: string,
  ) => ({
    ok: false as const,
    error: freezeError(descriptor, code, requestedVersion, path, message),
  });

  const outputPolicyPath = (output: unknown): readonly (string | number)[] | undefined => {
    const unsafePath = unsafeInputPath(output);
    if (unsafePath !== undefined) return unsafePath;
    if (typeof output !== 'object' || output === null || Array.isArray(output)) return [];
    const record = output as Record<string, unknown>;
    if (descriptor.embeddedVersion === null) {
      if (Object.hasOwn(record, 'schemaVersion')) return ['schemaVersion'];
    } else if (record[descriptor.embeddedVersion] !== descriptor.version) {
      return [descriptor.embeddedVersion];
    }
    if (descriptor.wireKind === null) {
      if (Object.hasOwn(record, 'kind')) return ['kind'];
    } else if (record.kind !== descriptor.wireKind) {
      return ['kind'];
    }
    return undefined;
  };

  const invalidShape = (path: readonly (string | number)[]) =>
    failure('invalid-shape', descriptor.version, path, `invalid ${descriptor.id} wire value`);

  const parsedCurrent = (input: unknown) => {
    const unsafePath = unsafeInputPath(input);
    if (unsafePath !== undefined) {
      return invalidShape(unsafePath);
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return invalidShape(first === undefined ? [] : issuePath(first));
    }
    const parsedPolicyPath = outputPolicyPath(parsed.data);
    if (parsedPolicyPath !== undefined) return invalidShape(parsedPolicyPath);

    const stabilized = schema.safeParse(parsed.data);
    if (!stabilized.success) {
      const first = stabilized.error.issues[0];
      return invalidShape(first === undefined ? [] : issuePath(first));
    }
    const stabilizedPolicyPath = outputPolicyPath(stabilized.data);
    if (stabilizedPolicyPath !== undefined) return invalidShape(stabilizedPolicyPath);
    if (JSON.stringify(parsed.data) !== JSON.stringify(stabilized.data)) {
      return invalidShape([]);
    }
    return { ok: true as const, value: stabilized.data };
  };

  const validate = (input: unknown) => {
    try {
      const unsafePath = unsafeInputPath(input);
      if (unsafePath !== undefined) {
        return failure(
          'invalid-shape',
          descriptor.version,
          unsafePath,
          `invalid ${descriptor.id} wire value`,
        );
      }
      if (
        descriptor.embeddedVersion !== null &&
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input)
      ) {
        const candidate = (input as Record<string, unknown>)[descriptor.embeddedVersion];
        if (
          typeof candidate === 'number' &&
          Number.isSafeInteger(candidate) &&
          candidate !== descriptor.version
        ) {
          return failure(
            'unsupported-version',
            candidate,
            [descriptor.embeddedVersion],
            `unsupported ${descriptor.id} wire version`,
          );
        }
      }

      return parsedCurrent(input);
    } catch {
      return failure(
        'invalid-shape',
        descriptor.version,
        [],
        `invalid ${descriptor.id} wire value`,
      );
    }
  };

  const codec: WireCodec<Id, Version, z.infer<Schema>> = {
    descriptor,
    validate,
    decode(text: string) {
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        return failure(
          'malformed-json',
          descriptor.version,
          [],
          `${descriptor.id} input is not valid JSON`,
        );
      }
      if (
        descriptor.embeddedVersion !== null &&
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input)
      ) {
        const candidate = (input as Record<string, unknown>)[descriptor.embeddedVersion];
        if (
          typeof candidate === 'number' &&
          Number.isSafeInteger(candidate) &&
          candidate !== descriptor.version
        ) {
          const migrate = migrations.get(candidate);
          if (migrate === undefined) {
            return failure(
              'unsupported-version',
              candidate,
              [descriptor.embeddedVersion],
              `unsupported ${descriptor.id} wire version`,
            );
          }
          try {
            const migrated = migrate(input);
            const parsed = parsedCurrent(migrated);
            if (!parsed.ok) {
              return failure(
                'migration-failed',
                candidate,
                parsed.error.path,
                `could not migrate ${descriptor.id} wire value`,
              );
            }
            return parsed;
          } catch {
            return failure(
              'migration-failed',
              candidate,
              [descriptor.embeddedVersion],
              `could not migrate ${descriptor.id} wire value`,
            );
          }
        }
      }
      return validate(input);
    },
    encode(dto: z.infer<Schema>) {
      const unsafePath = unsafeInputPath(dto);
      if (unsafePath !== undefined) return invalidShape(unsafePath);
      const fingerprint = inputFingerprint(dto);
      if (typeof dto === 'object' && dto !== null && fingerprint !== undefined) {
        const cached = encodedByInput.get(dto);
        if (cached !== undefined && cached.fingerprint === fingerprint) {
          return { ok: true as const, value: cached.value };
        }
      }
      const validated = validate(dto);
      if (!validated.ok) return validated;
      try {
        const encoded = JSON.stringify(
          validated.value,
          null,
          descriptor.formatting.indent === 0 ? undefined : descriptor.formatting.indent,
        );
        const value = descriptor.formatting.terminalLf ? `${encoded}\n` : encoded;
        if (typeof dto === 'object' && dto !== null && fingerprint !== undefined) {
          encodedByInput.set(dto, { fingerprint, value });
        }
        return {
          ok: true as const,
          value,
        };
      } catch {
        return failure(
          'migration-failed',
          descriptor.version,
          [],
          `could not encode ${descriptor.id} wire value`,
        );
      }
    },
  };

  const identity = identityForDescriptor(descriptor);
  for (const value of [codec, codec.validate, codec.decode, codec.encode]) {
    Object.defineProperty(value, WIRE_CODEC_IDENTITY, { value: identity });
  }
  for (const method of [codec.validate, codec.decode, codec.encode]) {
    markFactoryCodecMethod(method);
  }

  return Object.freeze(codec);
};
