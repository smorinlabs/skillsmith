import { INIT_MANIFEST_OPERATION_KINDS, planInitManifest } from '@skillsmith/core';
import type * as publicCore from '@skillsmith/core';
import type {
  ArtifactDigest,
  InitManifestBeforeImage,
  InitManifestCurrentInput,
  InitManifestDefaultsInput,
  InitManifestIntentField,
  InitManifestLegacyIntentInput,
  InitManifestOperationInput,
  InitManifestRefusal,
  InitManifestRequest,
  InitManifestSkeletonInput,
  InitManifestWriteImage,
  ManifestScope,
  ManifestShape,
  ManifestTool,
  Result,
} from '@skillsmith/core/public-types';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type WhenAvailable<T, Check> = IsAny<T> extends true ? false : Check extends true ? true : false;

type _OperationKinds = Assert<
  Equal<
    typeof INIT_MANIFEST_OPERATION_KINDS,
    readonly ['create-manifest', 'replace-manifest', 'migrate-project-config', 'noop']
  >
>;
type _IntentFields = Assert<
  WhenAvailable<
    InitManifestIntentField,
    Equal<
      InitManifestIntentField,
      'defaults.tools' | 'defaults.scope' | 'defaults.path' | 'registry.default'
    >
  >
>;
type _DefaultsInput = Assert<
  WhenAvailable<
    InitManifestDefaultsInput,
    Equal<
      InitManifestDefaultsInput,
      Readonly<{
        readonly tools?: readonly ManifestTool[];
        readonly scope?: ManifestScope;
        readonly path?: string;
      }>
    >
  >
>;
type _SkeletonInput = Assert<
  WhenAvailable<
    InitManifestSkeletonInput,
    Equal<
      InitManifestSkeletonInput,
      Readonly<{
        readonly defaults?: InitManifestDefaultsInput;
        readonly registry?: Readonly<{ readonly default: string }>;
      }>
    >
  >
>;
type _LegacyIntentInput = Assert<
  WhenAvailable<
    InitManifestLegacyIntentInput,
    Equal<
      InitManifestLegacyIntentInput,
      Readonly<{ readonly requireMatch: readonly InitManifestIntentField[] }>
    >
  >
>;
type _CurrentInput = Assert<
  WhenAvailable<
    InitManifestCurrentInput,
    Equal<
      InitManifestCurrentInput,
      | Readonly<{ readonly state: 'absent' }>
      | Readonly<{ readonly state: 'present'; readonly bytes: Uint8Array }>
    >
  >
>;
type _RequestInput = Assert<
  WhenAvailable<
    InitManifestRequest,
    Equal<
      InitManifestRequest,
      Readonly<{
        readonly skeleton: InitManifestSkeletonInput;
        readonly current: InitManifestCurrentInput;
        readonly legacyIntent: InitManifestLegacyIntentInput;
        readonly force: boolean;
      }>
    >
  >
>;
type _BeforeImage = Assert<
  WhenAvailable<
    InitManifestBeforeImage,
    Equal<
      InitManifestBeforeImage,
      Readonly<{
        readonly byteHash: ArtifactDigest;
        readonly semanticHash: ArtifactDigest | null;
        readonly shape: ManifestShape;
      }>
    >
  >
>;
type _WriteImage = Assert<
  WhenAvailable<
    InitManifestWriteImage,
    Equal<
      InitManifestWriteImage,
      Readonly<{
        readonly source: string;
        readonly byteHash: ArtifactDigest;
        readonly semanticHash: ArtifactDigest;
        readonly shape: 'canonical';
      }>
    >
  >
>;
type _OperationUnion = Assert<
  WhenAvailable<
    InitManifestOperationInput,
    Equal<
      InitManifestOperationInput,
      | Readonly<{
          readonly kind: 'create-manifest';
          readonly before: null;
          readonly after: InitManifestWriteImage;
        }>
      | Readonly<{
          readonly kind: 'replace-manifest' | 'migrate-project-config';
          readonly before: InitManifestBeforeImage;
          readonly after: InitManifestWriteImage;
        }>
      | Readonly<{
          readonly kind: 'noop';
          readonly before: InitManifestBeforeImage;
          readonly after: null;
        }>
    >
  >
