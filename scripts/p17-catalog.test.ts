import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { runGit } from '../packages/core/tests/fixtures/git-env.ts';
import { gitRecordsExactDeletion, ownedPathState } from './p17-catalog.ts';

const root = resolve(import.meta.dir, '..');
const checklistPath = resolve(root, 'projects/p17/CHECKLIST.md');
const prepPath = resolve(root, 'projects/p17/PREP.md');
const evidence = 'projects/p17/evidence/README.md';
const groupEvidence = `${evidence}#validator-self-test-group-p17-g0-01`;
const temporaryDirectories: string[] = [];

type Gate = { status: 'pending' | 'passed' | 'failed' | 'blocked'; evidence: string[] };
type ExecutionTarget = {
  kind: 'test' | 'static' | 'workflow' | 'distribution';
  path: string;
  selector: string;
  command: string;
};
type Entity = {
  id: string;
  kind: string;
  stateModel: 'work' | 'validation' | 'coverage';
  primaryGroup: string;
  secondaryGroups: string[];
  validatedBy: string[];
  impactedValidations: string[];
  affectedContracts: string[];
  plannedTarget: string;
  target: ExecutionTarget | string | null;
  status: string;
  tier: string;
  evidence: string[];
};
type GroupStatus =
  | 'planned'
  | 'mapped'
  | 'ready'
  | 'active'
  | 'reviewed'
  | 'signed-off'
  | 'failed'
  | 'blocked'
  | 'deferred';
