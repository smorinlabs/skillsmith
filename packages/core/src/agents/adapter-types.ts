import type { Scope } from '../config/types.ts';
import type { InstallRecord } from '../detect/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { DetectionPorts, InventoryReadPorts, PlatformPaths } from '../ports/types.ts';
import type { Result } from '../result.ts';
import type { Origin } from '../skills/types.ts';
import type { ToolVerifier, VerifyMode } from '../verify/types.ts';
import type { Placement } from './placement-shared.ts';

export const TOOL_OPERATIONS = Object.freeze([
  'detect',
  'inventory-skills',
  'inventory-commands',
  'diagnostics',
  'install',
  'uninstall',
  'dev',
  'promote',
  'undo',
  'verify-static',
  'verify-deep',
  'plan',
  'apply',
  'sync',
  'update',
  'adapt',
] as const);

export type ToolOperation = (typeof TOOL_OPERATIONS)[number];
export type ToolCapabilityScope = Scope | 'custom' | 'artifact';

export interface ToolOperationFact {
  readonly supported: boolean;
  readonly scopes: readonly ToolCapabilityScope[];
  readonly remediation: string | null;
}

export interface ToolDescriptor<ToolId extends string = string> {
  readonly id: ToolId;
  readonly order: number;
  readonly capabilityVersion: number;
  readonly operations: Readonly<Record<ToolOperation, ToolOperationFact>>;
}

export interface SkillRootsCtx {
  readonly cwd: string;
  readonly configuration: import('../ports/types.ts').ResolvedRuntimeConfiguration;
}

/** Frozen, read-only surface supplied to adapter-owned inventory identity logic. */
export interface InventoryIdentitySurface {
  readonly name: string;
  readonly scope: Scope;
  readonly origin: Origin;
  readonly rootOrdinal: number;
  readonly root: string;
  readonly path: string;
  readonly realpath: string;
}

export type InventoryIdentity = (surface: InventoryIdentitySurface) => string;
export type InventoryCollisionResolver = (
  candidates: readonly InventoryIdentitySurface[],
) => string | null;

export interface InventoryBundle<ToolId extends string = string> {
  readonly tool: ToolId;
  readonly installHint: string;
  detect(
    env: DetectionPorts,
    signal?: AbortSignal,
  ): Promise<Result<InstallRecord[], SkillSmithError>>;
  getSkillRoots(env: PlatformPaths, scope: Scope, ctx: SkillRootsCtx): readonly string[];
  getCommandRoots(env: PlatformPaths, scope: Scope, ctx: SkillRootsCtx): readonly string[];
  getPluginSkillDir(installPath: string): string | null;
  getPluginCommandDir(installPath: string): string | null;
  /** Project the runtime-visible skill name. The raw scanned name is the compatible default. */
  readonly inventoryIdentity?: InventoryIdentity;
  /** Return the winning logical path, or null when precedence is intentionally ambiguous. */
  readonly resolveInventoryCollision?: InventoryCollisionResolver;
}

export interface VerificationGatePolicy {
  readonly installDeep: boolean;
  readonly promote: 'static' | 'static+deep';
  /** Optional only at the aggregate boundary for legacy custom-adapter compatibility. */
  readonly update?: 'static' | 'static+deep';
}

export interface VerificationRenderedFacts {
  readonly deepSkillCoverageSuffix: string | null;
  readonly installStaticNotice: ((skill: string) => string) | null;
}

export interface VerificationBundle<ToolId extends string = string> {
  readonly verifiedAgainst: string;
  readonly modes: readonly VerifyMode[];
  readonly verify: ToolVerifier<ToolId>;
  readonly gatePolicy: VerificationGatePolicy;
  readonly targetManifests: readonly string[];
  readonly renderedFacts: VerificationRenderedFacts;
}

export interface PlacementInventory {
  readonly placements: readonly Placement[];
  readonly duplicates: readonly string[];
  readonly currentRoot: string | null;
  readonly legacyRoot: string | null;
}

export interface PlacementResolution {
  readonly placement: Placement;
  readonly notices: readonly string[];
  readonly duplicateReason: string | null;
}

export interface PlacementRootFact {
  readonly path: string;
  readonly role: 'destination' | 'alternate';
}

