import type { SupportedTool } from '../agents/types.ts';
import type { ArtifactCoordinatorPorts } from '../artifacts/coordinator-types.ts';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { LedgerMigrationV1ToV2 } from '../artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import type { ProjectConfigMigration } from '../artifacts/repository.ts';
import type { Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import type { ObservationBundle } from '../observation/index.ts';
import type { ExecutableOperation, OperationImage, OperationPlan } from '../planning/types.ts';
import type {
  ClockPort,
  FileMetadataReadPort,
  FileModeWritePort,
  FileReadPort,
  FileWritePort,
  HttpPort,
  InventoryReadPorts,
  LockPort,
  PathAccessPort,
  ResolvedRuntimeConfiguration,
} from '../ports/types.ts';

export type Severity = 'error' | 'warning' | 'info';
export type CheckRunMode = 'doctor' | 'check';

export interface DoctorSourceResolutionRequest {
  readonly skillName: string;
  readonly remoteUrl: string;
  readonly ref: string | null;
}

export interface DoctorSourceResolution extends DoctorSourceResolutionRequest {
  readonly resolvedSha: string;
}

export interface Finding {
  checkId: string;
  severity: Severity;
  title: string;
  message: string;
  remediation?: string;
  tool?: SupportedTool;
  scope?: Scope;
  path?: string;
  operation?: string;
  reason?: string;
  scopeInUse?: boolean;
  /** Internal, read-derived authorization. Wire mappers deliberately omit this field. */
  repair?: DoctorRepairAuthorization;
  /** Internal exit classification for invalid/corrupt artifact observations. */
  failureClass?: 'state' | 'permission' | 'source';
  /** Internal credential-free probe input; wire mappers deliberately omit this field. */
  sourceResolution?: DoctorSourceResolutionRequest;
}

export type DoctorRepairKind = 'migrate-ledger' | 'migrate-project-config' | 'write-lock';
export type DoctorRepairArtifact = 'ledger' | 'manifest' | 'lock';

export type DoctorRepairArtifactSummary =
  | Readonly<{
      state: 'absent';
      schemaVersion: null;
      byteRevision: null;
      semanticRevision: null;
    }>
  | Readonly<{
      state: 'present';
      schemaVersion: number | null;
      byteRevision: ArtifactDigest;
      semanticRevision: ArtifactDigest | null;
    }>;

export interface DoctorRepairAuthorization {
  readonly kind: DoctorRepairKind;
  readonly artifact: DoctorRepairArtifact;
  readonly path: string;
  readonly before: DoctorRepairArtifactSummary;
  readonly after: DoctorRepairArtifactSummary;
  readonly targetSource: string;
  readonly beforeImage: OperationImage;
  readonly afterImage: OperationImage;
  readonly ledgerMigration?: LedgerMigrationV1ToV2;
  readonly projectMigration?: ProjectConfigMigration;
  readonly artifactPair?: Readonly<{ readonly file: string; readonly lockfile: string }>;
  readonly targetLock?: PortableLockV1;
}

export interface IdentifiedFinding extends Finding {
  readonly findingId: `finding:v1:${string}`;
}

export interface DoctorRepairOperation {
  readonly operationId: string;
  readonly kind: DoctorRepairKind;
  readonly artifact: DoctorRepairArtifact;
  readonly path: string;
  readonly before: DoctorRepairArtifactSummary;
  readonly after: DoctorRepairArtifactSummary;
  readonly findingIds: readonly `finding:v1:${string}`[];
}

export interface DoctorRepairResult {
  readonly operationId: string;
  readonly outcome: 'changed' | 'unchanged' | 'failed';
  readonly error: null | Readonly<{ code: string; message: string; remediation: string }>;
}

export interface DoctorRepairProduct {
  readonly mode: 'not-requested' | 'preview' | 'execute';
  readonly operations: readonly DoctorRepairOperation[];
  readonly results: readonly DoctorRepairResult[];
}

/** Doctor-owned mutation projection; structurally compatible with application outcomes. */
export interface DoctorMutationSummary {
  readonly kind: 'none' | 'preview' | 'applied';
  readonly planned: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly failed: number;
}

export interface DoctorRunResult extends CheckRunResult {
  findings: IdentifiedFinding[];
  repair: DoctorRepairProduct;
  mutation: DoctorMutationSummary;
}

/** Internal bridge to the shared immutable planning/execution authorities. */
export interface DoctorRepairPlan {
  readonly plan: OperationPlan<'doctor'>;
  readonly operations: readonly DoctorRepairOperation[];
  readonly authorizations: ReadonlyMap<string, DoctorRepairAuthorization>;
  readonly executableOperations: readonly ExecutableOperation[];
}

export interface DoctorRepairExecutionRequest {
  readonly plan: OperationPlan<'doctor'>;
  readonly authorizations: ReadonlyMap<string, DoctorRepairAuthorization>;
  readonly ports: DoctorRepairPorts;
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly signal?: AbortSignal;
}

/** Minimum local capabilities needed by automatic doctor repair adapters. */
export type DoctorRepairPorts = Pick<FileReadPort, 'pathKind' | 'readBytes'> &
  FileMetadataReadPort &
  FileModeWritePort &
  Pick<
    FileWritePort,
    'makeDir' | 'writeTextFile' | 'rename' | 'copyTree' | 'removeTree' | 'fsyncFile' | 'fsyncDir'
  > &
  Pick<ClockPort, 'wallNowIso'> &
  LockPort;

export type DoctorRepairExecutor = (
  request: DoctorRepairExecutionRequest,
) => Promise<readonly DoctorRepairResult[]>;

export type DoctorPorts = InventoryReadPorts & PathAccessPort & { readonly http: HttpPort };

export interface CheckRunContext {
  env: DoctorPorts;
  mode: CheckRunMode;
  tools: readonly SupportedTool[];
  scopes: readonly Scope[];
  /** Whether the caller explicitly selected a scope instead of using the default sweep. */
  scopeExplicit?: boolean;
  cwd: string;
  /** Resolved read-only artifact pair selected by the CLI; schemas and writes remain downstream. */
  artifactPair?: { readonly file: string; readonly lockfile: string };
  configuration: ResolvedRuntimeConfiguration;
  offline: boolean;
  /** Credential-free ref facts resolved by the application before exact repair replanning. */
  sourceResolutions?: readonly DoctorSourceResolution[];
  observation?: ObservationBundle;
  /** @deprecated Use observation. */
  logger?: Logger;
  signal?: AbortSignal;
}

export interface Check {
  readonly id: string;
  readonly severity: Severity;
  readonly runsIn: readonly CheckRunMode[];
  run(ctx: CheckRunContext): Promise<Finding[]>;
}

export interface CheckRunResult {
  findings: Finding[];
  counts: { ok: number; warning: number; error: number };
}