type Group = {
  id: string;
  dependsOn: string[];
  impactedValidations: string[];
  requiredNowValidations: string[];
  downstreamCoverage: string[];
  status: GroupStatus;
  ownedFiles: string[];
  testCommands: string[];
  implementers: string[];
  reviewer: string | null;
  gates: Record<string, Gate>;
};
type Phase = {
  id: string;
  status: 'planned' | 'active' | 'approved' | 'blocked' | 'deferred';
  entry: Gate;
  review: Gate & { reviewer: string | null };
  approval: Gate & { approvedBy: string | null };
  exit: Gate;
};
type CatalogFixture = {
  entities: Entity[];
  groups: Group[];
  phases: Phase[];
  finalReview: Gate & { reviewer: string | null };
  finalApproval: Gate & { approvedBy: string | null };
  finalSignoff: Gate;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

let baselineFixtureBody: string | undefined;

function fixture(): CatalogFixture {
  if (!baselineFixtureBody) {
    const temporaryCatalog = temporaryFile('skillsmith-p17-baseline-catalog-', 'catalog.json');
    const temporaryChecklist = temporaryFile('skillsmith-p17-baseline-checklist-', 'CHECKLIST.md');
    const result = Bun.spawnSync(['bun', 'scripts/p17-catalog.ts', '--init'], {
      cwd: root,
      env: {
        ...process.env,
        P17_CATALOG_PATH: temporaryCatalog,
        P17_CHECKLIST_PATH: temporaryChecklist,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
      throw new Error(`could not generate baseline catalog fixture: ${result.stderr.toString()}`);
    }
    baselineFixtureBody = readFileSync(temporaryCatalog, 'utf8');
  }
  return JSON.parse(baselineFixtureBody) as CatalogFixture;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function temporaryFile(prefix: string, name: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return resolve(directory, name);
}

type CatalogRepository = {
  root: string;
  home: string;
  catalog: string;
  checklist: string;
};

function isolatedCatalogEnvironment(
  repository: CatalogRepository,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const environment = { ...process.env, ...overrides };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GIT_') || name.startsWith('P17_')) delete environment[name];
  }
  return {
    ...environment,
    HOME: repository.home,
    XDG_CONFIG_HOME: resolve(repository.home, 'config'),
    XDG_CACHE_HOME: resolve(repository.home, 'cache'),
    XDG_DATA_HOME: resolve(repository.home, 'data'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    P17_CATALOG_PATH: repository.catalog,
    P17_CHECKLIST_PATH: repository.checklist,
  };
}

function isolatedCatalogGit(repository: CatalogRepository, cwd: string, args: string[]): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      env: isolatedCatalogEnvironment(repository),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`isolated catalog Git failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function isolatedCatalogRepository(directory: string): CatalogRepository {
  const repository = {
    root: resolve(directory, 'repository'),
    home: resolve(directory, 'home'),
    catalog: resolve(directory, 'catalog.json'),
    checklist: resolve(directory, 'CHECKLIST.md'),
  };
  mkdirSync(repository.home);
  const head = isolatedCatalogGit(repository, root, ['rev-parse', '--verify', 'HEAD']);
  isolatedCatalogGit(repository, root, [
    'clone',
    '--no-local',
    '--no-hardlinks',
    '--no-checkout',
    root,
    repository.root,
  ]);
  isolatedCatalogGit(repository, repository.root, ['checkout', '--quiet', '--detach', head]);
  expect(isolatedCatalogGit(repository, repository.root, ['rev-parse', 'HEAD'])).toBe(head);
  expect(
    realpathSync(isolatedCatalogGit(repository, repository.root, ['rev-parse', '--show-toplevel'])),
  ).toBe(realpathSync(repository.root));
  const innerGit = isolatedCatalogGit(repository, repository.root, [
    'rev-parse',
    '--absolute-git-dir',
  ]);
  expect(realpathSync(innerGit)).toBe(realpathSync(resolve(repository.root, '.git')));
  expect(realpathSync(repository.root)).not.toBe(realpathSync(root));
  expect(
    isolatedCatalogGit(repository, repository.root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]),
  ).toBe(innerGit);
  expect(existsSync(resolve(innerGit, 'objects/info/alternates'))).toBeFalse();
  // Exercise the current validator and its runtime imports, including a dirty implementation.
  for (const path of [
    'scripts/p17-catalog.ts',
    'packages/core/src/env/git.ts',
    'packages/core/src/ports/git.ts',
    'packages/core/src/ports/errors.ts',
  ]) {
    copyFileSync(resolve(root, path), resolve(repository.root, path));
    expect(readFileSync(resolve(repository.root, path))).toEqual(readFileSync(resolve(root, path)));
  }
  return repository;
}

function objectFileInodes(directory: string): Set<string> {
  const identities = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      for (const identity of objectFileInodes(path)) identities.add(identity);
    } else if (entry.isFile()) {
      const metadata = statSync(path, { bigint: true });
      identities.add(`${metadata.dev}:${metadata.ino}`);
    }
  }
  return identities;
}

function runCatalogMutation(
  mutate: (catalog: CatalogFixture) => void,
  mode: '--check' | '--write' | '--reset-baseline' = '--check',
  environment: Readonly<Record<string, string | undefined>> = {},
  repository?: CatalogRepository,
) {
  const temporaryCatalog =
    repository?.catalog ?? temporaryFile('skillsmith-p17-catalog-', 'catalog.json');
  const temporaryChecklist =
    repository?.checklist ?? temporaryFile('skillsmith-p17-checklist-', 'CHECKLIST.md');
  const catalog = fixture();
  mutate(catalog);
  writeFileSync(temporaryCatalog, `${JSON.stringify(catalog, null, 2)}\n`);
  if (mode === '--check' && repository === undefined) {
    writeFileSync(temporaryChecklist, readFileSync(checklistPath, 'utf8'));
  }
  return Bun.spawnSync(['bun', 'scripts/p17-catalog.ts', mode], {
    cwd: repository?.root ?? root,
    env: {
      ...(repository === undefined
        ? { ...process.env, ...environment }
        : isolatedCatalogEnvironment(repository, environment)),
      P17_CATALOG_PATH: temporaryCatalog,
      P17_CHECKLIST_PATH: temporaryChecklist,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function temporaryGitRepository(prefix: string): string {
  const repository = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryDirectories.push(repository);
  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.name', 'P17 Validator']);
  runGit(repository, ['config', 'user.email', 'p17-validator@example.invalid']);
  return repository;
}

function commitAll(repository: string, message: string): void {
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '--quiet', '-m', message]);
}

function expectFailure(result: ReturnType<typeof runCatalogMutation>, message: string): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(message);
}

function pass(gate: Gate): void {
  gate.status = 'passed';
  gate.evidence = [evidence];
}

function activatePhase0(catalog: CatalogFixture): void {
  const phase = catalog.phases.find((item) => item.id === '0');
  if (!phase) throw new Error('missing Phase 0 fixture');
  phase.status = 'active';
  pass(phase.entry);
}

function group(catalog: CatalogFixture, id = 'P17-G0-01'): Group {
  const value = catalog.groups.find((item) => item.id === id);
  if (!value) throw new Error(`missing ${id} fixture`);
  return value;
}

function validation(catalog: CatalogFixture, id = 'EWP-P0A-TS01'): Entity {
  const value = catalog.entities.find((item) => item.id === id);
  if (!value) throw new Error(`missing ${id} fixture`);
  return value;
}

function passGroupThrough(value: Group, lastGate: string): void {
  for (const [name, gate] of Object.entries(value.gates)) {
    pass(gate);
    gate.evidence = [groupEvidence];
    if (name === lastGate) return;
  }
  throw new Error(`unknown group gate ${lastGate}`);
}

function executableTarget(id: string, path = 'scripts/p17-catalog.test.ts'): ExecutionTarget {
  return {
    kind: 'test',
    path,
    selector: id,
    command: `bun test ${path} --test-name-pattern ${id}`,
  };
}

function activateGroupThroughTargetedGreen(catalog: CatalogFixture): void {
  activatePhase0(catalog);
  const value = group(catalog);
  value.status = 'active';
  value.ownedFiles = ['scripts/p17-catalog.test.ts'];
  value.testCommands = ['bun test scripts/p17-catalog.test.ts'];
  value.implementers = ['implementation-agent'];
  validation(catalog).ownedFiles = ['scripts/p17-catalog.test.ts'];
  passGroupThrough(value, 'targeted-green');
}

describe('P17 immutable catalog and traceability baseline', () => {
  test('EWP-P0A-TS01 validator self-test selector executes', () => {
    expect(true).toBe(true);
  });

  test('accepts the committed baseline', () => {
    const result = Bun.spawnSync(['bun', 'scripts/p17-catalog.ts', '--check'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const committed = JSON.parse(
      readFileSync(resolve(root, 'projects/p17/catalog.json'), 'utf8'),
    ) as CatalogFixture;
    const g502 = group(committed, 'P17-G5-02');
    expect(g502.ownedFiles).toHaveLength(97);
    expect(g502.ownedFiles).toContain('packages/core/src/place/swap.ts');
    expect(g502.ownedFiles).toContain('tests/ergonomics/phase/EWP-P3A-TS02.test.ts');
    expect(g502.ownedFiles).toContain('packages/core/tests/artifacts/ledger-writer.test.ts');
  });

  test('tracks every entity one-to-one with required validation coverage', () => {
    const catalog = fixture();
    const checklistIds = [
      ...readFileSync(checklistPath, 'utf8').matchAll(/^- \[[ x]\] \*\*([^*]+)\*\* —/gm),
    ].map((match) => match[1]);
    const requiredEntities = catalog.entities.filter((entity) => entity.tier !== 'deferred');
    const deferredEntities = catalog.entities.filter((entity) => entity.tier === 'deferred');
    const validations = catalog.entities.filter((entity) => entity.stateModel === 'validation');

    expect(catalog.entities).toHaveLength(426);
    expect(new Set(catalog.entities.map((entity) => entity.id)).size).toBe(426);
    expect(checklistIds).toHaveLength(426);
    expect(new Set(checklistIds).size).toBe(426);
    expect(requiredEntities).toHaveLength(419);
    expect(deferredEntities).toHaveLength(7);
    expect(validations).toHaveLength(244);
    expect(
      requiredEntities.every(
        (entity) => entity.validatedBy.length > 0 && entity.impactedValidations.length > 0,
      ),
    ).toBe(true);
  });

  test('rejects a required entity without validation mappings', () => {
    const result = runCatalogMutation((catalog) => {
      const entity = required(
        catalog.entities.find((item) => item.tier !== 'deferred'),
        'missing required entity',
      );
      entity.validatedBy = [];
      entity.impactedValidations = [];
    });
    expectFailure(result, 'required entity has no validation mapping');
  });

  test.each([
    [
      'primary ownership',
      (catalog: CatalogFixture) => {
        required(catalog.entities[0], 'missing first entity').primaryGroup = 'P17-G0-02';
      },
      'immutable primaryGroup drifted',
    ],
    [
      'dependency',
      (catalog: CatalogFixture) => {
        required(catalog.groups[1], 'missing second group').dependsOn = [];
      },
      'immutable dependsOn drifted',
    ],
    [
      'planned target',
      (catalog: CatalogFixture) => {
        required(catalog.entities[0], 'missing first entity').plannedTarget = 'planned:drifted';
      },
      'immutable plannedTarget drifted',
    ],
    [
      'secondary groups',
      (catalog: CatalogFixture) => {
        required(
          catalog.entities.find((item) => item.id === 'EWP-CF-033'),
          'missing EWP-CF-033',
        ).secondaryGroups = [];
      },
      'immutable secondaryGroups drifted',
    ],
    [
      'entity validation impact',
      (catalog: CatalogFixture) => {
        required(
          catalog.entities.find((item) => item.id === 'EWP-CF-039'),
          'missing EWP-CF-039',
        ).impactedValidations = ['EWP-P0A-TS09'];
      },
      'immutable impactedValidations drifted',
    ],
    [
      'group validation impact',
      (catalog: CatalogFixture) => {
        required(
          catalog.groups.find((item) => item.id === 'P17-G1-03'),
          'missing P17-G1-03',
        ).impactedValidations = [];
      },
      'immutable impactedValidations drifted',
    ],
  ])('rejects immutable %s drift', (_label, mutate, message) => {
    expectFailure(runCatalogMutation(mutate), message);
  });

  test('preserves the exact cross-group validation relations for CF-033 and CF-039', () => {
    const catalog = fixture();
    const cf033 = catalog.entities.find((item) => item.id === 'EWP-CF-033');
    const cf039 = catalog.entities.find((item) => item.id === 'EWP-CF-039');
    expect(cf033?.impactedValidations).toEqual(['EWP-P1-TS07', 'EWP-WF15', 'EWP-WF16']);
    expect(cf033?.secondaryGroups).toEqual(['P17-G1-02A', 'P17-G6-02A']);
    expect(cf039?.impactedValidations).toEqual(['EWP-P0A-TS09', 'EWP-P6-TS06']);
    expect(cf039?.secondaryGroups).toEqual(['P17-G6-04']);
    expect(group(catalog, 'P17-G1-03').impactedValidations).toEqual(
      expect.arrayContaining(['EWP-P1-TS07', 'EWP-WF15', 'EWP-WF16']),
    );
    expect(group(catalog, 'P17-G0-05').impactedValidations).toEqual(
      expect.arrayContaining(['EWP-P0A-TS09', 'EWP-P6-TS06']),
    );
  });

  test('schedules the complete WF01 workflow at the dependency-complete Phase-6 boundary', () => {
    const catalog = fixture();
    const wf01 = required(
      catalog.entities.find((item) => item.id === 'EWP-WF01'),
      'missing EWP-WF01',
    );
    const distribution = required(
      catalog.entities.find((item) => item.id === 'EWP-P6-T02'),
      'missing EWP-P6-T02',
    );
    const documentation = required(
      catalog.entities.find((item) => item.id === 'EWP-P6-T06'),
      'missing EWP-P6-T06',
    );

    expect(wf01.primaryGroup).toBe('P17-G6-04');
    expect(wf01.tier).toBe('release');
    expect(group(catalog, 'P17-G4A-01').impactedValidations).not.toContain('EWP-WF01');
    expect(group(catalog, 'P17-G6-01').downstreamCoverage).toContain('EWP-WF01');
    expect(group(catalog, 'P17-G6-02A').downstreamCoverage).toContain('EWP-WF01');
    expect(group(catalog, 'P17-G6-02B').downstreamCoverage).toContain('EWP-WF01');
    expect(group(catalog, 'P17-G6-03').downstreamCoverage).toContain('EWP-WF01');
    expect(group(catalog, 'P17-G6-04').requiredNowValidations).toContain('EWP-WF01');
    expect(distribution.validatedBy).toContain('EWP-WF01');
    expect(distribution.secondaryGroups).toContain('P17-G6-04');
    expect(documentation.validatedBy).toContain('EWP-WF01');
    expect(documentation.secondaryGroups).toContain('P17-G6-04');
  });

  test('locks the approved Phase-6 DAG independently of stable group-ID display order', () => {
    const catalog = fixture();
    expect(group(catalog, 'P17-G6-02A').dependsOn).toEqual(['P17-G5-04', 'P17-G5-05']);
    expect(group(catalog, 'P17-G6-02B').dependsOn).toEqual(['P17-G6-02A']);
    expect(group(catalog, 'P17-G6-03').dependsOn).toEqual(['P17-G6-02A']);
    expect(group(catalog, 'P17-G6-01').dependsOn).toEqual(['P17-G6-02B', 'P17-G6-03']);
    expect(group(catalog, 'P17-G6-04').dependsOn).toEqual(['P17-G6-01']);

    const stableIds = catalog.groups.map((item) => item.id);
    expect(stableIds.indexOf('P17-G6-01')).toBeLessThan(stableIds.indexOf('P17-G6-02A'));
  });

  test('schedules WF03 and WF04 at the dependency-complete Phase-4B boundary', () => {
    const catalog = fixture();
    const wf03 = required(
      catalog.entities.find((item) => item.id === 'EWP-WF03'),
      'missing EWP-WF03',
    );
    const wf04 = required(
      catalog.entities.find((item) => item.id === 'EWP-WF04'),
      'missing EWP-WF04',
    );
    const init = required(
      catalog.entities.find((item) => item.id === 'COMMAND:init'),
      'missing COMMAND:init',
    );
    const exportCommand = required(
      catalog.entities.find((item) => item.id === 'COMMAND:export'),
      'missing COMMAND:export',
    );

    expect(wf03.primaryGroup).toBe('P17-G4B-03');
    expect(wf04.primaryGroup).toBe('P17-G4B-03');
    expect(wf03.affectedContracts).toEqual(['COMMAND:init', 'EWP-CF-041', 'P1-05']);
    expect(wf04.affectedContracts).toEqual(['COMMAND:export', 'D-005', 'EWP-CF-011', 'P1-06']);
    expect(wf03.secondaryGroups).toContain('P17-G4A-03');
    expect(wf04.secondaryGroups).toContain('P17-G4A-02');

    expect(group(catalog, 'P17-G4A-03').requiredNowValidations).not.toContain('EWP-WF03');
    expect(group(catalog, 'P17-G4A-03').downstreamCoverage).toContain('EWP-WF03');
    expect(group(catalog, 'P17-G4A-02').requiredNowValidations).not.toContain('EWP-WF04');
    expect(group(catalog, 'P17-G4A-02').downstreamCoverage).toContain('EWP-WF04');
    expect(group(catalog, 'P17-G4B-03').requiredNowValidations).toEqual(
      expect.arrayContaining(['EWP-WF03', 'EWP-WF04']),
    );
    expect(init.validatedBy).toContain('EWP-WF03');
    expect(init.secondaryGroups).toContain('P17-G4B-03');
    expect(exportCommand.validatedBy).toContain('EWP-WF04');
    expect(exportCommand.secondaryGroups).toContain('P17-G4B-03');
    for (const id of ['D-005', 'EWP-CF-011', 'EWP-P4A-T02', 'P1-06']) {
      const entity = required(
        catalog.entities.find((item) => item.id === id),
        `missing ${id}`,
      );
      expect(entity.validatedBy).toContain('EWP-WF04');
      expect(entity.secondaryGroups).toContain('P17-G4B-03');
    }
    for (const id of ['EWP-CF-041', 'EWP-P4A-T04', 'P1-05']) {
      const entity = required(
        catalog.entities.find((item) => item.id === id),
        `missing ${id}`,
      );
      expect(entity.validatedBy).toContain('EWP-WF03');
      expect(entity.secondaryGroups).toContain('P17-G4B-03');
    }
  });

  test('schedules WF13 at its dependency-complete boundary with an exact G4A-04 partition', () => {
    const catalog = fixture();
    const wf13 = required(
      catalog.entities.find((item) => item.id === 'EWP-WF13'),
      'missing EWP-WF13',
    );
    const g4a04 = group(catalog, 'P17-G4A-04');

    expect(wf13.primaryGroup).toBe('P17-G5-05');
    expect(wf13.plannedTarget).toBe(
      'planned:P17-G5-05:tests/ergonomics/workflows/EWP-WF13.test.ts#EWP-WF13',
    );
    expect(wf13.secondaryGroups).toEqual(['P17-G4A-04', 'P17-G4B-02', 'P17-G5-01', 'P17-G5-02']);
    expect(g4a04.impactedValidations).toEqual([
      'EWP-CMD-INSTALL-TS08',
      'EWP-CMD-PROMOTE-TS04',
      'EWP-CMD-PROMOTE-TS06',
      'EWP-CMD-UNINSTALL-TS04',
      'EWP-CMD-UNINSTALL-TS07',
      'EWP-P3B-TS03',
      'EWP-P3B-TS05',
      'EWP-P4A-TS02',
      'EWP-WF13',
    ]);
    expect(g4a04.requiredNowValidations).toEqual([
      'EWP-CMD-INSTALL-TS08',
      'EWP-CMD-PROMOTE-TS04',
      'EWP-CMD-PROMOTE-TS06',
      'EWP-CMD-UNINSTALL-TS04',
      'EWP-CMD-UNINSTALL-TS07',
      'EWP-P3B-TS03',
      'EWP-P3B-TS05',
      'EWP-P4A-TS02',
    ]);
    expect(g4a04.downstreamCoverage).toEqual(['EWP-WF13']);
    expect(group(catalog, 'P17-G4B-02').downstreamCoverage).toContain('EWP-WF13');
    expect(group(catalog, 'P17-G5-01').downstreamCoverage).toContain('EWP-WF13');
    expect(group(catalog, 'P17-G5-02').downstreamCoverage).toContain('EWP-WF13');
    expect(group(catalog, 'P17-G5-05').requiredNowValidations).toContain('EWP-WF13');
  });

  test('schedules update-to-undo closure at dependency-complete G5-05 with reciprocal traceability', () => {
    const catalog = fixture();
    const moved = [
      {
        id: 'EWP-CMD-UPDATE-TS07',
        target: 'planned:P17-G5-05:packages/cli/tests/contracts/update.test.ts#EWP-CMD-UPDATE-TS07',
        contracts: [
          'COMMAND:update',
          'COMMAND:undo',
          'D-010',
          'D-011',
          'EWP-CF-008',
          'EWP-CF-026',
          'EWP-CF-031',
          'P1-11',
          'P2-02',
        ],
        secondary: ['P17-G5-02', 'P17-G5-03', 'P17-G3B-03', 'P17-G3B-02', 'P17-G1-01'],
      },
      {
        id: 'EWP-CMD-UNDO-TS03',
        target: 'planned:P17-G5-05:packages/cli/tests/contracts/undo.test.ts#EWP-CMD-UNDO-TS03',
        contracts: [
          'COMMAND:update',
          'COMMAND:undo',
          'D-010',
          'D-011',
          'EWP-CF-026',
          'EWP-CF-031',
          'P1-11',
          'P2-02',
        ],
        secondary: ['P17-G5-02', 'P17-G5-03', 'P17-G3B-03', 'P17-G3B-02', 'P17-G1-01'],
      },
      {
        id: 'EWP-WF09',
        target: 'planned:P17-G5-05:tests/ergonomics/workflows/EWP-WF09.test.ts#EWP-WF09',
        contracts: [
          'COMMAND:update',
          'COMMAND:undo',
          'D-010',
          'D-011',
          'EWP-CF-008',
          'EWP-CF-026',
          'EWP-CF-027',
          'EWP-CF-031',
          'P1-11',
          'P2-02',
        ],
        secondary: ['P17-G5-02', 'P17-G5-03', 'P17-G3B-03', 'P17-G3B-02', 'P17-G2-02', 'P17-G1-01'],
      },
    ] as const;

    for (const expected of moved) {
      const entity = required(
        catalog.entities.find((item) => item.id === expected.id),
        `missing ${expected.id}`,
      );
      expect(entity.primaryGroup).toBe('P17-G5-05');
      expect(entity.plannedTarget).toBe(expected.target);
      expect(entity.affectedContracts).toEqual(expected.contracts);
      expect(entity.secondaryGroups).toEqual(expected.secondary);
      for (const contractId of expected.contracts) {
        const contract = required(
          catalog.entities.find((item) => item.id === contractId),
          `missing ${contractId}`,
        );
        expect(contract.validatedBy).toContain(expected.id);
      }
    }

    const g502 = group(catalog, 'P17-G5-02');
    const g503 = group(catalog, 'P17-G5-03');
    const g505 = group(catalog, 'P17-G5-05');
    expect(catalog.entities.filter((entity) => entity.primaryGroup === g502.id)).toHaveLength(16);
    expect(catalog.entities.filter((entity) => entity.primaryGroup === g503.id)).toHaveLength(14);
    expect(catalog.entities.filter((entity) => entity.primaryGroup === g505.id)).toHaveLength(7);
    expect(g502.requiredNowValidations).toEqual([
      'EWP-CMD-INSTALL-TS05',
      'EWP-CMD-UPDATE-TS01',
      'EWP-CMD-UPDATE-TS02',
      'EWP-CMD-UPDATE-TS03',
      'EWP-CMD-UPDATE-TS04',
      'EWP-CMD-UPDATE-TS05',
      'EWP-CMD-UPDATE-TS06',
      'EWP-CMD-UPDATE-TS08',
      'EWP-CMD-UPDATE-TS09',
      'EWP-CMD-UPDATE-TS10',
      'EWP-P5-TS02',
    ]);
    expect(g502.downstreamCoverage).toEqual([
      'EWP-CMD-UNDO-TS03',
      'EWP-CMD-UPDATE-TS07',
      'EWP-WF09',
      'EWP-WF13',
    ]);
    expect(g503.requiredNowValidations).toEqual([
      'EWP-CMD-DEV-TS05',
      'EWP-CMD-PROMOTE-TS05',
      'EWP-CMD-UNDO-TS01',
      'EWP-CMD-UNDO-TS02',
      'EWP-CMD-UNDO-TS04',
      'EWP-CMD-UNDO-TS05',
      'EWP-CMD-UNDO-TS06',
      'EWP-CMD-UNDO-TS07',
      'EWP-CMD-UNDO-TS08',
      'EWP-CMD-UNDO-TS09',
      'EWP-P5-TS03',
      'EWP-WF05',
      'EWP-WF11',
    ]);
    expect(g503.downstreamCoverage).toEqual([
      'EWP-CMD-UNDO-TS03',
      'EWP-CMD-UPDATE-TS07',
      'EWP-WF09',
    ]);
    expect(g505.requiredNowValidations).toEqual([
      'EWP-CMD-APPLY-TS09',
      'EWP-CMD-APPLY-TS11',
      'EWP-CMD-APPLY-TS13',
      'EWP-CMD-SYNC-TS09',
      'EWP-CMD-UNDO-TS03',
      'EWP-CMD-UPDATE-TS06',
      'EWP-CMD-UPDATE-TS07',
      'EWP-CMD-UPDATE-TS08',
      'EWP-CMD-UPDATE-TS09',
      'EWP-OPT-TS08',
      'EWP-P4A-TS02',
      'EWP-P5-TS05',
      'EWP-WF09',
      'EWP-WF13',
    ]);
    expect(g505.downstreamCoverage).toEqual([]);

    const g3b03 = group(catalog, 'P17-G3B-03');
    expect(g3b03.impactedValidations).toHaveLength(27);
    expect(g3b03.requiredNowValidations).toEqual([
      'EWP-CMD-DOCTOR-TS01',
      'EWP-CMD-DOCTOR-TS02',
      'EWP-CMD-DOCTOR-TS03',
      'EWP-CMD-DOCTOR-TS04',
      'EWP-CMD-DOCTOR-TS05',
      'EWP-CMD-DOCTOR-TS06',
      'EWP-CMD-STATUS-TS04',
      'EWP-P3B-TS03',
      'EWP-P3B-TS04',
    ]);
    expect(g3b03.downstreamCoverage).toHaveLength(18);
    expect(g3b03.downstreamCoverage).toContain('EWP-CMD-UPDATE-TS07');
    expect(g3b03.downstreamCoverage).toContain('EWP-WF09');
  });

  test('schedules apply-dependent plan closure at G4B-02 with exact G4B-01 traceability', () => {
    const catalog = fixture();
    const g4b01 = group(catalog, 'P17-G4B-01');
    const g4b02 = group(catalog, 'P17-G4B-02');
    const downstream = ['EWP-CMD-PLAN-TS11', 'EWP-P4B-TS02', 'EWP-WF06', 'EWP-WF08'];

    expect(g4b01.requiredNowValidations).toEqual([
      'EWP-CMD-PLAN-TS01',
      'EWP-CMD-PLAN-TS02',
      'EWP-CMD-PLAN-TS03',
      'EWP-CMD-PLAN-TS04',
      'EWP-CMD-PLAN-TS05',
      'EWP-CMD-PLAN-TS06',
      'EWP-CMD-PLAN-TS07',
      'EWP-CMD-PLAN-TS08',
      'EWP-CMD-PLAN-TS09',
      'EWP-CMD-PLAN-TS10',
      'EWP-CMD-PLAN-TS12',
      'EWP-P4B-TS01',
      'EWP-P4B-TS04',
    ]);
    expect(g4b01.downstreamCoverage).toEqual(downstream);
    expect(g4b02.requiredNowValidations).toEqual(expect.arrayContaining(downstream));

    for (const id of downstream) {
      const entity = required(
        catalog.entities.find((item) => item.id === id),
        `missing ${id}`,
      );
      expect(entity.primaryGroup).toBe('P17-G4B-02');
      expect(entity.secondaryGroups).toContain('P17-G4B-01');
      expect(entity.affectedContracts).toEqual(
        expect.arrayContaining(['COMMAND:plan', 'D-001', 'P1-07']),
      );
    }

    for (const id of ['COMMAND:plan', 'D-001', 'EWP-P4B-T01', 'EWP-P4B-T02', 'P1-07']) {
      const entity = required(
        catalog.entities.find((item) => item.id === id),
        `missing ${id}`,
      );
      expect(entity.validatedBy).toEqual(expect.arrayContaining(downstream));
      expect(entity.secondaryGroups).toContain('P17-G4B-02');
    }

    for (const [id, primary, validations] of [
      ['D-002', 'P17-G4B-02', ['EWP-CMD-PLAN-TS09', 'EWP-CMD-PLAN-TS10']],
      ['EWP-P4B-T03', 'P17-G4B-02', ['EWP-CMD-PLAN-TS09', 'EWP-CMD-PLAN-TS10']],
      ['D-015', 'P17-G4B-03', ['EWP-CMD-PLAN-TS04', 'EWP-CMD-PLAN-TS09']],
      ['EWP-P4B-T05', 'P17-G4B-03', ['EWP-CMD-PLAN-TS04', 'EWP-CMD-PLAN-TS09']],
    ] as const) {
      const entity = required(
        catalog.entities.find((item) => item.id === id),
        `missing ${id}`,
      );
      expect(entity.primaryGroup).toBe(primary);
      expect(entity.secondaryGroups).toContain('P17-G4B-01');
      expect(entity.validatedBy).toEqual(expect.arrayContaining([...validations]));
    }
  });

  test('separates required-now validation from immutable downstream coverage', () => {
    const catalog = fixture();
    const phase0 = group(catalog, 'P17-G0-05');
    expect(phase0.requiredNowValidations).toContain('EWP-P0A-TS09');
    expect(phase0.downstreamCoverage).toContain('EWP-P6-TS06');
    const phase1 = group(catalog, 'P17-G1-03');
    expect(phase1.requiredNowValidations).toEqual(
      expect.arrayContaining(['EWP-P1-TS07', 'EWP-WF15']),
    );
    expect(phase1.downstreamCoverage).toContain('EWP-WF16');
  });

  test('preserves P0-01 output, observer, and TTY behavior as explicit downstream ownership', () => {
    const catalog = fixture();
    const p001 = required(
      catalog.entities.find((item) => item.id === 'P0-01'),
      'missing P0-01',
    );
    expect(p001.impactedValidations).toEqual(
      expect.arrayContaining(['EWP-P1-TS07', 'EWP-P1-TS11', 'EWP-P6-TS03']),
    );
    expect(p001.secondaryGroups).toEqual(
      expect.arrayContaining(['P17-G1-03', 'P17-G1-07', 'P17-G6-03']),
    );
    expect(group(catalog, 'P17-G1-01').downstreamCoverage).toEqual(
      expect.arrayContaining(['EWP-P1-TS07', 'EWP-P1-TS11', 'EWP-P6-TS03']),
    );
  });

  test('expands shorthand finding command contracts explicitly', () => {
    const catalog = fixture();
    const contracts = (id: string) =>
      required(
        catalog.entities.find((item) => item.id === id),
        `missing ${id}`,
      ).affectedContracts;
    expect(contracts('EWP-CF-025')).toEqual([
      'COMMAND:export',
      'COMMAND:init',
      'COMMAND:install',
      'COMMAND:plan',
      'COMMAND:sync',
      'COMMAND:uninstall',
    ]);
    const shorthand: Record<string, string[]> = {
      'EWP-CF-023': ['check', 'dev', 'install', 'promote', 'undo'],
      'EWP-CF-026': ['apply', 'dev', 'install', 'promote', 'sync', 'undo', 'uninstall', 'update'],
      'EWP-CF-029': [
        'apply',
        'config',
        'doctor',
        'export',
        'init',
        'install',
        'plan',
        'sync',
        'uninstall',
      ],
      'EWP-CF-030': ['apply', 'export', 'install', 'plan'],
      'EWP-CF-031': ['apply', 'dev', 'gc', 'plan', 'promote', 'status', 'sync', 'undo', 'update'],
      'EWP-CF-043': [
        'apply',
        'check',
        'dev',
        'doctor',
        'export',
        'gc',
        'init',
        'install',
        'plan',
        'promote',
        'sync',
        'undo',
        'uninstall',
        'update',
      ],
      'EWP-CF-044': ['gc'],
    };
    for (const [id, commands] of Object.entries(shorthand)) {
      expect(contracts(id)).toEqual(commands.map((command) => `COMMAND:${command}`));
      const finding = required(
        catalog.entities.find((item) => item.id === id),
        `missing ${id}`,
      );
      const expectedCommandTests = catalog.entities
        .filter(
          (item) =>
            item.kind === 'command-test' &&
            commands.some((command) => item.id.startsWith(`EWP-CMD-${command.toUpperCase()}-TS`)),
        )
        .map((item) => item.id)
        .sort();
      expect(
        finding.impactedValidations.filter((value) => value.startsWith('EWP-CMD-')).sort(),
      ).toEqual(expectedCommandTests);
    }
  });
});

describe('P17 validation targets and evidence', () => {
  test.each([
    ['null', null, 'has no executable actual target'],
    ['planned', 'planned:tests/not-real.test.ts', 'has no executable actual target'],
  ])('rejects an active validation with a %s target', (_label, target, message) => {
    const result = runCatalogMutation((catalog) => {
      const entity = validation(catalog);
      entity.status = 'active';
      entity.target = target;
      entity.evidence = [evidence];
    });
    expectFailure(result, message);
  });

  test('rejects a passing validation whose actual target does not exist', () => {
    const result = runCatalogMutation((catalog) => {
      const entity = validation(catalog);
      entity.status = 'passing';
      entity.target = executableTarget(entity.id, 'tests/does-not-exist.test.ts');
      entity.evidence = [`${evidence}#validator-self-test-receipt-${entity.id.toLowerCase()}`];
    });
    expectFailure(result, 'has invalid executable target path tests/does-not-exist.test.ts');
  });

  test('accepts a transition from the immutable planned target to an existing actual target', () => {
    const result = runCatalogMutation((catalog) => {
      activateGroupThroughTargetedGreen(catalog);
      const entity = validation(catalog);
      entity.status = 'passing';
      entity.target = executableTarget(entity.id);
      entity.evidence = [`${evidence}#validator-self-test-receipt-${entity.id.toLowerCase()}`];
    }, '--write');
    expect(result.exitCode).toBe(0);
  });

  test.each([
    ['directory', 'projects/p17/evidence'],
    ['prose file', 'projects/p17/evidence/README.md'],
  ])('rejects a %s as an executable target', (_label, path) => {
    const result = runCatalogMutation((catalog) => {
      const entity = validation(catalog);
      entity.status = 'passing';
      entity.target = executableTarget(entity.id, path);
      entity.evidence = [`${evidence}#validator-self-test-receipt-${entity.id.toLowerCase()}`];
    });
    expectFailure(result, `has invalid executable target path ${path}`);
  });

  test('rejects a target whose selector and command are not bound to the validation ID', () => {
    const result = runCatalogMutation((catalog) => {
      const entity = validation(catalog);
      entity.status = 'passing';
      entity.target = {
        ...executableTarget(entity.id),
        selector: 'another-test',
        command: 'bun test scripts/p17-catalog.test.ts --test-name-pattern another-test',
      };
      entity.evidence = [`${evidence}#validator-self-test-receipt-${entity.id.toLowerCase()}`];
    });
    expectFailure(result, 'target is not bound to its runnable command and selector');
  });

  test('rejects a passing validation without an ID-bound execution receipt', () => {
    const result = runCatalogMutation((catalog) => {
      const entity = validation(catalog);
      entity.status = 'passing';
      entity.target = executableTarget(entity.id);
      entity.evidence = [evidence];
    });
    expectFailure(result, 'lacks an execution receipt bound to its target');
  });

  test('rejects a command grammar that cannot run the declared target kind', () => {
    const result = runCatalogMutation((catalog) => {
      const entity = validation(catalog);
      entity.status = 'passing';
      entity.target = {
        ...executableTarget(entity.id),
        command: `echo scripts/p17-catalog.test.ts ${entity.id}`,
      };
      entity.evidence = [`${evidence}#validator-self-test-receipt-${entity.id.toLowerCase()}`];
    });
    expectFailure(result, 'target command is invalid for test');
  });

  test('rejects a receipt whose command does not match the declared target', () => {
    const result = runCatalogMutation((catalog) => {
      const entity = validation(catalog);
      entity.status = 'passing';
      entity.target = {
        ...executableTarget(entity.id),
        command: `${executableTarget(entity.id).command} --timeout 5`,
      };
      entity.evidence = [`${evidence}#validator-self-test-receipt-${entity.id.toLowerCase()}`];
    });
    expectFailure(result, 'execution receipt is incomplete or does not match its target');
  });

  test('rejects evidence that does not resolve', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'mapped';
      const gate = required(value.gates.mapped, 'missing mapped gate');
      gate.status = 'passed';
      gate.evidence = ['projects/p17/evidence/not-real.md'];
    });
    expectFailure(result, 'P17-G0-01:mapped has unresolved evidence');
  });
});

