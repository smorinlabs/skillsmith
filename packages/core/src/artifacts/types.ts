import type { BuiltInToolId } from '../agents/registry.ts';

export const MANIFEST_VERSION = 1 as const;

export const MANIFEST_SHAPES = Object.freeze([
  'canonical',
  'legacy',
  'mixed',
  'empty',
  'malformed',
  'unknown',
  'future',
] as const);

export type ManifestShape = (typeof MANIFEST_SHAPES)[number];
export type ReadableManifestShape = Extract<ManifestShape, 'canonical' | 'legacy'>;
export type ManifestScope = 'user' | 'project';
export type ManifestPlacement = 'symlink' | 'copy';
export type ManifestTool = BuiltInToolId;

export interface ManifestStateError {
  readonly code: 'manifest-state';
  readonly exitCode: 3;
  readonly shape?: ManifestShape;
  readonly field?: string;
  readonly message: string;
}

/** A parsed, read-only manifest retaining the exact source bytes supplied by its caller. */
export interface ReadableManifestDocument {
  readonly shape: ReadableManifestShape;
  readonly migrationPending: boolean;
  readonly source: string;
  readonly declaredNames: readonly string[];
}

export interface CanonicalSourceIdentity {
  readonly host: string;
  readonly repository: string;
  readonly path: string | null;
}

export interface NormalizedManifestDefaults {
  readonly tools?: readonly ManifestTool[];
  readonly scope?: ManifestScope;
  readonly path?: string;
}

export interface NormalizedManifestDeclaration {
  readonly name: string;
  readonly source: CanonicalSourceIdentity;
  readonly ref: string | null;
  readonly tools: readonly ManifestTool[];
  readonly scope: ManifestScope;
  readonly placement: ManifestPlacement;
  readonly path: string | null;
}

export interface NormalizedManifestV1 {
  readonly version: typeof MANIFEST_VERSION;
  readonly defaults?: NormalizedManifestDefaults;
  readonly registry?: Readonly<{ readonly default?: string }>;
  readonly skills: readonly NormalizedManifestDeclaration[];
}

export interface ManifestSemanticProjectionV1 {
  readonly version: typeof MANIFEST_VERSION;
  readonly defaults?: NormalizedManifestDefaults;
  readonly registry?: Readonly<{ readonly default?: string }>;
  readonly skills: readonly NormalizedManifestDeclaration[];
}
