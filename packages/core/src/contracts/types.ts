import type { Result } from '../result.ts';

export type WireCodecErrorCode =
  | 'malformed-json'
  | 'invalid-shape'
  | 'unsupported-version'
  | 'migration-failed';

export interface WireCodecError {
  readonly code: WireCodecErrorCode;
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
  readonly formatting: {
    readonly indent: 0 | 2;
    readonly terminalLf: boolean;
  };
  readonly migrations: readonly number[];
  readonly compatibility: 'conservative';
}

export interface WireCodec<
  Id extends string = string,
  Version extends number = number,
  Dto = unknown,
> {
  readonly descriptor: WireCodecDescriptor<Id, Version>;
  validate(input: unknown): Result<Dto, WireCodecError>;
  decode(text: string): Result<Dto, WireCodecError>;
  encode(dto: Dto): Result<string, WireCodecError>;
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