describe('P17 group lifecycle coherence', () => {
  test('rejects lifecycle progress while a group remains planned', () => {
    const result = runCatalogMutation((catalog) => {
      const gate = required(group(catalog).gates.mapped, 'missing mapped gate');
      pass(gate);
      gate.evidence = [groupEvidence];
    });
    expectFailure(result, 'P17-G0-01 status planned has incoherent lifecycle gates');
  });

  test('rejects mapped status without the mapped gate', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      group(catalog).status = 'mapped';
    });
    expectFailure(result, 'P17-G0-01 status mapped has incoherent lifecycle gates');
  });

  test('rejects ready status without owned files, test commands, and implementers', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'ready';
      passGroupThrough(value, 'ready');
    });
    expectFailure(
      result,
      'P17-G0-01 is ready without owned files, test commands, and implementers',
    );
  });

  test.each([
    ['absent', 'packages/cli/tests/output/not-a-real-test.ts'],
    ['non-file', 'packages/cli/tests/output'],
    ['lexical traversal', 'scripts/../scripts/p17-catalog.test.ts'],
    ['Windows traversal', 'scripts\\..\\scripts\\p17-catalog.test.ts'],
    ['absolute', resolve(root, 'scripts/p17-catalog.test.ts')],
  ])('rejects %s ownership after a group leaves planned state', (_kind, path) => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'ready';
      value.ownedFiles = [path];
      value.testCommands = ['bun test scripts/p17-catalog.test.ts'];
      value.implementers = ['implementation-agent'];
      passGroupThrough(value, 'ready');
    });
    expectFailure(
      result,
      `P17-G0-01 owned path is neither a regular repository file nor a recorded deletion: ${path}`,
    );
  });

  test('rejects a regular file reached through a symlinked repository parent', () => {
    const directory = mkdtempSync(resolve(root, '.p17-owned-path-symlink-'));
    temporaryDirectories.push(directory);
    const realDirectory = resolve(directory, 'real');
    mkdirSync(realDirectory);
    writeFileSync(resolve(realDirectory, 'owner.ts'), 'export {};\n');
    symlinkSync('real', resolve(directory, 'linked'), 'dir');
    const path = relative(root, resolve(directory, 'linked/owner.ts'));
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'ready';
      value.ownedFiles = [path];
      value.testCommands = ['bun test scripts/p17-catalog.test.ts'];
      value.implementers = ['implementation-agent'];
      passGroupThrough(value, 'ready');
    });
    expectFailure(
      result,
      `P17-G0-01 owned path is neither a regular repository file nor a recorded deletion: ${path}`,
    );
  });

  test('rejects a dangling symlink even when the path has exact deletion provenance', () => {
    const path = 'packages/cli/src/util/config-notice.ts';
    const absolute = resolve(root, path);
    symlinkSync('missing-config-notice-target', absolute);
    try {
      const result = runCatalogMutation((catalog) => {
        activatePhase0(catalog);
        const value = group(catalog);
        value.status = 'ready';
        value.ownedFiles = [path];
        value.testCommands = ['bun test scripts/p17-catalog.test.ts'];
        value.implementers = ['implementation-agent'];
        passGroupThrough(value, 'ready');
      });
      expectFailure(
        result,
        `P17-G0-01 owned path is neither a regular repository file nor a recorded deletion: ${path}`,
      );
    } finally {
      rmSync(absolute, { force: true });
    }
  });

  test('rejects an absent path whose latest exact Git event is not deletion', () => {
    const path = 'LICENSE';
    const absolute = resolve(root, path);
    const sourceIndexPath = runGit(root, [
      '-c',
      'core.fsmonitor=false',
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ]).trim();
    const sourceIndex = readFileSync(sourceIndexPath);
    const sourceBytes = readFileSync(absolute);
    const sourceMetadata = () => {
      const value = statSync(absolute, { bigint: true });
      return {
        device: value.dev,
        inode: value.ino,
        mode: value.mode,
        size: value.size,
        mtime: value.mtimeNs,
        ctime: value.ctimeNs,
      };
    };
    const beforeMetadata = sourceMetadata();
    const directory = mkdtempSync(resolve(tmpdir(), 'skillsmith-p17-owned-path-history-'));
    temporaryDirectories.push(directory);
    try {
      const repository = isolatedCatalogRepository(directory);
      const innerIndex = isolatedCatalogGit(repository, repository.root, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'index',
      ]);
      expect(realpathSync(innerIndex)).not.toBe(realpathSync(sourceIndexPath));
      const innerIndexBefore = createHash('sha256').update(readFileSync(innerIndex)).digest('hex');
      const sourceCommon = isolatedCatalogGit(repository, root, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      const sourceObjects = objectFileInodes(resolve(sourceCommon, 'objects'));
      const fixtureObjects = objectFileInodes(resolve(repository.root, '.git/objects'));
      const sharedObjects = [...fixtureObjects].filter((identity) => sourceObjects.has(identity));
      expect(fixtureObjects.size).toBeGreaterThan(0);
      expect(sharedObjects).toEqual([]);
      const innerStatus = isolatedCatalogGit(repository, repository.root, [
        'status',
        '--porcelain=v1',
      ]);
      const latestEvent = isolatedCatalogGit(repository, repository.root, [
        'log',
        '-1',
        '--format=',
        '--name-status',
        '--no-renames',
        '--',
        ':(literal)LICENSE',
      ]);
      expect(latestEvent).toMatch(/^[AMT]\tLICENSE$/u);
      const mutate = (catalog: CatalogFixture) => {
        activatePhase0(catalog);
        const value = group(catalog);
        value.status = 'ready';
        value.ownedFiles = [path];
        value.testCommands = ['bun test scripts/p17-catalog.test.ts'];
        value.implementers = ['implementation-agent'];
        passGroupThrough(value, 'ready');
      };
      const poisonRoot = resolve(directory, 'poison');
      mkdirSync(poisonRoot);
      const poisonCatalog = resolve(poisonRoot, 'catalog.json');
      const poisonChecklist = resolve(poisonRoot, 'CHECKLIST.md');
      const poisonIndex = resolve(poisonRoot, 'index');
      const sentinel = 'owned poison sentinel: must not be selected\n';
      for (const target of [poisonCatalog, poisonChecklist, poisonIndex]) {
        writeFileSync(target, sentinel);
      }
      const poison = {
        GIT_DIR: poisonRoot,
        GIT_WORK_TREE: poisonRoot,
        GIT_INDEX_FILE: poisonIndex,
        P17_CATALOG_PATH: poisonCatalog,
        P17_CHECKLIST_PATH: poisonChecklist,
        P17_UNKNOWN_CANARY: poisonRoot,
      };
      expect(isolatedCatalogEnvironment(repository, poison).P17_UNKNOWN_CANARY).toBeUndefined();
      const written = runCatalogMutation(mutate, '--write', poison, repository);
      expect(written.exitCode).toBe(0);
      const present = runCatalogMutation(mutate, '--check', poison, repository);
      expect(present.exitCode).toBe(0);
      const innerLicense = resolve(repository.root, path);
      const backup = resolve(directory, 'LICENSE');
      renameSync(innerLicense, backup);
      const result = runCatalogMutation(mutate, '--check', poison, repository);
      expectFailure(
        result,
        `P17-G0-01 owned path is neither a regular repository file nor a recorded deletion: ${path}`,
      );
      for (const target of [poisonCatalog, poisonChecklist, poisonIndex]) {
        expect(readFileSync(target, 'utf8')).toBe(sentinel);
      }
      process.stdout.write(
        `P17_CATALOG_ISOLATED_FIXTURE ${JSON.stringify({
          root: repository.root,
          head: isolatedCatalogGit(repository, repository.root, ['rev-parse', 'HEAD']),
          statusBeforeRemoval: innerStatus,
          statusAfterRemoval: isolatedCatalogGit(repository, repository.root, [
            'status',
            '--porcelain=v1',
          ]),
          indexSha256Before: innerIndexBefore,
          indexSha256After: createHash('sha256').update(readFileSync(innerIndex)).digest('hex'),
          sourceObjectFiles: sourceObjects.size,
          fixtureObjectFiles: fixtureObjects.size,
          sharedObjectInodes: sharedObjects,
          latestEvent,
          presentWriteExit: written.exitCode,
          presentCheckExit: present.exitCode,
          absentCheckExit: result.exitCode,
        })}\n`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(readFileSync(absolute)).toEqual(sourceBytes);
    expect(readFileSync(sourceIndexPath)).toEqual(sourceIndex);
    expect(sourceMetadata()).toEqual(beforeMetadata);
  });

  test('rejects a rename-away instead of treating its path-filtered status as deletion', () => {
    const path = 'commitlint.config.js';
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'ready';
      value.ownedFiles = [path];
      value.testCommands = ['bun test scripts/p17-catalog.test.ts'];
      value.implementers = ['implementation-agent'];
      passGroupThrough(value, 'ready');
    });
    expectFailure(
      result,
      `P17-G0-01 owned path is neither a regular repository file nor a recorded deletion: ${path}`,
    );
  });

  test('accepts an absent owned path only when Git records its deletion', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'ready';
      value.ownedFiles = ['packages/cli/src/util/config-notice.ts'];
      value.testCommands = ['bun test scripts/p17-catalog.test.ts'];
      value.implementers = ['implementation-agent'];
      passGroupThrough(value, 'ready');
    }, '--write');
    expect(result.exitCode).toBe(0);
  });

  test('accepts only a latest exact deletion in a hermetic repository', () => {
    const repository = temporaryGitRepository('skillsmith-p17-deletion-');
    const path = 'owned.ts';
    writeFileSync(resolve(repository, path), 'export const value = 1;\n');
    commitAll(repository, 'add owner');
    rmSync(resolve(repository, path));
    commitAll(repository, 'delete owner');
    expect(gitRecordsExactDeletion(path, repository)).toBe(true);
  });

  test('accepts a deletion recorded on the merged branch under a main-first merge', () => {
    const repository = temporaryGitRepository('skillsmith-p17-merge-direction-');
    const path = 'owned.ts';
    writeFileSync(resolve(repository, 'base.txt'), 'base\n');
    commitAll(repository, 'base without owner');
    runGit(repository, ['checkout', '--quiet', '-b', 'feature']);
    writeFileSync(resolve(repository, path), 'export const value = 1;\n');
    commitAll(repository, 'add owner');
    rmSync(resolve(repository, path));
    commitAll(repository, 'delete owner');
    runGit(repository, ['checkout', '--quiet', '-']);
    writeFileSync(resolve(repository, 'unrelated.txt'), 'main work\n');
    commitAll(repository, 'main work');
    runGit(repository, ['merge', '--no-ff', '--quiet', '-m', 'merge feature', 'feature']);
    expect(gitRecordsExactDeletion(path, repository)).toBe(true);
  });

  test('rejects stale deletion history followed by an add or modification', () => {
    const repository = temporaryGitRepository('skillsmith-p17-stale-deletion-');
    const path = 'owned.ts';
    const absolute = resolve(repository, path);
    writeFileSync(absolute, 'export const value = 1;\n');
    commitAll(repository, 'add owner');
    rmSync(absolute);
    commitAll(repository, 'delete owner');

    writeFileSync(absolute, 'export const value = 2;\n');
    commitAll(repository, 'restore owner');
    rmSync(absolute);
    expect(gitRecordsExactDeletion(path, repository)).toBe(false);

    writeFileSync(absolute, 'export const value = 3;\n');
    commitAll(repository, 'modify restored owner');
    rmSync(absolute);
    expect(gitRecordsExactDeletion(path, repository)).toBe(false);
  });

  test('rejects rename provenance in a hermetic repository', () => {
    const repository = temporaryGitRepository('skillsmith-p17-rename-');
    const oldPath = 'owned.ts';
    writeFileSync(resolve(repository, oldPath), 'export const value = 1;\n');
    commitAll(repository, 'add owner');
    renameSync(resolve(repository, oldPath), resolve(repository, 'renamed.ts'));
    commitAll(repository, 'rename owner');
    expect(gitRecordsExactDeletion(oldPath, repository)).toBe(false);
  });

  test('ignores ambient repository selectors and fails closed on Git errors', () => {
    const intended = temporaryGitRepository('skillsmith-p17-intended-');
    const foreign = temporaryGitRepository('skillsmith-p17-foreign-');
    const path = 'foreign-owned.ts';
    writeFileSync(resolve(foreign, path), 'export {};\n');
    commitAll(foreign, 'add foreign owner');
    rmSync(resolve(foreign, path));
    commitAll(foreign, 'delete foreign owner');

    expect(
      gitRecordsExactDeletion(path, intended, {
        ...process.env,
        GIT_DIR: resolve(foreign, '.git'),
        GIT_WORK_TREE: foreign,
      }),
    ).toBe(false);
    expect(gitRecordsExactDeletion(path, resolve(intended, 'missing-repository'))).toBe(false);
  });

  test('classifies a non-directory parent as non-file rather than absence', () => {
    expect(ownedPathState('package.json/child.ts', root)).toBe('non-file');
  });

  test('rejects ready status after a later lifecycle gate has passed', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'ready';
      value.ownedFiles = [evidence];
      value.testCommands = ['bun test'];
      value.implementers = ['implementation-agent'];
      passGroupThrough(value, 'test-first');
    });
    expectFailure(result, 'P17-G0-01 status ready has incoherent lifecycle gates');
  });

  test('rejects a non-independent adversarial reviewer', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'reviewed';
      value.ownedFiles = [evidence];
      value.testCommands = ['bun test'];
      value.implementers = ['same-agent'];
      value.reviewer = 'same-agent';
      passGroupThrough(value, 'adversarial-review');
    });
    expectFailure(result, 'P17-G0-01 adversarial review lacks an independent reviewer');
  });

  test('rejects failed gates while a group remains planned', () => {
    const result = runCatalogMutation((catalog) => {
      const gate = required(group(catalog).gates.mapped, 'missing mapped gate');
      gate.status = 'failed';
      gate.evidence = [groupEvidence];
    });
    expectFailure(result, 'P17-G0-01 status planned has incoherent lifecycle gates');
  });

  test('rejects impacted-green before every required-now validation passes', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const value = group(catalog);
      value.status = 'active';
      value.ownedFiles = ['scripts/p17-catalog.test.ts'];
      value.testCommands = ['bun test scripts/p17-catalog.test.ts'];
      value.implementers = ['implementation-agent'];
      passGroupThrough(value, 'impacted-green');
    });
    expectFailure(result, 'impacted-green passed before EWP-P0A-TS01 passed');
  });

  test.each(['failed', 'blocked'] as const)(
    'accepts a coherent entity and group %s state',
    (state) => {
      const result = runCatalogMutation((catalog) => {
        activatePhase0(catalog);
        const value = group(catalog);
        value.status = state;
        const gate = required(value.gates.mapped, 'missing mapped gate');
        gate.status = state;
        gate.evidence = [groupEvidence];
        const entity = required(
          catalog.entities.find((item) => item.id === 'EWP-P0A-T01'),
          'missing work entity',
        );
        entity.status = state;
        entity.evidence = [evidence];
      }, '--write');
      expect(result.exitCode).toBe(0);
    },
  );
});

