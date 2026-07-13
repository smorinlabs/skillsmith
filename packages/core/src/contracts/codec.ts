import { z } from 'zod';
import type {
  WireCodec,
  WireCodecDescriptor,
  WireCodecError,
  WireCodecErrorCode,
} from './types.ts';

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

const ownDescriptor = <Id extends string, Version extends number>(
  descriptor: WireCodecDescriptor<Id, Version>,
): WireCodecDescriptor<Id, Version> =>
  Object.freeze({
    id: descriptor.id,
    version: descriptor.version,
    wireKind: descriptor.wireKind,
    embeddedVersion: descriptor.embeddedVersion,
    unknownFields: descriptor.unknownFields,
    formatting: Object.freeze({
      indent: descriptor.formatting.indent,
      terminalLf: descriptor.formatting.terminalLf,
    }),
    migrations: Object.freeze([...descriptor.migrations]),
    compatibility: descriptor.compatibility,
  });

export const createJsonWireCodec = <
  const Id extends string,
  const Version extends number,
  Schema extends z.ZodTypeAny,
>(
  sourceDescriptor: WireCodecDescriptor<Id, Version>,
  schema: Schema,
): WireCodec<Id, Version, z.infer<Schema>> => {
  const descriptor = ownDescriptor(sourceDescriptor);

  const failure = (
    code: WireCodecErrorCode,
    requestedVersion: number,
    path: readonly (string | number)[],
    message: string,
  ) => ({
    ok: false as const,
    error: freezeError(descriptor, code, requestedVersion, path, message),
  });

  const validate = (input: unknown) => {
    try {
      if (
        descriptor.embeddedVersion !== null &&
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input)
      ) {
        const candidate = (input as Record<string, unknown>)[descriptor.embeddedVersion];
        if (typeof candidate === 'number' && candidate !== descriptor.version) {
          return failure(
            'unsupported-version',
            candidate,
            [descriptor.embeddedVersion],
            `unsupported ${descriptor.id} wire version`,
          );
        }
      }

      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return failure(
          'invalid-shape',
          descriptor.version,
          first === undefined ? [] : issuePath(first),
          `invalid ${descriptor.id} wire value`,
        );
      }
      return { ok: true as const, value: parsed.data };
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
      return validate(input);
    },
    encode(dto: z.infer<Schema>) {
      const validated = validate(dto);
      if (!validated.ok) return validated;
      try {
        const encoded = JSON.stringify(
          validated.value,
          null,
          descriptor.formatting.indent === 0 ? undefined : descriptor.formatting.indent,
        );
        return {
          ok: true as const,
          value: descriptor.formatting.terminalLf ? `${encoded}\n` : encoded,
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

  return Object.freeze(codec);
};
