import type { WireCodec } from '@skillsmith/core/contracts';

export interface WireSchemaFacade<Dto> {
  parse(value: unknown): Dto;
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: Dto }
    | { readonly success: false; readonly error: Error };
}

const failure = (message: string): Error => new Error(message);

/** Compatibility facade for callers that previously consumed renderer-owned Zod schemas. */
export const wireSchema = <Dto>(codec: WireCodec<string, number, Dto>): WireSchemaFacade<Dto> => ({
  parse(value: unknown) {
    const result = codec.validate(value);
    if (!result.ok) throw failure(result.error.message);
    return result.value;
  },
  safeParse(value: unknown) {
    const result = codec.validate(value);
    return result.ok
      ? { success: true as const, data: result.value }
      : { success: false as const, error: failure(result.error.message) };
  },
});

export const encodeWire = <Dto>(codec: WireCodec<string, number, Dto>, dto: Dto): string => {
  const result = codec.encode(dto);
  if (!result.ok) throw failure(result.error.message);
  return result.value;
};