>;
type RefusalField =
  | 'skeleton'
  | 'skeleton.defaults'
  | 'skeleton.defaults.tools'
  | 'skeleton.defaults.scope'
  | 'skeleton.defaults.path'
  | 'skeleton.registry.default'
  | 'current'
  | 'current.bytes'
  | 'legacyIntent'
  | 'legacyIntent.requireMatch'
  | 'force';
type _Refusal = Assert<
  WhenAvailable<
    InitManifestRefusal,
    Equal<
      InitManifestRefusal,
      Readonly<{
        readonly code: 'init-manifest';
        readonly exitCode: 2 | 3;
        readonly reason:
          | 'invalid-request'
          | 'existing-manifest'
          | 'future-manifest'
          | 'legacy-intent-conflict'
          | 'unsafe-legacy-migration';
        readonly field?: RefusalField;
        readonly shape?: ManifestShape;
        readonly message: string;
      }>
    >
  >
>;
type _ExactFunction = Assert<
  Equal<
    typeof planInitManifest,
    (input: unknown) => Result<InitManifestOperationInput, InitManifestRefusal>
  >
>;
type _BeforeHasNoRawBytes = Assert<
  WhenAvailable<
    InitManifestBeforeImage,
    Equal<
      | ('bytes' extends keyof InitManifestBeforeImage ? true : false)
      | ('source' extends keyof InitManifestBeforeImage ? true : false),
      false
    >
  >
>;
type _RequestHasNoEffects = Assert<
  WhenAvailable<
    InitManifestRequest,
    Equal<
      | ('path' extends keyof InitManifestRequest ? true : false)
      | ('ports' extends keyof InitManifestRequest ? true : false)
      | ('context' extends keyof InitManifestRequest ? true : false)
      | ('projectContext' extends keyof InitManifestRequest ? true : false)
      | ('operationId' extends keyof InitManifestRequest ? true : false)
      | ('lock' extends keyof InitManifestRequest ? true : false)
      | ('ledger' extends keyof InitManifestRequest ? true : false)
      | ('live' extends keyof InitManifestRequest ? true : false)
      | ('store' extends keyof InitManifestRequest ? true : false)
      | ('planner' extends keyof InitManifestRequest ? true : false)
      | ('plannerPolicy' extends keyof InitManifestRequest ? true : false)
      | ('policy' extends keyof InitManifestRequest ? true : false)
      | ('clock' extends keyof InitManifestRequest ? true : false)
      | ('process' extends keyof InitManifestRequest ? true : false),
      false
    >
  >
>;
type _NoInitPorts = Assert<
  Equal<'InitManifestPorts' extends keyof typeof publicCore ? true : false, false>
>;
type _NoInitPlanner = Assert<
  Equal<'InitManifestPlan' extends keyof typeof publicCore ? true : false, false>
>;

const _plan: (input: unknown) => Result<InitManifestOperationInput, InitManifestRefusal> =
  planInitManifest;
const _defaults: InitManifestDefaultsInput = {
  tools: ['codex'] as readonly ManifestTool[],
  scope: 'project',
  path: './skills',
};
const _skeleton: InitManifestSkeletonInput = {
  defaults: _defaults,
  registry: { default: 'github.com/acme' },
};
const _intent: InitManifestLegacyIntentInput = {
  requireMatch: ['defaults.scope', 'registry.default'],
};
const _request: InitManifestRequest = {
  skeleton: _skeleton,
  current: { state: 'absent' },
  legacyIntent: _intent,
  force: false,
};
declare const digest: ArtifactDigest;
declare const shape: ManifestShape;
const _before: InitManifestBeforeImage = { byteHash: digest, semanticHash: null, shape };
const _write: InitManifestWriteImage = {
  source: 'version = 1\n',
  byteHash: digest,
  semanticHash: digest,
  shape: 'canonical',
};
const _create: InitManifestOperationInput = {
  kind: 'create-manifest',
  before: null,
  after: _write,
};
const _replace: InitManifestOperationInput = {
  kind: 'replace-manifest',
  before: _before,
  after: _write,
};
const _migrate: InitManifestOperationInput = {
  kind: 'migrate-project-config',
  before: _before,
  after: _write,
};
const _noop: InitManifestOperationInput = { kind: 'noop', before: _before, after: null };

