import type { WireCodecDescriptor } from './types.ts';

export const WIRE_CODEC_IDENTITY = Symbol('skillsmith.wire-codec-identity');

type CodecMethod = (...args: never[]) => unknown;

const factoryCodecMethods = new WeakSet<CodecMethod>();

export const markFactoryCodecMethod = (method: CodecMethod): void => {
  factoryCodecMethods.add(method);
};

export const isFactoryCodecMethod = (method: CodecMethod): boolean =>
  factoryCodecMethods.has(method);

export interface WireCodecIdentity {
  readonly id: string;
  readonly version: number;
  readonly wireKind: string | null;
  readonly embeddedVersion: 'schemaVersion' | null;
  readonly unknownFields: 'reject-recursive';
  readonly formatting: { readonly indent: 0 | 2; readonly terminalLf: boolean };
  readonly migrations: readonly number[];
  readonly compatibility: 'conservative';
}

export const identityForDescriptor = (descriptor: WireCodecDescriptor): WireCodecIdentity =>
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
    migrations: Object.freeze(
      Array.from(
        { length: descriptor.migrations.length },
        (_, index) => descriptor.migrations[index] as number,
      ),
    ),
    compatibility: descriptor.compatibility,
  });

export const identityMatchesDescriptor = (
  identity: WireCodecIdentity,
  descriptor: WireCodecDescriptor,
): boolean =>
  identity.id === descriptor.id &&
  identity.version === descriptor.version &&
  identity.wireKind === descriptor.wireKind &&
  identity.embeddedVersion === descriptor.embeddedVersion &&
  identity.unknownFields === descriptor.unknownFields &&
  identity.formatting.indent === descriptor.formatting.indent &&
  identity.formatting.terminalLf === descriptor.formatting.terminalLf &&
  identity.migrations.length === descriptor.migrations.length &&
  identity.migrations.every((version, index) => version === descriptor.migrations[index]) &&
  identity.compatibility === descriptor.compatibility;
