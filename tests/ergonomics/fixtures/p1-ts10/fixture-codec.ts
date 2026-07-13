import type { WireCodec } from '@skillsmith/core/contracts';

export interface FixtureDto {
  readonly value: string;
}

const descriptor = Object.freeze({
  id: 'fixture',
  version: 1,
  wireKind: null,
  embeddedVersion: null,
  unknownFields: 'reject-recursive',
  formatting: Object.freeze({ indent: 2, terminalLf: false }),
  migrations: Object.freeze([]),
  compatibility: 'conservative',
} as const);

const error = (code: 'malformed-json' | 'invalid-shape', message: string) => ({
  ok: false as const,
  error: Object.freeze({
    code,
    contractId: descriptor.id,
    requestedVersion: descriptor.version,
    path: Object.freeze([] as string[]),
    message,
  }),
});

const validate = (input: unknown) => {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, 'value') ||
    typeof (input as { readonly value?: unknown }).value !== 'string'
  ) {
    return error('invalid-shape', 'fixture value must be an object containing only string value');
  }

  return {
    ok: true as const,
    value: Object.freeze({ value: (input as { readonly value: string }).value }),
  };
};

/** A structural future codec proving generic registry extension without production source edits. */
export const fixtureCodec = Object.freeze({
  descriptor,
  validate,
  decode(text: string) {
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return error('malformed-json', 'fixture input is not valid JSON');
    }
    return validate(input);
  },
  encode(dto: FixtureDto) {
    const validated = validate(dto);
    if (!validated.ok) return validated;
    return { ok: true as const, value: JSON.stringify(validated.value, null, 2) };
  },
}) satisfies WireCodec<'fixture', 1, FixtureDto>;

export const fixtureCommandMapping = Object.freeze({
  commandPath: 'skillsmith fixture',
  contractId: 'fixture',
  version: 1,
} as const);

export const toFixtureDto = (domain: { readonly publicValue: string }): FixtureDto => ({
  value: domain.publicValue,
});
