import { join } from 'node:path';
import { SUPPORTED_TOOLS } from '../../agents/types.ts';
import {
  type ArtifactDigest,
  hashCanonicalInput,
  hashManifestSemantics,
} from '../../artifacts/hash.ts';
import type { LedgerModel } from '../../artifacts/ledger-types.ts';
import {
  type PortableLockSkillV1,
  type PortableLockV1,
  correlatePortableLock,
  serializePortableLock,
} from '../../artifacts/lock.ts';
import {
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
} from '../../artifacts/repository.ts';
import type { NormalizedManifestV1 } from '../../artifacts/types.ts';
import { selectBoundedHistory } from '../../place/history.ts';
import { ledgerPathOf } from '../../place/paths.ts';
import type { OperationDigest, OperationLockSnapshot } from '../../planning/types.ts';
import type { DoctorRepairArtifactSummary, DoctorRepairAuthorization, Finding } from '../types.ts';
import type { Check } from '../types.ts';

const encoder = new TextEncoder();
const planningDigest = (value: ArtifactDigest): OperationDigest =>
  value as unknown as OperationDigest;

const lockSnapshot = (lock: {
  readonly version: 1;
  readonly hashSchemaVersion: 1;
  readonly manifestHash: ArtifactDigest;
  readonly skills: readonly {
    readonly name: string;
    readonly source: string;
    readonly requestedRef: string | null;
    readonly resolvedSha: string;
    readonly sourcePath: string;
    readonly contentHash: ArtifactDigest;
  }[];
}): OperationLockSnapshot => ({
  version: lock.version,
  hashSchemaVersion: lock.hashSchemaVersion,
  manifestHash: planningDigest(lock.manifestHash),
  skills: lock.skills.map((skill) => ({
    ...skill,
    contentHash: planningDigest(skill.contentHash),
  })),
});

const present = (
  schemaVersion: number | null,
  byteRevision: ArtifactDigest,
  semanticRevision: ArtifactDigest | null,
): DoctorRepairArtifactSummary => ({
  state: 'present',
  schemaVersion,
  byteRevision,
  semanticRevision,
});

const absent = (): DoctorRepairArtifactSummary => ({
  state: 'absent',
  schemaVersion: null,
  byteRevision: null,
  semanticRevision: null,
});

const location = (path: string) => ({ kind: 'machine-bound' as const, path });

const lockSource = (source: NormalizedManifestV1['skills'][number]['source']): string =>
  `${source.host}/${source.repository}${source.path === null ? '' : `//${source.path}`}`;

const sourceResolution = (
  ctx: Parameters<Check['run']>[0],
  skill: NormalizedManifestV1['skills'][number],
): string | null =>
  ctx.sourceResolutions?.find(
    (candidate) =>
      candidate.skillName === skill.name &&
      candidate.remoteUrl === `https://${skill.source.host}/${skill.source.repository}.git` &&
      candidate.ref === skill.ref,
  )?.resolvedSha ?? null;

const sourceResolutionFinding = (
  ctx: Parameters<Check['run']>[0],
  skill: NormalizedManifestV1['skills'][number],
  path: string,
  requestResolution: boolean,
): Finding => ({
  checkId: 'lock-regeneration',
  severity: 'error',
  title: 'lock regeneration requires source resolution',
  message: 'the selected lock cannot be regenerated from local facts alone',
  path,
  operation: 'write-lock',
  reason: `exact source facts are unavailable for ${skill.name}`,
  remediation: 'rerun doctor online after verifying credential-free source access',
  ...(!ctx.offline ? { failureClass: 'source' as const } : {}),
  ...(requestResolution
    ? {
        sourceResolution: {
          skillName: skill.name,
          remoteUrl: `https://${skill.source.host}/${skill.source.repository}.git`,
          ref: skill.ref,
        },
      }
    : {}),
});

const manifestSnapshot = (manifest: NormalizedManifestV1) => ({
  version: 1 as const,
  defaults:
    manifest.defaults === undefined
      ? null
      : {
          tools: manifest.defaults.tools ?? null,
          scope: manifest.defaults.scope ?? null,
          path: manifest.defaults.path ?? null,
        },
  registry: manifest.registry === undefined ? null : { default: manifest.registry.default ?? null },
  skills: manifest.skills.map((skill) => ({
    name: skill.name,
    source: skill.source,
    ref: skill.ref,
    tools: skill.tools,
    scope: skill.scope,
    placement: skill.placement,
    path: skill.path,
  })),
});

