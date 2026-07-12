import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const catalogPath = resolve(root, 'projects/p17/catalog.json');
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

function fixture(): CatalogFixture {
  return JSON.parse(readFileSync(catalogPath, 'utf8')) as CatalogFixture;
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

function runCatalogMutation(
  mutate: (catalog: CatalogFixture) => void,
  mode: '--check' | '--write' | '--reset-baseline' = '--check',
) {
  const temporaryCatalog = temporaryFile('skillsmith-p17-catalog-', 'catalog.json');
  const temporaryChecklist = temporaryFile('skillsmith-p17-checklist-', 'CHECKLIST.md');
  const catalog = fixture();
  mutate(catalog);
  writeFileSync(temporaryCatalog, `${JSON.stringify(catalog, null, 2)}\n`);
  if (mode === '--check') writeFileSync(temporaryChecklist, readFileSync(checklistPath, 'utf8'));
  return Bun.spawnSync(['bun', 'scripts/p17-catalog.ts', mode], {
    cwd: root,
    env: {
      ...process.env,
      P17_CATALOG_PATH: temporaryCatalog,
      P17_CHECKLIST_PATH: temporaryChecklist,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
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
  });

  test('tracks every entity one-to-one with required validation coverage', () => {
    const catalog = fixture();
    const checklistIds = [
      ...readFileSync(checklistPath, 'utf8').matchAll(/^- \[[ x]\] \*\*([^*]+)\*\* —/gm),
    ].map((match) => match[1]);
    const requiredEntities = catalog.entities.filter((entity) => entity.tier !== 'deferred');
    const deferredEntities = catalog.entities.filter((entity) => entity.tier === 'deferred');
    const validations = catalog.entities.filter((entity) => entity.stateModel === 'validation');

    expect(catalog.entities).toHaveLength(425);
    expect(new Set(catalog.entities.map((entity) => entity.id)).size).toBe(425);
    expect(checklistIds).toHaveLength(425);
    expect(new Set(checklistIds).size).toBe(425);
    expect(requiredEntities).toHaveLength(418);
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
    expectFailure(result, 'final approval lacks passed review or explicit user approval');
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
