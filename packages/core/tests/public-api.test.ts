import { describe, expect, test } from 'bun:test';
import * as core from '@skillsmith/core';
import pkg from '../package.json' with { type: 'json' };
import * as readApplications from '../src/application/read-services.ts';
import * as artifacts from '../src/artifacts/index.ts';
import * as status from '../src/status/index.ts';
import { runtimePorts } from './fixtures/runtime-ports.ts';

describe('@skillsmith/core public API', () => {
  test('exports the documented runtime symbols', () => {
    const expected = new Set([
      'VERSION',
      'defaultScanEnv',
      'noopLogger',
      'registry',
      'toolRegistry',
      'createToolRegistry',
      'TOOL_OPERATIONS',
      'listSupportedTools',
      'getAgent',
      'detectAll',
      'detectTool',
      'ok',
      'err',
      'isOk',
      'isErr',
      'map',
      'mapErr',
      'genericError',
      'unknownToolError',
      'configError',
      'loadConfig',
      'saveConfig',
      'getConfigPath',
      'findProjectConfig',
      'resolveExplicitFile',
      'CONFIG_KEYS',
      'SCOPES',
      'SUPPORTED_TOOLS',
      'parseSkillFrontmatter',
      'listSkills',
      'runChecks',
      'builtInChecks',
      'skillParseError',
      'runVerify',
      'verifyPlugin',
      'VERIFY_TOOLS',
      'VERIFIED_AGAINST',
      'runPromote',
      'runDev',
      'runRollback',
      'defaultFlipDeps',
      'FLIP_TOOLS',
      'runInstall',
      'runUninstall',
      'defaultInstallDeps',
      'defaultUninstallDeps',
      'parseSource',
      'defaultClockPort',
      'defaultIdPort',
      'defaultArtifactCoordinatorPorts',
      'CURRENT_APPLICATION_SERVICES',
      'runExportApplication',
      'runInitApplication',
      'runPlanApplication',
      'runApplyApplication',
      'runSyncApplication',
      'prepareInitOperationPlan',
      'observeInitManifest',
      'executePreparedInit',
      'observeExport',
      'classifyExport',
      'mergePortableCandidates',
      'prepareExportArtifacts',
      'prepareExportLedgerMigration',
      'previewExportEffects',
      'executeExportArtifacts',
      'OBSERVATION_EVENT_KINDS',
      'OPERATION_KINDS',
      'createOperationContext',
      'createChildOperationContext',
      'withOperationTarget',
      'nextOperationAttempt',
      'createObserverEvent',
      'createObservationEmitter',
      'noopObserver',
      'redactObservationValue',
      'containsSensitiveMaterial',
      'redactSensitiveString',
      'redactSensitiveValue',
      'HASH_SCHEMA_VERSION',
      'HASH_DOMAINS',
      'hashCanonicalInput',
      'parseArtifactDigest',
      'hashManifestSemantics',
      'hashManifestBytes',
      'LOCK_VERSION',
      'readPortableLockSource',
      'serializePortableLock',
      'hashPortableLock',
      'correlatePortableLock',
      'SOURCE_CONTENT_EXCLUSIONS_VERSION',
      'SOURCE_CONTENT_EXCLUSIONS_V1',
      'projectSourceContent',
      'serializeSourceContentProjection',
      'hashSourceContentV1',
      'ARTIFACT_LOCK_RETRY_DELAYS_MS',
      'ARTIFACT_CENTRAL_LOCK_STALE_MS',
      'ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS',
      'ARTIFACT_COMPATIBILITY_LOCK_STALE_MS',
      'ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS',
      'editManifestBytes',
      'INIT_MANIFEST_OPERATION_KINDS',
      'planInitManifest',
      'withArtifactGroupLock',
      'withArtifactPairExecutionAuthority',
      'commitArtifactPair',
      'recoverArtifactPair',
      'readCoordinatedArtifactPair',
      'artifactContractRegistry',
      'readManifestArtifact',
      'readLockArtifact',
      'readSavedPlanArtifact',
      'readLedgerArtifact',
      'readJournalArtifact',
      'writeSavedPlan',
      'planProjectConfigMigration',
      'selectReadableArtifactContext',
      'observePlanArtifacts',
      'resolvePlanInput',
      'createReconcilePlan',
      'createSavedPlan',
      'readStatus',
      'runStatusApplication',
      'EXECUTABLE_OPERATION_KINDS',
      'OPERATION_EXECUTION_OUTCOMES',
      'OPERATION_SELECTION_SOURCES',
      'PLANNING_DIAGNOSTIC_KINDS',
      'canonicalPlanningString',
      'compareExecutableOperations',
      'comparePlanChecks',
      'comparePlanningDiagnostics',
      'comparePlanningText',
      'createBoundedForceEffect',
      'createOperationExecutionResult',
      'createOperationGroupId',
      'createOperationId',
      'createOperationPairId',
      'createOperationPlan',
      'createPlanCheckId',
      'createPlanningDiagnosticId',
      'toCurrentCompatibilityAction',
      'scheduleOperationPlan',
      'createExecutionPrecondition',
      'validateExecutionPreconditions',
      'withExecutionLockHierarchy',
      'executeOperationPlan',
    ]);
    const actual = new Set(Object.keys(core));
    for (const k of expected) expect(actual.has(k)).toBe(true);
  });

  test('re-exports the portable artifact authority by identity', () => {
    for (const name of [
      'HASH_SCHEMA_VERSION',
      'HASH_DOMAINS',
      'hashCanonicalInput',
      'parseArtifactDigest',
      'hashManifestSemantics',
      'hashManifestBytes',
      'LOCK_VERSION',
      'readPortableLockSource',
      'serializePortableLock',
      'hashPortableLock',
      'correlatePortableLock',
      'SOURCE_CONTENT_EXCLUSIONS_VERSION',
      'SOURCE_CONTENT_EXCLUSIONS_V1',
      'projectSourceContent',
      'serializeSourceContentProjection',
      'hashSourceContentV1',
    ] as const) {
      expect(core[name], name).toBe(artifacts[name]);
    }
  });

  test('re-exports one mutation and redaction authority by identity', () => {
    for (const name of [
      'ARTIFACT_LOCK_RETRY_DELAYS_MS',
      'ARTIFACT_CENTRAL_LOCK_STALE_MS',
      'ARTIFACT_CENTRAL_LOCK_HEARTBEAT_MS',
      'ARTIFACT_COMPATIBILITY_LOCK_STALE_MS',
      'ARTIFACT_COMPATIBILITY_LOCK_HEARTBEAT_MS',
      'editManifestBytes',
      'INIT_MANIFEST_OPERATION_KINDS',
      'planInitManifest',
      'withArtifactGroupLock',
      'withArtifactPairExecutionAuthority',
      'commitArtifactPair',
      'recoverArtifactPair',
      'readCoordinatedArtifactPair',
    ] as const) {
      expect(core[name], name).toBe(artifacts[name]);
    }
    expect(core.redactObservationValue).toBe(core.redactSensitiveValue);
    expect(core.saveConfig.length).toBe(2);
    expect(core).not.toHaveProperty('saveConfigWithCoordinator');
  });

  test('re-exports the read-only artifact repository without its internal executor', () => {
    for (const name of [
      'artifactContractRegistry',
      'readManifestArtifact',
      'readLockArtifact',
      'readSavedPlanArtifact',
      'readLedgerArtifact',
      'readJournalArtifact',
      'planProjectConfigMigration',
    ] as const) {
      expect(core[name], name).toBe(artifacts[name]);
    }
    expect(core).not.toHaveProperty('executeProjectConfigMigration');
  });

  test('re-exports the status read, selection, and application authorities by identity', () => {
    expect(core.selectReadableArtifactContext).toBe(artifacts.selectReadableArtifactContext);
    expect(core.readStatus).toBe(status.readStatus);
    expect(core.runStatusApplication).toBe(readApplications.runStatusApplication);
    expect(core.CURRENT_READ_APPLICATIONS.status).toBe(readApplications.runStatusApplication);
  });

  test('does not expose internal sync preparation projections from the package root', () => {
    expect(core).not.toHaveProperty('prepareSyncStoreResourcesV1');
    expect(core).not.toHaveProperty('toSyncReportOperationV1');
  });

  test('exports the validated registry without breaking the 1.x inventory projection', () => {
    expect(core.toolRegistry.ids).toEqual(core.SUPPORTED_TOOLS);
    expect(core.toolRegistry.toolsFor('verify-static')).toEqual(core.VERIFY_TOOLS);
    expect(core.toolRegistry.toolsFor('install')).toEqual(core.FLIP_TOOLS);
    expect(core.TOOL_OPERATIONS).toContain('diagnostics');
    const codex = core.toolRegistry.get('codex');
    expect(codex).toBeDefined();
    if (codex === undefined) throw new Error('built-in codex adapter is missing');
    expect(codex.inventory).toBe(core.registry.codex);
    expect(core.createToolRegistry(core.toolRegistry.adapters).ids).toEqual(core.toolRegistry.ids);
  });

  test('VERSION matches packages/core/package.json', () => {
    expect(core.VERSION).toBe(pkg.version);
  });

  test('detectAll is callable with defaultScanEnv and returns a Result', async () => {
    const env = await core.defaultScanEnv();
    const r = await core.detectAll(runtimePorts(env));
    expect(typeof r.ok).toBe('boolean');
  });
});
