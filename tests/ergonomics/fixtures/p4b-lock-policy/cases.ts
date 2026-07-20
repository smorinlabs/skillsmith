import { readFile, writeFile } from 'node:fs/promises';
import {
  type PortableLockV1,
  readPortableLockSource,
  serializePortableLock,
} from '../../../../packages/core/src/artifacts/lock.ts';
import {
  type ApplyFixture,
  createApplyFixture,
  destroyApplyFixture,
  runApplyCli,
} from '../p4b-apply/cases.ts';

export const STRICT_WHOLE_PAIR_CASES = Object.freeze([
  'unbounded',
  'bounded-tool',
  'bounded-scope',
  'filter-to-zero',
] as const);

export const SUPPORTED_REPRODUCTION_PLATFORMS = Object.freeze(['darwin', 'linux'] as const);

export const POLICY_SECRET_CANARIES = Object.freeze([
  'P17_G4B03_AUTH_CANARY',
  'P17_G4B03_OUTPUT_CANARY',
] as const);

export interface IncompleteWholePairFixture {
  readonly fixture: ApplyFixture;
  readonly omittedName: 'beta';
  readonly beforeLock: PortableLockV1;
}

export const createIncompleteWholePairFixture = async (): Promise<IncompleteWholePairFixture> => {
  const fixture = await createApplyFixture([
    { name: 'alpha', tool: 'codex', scope: 'user' },
    { name: 'beta', tool: 'claude-code', scope: 'project' },
  ]);
  try {
    const decoded = readPortableLockSource(await readFile(fixture.lock));
    if (!decoded.ok) throw new Error(decoded.error.message);
    const replacement: PortableLockV1 = {
      ...decoded.value,
      skills: decoded.value.skills.filter(({ name }) => name !== 'beta'),
    };
    const encoded = serializePortableLock(replacement);
    if (!encoded.ok) throw new Error(encoded.error.message);
    await writeFile(fixture.lock, encoded.value);
    return { fixture, omittedName: 'beta', beforeLock: decoded.value };
  } catch (error) {
    await destroyApplyFixture(fixture);
    throw error;
  }
};

export const destroyIncompleteWholePairFixture = async (
  selected: IncompleteWholePairFixture,
): Promise<void> => destroyApplyFixture(selected.fixture);

export const runBoundedLockedPreview = (
  selected: IncompleteWholePairFixture,
  command: 'apply' | 'plan',
) =>
  runApplyCli(selected.fixture, [
    command,
    '--file',
    selected.fixture.manifest,
    '--lockfile',
    selected.fixture.lock,
    '--tool',
    'codex',
    '--locked',
    ...(command === 'apply' ? ['--dry-run'] : []),
    '--json',
  ]);