describe('P17 phase lifecycle and ordering', () => {
  test('rejects a planned phase with a passed entry gate', () => {
    const result = runCatalogMutation((catalog) =>
      pass(required(catalog.phases[0], 'missing Phase 0').entry),
    );
    expectFailure(result, 'planned phase 0 has a non-pending gate');
  });

  test('rejects active phase status without passed entry', () => {
    const result = runCatalogMutation((catalog) => {
      required(catalog.phases[0], 'missing Phase 0').status = 'active';
    });
    expectFailure(result, 'phase 0 entry must be passed, found pending');
  });

  test('rejects entering Phase 1 before Phase 0 approval and exit', () => {
    const result = runCatalogMutation((catalog) => {
      const phase = required(
        catalog.phases.find((item) => item.id === '1'),
        'missing Phase 1',
      );
      phase.status = 'active';
      pass(phase.entry);
    });
    expectFailure(result, 'phase 1 entered before phase 0 approval/exit');
  });

  test('rejects a non-independent phase reviewer', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      group(catalog).implementers = ['same-agent'];
      const phase = required(catalog.phases[0], 'missing Phase 0');
      pass(phase.review);
      phase.review.reviewer = 'same-agent';
    });
    expectFailure(result, 'phase 0 reviewer is not independent');
  });

  test('rejects failed review while a phase remains active', () => {
    const result = runCatalogMutation((catalog) => {
      activatePhase0(catalog);
      const phase = required(catalog.phases[0], 'missing Phase 0');
      phase.review.status = 'failed';
      phase.review.evidence = [evidence];
    });
    expectFailure(result, 'active phase 0 has advanced, failed, or blocked closure gates');
  });

  test('rejects entity progress while its group and phase remain planned', () => {
    const result = runCatalogMutation((catalog) => {
      const entity = required(
        catalog.entities.find((item) => item.id === 'EWP-P0A-T01'),
        'missing work entity',
      );
      entity.status = 'green';
      entity.evidence = [evidence];
    });
    expectFailure(result, 'EWP-P0A-T01 advanced before phase 0 entry');
  });
});