export interface PlacementBundle {
  roots(env: PlatformPaths, scope: Scope, ctx: SkillRootsCtx): readonly string[];
  rootFacts?(env: PlatformPaths, scope: Scope, ctx: SkillRootsCtx): readonly PlacementRootFact[];
  standardRoots(env: PlatformPaths, ctx: SkillRootsCtx): readonly string[];
  list(env: InventoryReadPorts, ctx: SkillRootsCtx, storeRoot: string): Promise<PlacementInventory>;
  listScoped?(
    env: InventoryReadPorts,
    ctx: SkillRootsCtx,
    storeRoot: string,
    scope: Scope,
  ): Promise<PlacementInventory>;
  resolve(
    env: InventoryReadPorts,
    ctx: SkillRootsCtx,
    storeRoot: string,
    skill: string,
  ): Promise<PlacementResolution>;
  resolveScoped?(
    env: InventoryReadPorts,
    ctx: SkillRootsCtx,
    storeRoot: string,
    skill: string,
    scope: Scope,
  ): Promise<PlacementResolution>;
  noticeForRoot(root: string, inventory: PlacementInventory): string | null;
}

export interface RegisteredPlacementBundle extends PlacementBundle {
  rootFacts(env: PlatformPaths, scope: Scope, ctx: SkillRootsCtx): readonly PlacementRootFact[];
  listScoped(
    env: InventoryReadPorts,
    ctx: SkillRootsCtx,
    storeRoot: string,
    scope: Scope,
  ): Promise<PlacementInventory>;
  resolveScoped(
    env: InventoryReadPorts,
    ctx: SkillRootsCtx,
    storeRoot: string,
    skill: string,
    scope: Scope,
  ): Promise<PlacementResolution>;
}

export interface AdaptationBundle {
  readonly version: number;
}

export interface ToolAdapter<ToolId extends string = string> {
  readonly descriptor: ToolDescriptor<ToolId>;
  readonly inventory: InventoryBundle<ToolId>;
  readonly verification?: VerificationBundle<ToolId>;
  readonly placement?: PlacementBundle;
  readonly adaptation?: AdaptationBundle;
}

const fact = (
  scopes: readonly ToolCapabilityScope[],
  remediation: string | null,
): ToolOperationFact => ({ supported: remediation === null, scopes, remediation });

const READ_SCOPES = ['user', 'project', 'system', 'managed'] as const;
const WRITE_SCOPES = ['user', 'project', 'custom'] as const;

export const fullLifecycleOperations = (tool: string): ToolDescriptor['operations'] => ({
  detect: fact([], null),
  'inventory-skills': fact(READ_SCOPES, null),
  'inventory-commands': fact(READ_SCOPES, null),
  diagnostics: fact(READ_SCOPES, null),
  install: fact(WRITE_SCOPES, null),
  uninstall: fact(WRITE_SCOPES, null),
  dev: fact(WRITE_SCOPES, null),
  promote: fact(WRITE_SCOPES, null),
  undo: fact(WRITE_SCOPES, null),
  'verify-static': fact(['artifact'], null),
  'verify-deep': fact(['artifact'], null),
  plan: fact(WRITE_SCOPES, null),
  apply: fact(WRITE_SCOPES, null),
  sync: fact(WRITE_SCOPES, null),
  update: fact(WRITE_SCOPES, null),
  adapt: fact([], `${tool} adaptation is not available`),
});

export const readOnlyOperations = (tool: string): ToolDescriptor['operations'] => ({
  detect: fact([], null),
  'inventory-skills': fact(READ_SCOPES, null),
  'inventory-commands': fact(READ_SCOPES, null),
  diagnostics: fact(READ_SCOPES, null),
  install: fact([], `${tool} is read-only; choose claude-code or codex`),
  uninstall: fact([], `${tool} is read-only; choose claude-code or codex`),
  dev: fact([], `${tool} is read-only; choose claude-code or codex`),
  promote: fact([], `${tool} is read-only; choose claude-code or codex`),
  undo: fact([], `${tool} is read-only; choose claude-code or codex`),
  'verify-static': fact([], `${tool} has no registered static verifier`),
  'verify-deep': fact([], `${tool} has no registered deep verifier`),
  plan: fact([], `${tool} cannot participate in desired-state mutations`),
  apply: fact([], `${tool} cannot participate in desired-state mutations`),
  sync: fact([], `${tool} cannot participate in desired-state mutations`),
  update: fact([], `${tool} cannot participate in desired-state mutations`),
  adapt: fact([], `${tool} adaptation is not available`),
});
