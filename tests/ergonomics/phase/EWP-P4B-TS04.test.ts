import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactDigest } from '../../../packages/core/src/artifacts/hash.ts';
import { deriveLedgerProjectRegistrations } from '../../../packages/core/src/artifacts/ledger-codec.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
} from '../../../packages/core/src/artifacts/ledger-types.ts';
import {
  type PortableLockSkillV1,
  readPortableLockSource,
  serializePortableLock,
} from '../../../packages/core/src/artifacts/lock.ts';
import {
  hashSourceContentV1,
  projectSourceContent,
} from '../../../packages/core/src/artifacts/source-content.ts';
import { ledgerV2Codec } from '../../../packages/core/src/contracts/v2/index.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
import {
  PRUNE_EXCLUSIONS,
  createPlanFixture,
  destroyPlanFixture,
  fileSnapshot,
  jsonReport,
  runPlanCli,
} from '../fixtures/p4b-plan/cases.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is UnknownRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

const contentHashOf = async (path: string): Promise<ArtifactDigest> => {
  const projected = await projectSourceContent(await defaultRuntimePorts(), path);
  if (!projected.ok) throw new Error(projected.error.message);
  const hashed = hashSourceContentV1(projected.value);
  if (!hashed.ok) throw new Error(hashed.error.message);
  return hashed.value;
};

const pinFor = (name: string, contentHash: ArtifactDigest): PortableLockSkillV1 => ({
  name,
  source: `fixture.invalid/acme/skills//skills/${name}`,
  requestedRef: null,
  resolvedSha: 'a'.repeat(40),
  sourcePath: `skills/${name}`,
  contentHash,
});

const pairFor = (
  pin: PortableLockSkillV1,
  placementPath: string,
  storePath: string,
  source = `https://${pin.source}`,
): LedgerPairV1Dto => ({
  placementPath,
  mode: 'pinned',
  dev: null,
  pinned: {
    storePath,
    rev: pin.resolvedSha.slice(0, 12),
    gitSha: pin.resolvedSha,
    dirty: false,
    contentHash: pin.contentHash,
    snapshotAt: '2026-07-19T00:00:00.000Z',
    verify: 'passed',
    placement: 'copy',
  },
  origin: {
    source,
    host: 'fixture.invalid',
    repo: source.includes('/other/') ? 'other/skills' : 'acme/skills',
    skillPath: pin.sourcePath,
    refRequested: pin.requestedRef,
    refResolved: pin.resolvedSha,
    pin: true,
    installedAt: '2026-07-19T00:00:00.000Z',
  },
});

const writeLedger = async (path: string, model: LedgerModel): Promise<void> => {
  const encoded = ledgerV2Codec.encode(model);
  if (!encoded.ok) throw new Error(`${encoded.error.message}: ${JSON.stringify(encoded.error)}`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, encoded.value);
};

