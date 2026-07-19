import { lstat, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { hashManifestSemantics } from '../../../../packages/core/src/artifacts/hash.ts';
import {
  type PortableLockV1,
  serializePortableLock,
} from '../../../../packages/core/src/artifacts/lock.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../../packages/core/src/artifacts/manifest.ts';
import {
  hashSourceContentV1,
  projectSourceContent,
} from '../../../../packages/core/src/artifacts/source-content.ts';
import { defaultRuntimePorts } from '../../../../packages/core/src/ports/default.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../../packages/core/tests/fixtures/acquire/remote.ts';
import {
  type CliProduct,
  type PlanFixture,
  createPlanFixture,
  destroyPlanFixture,
  fileSnapshot,
  jsonReport,
  runPlanCli,
} from '../p4b-plan/cases.ts';

export const APPLY_EQUIVALENCE_VIEWS = Object.freeze([
  'plan',
  'plan-check',
  'apply-dry-run',
  'apply-check',
] as const);

export const SAVED_PLAN_STALE_DOMAINS = Object.freeze([
  'manifest-semantic',
  'lock-canonical',
  'resource',
  'selection-set',
  'capability-version',
  'executor-schema',
  'hash-schema',
] as const);

export const APPLY_PORTABILITY_MATRIX = Object.freeze([
  'portable-zero-local-path',
  'machine-bound-reasons',
  'machine-bound-exact-context',
  'cross-context-refusal',
  'nested-canary-redaction',
] as const);

export const APPLY_SECRET_CANARIES = Object.freeze([
  'P17_SECRET_CANARY_APPLY_URL',
  'P17_SECRET_CANARY_APPLY_ENV',
  'P17_SECRET_CANARY_APPLY_NESTED_ERROR',
] as const);

export interface ApplyFixture extends PlanFixture {
  readonly plan: string;
  readonly skillsmithHome: string;
  readonly ledger: string;
  readonly store: string;
  readonly live: {
    readonly user: string;
    readonly project: string;
  };
}

export interface RemoteApplyFixture extends ApplyFixture {
  readonly remote: RemoteFixture;
  readonly skill: {
    readonly name: 'lint';
    readonly source: 'fixture.invalid/acme/single//tools/deep/skills/lint';
    readonly sourcePath: string;
    readonly livePath: string;
  };
}

type JsonRecord = Record<string, unknown>;

const asApplyFixture = (fixture: PlanFixture): ApplyFixture => {
  const skillsmithHome = join(fixture.data, 'skillsmith');
  return {
    ...fixture,
    plan: fixture.out,
    skillsmithHome,
    ledger: join(skillsmithHome, 'placements.json'),
    store: join(skillsmithHome, 'store'),
    live: {
      user: join(fixture.home, '.agents', 'skills'),
      project: join(fixture.cwd, '.agents', 'skills'),
    },
  };
};

export const createApplyFixture = async (
  skills: Parameters<typeof createPlanFixture>[0] = [],
  options: Parameters<typeof createPlanFixture>[1] = {},
): Promise<ApplyFixture> => asApplyFixture(await createPlanFixture(skills, options));

export const destroyApplyFixture = destroyPlanFixture;

const contentHashAt = async (path: string) => {
  const projected = await projectSourceContent(await defaultRuntimePorts(), path);
  if (!projected.ok) throw new Error(projected.error.message);
  const hashed = hashSourceContentV1(projected.value);
  if (!hashed.ok) throw new Error(hashed.error.message);
  return hashed.value;
};

export const createRemoteApplyFixture = async (): Promise<RemoteApplyFixture> => {
  const [base, remote] = await Promise.all([
    createApplyFixture([], { writeLock: false }),
    buildRemoteFixture(),
  ]);
  try {
    const name = 'lint' as const;
    const source = 'fixture.invalid/acme/single//tools/deep/skills/lint' as const;
    const sourcePath = join(remote.base, 'single-work', 'tools', 'deep', 'skills', name);
    const manifest = `${[
      '# P4B apply fixture: public identity is fixture.invalid; Git transport is local.',
      'version = 1',
      '',
      '[[skills]]',
      `name = "${name}"`,
      `source = "${source}"`,
      'tools = ["codex"]',
      'scope = "user"',
      'placement = "copy"',
      '',
    ].join('\n')}\n`;
    const lock: PortableLockV1 = {
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: (() => {
        // Keep fixture parsing on the same public artifact seam as the planner.
        const sourceDocument = readManifestSource(manifest);
        if (!sourceDocument.ok) throw new Error(sourceDocument.error.message);
        const normalized = normalizeManifestDocument(sourceDocument.value);
        if (!normalized.ok) throw new Error(normalized.error.message);
        return hashManifestSemantics(normalized.value);
      })(),
      skills: [
        {
          name,
          source,
          requestedRef: null,
          resolvedSha: remote.singleHead,
          sourcePath: 'tools/deep/skills/lint',
          contentHash: await contentHashAt(sourcePath),
        },
      ],
    };
    const encodedLock = serializePortableLock(lock);
    if (!encodedLock.ok) throw new Error(encodedLock.error.message);
    await Promise.all([
      writeFile(base.manifest, manifest),
      writeFile(base.lock, encodedLock.value),
    ]);
    return {
      ...base,
      remote,
      env: Object.freeze({ ...base.env, ...remote.gitRewriteEnv }),
      skill: {
        name,
        source,
        sourcePath,
        livePath: join(base.live.user, name),
      },
    };
  } catch (error) {
    await Promise.all([destroyApplyFixture(base), destroyRemoteFixture(remote)]);
    throw error;
  }
};

export const destroyRemoteApplyFixture = async (fixture: RemoteApplyFixture): Promise<void> => {
  await Promise.all([destroyApplyFixture(fixture), destroyRemoteFixture(fixture.remote)]);
};

export const runApplyCli = runPlanCli;

export const jsonApplyReport = (
  product: CliProduct,
  expectedExit: number,
  label: string,
): JsonRecord => jsonReport(product, expectedExit, label);

export const createReviewedPlan = async (
  fixture: ApplyFixture,
  options: Readonly<{ machineBound?: boolean; args?: readonly string[] }> = {},
): Promise<JsonRecord> => {
  const product = await runApplyCli(fixture, [
    'plan',
    ...(options.machineBound ? ['--file', fixture.manifest] : []),
    '--locked',
    '--out',
    fixture.plan,
    ...(options.args ?? []),
    '--json',
  ]);
  jsonApplyReport(product, 0, 'create reviewed apply plan');
  return JSON.parse(await readFile(fixture.plan, 'utf8')) as JsonRecord;
};

export const writeCanonicalPlanVariant = async (
  source: string,
  destination: string,
  mutate: (draft: JsonRecord) => void,
): Promise<JsonRecord> => {
  const draft = JSON.parse(await readFile(source, 'utf8')) as JsonRecord;
  mutate(draft);
  await writeFile(destination, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  return draft;
};

const snapshotPath = async (
  path: string,
  label: string,
  output: Record<string, unknown>,
): Promise<void> => {
  try {
    const metadata = await lstat(path);
    const mode = metadata.mode & 0o777;
    if (metadata.isSymbolicLink()) {
      output[label] = { kind: 'symlink', mode, target: await readlink(path) };
      return;
    }
    if (metadata.isFile()) {
      output[label] = { kind: 'file', mode, bytes: await readFile(path, 'base64') };
      return;
    }
    if (!metadata.isDirectory()) {
      output[label] = { kind: 'other', mode };
      return;
    }
    output[label] = { kind: 'directory', mode };
    for (const entry of (await readdir(path)).sort()) {
      await snapshotPath(join(path, entry), `${label}/${entry}`, output);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      output[label] = null;
      return;
    }
    throw error;
  }
};

export const snapshotApplyState = async (fixture: ApplyFixture) => {
  const output: Record<string, unknown> = {};
  for (const [label, path] of [
    ['manifest', fixture.manifest],
    ['lock', fixture.lock],
    ['ledger', fixture.ledger],
    ['store', fixture.store],
    ['live:user', fixture.live.user],
    ['live:project', fixture.live.project],
  ] as const) {
    await snapshotPath(path, label, output);
  }
  return output;
};

export const collectStrings = (value: unknown): readonly string[] => {
  const output: string[] = [];
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') output.push(current);
    else if (Array.isArray(current)) pending.push(...current);
    else if (typeof current === 'object' && current !== null) {
      pending.push(...Object.keys(current), ...Object.values(current));
    }
  }
  return output;
};

export const localAbsoluteStrings = (value: unknown, fixture: ApplyFixture): readonly string[] =>
  collectStrings(value).filter(
    (candidate) =>
      isAbsolute(candidate) &&
      [fixture.root, fixture.home, fixture.cwd, fixture.data, fixture.config, fixture.cache].some(
        (root) => candidate === root || relative(root, candidate).startsWith('..') === false,
      ),
  );

export { fileSnapshot };

export const removeReviewedPlan = async (fixture: ApplyFixture): Promise<void> => {
  await rm(fixture.plan, { force: true });
};
