type WireResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: WireCodecError;
    };

export interface WireCodecError {
  readonly code: 'malformed-json' | 'invalid-shape' | 'unsupported-version' | 'migration-failed';
  readonly contractId: string;
  readonly requestedVersion: number;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface WireCodecDescriptor<Id extends string = string, Version extends number = number> {
  readonly id: Id;
  readonly version: Version;
  readonly wireKind: string | null;
  readonly embeddedVersion: 'schemaVersion' | null;
  readonly unknownFields: 'reject-recursive';
  readonly formatting: { readonly indent: 0 | 2; readonly terminalLf: boolean };
  readonly migrations: readonly number[];
  readonly compatibility: 'conservative';
}

export interface WireCodec<
  Id extends string = string,
  Version extends number = number,
  Dto = unknown,
> {
  readonly descriptor: WireCodecDescriptor<Id, Version>;
  validate(input: unknown): WireResult<Dto>;
  decode(text: string): WireResult<Dto>;
  encode(dto: Dto): WireResult<string>;
}

export interface WireContractMapping {
  readonly commandPath: string;
  readonly contractId: string;
  readonly version: number;
}

export interface WireContractRegistry {
  readonly codecs: readonly WireCodec[];
  readonly commandMappings: readonly WireContractMapping[];
  get(id: string, version: number): WireCodec | undefined;
  latest(id: string): WireCodec | undefined;
  forCommand(commandPath: string): WireCodec | undefined;
}

export declare const createWireContractRegistry: (
  codecs: readonly WireCodec[],
  commandMappings: readonly WireContractMapping[],
) => WireContractRegistry;