// @ts-expect-error refusal is not a fifth executable operation kind
const _refusalOperation: InitManifestOperationInput = { kind: 'refusal' };
// @ts-expect-error the pure request cannot carry a destination path
const _pathfulRequest: InitManifestRequest = { ..._request, path: '/tmp/skillsmith.toml' };
// @ts-expect-error the pure request cannot carry runtime ports
const _portedRequest: InitManifestRequest = { ..._request, ports: {} };
// @ts-expect-error legacy intent is required
const _intentlessRequest: InitManifestRequest = {
  skeleton: {},
  current: { state: 'absent' },
  force: false,
};
// @ts-expect-error force is required
const _forcelessRequest: InitManifestRequest = {
  skeleton: {},
  current: { state: 'absent' },
  legacyIntent: { requireMatch: [] },
};
// @ts-expect-error optional fields are absent, never explicitly undefined
const _undefinedDefaults: InitManifestSkeletonInput = { defaults: undefined };
// @ts-expect-error project context is application-service authority
const _contextRequest: InitManifestRequest = { ..._request, projectContext: {} };
// @ts-expect-error operation identity is planner authority
const _identifiedRequest: InitManifestRequest = { ..._request, operationId: 'op-1' };
// @ts-expect-error lock state is outside the pure init input
const _lockedRequest: InitManifestRequest = { ..._request, lock: null };
// @ts-expect-error ledger state is outside the pure init input
const _ledgerRequest: InitManifestRequest = { ..._request, ledger: null };
// @ts-expect-error live state is outside the pure init input
const _liveRequest: InitManifestRequest = { ..._request, live: null };
// @ts-expect-error mutable planner policy is outside the pure init input
const _policyRequest: InitManifestRequest = { ..._request, plannerPolicy: {} };
// @ts-expect-error a current image carries bytes, never a filesystem path
const _pathfulCurrent: InitManifestCurrentInput = {
  state: 'present',
  bytes: new Uint8Array(),
  path: '/tmp/skillsmith.toml',
};
// @ts-expect-error init skeletons are declaration-empty
const _declaredSkeleton: InitManifestSkeletonInput = { skills: [] };
// @ts-expect-error intent fields are a closed union
const _invalidIntent: InitManifestLegacyIntentInput = { requireMatch: ['defaults.placement'] };
// @ts-expect-error before images never expose raw current bytes
const _rawBefore: InitManifestBeforeImage = { ..._before, bytes: new Uint8Array() };
// @ts-expect-error before images never expose current source
const _sourceBefore: InitManifestBeforeImage = { ..._before, source: 'version = 1\n' };
// @ts-expect-error write images expose immutable source, not a mutable byte view
const _byteAfter: InitManifestWriteImage = { ..._write, bytes: new Uint8Array() };
// @ts-expect-error operations have no planner operation identity
const _identifiedOperation: InitManifestOperationInput = { ..._create, operationId: 'op-1' };
// @ts-expect-error operations have no mutable execution policy
const _policyOperation: InitManifestOperationInput = { ..._create, policy: {} };
// @ts-expect-error old whole-request legacy intent strings are not accepted
const _oldLegacyIntent: InitManifestRequest = { ..._request, legacyIntent: 'preserve-existing' };

void [
  INIT_MANIFEST_OPERATION_KINDS,
  _plan,
  _request,
  _create,
  _replace,
  _migrate,
  _noop,
  _refusalOperation,
  _pathfulRequest,
  _portedRequest,
  _intentlessRequest,
  _forcelessRequest,
  _undefinedDefaults,
  _contextRequest,
  _identifiedRequest,
  _lockedRequest,
  _ledgerRequest,
  _liveRequest,
  _policyRequest,
  _pathfulCurrent,
  _declaredSkeleton,
  _invalidIntent,
  _rawBefore,
  _sourceBefore,
  _byteAfter,
  _identifiedOperation,
  _policyOperation,
  _oldLegacyIntent,
];