describe('P17 final approval gates and reset safety', () => {
  test('rejects final review without a reviewer', () => {
    const result = runCatalogMutation((catalog) => pass(catalog.finalReview));
    expectFailure(result, 'final review passed without reviewer');
  });

  test('rejects final approval before final review', () => {
    const result = runCatalogMutation((catalog) => {
      pass(catalog.finalApproval);
      catalog.finalApproval.approvedBy = 'user';
    });
    expectFailure(result, 'final approval lacks passed review or canonical standing authorization');
  });

  test('rejects final sign-off before final approval', () => {
    const result = runCatalogMutation((catalog) => {
      catalog.finalSignoff.status = 'passed';
      catalog.finalSignoff.evidence = [groupEvidence];
    });
    expectFailure(result, 'final sign-off passed before final approval');
  });

  test('refuses to reset after execution state exists', () => {
    const result = runCatalogMutation((catalog) => {
      group(catalog).ownedFiles = [evidence];
    }, '--reset-baseline');
    expectFailure(result, '--reset-baseline refuses after any execution state exists');
  });
});

describe('P17 preparation checklist parsing', () => {
  function runWithPrep(
    body: string,
    mode = '--check',
    overrides: { project?: string; review?: string; trunk?: string } = {},
  ) {
    const temporaryPrep = temporaryFile('skillsmith-p17-prep-', 'PREP.md');
    writeFileSync(temporaryPrep, body);
    const environment = { ...process.env, P17_PREP_PATH: temporaryPrep };
    if (overrides.project) {
      const project = temporaryFile('skillsmith-p17-project-', 'P17.md');
      writeFileSync(project, overrides.project);
      environment.P17_PROJECT_PATH = project;
    }
    if (overrides.review) {
      const review = temporaryFile('skillsmith-p17-review-', 'review.md');
      writeFileSync(review, overrides.review);
      environment.P17_REVIEW_PATH = review;
    }
    if (overrides.trunk) {
      const trunk = temporaryFile('skillsmith-p17-trunk-', 'PROJECTS.md');
      writeFileSync(trunk, overrides.trunk);
      environment.P17_TRUNK_PATH = trunk;
    }
    return Bun.spawnSync(['bun', 'scripts/check-p17-package.ts', mode], {
      cwd: root,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  test('rejects duplicate canonical checklist definitions', () => {
    const prep = readFileSync(prepPath, 'utf8');
    const result = runWithPrep(`${prep.trimEnd()}\n- [ ] **P17-PREP-A01:** duplicate definition\n`);
    expectFailure(result, 'duplicate preparation checklist definition P17-PREP-A01');
  });

  test('rejects malformed checkbox syntax', () => {
    const prep = readFileSync(prepPath, 'utf8').replace(
      '- [x] **P17-PREP-A01:**',
      '- [X] **P17-PREP-A01:**',
    );
    expectFailure(runWithPrep(prep), 'malformed preparation checklist line');
  });

  test('rejects PR-openable state when an evidence-summary row is pending', () => {
    const prep = readFileSync(prepPath, 'utf8').replace(
      /^(\| Goal research \|[^|]+\|) [^|]+ \|$/m,
      '$1 pending |',
    );
    const result = runWithPrep(prep, '--pr-openable');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(
      /P17-TS01 must be checked if and only if the preparation package is PR-openable|requires the complete pr-openable preparation state/,
    );
  });

  function openableFixture(evidenceValue: (area: string) => string) {
    let prep = readFileSync(prepPath, 'utf8')
      .replace('**Status:** in progress', '**Status:** pr-openable')
      .replace(/^- \[ \] \*\*(P17-PREP-([A-H])(\d{2})):\*\*/gm, '- [x] **$1:**')
      .replace(/^- \[ \] \*\*(P17-PREP-I0[1-3]):\*\*/gm, '- [x] **$1:**');
    prep = prep.replace(
      /^(\| (?!Area |---)([^|]+) \| [^|]+ \|) [^|]+ \|$/gm,
      (_line, prefix: string, area: string) => `${prefix} ${evidenceValue(area.trim())} |`,
    );
    const project = readFileSync(
      resolve(root, 'projects/P17-skillsmith-ergonomics-and-declarative-workflow.md'),
      'utf8',
    ).replace('- [ ] [P17-TS01]', '- [x] [P17-TS01]');
    const reviewIds = [
      ...Array.from(
        { length: 11 },
        (_, index) => `P17-PREP-RV-F${String(index + 1).padStart(2, '0')}`,
      ),
      ...Array.from({ length: 6 }, (_, index) => `P17-AR-F${index + 12}`),
      'P17-QR-F18',
      'P17-QR-F19',
      'P17-BR-F20',
    ];
    const review = `# test review\n\n**Status:** closed\n**Re-review result:** passed\n\n${reviewIds
      .map((id) => `### ${id} — test\n\n- **Disposition:** corrected.\n`)
      .join('\n')}`;
    const trunk = readFileSync(resolve(root, 'PROJECTS.md'), 'utf8').replace(
      '- [ ] **P17** —',
      '- [~] **P17** —',
    );
    return { prep, project, review, trunk };
  }

  test('rejects arbitrary prose as preparation evidence', () => {
    const candidate = openableFixture(() => 'definitely-not-evidence');
    const result = runWithPrep(candidate.prep, '--pr-openable', candidate);
    expectFailure(
      result,
      'P17-TS01 must be checked if and only if the preparation package is PR-openable',
    );
  });

  test('rejects a preparation evidence reference whose Markdown anchor does not exist', () => {
    const candidate = openableFixture((area) => {
      if (area === 'Goal research') return 'projects/P17-GOAL.md#not-a-real-heading';
      if (area === 'PR/merge') {
        return 'projects/p17/evidence/preparation-review.md#candidate-tree; live gate: --merge-ready then --final';
      }
      if (area === 'Handoff') {
        return 'projects/P17-GOAL.md#bootstrap-sentence; manual next step: deliver bootstrap after --final';
      }
      return 'projects/P17-GOAL.md#bootstrap-sentence';
    });
    const result = runWithPrep(candidate.prep, '--pr-openable', candidate);
    expectFailure(
      result,
      'P17-TS01 must be checked if and only if the preparation package is PR-openable',
    );
  });

  test('accepts resolving offline evidence plus explicit live and manual markers', () => {
    const areaEvidence: Record<string, string> = {
      'Goal research': 'research/reference/codex-persistent-goal-2026-07-11.md',
      'Project mechanics': 'projects/P17-skillsmith-ergonomics-and-declarative-workflow.md',
      'Consolidated plan':
        'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md',
      'Execution decomposition': 'projects/p17/EXECUTION.md',
      'Catalog/checklist': 'scripts/p17-catalog.test.ts',
      'Group protocol': 'projects/P17-GOAL.md#per-group-tdd-and-verification-loop',
      'Goal prompt': 'research/topics/codex-persistent-goal/DECISION.md',
      'Adversarial review': 'projects/p17/evidence/preparation-review.md',
      'PR/merge':
        'projects/p17/evidence/preparation-review.md#candidate-tree; live gate: --merge-ready then --final',
      Handoff:
        'projects/P17-GOAL.md#bootstrap-sentence; manual next step: deliver bootstrap after --final',
    };
    const candidate = openableFixture((area) => areaEvidence[area] ?? 'missing');
    const result = runWithPrep(candidate.prep, '--pr-openable', candidate);
    expect(result.exitCode).toBe(0);
  });

  test('rejects a closed review ledger with a missing stable finding', () => {
    const candidate = openableFixture((area) => {
      if (area === 'PR/merge') {
        return 'projects/p17/evidence/preparation-review.md#candidate-tree; live gate: --merge-ready then --final';
      }
      if (area === 'Handoff') {
        return 'projects/P17-GOAL.md#bootstrap-sentence; manual next step: deliver bootstrap after --final';
      }
      return 'projects/P17-GOAL.md#bootstrap-sentence';
    });
    candidate.review = candidate.review.replace(
      /### P17-BR-F20 — test\n\n- \*\*Disposition:\*\* corrected\.\n/,
      '',
    );
    const result = runWithPrep(candidate.prep, '--pr-openable', candidate);
    expectFailure(
      result,
      'P17-TS01 must be checked if and only if the preparation package is PR-openable',
    );
  });
});