const artifactFailure = (
  checkId: string,
  path: string,
  message: string,
  permission: boolean,
  upgrade: boolean,
): Finding => ({
  checkId,
  severity: 'error',
  title: upgrade ? 'artifact requires a newer SkillSmith' : 'artifact state is invalid',
  message,
  path,
  remediation: upgrade
    ? 'upgrade SkillSmith before reading or repairing this artifact'
    : 'repair the artifact manually, then rerun doctor',
  failureClass: permission ? 'permission' : 'state',
});

const pendingJournalFindings = (model: LedgerModel): Finding[] => {
  const findings: Finding[] = [];
  const visit = (skills: LedgerModel['skills']): void => {
    for (const entry of Object.values(skills)) {
      for (const [tool, unknownPair] of Object.entries(entry.tools)) {
        const supportedTool = SUPPORTED_TOOLS.find((candidate) => candidate === tool);
        const pair = unknownPair as {
          placementPath?: string;
          journal?: { txId?: string; phase?: string } | null;
        };
        if (pair.journal === null || pair.journal === undefined) continue;
        findings.push({
          checkId: 'journal-pending',
          severity: 'warning',
          title: 'placement transaction is pending',
          message: 'an interrupted placement transaction requires same-operation recovery',
          ...(supportedTool === undefined ? {} : { tool: supportedTool }),
          ...(pair.placementPath === undefined ? {} : { path: pair.placementPath }),
          reason: `pending transaction ${pair.journal.txId ?? 'unknown'} at ${pair.journal.phase ?? 'unknown'}`,
          remediation: 'rerun the same operation or use the validated pending-abort workflow',
        });
      }
    }
  };
  visit(model.skills);
  for (const project of Object.values(model.projects)) visit(project.skills);
  return findings;
};

const ledgerFindings = async (ctx: Parameters<Check['run']>[0]): Promise<Finding[]> => {
  const dataDirectory = ctx.configuration.skillsmithHome ?? join(ctx.env.xdg.data, 'skillsmith');
  const path = ledgerPathOf(dataDirectory);
  const read = await readLedgerArtifact(ctx.env, path);
  if (!read.ok) {
    return [
      artifactFailure(
        'ledger-state',
        path,
        read.error.message,
        read.error.exitCode === 6,
        read.error.reason === 'unsupported-version',
      ),
    ];
  }
  if (read.value.state === 'absent') return [];
  const findings = pendingJournalFindings(read.value.model);
  if (read.value.sourceVersion === 1 && read.value.migration?.kind === 'ledger-v1-to-v2') {
    const migration = read.value.migration;
    const authorization: DoctorRepairAuthorization = {
      kind: 'migrate-ledger',
      artifact: 'ledger',
      path,
      before: present(1, migration.sourceByteRevision, migration.sourceSemanticRevision),
      after: present(2, migration.targetByteRevision, migration.targetSemanticRevision),
      targetSource: migration.targetCanonicalSource,
      beforeImage: {
        kind: 'ledger',
        projectRoot: null,
        schemaVersion: 1,
        byteHash: planningDigest(migration.sourceByteRevision),
        semanticHash: planningDigest(migration.sourceSemanticRevision),
      },
      afterImage: {
        kind: 'ledger',
        projectRoot: null,
        schemaVersion: 2,
        byteHash: planningDigest(migration.targetByteRevision),
        semanticHash: planningDigest(migration.targetSemanticRevision),
      },
      ledgerMigration: migration,
    };
    findings.unshift({
      checkId: 'ledger-migration',
      severity: 'info',
      title: 'ledger migration is pending',
      message: 'the selected supported v1 ledger remains readable but current mutations require v2',
      path,
      operation: 'migrate-ledger',
      remediation: "run 'skillsmith doctor --fix' to migrate the selected ledger",
      repair: authorization,
    });
  }
  if (read.value.sourceVersion === 2 && read.value.model.history.length > 256) {
    const selected = selectBoundedHistory(read.value.model);
    let cleanupTransaction = selected.ok
      ? (selected.value.cleanupVictim?.transactionId ?? null)
      : null;
    if (cleanupTransaction === null) {
      for (const journal of read.value.model.history) {
        const backup = journal.actual.retained.find((resource) => resource.role === 'backup');
        if (backup !== undefined && (await ctx.env.pathKind(backup.path)) === 'absent') {
          cleanupTransaction = journal.transactionId;
          break;
        }
      }
    }
    if (cleanupTransaction !== null) {
      findings.push({
        checkId: 'history-cleanup-tombstone',
        severity: 'error',
        title: 'retention cleanup is pending',
        message: 'a deterministic over-capacity history victim has retained cleanup work',
        reason: `retention cleanup for ${cleanupTransaction}`,
        remediation: 'verify the owned backup and rerun the same cleanup operation',
      });
    }
  }
  return findings;
};

