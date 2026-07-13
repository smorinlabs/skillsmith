import {
  classifyArtifactSelectorToken,
  containsSensitiveMaterial,
  normalizePortablePath,
  normalizeRegistryIdentity,
  normalizeSourceIdentity,
  parseSource,
  redactObservationValue,
  redactSensitiveString,
  redactSensitiveValue,
} from '@skillsmith/core';
import type {
  InstallResult,
  InstallSourceTransport,
  SourceSpec,
} from '@skillsmith/core/public-types';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

type _NoRaw = Assert<Equal<'raw' extends keyof SourceSpec ? true : false, false>>;
type _NoHostAlias = Assert<Equal<'host' extends keyof SourceSpec ? true : false, false>>;
type _NoRepositoryAlias = Assert<Equal<'repoPath' extends keyof SourceSpec ? true : false, false>>;
type _Identity = Assert<Equal<SourceSpec['identity']['path'], string | null>>;
type _CanonicalSource = Assert<Equal<SourceSpec['canonicalSource'], string>>;
type _CanonicalInvocation = Assert<Equal<SourceSpec['canonicalInvocation'], string>>;
type _OriginSource = Assert<Equal<SourceSpec['originSource'], string>>;
type _CloneUrl = Assert<Equal<SourceSpec['cloneUrl'], string>>;
type _Selector = Assert<
  Equal<
    SourceSpec['selector'],
    | { readonly kind: 'whole-repo' }
    | { readonly kind: 'name'; readonly name: string }
    | { readonly kind: 'path'; readonly path: string }
  >
>;
type _RequestIndex = Assert<Equal<InstallResult['requestIndex'], number | undefined>>;
type _TransportKeys = Assert<
  Equal<
    keyof InstallSourceTransport,
    'resolveRef' | 'fetchRepo' | 'listSkills' | 'materializeSkill'
  >
>;

const _parseSource: (
  input: string,
  options?: Readonly<{ overrideRef?: string }>,
) => ReturnType<typeof parseSource> = parseSource;
const _contains: (input: string) => boolean = containsSensitiveMaterial;
const _redactString: (input: string) => string = redactSensitiveString;
const _redactValue: (input: unknown) => unknown = redactSensitiveValue;
const _observationAlias: typeof redactSensitiveValue = redactObservationValue;
const _sourceIdentity: typeof normalizeSourceIdentity = normalizeSourceIdentity;
const _registryIdentity: typeof normalizeRegistryIdentity = normalizeRegistryIdentity;
const _portablePath: typeof normalizePortablePath = normalizePortablePath;
const _selectorClassification: (
  token: string,
  host: 'posix' | 'windows',
) => 'portable' | 'machine-bound' | 'invalid' | 'nonportable' = classifyArtifactSelectorToken;

void [
  _parseSource,
  _contains,
  _redactString,
  _redactValue,
  _observationAlias,
  _sourceIdentity,
  _registryIdentity,
  _portablePath,
  _selectorClassification,
];