describe('EWP-P4B-TS04', () => {
  test('prune removes exactly one ledger-owned placement and preserves every excluded authority boundary', async () => {
    expect(PRUNE_EXCLUSIONS).toEqual([
      'unmanaged',
      'undeclared',
      'unselected-tool',
      'unselected-scope',
      'other-project',
      'wrong-source',
      'unknown-adapter',
      'custom-root',
      'filter-to-zero',
    ]);

    const fixture = await createPlanFixture([{ name: 'alpha', tool: 'codex' }]);
    const ledgerPath = join(fixture.data, 'skillsmith', 'placements.json');
    const otherProject = join(fixture.root, 'other-project');
    const skillFiles = {
      owned: join(fixture.home, '.agents', 'skills', 'owned-prune', 'SKILL.md'),
      unmanaged: join(fixture.home, '.agents', 'skills', 'unmanaged', 'SKILL.md'),
      undeclared: join(fixture.home, '.agents', 'skills', 'undeclared', 'SKILL.md'),
      unselectedTool: join(fixture.home, '.claude', 'skills', 'unselected-tool', 'SKILL.md'),
      unselectedScope: join(fixture.cwd, '.agents', 'skills', 'unselected-scope', 'SKILL.md'),
      otherProject: join(otherProject, '.agents', 'skills', 'other-project', 'SKILL.md'),
      wrongSource: join(fixture.home, '.agents', 'skills', 'wrong-source', 'SKILL.md'),
      unknownAdapter: join(fixture.root, 'unknown-adapter', 'unknown-adapter', 'SKILL.md'),
      customRoot: join(fixture.root, 'custom-root', 'custom-root', 'SKILL.md'),
    } as const;
    for (const [label, path] of Object.entries(skillFiles)) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `canary:${label}\n`);
    }

    const hashes = Object.fromEntries(
      await Promise.all(
        Object.entries(skillFiles).map(async ([label, path]) => [
          label,
          await contentHashOf(join(path, '..')),
        ]),
      ),
    ) as Record<keyof typeof skillFiles, ArtifactDigest>;
    const pins = {
      owned: pinFor('owned-prune', hashes.owned),
      unmanaged: pinFor('unmanaged', hashes.unmanaged),
      unselectedTool: pinFor('unselected-tool', hashes.unselectedTool),
      unselectedScope: pinFor('unselected-scope', hashes.unselectedScope),
      otherProject: pinFor('other-project', hashes.otherProject),
      wrongSource: pinFor('wrong-source', hashes.wrongSource),
      unknownAdapter: pinFor('unknown-adapter', hashes.unknownAdapter),
      customRoot: pinFor('custom-root', hashes.customRoot),
    } as const;

    const originalLock = readPortableLockSource(await readFile(fixture.lock));
    if (!originalLock.ok) throw new Error(originalLock.error.message);
    const expandedLock = serializePortableLock({
      ...originalLock.value,
      skills: [
        originalLock.value.skills[0] as PortableLockSkillV1,
        ...Object.values(pins),
      ].toSorted((left, right) => left.name.localeCompare(right.name)),
    });
    if (!expandedLock.ok) throw new Error(expandedLock.error.message);
    await writeFile(fixture.lock, expandedLock.value);

    const storeRoot = join(fixture.data, 'skillsmith', 'store');
    const userSkills: Record<string, { tools: Record<string, LedgerPairV1Dto> }> = {
      'owned-prune': {
        tools: {
          codex: pairFor(
            pins.owned,
            join(skillFiles.owned, '..'),
            join(storeRoot, 'acme', `skills@${pins.owned.resolvedSha.slice(0, 12)}`, 'owned-prune'),
          ),
        },
      },
      'wrong-source': {
        tools: {
          codex: pairFor(
            pins.wrongSource,
            join(skillFiles.wrongSource, '..'),
            join(storeRoot, 'wrong-source'),
            'https://fixture.invalid/other/skills//skills/wrong-source',
          ),
        },
      },
      'unselected-tool': {
        tools: {
          'claude-code': pairFor(
            pins.unselectedTool,
            join(skillFiles.unselectedTool, '..'),
            join(storeRoot, 'unselected-tool'),
          ),
        },
      },
      'unknown-adapter': {
        tools: {
          'unknown-adapter': pairFor(
            pins.unknownAdapter,
            join(skillFiles.unknownAdapter, '..'),
            join(storeRoot, 'unknown-adapter'),
          ),
        },
      },
      'custom-root': {
        tools: {
          codex: pairFor(
            pins.customRoot,
            join(skillFiles.customRoot, '..'),
            join(storeRoot, 'custom-root'),
          ),
        },
      },
    };
    const projects: LedgerModel['projects'] = {
      [fixture.cwd]: {
        skills: {
          'unselected-scope': {
            tools: {
              codex: pairFor(
                pins.unselectedScope,
                join(skillFiles.unselectedScope, '..'),
                join(storeRoot, 'unselected-scope'),
              ),
            },
          },
        },
      },
      [otherProject]: {
        skills: {
          'other-project': {
            tools: {
              codex: pairFor(
                pins.otherProject,
                join(skillFiles.otherProject, '..'),
                join(storeRoot, 'other-project'),
              ),
            },
          },
        },
      },
    };
    const ledger: LedgerModel = {
      updatedAt: '2026-07-19T00:00:00.000Z',
      skills: userSkills,
      projects,
      projectRegistrations: deriveLedgerProjectRegistrations(projects),
      transactions: {},
      history: [],
    };
    await writeLedger(ledgerPath, ledger);

    const canaries = Object.values(skillFiles);
    const stateFiles = [fixture.manifest, fixture.lock, ledgerPath, ...canaries];
    const before = await fileSnapshot(stateFiles);

    try {
      const product = await runPlanCli(fixture, [
        'plan',
        '--file',
        fixture.manifest,
        '--prune',
        '--tool',
        'codex',
        '--json',
      ]);
      const report = jsonReport(product, 0, 'ledger-owned prune authority');
      const operations = records(report.operations);
      const removes = operations.filter((row) => row.kind === 'remove');
      expect(removes).toHaveLength(1);
      const remove = removes[0] as UnknownRecord;
      expect(remove).toMatchObject({
        kind: 'remove',
        skill: 'owned-prune',
        tool: 'codex',
        scope: 'user',
        before: {
          kind: 'placement',
          classification: 'pinned',
          representation: 'copy',
          contentHash: hashes.owned,
          resource: { location: { kind: 'machine-bound', path: join(skillFiles.owned, '..') } },
        },
        after: {
          kind: 'absent',
          resource: { location: { kind: 'machine-bound', path: join(skillFiles.owned, '..') } },
        },
        reason: { code: 'prune-lock-owned-placement' },
        mutates: { live: true, manifest: false, lock: false, ledger: true },
        conflict: null,
      });
      const preconditionIds = remove.preconditionIds as readonly string[];
      expect(preconditionIds.length).toBeGreaterThan(0);
      expect(preconditionIds.every((id) => /^precondition:v1:[0-9a-f]{64}$/u.test(id))).toBeTrue();
      expect(preconditionIds).toEqual(preconditionIds.toSorted());
      expect(new Set(preconditionIds).size).toBe(preconditionIds.length);
      const checks = records(report.checks);
      const operationId = remove.operationId as string;
      const operationIds = new Set(operations.map((operation) => operation.operationId));
      for (const operation of operations) {
        for (const dependencyId of operation.dependsOn as readonly string[]) {
          expect(operationIds.has(dependencyId)).toBeTrue();
        }
      }
      for (const check of checks) {
        for (const referencedOperationId of check.operationIds as readonly string[]) {
          expect(operationIds.has(referencedOperationId)).toBeTrue();
        }
      }
      const referencingChecks = checks.filter(
        (check) =>
          Array.isArray(check.operationIds) &&
          (check.operationIds as readonly unknown[]).includes(operationId),
      );
      expect(referencingChecks.length).toBeGreaterThan(0);
      const checkIds = new Set(checks.map((check) => check.checkId));
      for (const checkId of remove.requiredCheckIds as readonly string[]) {
        expect(checkIds.has(checkId)).toBeTrue();
      }

      expect(
        removes.map((row) => row.skill),
        'only exact lock + ledger + live ownership grants prune authority',
      ).toEqual(['owned-prune']);
      expect(report.summary).toMatchObject({
        operations: operations.length,
        operationKinds: { remove: 1 },
      });
      expect(await fileSnapshot(stateFiles)).toEqual(before);
      for (const [label, path] of Object.entries(skillFiles)) {
        expect(await readFile(path, 'utf8')).toBe(`canary:${label}\n`);
      }

      const zero = await runPlanCli(fixture, [
        'plan',
        '--file',
        fixture.manifest,
        '--prune',
        '--tool',
        'opencode',
        '--json',
      ]);
      expect(records(jsonReport(zero, 0, 'filter-to-zero prune').operations)).toHaveLength(0);
      expect(await fileSnapshot(stateFiles)).toEqual(before);
    } finally {
      await destroyPlanFixture(fixture);
    }
  });
});