const projectFindings = async (ctx: Parameters<Check['run']>[0]): Promise<Finding[]> => {
  const pair = ctx.artifactPair;
  if (pair === undefined) return [];
  const manifest = await readManifestArtifact(ctx.env, pair.file);
  if (!manifest.ok) {
    return [
      artifactFailure(
        'project-artifact-state',
        pair.file,
        manifest.error.message,
        manifest.error.exitCode === 6,
        manifest.error.reason === 'unsupported-version',
      ),
    ];
  }
  if (manifest.value.state === 'absent') return [];
  const findings: Finding[] = [];
  if (
    manifest.value.sourceVersion === 'legacy' &&
    manifest.value.migration?.kind === 'migrate-project-config'
  ) {
    const migration = manifest.value.migration;
    const authorization: DoctorRepairAuthorization = {
      kind: 'migrate-project-config',
      artifact: 'manifest',
      path: pair.file,
      before: present(null, migration.expectedByteRevision, migration.expectedSemanticRevision),
      after: present(1, migration.resultByteRevision, migration.resultSemanticRevision),
      targetSource: migration.resultSource,
      beforeImage: {
        kind: 'manifest',
        location: location(pair.file),
        shape: 'legacy',
        version: 1,
        byteHash: planningDigest(migration.expectedByteRevision),
        semanticHash: planningDigest(migration.expectedSemanticRevision),
        value: manifestSnapshot(manifest.value.model),
      },
      afterImage: {
        kind: 'manifest',
        location: location(pair.file),
        shape: 'canonical',
        version: 1,
        byteHash: planningDigest(migration.resultByteRevision),
        semanticHash: planningDigest(migration.resultSemanticRevision),
        value: manifestSnapshot(manifest.value.model),
      },
      projectMigration: migration,
      artifactPair: pair,
    };
    findings.push({
      checkId: 'project-config-migration',
      severity: 'info',
      title: 'project configuration migration is pending',
      message: 'the exact supported legacy project configuration can be migrated losslessly',
      path: pair.file,
      operation: 'migrate-project-config',
      remediation: `run 'skillsmith doctor --fix --file "${pair.file}" --lockfile "${pair.lockfile}"' to migrate the selected project configuration`,
      repair: authorization,
    });
  }

  const lockKind = await ctx.env.pathKind(pair.lockfile);
  if (lockKind === 'absent' && findings.some((finding) => finding.repair !== undefined)) {
    return findings;
  }
  const lock = await readLockArtifact(ctx.env, pair.lockfile);
  const relationship =
    lock.ok && lock.value.state === 'present'
      ? correlatePortableLock(manifest.value.model, lock.value.model)
      : null;
  if (lock.ok && lock.value.state === 'present' && relationship?.state === 'current') {
    return findings;
  }
  let targetLock: PortableLockV1;
  if (manifest.value.model.skills.length > 0) {
    const unresolved = manifest.value.model.skills.filter(
      (skill) => sourceResolution(ctx, skill) === null,
    );
    if (unresolved.length > 0) {
      findings.push(
        ...unresolved.map((skill) => sourceResolutionFinding(ctx, skill, pair.lockfile, true)),
      );
      return findings;
    }
    if (!lock.ok || lock.value.state !== 'present') {
      findings.push(
        ...manifest.value.model.skills.map((skill) =>
          sourceResolutionFinding(ctx, skill, pair.lockfile, false),
        ),
      );
      return findings;
    }
    const currentByName = new Map(lock.value.model.skills.map((skill) => [skill.name, skill]));
    const targetSkills: PortableLockSkillV1[] = [];
    const incomplete: NormalizedManifestV1['skills'][number][] = [];
    for (const skill of manifest.value.model.skills) {
      const current = currentByName.get(skill.name);
      const resolvedSha = sourceResolution(ctx, skill);
      if (
        current === undefined ||
        resolvedSha === null ||
        current.source !== lockSource(skill.source) ||
        current.sourcePath !== (skill.source.path ?? '.') ||
        current.resolvedSha !== resolvedSha
      ) {
        incomplete.push(skill);
        continue;
      }
      targetSkills.push({
        name: skill.name,
        source: lockSource(skill.source),
        requestedRef: skill.ref,
        resolvedSha,
        sourcePath: skill.source.path ?? '.',
        contentHash: current.contentHash,
      });
    }
    if (incomplete.length > 0 || targetSkills.length !== manifest.value.model.skills.length) {
      findings.push(
        ...incomplete.map((skill) => sourceResolutionFinding(ctx, skill, pair.lockfile, false)),
      );
      return findings;
    }
    targetLock = {
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(manifest.value.model),
      skills: targetSkills,
    };
  } else {
    targetLock = {
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(manifest.value.model),
      skills: [],
    };
  }
  const target = serializePortableLock(targetLock);
  const targetSemantic = target.ok ? hashCanonicalInput('lock-canonical', 1, target.value) : target;
  const targetBytes = target.ok
    ? hashCanonicalInput('resource', 1, encoder.encode(target.value))
    : target;
  if (!target.ok || !targetSemantic.ok || !targetBytes.ok) {
    return [
      ...findings,
      artifactFailure(
        'lock-regeneration',
        pair.lockfile,
        'lock repair planning failed',
        false,
        false,
      ),
    ];
  }
  let beforeSummary: DoctorRepairArtifactSummary;
  let beforeImage: DoctorRepairAuthorization['beforeImage'];
  if (lockKind === 'absent') {
    beforeSummary = absent();
    beforeImage = {
      kind: 'absent',
      resource: { kind: 'lock', location: location(pair.lockfile) },
    };
  } else if (lock.ok && lock.value.state === 'present') {
    beforeSummary = present(
      lock.value.sourceVersion === 'legacy' ? null : lock.value.sourceVersion,
      lock.value.byteRevision,
      lock.value.semanticRevision,
    );
    beforeImage = {
      kind: 'lock',
      location: location(pair.lockfile),
      version: 1,
      canonicalHash: planningDigest(lock.value.semanticRevision ?? lock.value.byteRevision),
      value: lockSnapshot(lock.value.model),
    };
  } else {
    let bytes: Uint8Array;
    try {
      bytes = await ctx.env.readBytes(pair.lockfile);
    } catch {
      return [
        ...findings,
        artifactFailure('lock-regeneration', pair.lockfile, 'lock could not be read', true, false),
      ];
    }
    const beforeRevision = hashCanonicalInput('resource', 1, bytes);
    if (!beforeRevision.ok) return findings;
    beforeSummary = present(null, beforeRevision.value, null);
    beforeImage = {
      kind: 'absent',
      resource: { kind: 'lock', location: location(pair.lockfile) },
    };
  }
  const authorization: DoctorRepairAuthorization = {
    kind: 'write-lock',
    artifact: 'lock',
    path: pair.lockfile,
    before: beforeSummary,
    after: present(1, targetBytes.value, targetSemantic.value),
    targetSource: target.value,
    beforeImage,
    afterImage: {
      kind: 'lock',
      location: location(pair.lockfile),
      version: 1,
      canonicalHash: planningDigest(targetSemantic.value),
      value: lockSnapshot(targetLock),
    },
    artifactPair: pair,
    targetLock,
  };
  findings.push({
    checkId: 'lock-regeneration',
    severity: 'info',
    title: 'portable lock regeneration is available',
    message: 'the selected noncanonical or stale lock has one canonical local repair',
    path: pair.lockfile,
    operation: 'write-lock',
    remediation: `run 'skillsmith doctor --fix --file "${pair.file}" --lockfile "${pair.lockfile}"' to regenerate the selected lock`,
    repair: authorization,
  });
  return findings;
};

export const artifactState: Check = {
  id: 'artifact-state',
  severity: 'error',
  runsIn: ['doctor'],
  run: async (ctx) => [...(await ledgerFindings(ctx)), ...(await projectFindings(ctx))],
};
