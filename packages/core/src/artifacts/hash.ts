import { createHash } from 'node:crypto';
import { type Result, err, ok } from '../result.ts';
import { projectManifestSemantics } from './manifest.ts';
import type { NormalizedManifestV1 } from './types.ts';

export const HASH_SCHEMA_VERSION = 1 as const;

export const HASH_DOMAINS = Object.freeze([
  'manifest-semantic',
  'manifest-bytes',
  'lock-canonical',
  'source-content',
  'resource',
  'selection-set',
  'capability',
] as const);

export type HashSchemaVersion = typeof HASH_SCHEMA_VERSION;
export type HashDomain = (typeof HASH_DOMAINS)[number];

declare const artifactDigestBrand: unique symbol;
export type ArtifactDigest = string & { readonly [artifactDigestBrand]: true };

export interface ArtifactHashError {
  readonly code: 'artifact-hash';
  readonly reason: 'unknown-domain' | 'unsupported-hash-schema' | 'invalid-digest';
  readonly field: 'domain' | 'schemaVersion' | 'digest';
  readonly message: string;
}

const DOMAIN_SET: ReadonlySet<string> = new Set(HASH_DOMAINS);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

const hashError = (
  reason: ArtifactHashError['reason'],
  field: ArtifactHashError['field'],
  message: string,
): ArtifactHashError =>
  Object.freeze({
    code: 'artifact-hash',
    reason,
    field,
    message,
  });

const digestCanonicalBytes = (domain: HashDomain, canonicalInput: Uint8Array): ArtifactDigest => {
  const prefix = encoder.encode(`skillsmith:${domain}:v${HASH_SCHEMA_VERSION}`);
  const digest = createHash('sha256')
    .update(prefix)
    .update(Uint8Array.of(0))
    .update(canonicalInput)
    .digest('hex');
  return `sha256:${digest}` as ArtifactDigest;
};

export const hashCanonicalInput = (
  domain: string,
  schemaVersion: number,
  canonicalInput: string | Uint8Array,
): Result<ArtifactDigest, ArtifactHashError> => {
  if (!DOMAIN_SET.has(domain)) {
    return err(hashError('unknown-domain', 'domain', 'artifact hash domain is unsupported'));
  }
  if (schemaVersion !== HASH_SCHEMA_VERSION) {
    return err(
      hashError('unsupported-hash-schema', 'schemaVersion', 'artifact hash schema is unsupported'),
    );
  }

  const ownedInput =
    typeof canonicalInput === 'string'
      ? encoder.encode(canonicalInput)
      : new Uint8Array(canonicalInput);
  return ok(digestCanonicalBytes(domain as HashDomain, ownedInput));
};

export const parseArtifactDigest = (value: unknown): Result<ArtifactDigest, ArtifactHashError> =>
  typeof value === 'string' && DIGEST_PATTERN.test(value)
    ? ok(value as ArtifactDigest)
    : err(hashError('invalid-digest', 'digest', 'artifact digest is invalid'));

export const hashManifestSemantics = (manifest: NormalizedManifestV1): ArtifactDigest =>
  digestCanonicalBytes(
    'manifest-semantic',
    encoder.encode(JSON.stringify(projectManifestSemantics(manifest))),
  );

export const hashManifestBytes = (source: string | Uint8Array): ArtifactDigest => {
  const ownedSource = typeof source === 'string' ? encoder.encode(source) : new Uint8Array(source);
  return digestCanonicalBytes('manifest-bytes', ownedSource);
};
