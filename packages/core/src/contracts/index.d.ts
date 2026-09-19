type WireResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: WireCodecError;
    };

export type ArtifactId = 'manifest' | 'lock' | 'plan' | 'ledger' | 'journal';
export type ArtifactSource =
  | { readonly kind: 'version'; readonly version: number }
  | { readonly kind: 'shape'; readonly id: 'legacy-project-config' };
export type ArtifactDiscriminator =
  | { readonly kind: 'field'; readonly field: 'version' | 'schemaVersion' }
  | { readonly kind: 'classifier'; readonly id: 'manifest-v1-or-legacy-project-config' };
export type ArtifactMapperId = 'legacy-project-config-to-manifest-v1' | 'ledger-v1-to-v2';

export interface ArtifactMigrationDescriptor {
  readonly source: ArtifactSource;
  readonly targetVersion: number;
  readonly mapperId: ArtifactMapperId;
}

export interface ArtifactCodecDescriptor<
  Id extends ArtifactId = ArtifactId,
  Version extends number = number,
> {
  readonly id: Id;
  readonly version: Version;
  readonly syntax: 'json' | 'toml';
  readonly discriminator: ArtifactDiscriminator;
  readonly wireKind: string | null;
  readonly presentation: {
    readonly decode: 'human' | 'canonical';
    readonly encode: 'canonical' | 'compatibility';
  };
  readonly terminalLf: boolean;
  readonly unknownFields: 'reject-recursive';
  readonly migrations: readonly ArtifactMigrationDescriptor[];
  readonly compatibility: 'conservative';
}

export interface ArtifactMigrationInfo {
  readonly mapperId: ArtifactMapperId;
  readonly targetVersion: number;
}

export interface DecodedArtifact<Model = unknown> {
  readonly source: ArtifactSource;
  readonly model: Model;
  readonly canonical: boolean;
  readonly migration: ArtifactMigrationInfo | null;
}

export type ArtifactCodecErrorReason =
  | 'malformed'
  | 'invalid-shape'
  | 'unsupported-version'
  | 'migration-failed'
  | 'noncanonical'
  | 'sensitive-content';

export interface ArtifactCodecError {
  readonly code: 'artifact-codec';
  readonly artifactId: ArtifactId;
  readonly requestedVersion: number | null;
  readonly reason: ArtifactCodecErrorReason;
  readonly path: readonly (string | number)[];
  readonly exitCode: 3;
  readonly message: string;
}

type ArtifactResult<T> = { ok: true; value: T } | { ok: false; error: ArtifactCodecError };

export interface ArtifactCodec<
  Id extends ArtifactId = ArtifactId,
  Version extends number = number,
  Dto = unknown,
  Model = unknown,
> {
  readonly descriptor: ArtifactCodecDescriptor<Id, Version>;
  validate(input: unknown): ArtifactResult<Dto>;
  fromDto(dto: Dto): ArtifactResult<Model>;
  toDto(model: Model): ArtifactResult<Dto>;
  decode(bytes: Uint8Array): ArtifactResult<DecodedArtifact<Model>>;
  encode(model: Model): ArtifactResult<Uint8Array>;
}

export interface ArtifactContractRegistry {
  readonly codecs: readonly ArtifactCodec[];
  get(id: ArtifactId, version: number): ArtifactCodec | undefined;
  latest(id: ArtifactId): ArtifactCodec | undefined;
}

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
