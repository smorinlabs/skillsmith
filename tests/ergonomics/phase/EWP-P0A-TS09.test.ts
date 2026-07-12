import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const transientPaths: string[] = [];
const groupEvidence = 'projects/p17/evidence/P17-G0-01.md';

type Gate = { status: string; evidence: string[] };
type EntityFixture = {
  id: string;
  kind: string;
  stateModel: string;
  primaryGroup: string;
  tier: string;
  status: string;
  plannedTarget: string;
  target: { kind: string; path: string; selector: string; command: string } | null;
  validatedBy: string[];
  secondaryGroups: string[];
  implements: string[];
  impactedValidations: string[];
  affectedContracts: string[];
  ownedFiles: string[];
  testCommands: string[];
  evidence: string[];
  [key: string]: unknown;
};
type GroupFixture = {
  id: string;
  phase: string;
  dependsOn: string[];
  status: string;
  ownedFiles: string[];
  testCommands: string[];
  implementers: string[];
  reviewer: string | null;
  gates: Record<string, Gate>;
  requiredNowValidations: string[];
  downstreamCoverage: string[];
  impactedValidations: string[];
  evidence: string[];
  [key: string]: unknown;
};
type PhaseFixture = {
  id: string;
  status: string;
  entry: Gate;
  review: Gate & { reviewer: string | null };
  approval: Gate & { approvedBy: string | null };
  [key: string]: unknown;
};
type CatalogFixture = {
  baselineDate: string;
  entities: EntityFixture[];
  groups: GroupFixture[];
  phases: PhaseFixture[];
  finalReview: Gate & { reviewer: string | null };
  finalApproval: Gate & { approvedBy: string | null };
  [key: string]: unknown;
};

let generatedBaseline: { catalog: string; checklist: string } | undefined;

afterEach(() => {
  for (const path of transientPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  transientPaths.push(directory);
  return directory;
}

function baseline(): { catalog: string; checklist: string } {
  if (generatedBaseline) return generatedBaseline;
  const directory = temporaryDirectory('p17-ts09-baseline-');
  const catalog = resolve(directory, 'catalog.json');
  const checklist = resolve(directory, 'CHECKLIST.md');
  const result = Bun.spawnSync(['bun', 'scripts/p17-catalog.ts', '--init'], {
    cwd: root,
    env: { ...process.env, P17_CATALOG_PATH: catalog, P17_CHECKLIST_PATH: checklist },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  generatedBaseline = {
    catalog: readFileSync(catalog, 'utf8'),
    checklist: readFileSync(checklist, 'utf8'),
  };
  return generatedBaseline;
}

function freshBaseline(): CatalogFixture {
  return JSON.parse(baseline().catalog) as CatalogFixture;
}

function runCatalog(
  catalogBody: string,
  checklistBody = baseline().checklist,
  mode: '--check' | '--write' = '--check',
) {
  const directory = temporaryDirectory('p17-ts09-mutation-');
  const catalog = resolve(directory, 'catalog.json');
  const checklist = resolve(directory, 'CHECKLIST.md');
  writeFileSync(catalog, catalogBody);
  writeFileSync(checklist, checklistBody);
  return Bun.spawnSync(['bun', 'scripts/p17-catalog.ts', mode], {
    cwd: root,
    env: { ...process.env, P17_CATALOG_PATH: catalog, P17_CHECKLIST_PATH: checklist },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function runMutation(mutate: (catalog: CatalogFixture) => void) {
  const catalog = freshBaseline();
  mutate(catalog);
  return runCatalog(`${JSON.stringify(catalog, null, 2)}\n`);
}

function expectRejected(result: ReturnType<typeof runCatalog>): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).not.toBe('');
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function writeRepositoryFixture(name: string, body: string): string {
  const directory = resolve(root, 'tests/ergonomics/phase/.p17-ts09-fixtures');
  transientPaths.push(directory);
  const path = resolve(directory, name);
  Bun.spawnSync(['mkdir', '-p', directory]);
  writeFileSync(path, body);
  return relative(root, path);
}

function writeScriptFixture(name: string, body: string): string {
  const path = resolve(root, 'scripts', `.p17-ts09-${name}`);
  transientPaths.push(path);
  writeFileSync(path, body);
  return relative(root, path);
}

function pass(gate: Gate): void {
  gate.status = 'passed';
  gate.evidence = [groupEvidence];
}

function activateTs01(
  catalog: CatalogFixture,
  targetPath: string,
  receiptPath: string,
  status: 'passing' | 'failing' | 'skipped-required' | 'active' | 'blocked' = 'passing',
): void {
  const phase = required(
    catalog.phases.find((item) => item.id === '0'),
    'missing Phase 0',
  );
  phase.status = 'active';
  phase.entry = {
    status: 'passed',
    evidence: ['projects/p17/evidence/standing-authorization.md'],
  };
  const group = required(
    catalog.groups.find((item) => item.id === 'P17-G0-01'),
    'missing G0-01',
  );
  group.status =
    status === 'skipped-required' ? 'failed' : status === 'blocked' ? 'blocked' : 'active';
  group.ownedFiles = [targetPath];
  group.testCommands = [`bun test ${targetPath} --test-name-pattern EWP-P0A-TS01`];
  group.implementers = ['ts09-fixture'];
  const gates = Object.values(group.gates);
  for (const gate of gates) {
    gate.status = 'pending';
    gate.evidence = [];
  }
  pass(required(gates[0], 'missing mapped gate'));
  pass(required(gates[1], 'missing ready gate'));
  if (status === 'skipped-required' || status === 'blocked') {
    const gate = required(gates[2], 'missing test-first gate');
    gate.status = status === 'blocked' ? 'blocked' : 'failed';
    gate.evidence = [groupEvidence];
  } else {
    pass(required(gates[2], 'missing test-first gate'));
    if (status === 'passing') {
      pass(required(gates[3], 'missing implementation gate'));
      pass(required(gates[4], 'missing targeted-green gate'));
    }
  }
  const entity = required(
    catalog.entities.find((item) => item.id === 'EWP-P0A-TS01'),
    'missing TS01',
  );
  entity.status = status;
  entity.ownedFiles = [targetPath];
  entity.target = {
    kind: 'test',
    path: targetPath,
    selector: entity.id,
    command: `bun test ${targetPath} --test-name-pattern ${entity.id}`,
  };
  entity.evidence = [`${receiptPath}#ewp-p0a-ts01`];
}

function receipt(command: string, exit: number | string, result: string): string {
  return `# Fixture\n\n## EWP-P0A-TS01\n\n- Validation ID: \`EWP-P0A-TS01\`\n- Command: \`${command}\`\n- Exit status: \`${exit}\`\n- Result: ${result}\n- Revision: \`working-tree\`\n`;
}

describe('EWP-P0A-TS09 verification-catalog closure', () => {
  test('EWP-P0A-TS09 selector executes', () => {
    expect(true).toBe(true);
  });

  test('generates byte-identical catalog and checklist baselines', () => {
    const first = baseline();
    generatedBaseline = undefined;
    const second = baseline();
    expect(second).toEqual(first);
  });

  test('safely synchronizes only validation planned targets and refuses identity drift', () => {
    const catalog = freshBaseline();
    for (const entity of catalog.entities) {
      if (entity.stateModel === 'validation') entity.plannedTarget = `planned:legacy:${entity.id}`;
    }
    const before = structuredClone(catalog);
    const directory = temporaryDirectory('p17-ts09-sync-');
    const catalogPath = resolve(directory, 'catalog.json');
    const checklistPath = resolve(directory, 'CHECKLIST.md');
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const result = Bun.spawnSync(['bun', 'scripts/p17-catalog.ts', '--sync-planned-targets'], {
      cwd: root,
      env: {
        ...process.env,
        P17_CATALOG_PATH: catalogPath,
        P17_CHECKLIST_PATH: checklistPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const synchronized = JSON.parse(readFileSync(catalogPath, 'utf8')) as CatalogFixture;
    for (const [index, entity] of synchronized.entities.entries()) {
      const prior = required(before.entities[index], 'prior entity');
      if (entity.stateModel === 'validation') prior.plannedTarget = entity.plannedTarget;
    }
    expect(synchronized).toEqual(before);

    const driftedBody = readFileSync(catalogPath, 'utf8').replace('EWP-P0A-T01', 'EWP-P0A-T99');
    writeFileSync(catalogPath, driftedBody);
    const rejected = Bun.spawnSync(['bun', 'scripts/p17-catalog.ts', '--sync-planned-targets'], {
      cwd: root,
      env: {
        ...process.env,
        P17_CATALOG_PATH: catalogPath,
        P17_CHECKLIST_PATH: checklistPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(rejected.exitCode).not.toBe(0);
    expect(readFileSync(catalogPath, 'utf8')).toBe(driftedBody);
    expect(rejected.stderr.toString()).toContain(
      'refuses an entity ID, kind, cardinality, or order',
    );
  });

  test.each([
    ['missing entity', (catalog: CatalogFixture) => catalog.entities.splice(0, 1)],
    [
      'duplicate entity',
      (catalog: CatalogFixture) =>
        catalog.entities.push(structuredClone(required(catalog.entities[0], 'entity'))),
    ],
    ['out-of-order entities', (catalog: CatalogFixture) => catalog.entities.reverse()],
    ['out-of-order groups', (catalog: CatalogFixture) => catalog.groups.reverse()],
    ['out-of-order phases', (catalog: CatalogFixture) => catalog.phases.reverse()],
    [
      'malformed relation',
      (catalog: CatalogFixture) => {
        required(catalog.entities[0], 'entity').validatedBy = 'prose' as unknown as string[];
      },
    ],
    [
      'unknown entity field',
      (catalog: CatalogFixture) => {
        required(catalog.entities[0], 'entity').unknown = true;
      },
    ],
    [
      'baseline-date drift',
      (catalog: CatalogFixture) => {
        catalog.baselineDate = 'unknown';
      },
    ],
    [
      'unreferenced deferred state',
      (catalog: CatalogFixture) => {
        const item = required(
          catalog.entities.find((entity) => entity.tier === 'deferred'),
          'deferred',
        );
        item.status = 'planned';
      },
    ],
    [
      'dirty planned target',
      (catalog: CatalogFixture) => {
        const item = required(
          catalog.entities.find((entity) => entity.stateModel === 'validation'),
          'validation',
        );
        item.target = {
          kind: 'test',
          path: 'README.md',
          selector: item.id,
          command: `bun test README.md ${item.id}`,
        };
      },
    ],
    [
      'prose-only planned target',
      (catalog: CatalogFixture) => {
        const item = required(
          catalog.entities.find((entity) => entity.id === 'EWP-P6-TS06'),
          'P6 TS06',
        );
        item.plannedTarget = 'planned:README.md';
      },
    ],
    [
      'future required-now owner',
      (catalog: CatalogFixture) => {
        const group = required(
          catalog.groups.find((item) => item.id === 'P17-G0-05'),
          'G0-05',
        );
        group.requiredNowValidations.push('EWP-P6-TS06');
        group.downstreamCoverage = group.downstreamCoverage.filter((id) => id !== 'EWP-P6-TS06');
      },
    ],
    [
      'disappearing downstream coverage',
      (catalog: CatalogFixture) => {
        const group = required(
          catalog.groups.find((item) => item.id === 'P17-G0-05'),
          'G0-05',
        );
        group.downstreamCoverage = [];
        group.impactedValidations = group.impactedValidations.filter((id) => id !== 'EWP-P6-TS06');
      },
    ],
    [
      'wrong relation kind',
      (catalog: CatalogFixture) => {
        const item = required(
          catalog.entities.find((entity) => entity.id === 'EWP-CF-039'),
          'CF-039',
        );
        item.affectedContracts = ['EWP-P0A-TS01'];
      },
    ],
  ] as Array<[string, (catalog: CatalogFixture) => void]>)('rejects %s', (_name, mutate) => {
    expectRejected(runMutation(mutate));
  });

  test('rejects invalid JSON and a manually drifted checklist', () => {
    expectRejected(runCatalog('{'));
    expectRejected(runCatalog(baseline().catalog, `${baseline().checklist}\nmanual drift\n`));
  });

  test.each([
    ['comment-only selector', `// test('EWP-P0A-TS01 comment only', () => {});\n`],
    [
      'skipped selector',
      `import { test } from 'bun:test';\ntest.skip('EWP-P0A-TS01 skipped', () => {});\n`,
    ],
    ['todo selector', `import { test } from 'bun:test';\ntest.todo('EWP-P0A-TS01 todo');\n`],
  ])('rejects a %s as an executable target', (_name, targetBody) => {
    const catalog = freshBaseline();
    const targetPath = writeRepositoryFixture('selector.test.ts', targetBody);
    const command = `bun test ${targetPath} --test-name-pattern EWP-P0A-TS01`;
    const evidencePath = writeRepositoryFixture('receipt.md', receipt(command, 0, '1 passed'));
    activateTs01(catalog, targetPath, evidencePath);
    expectRejected(runCatalog(`${JSON.stringify(catalog, null, 2)}\n`));

    const mixedCatalog = freshBaseline();
    const mixedTargetPath = writeRepositoryFixture(
      'mixed-duplicate-selector.test.ts',
      `import { describe, test } from 'bun:test';\ndescribe('EWP-P0A-TS01 owning suite', () => {\n  test('nested case', () => {});\n});\ntest('EWP-P0A-TS01 hidden second owner', () => {});\n`,
    );
    const mixedCommand = `bun test ${mixedTargetPath} --test-name-pattern EWP-P0A-TS01`;
    const mixedEvidencePath = writeRepositoryFixture(
      'mixed-duplicate-selector.md',
      receipt(mixedCommand, 0, '2 passed'),
    );
    activateTs01(mixedCatalog, mixedTargetPath, mixedEvidencePath);
    expectRejected(runCatalog(`${JSON.stringify(mixedCatalog, null, 2)}\n`));
  });

  test('rejects a symlink rather than treating it as a repository-owned regular target', () => {
    const catalog = freshBaseline();
    const outside = resolve(temporaryDirectory('p17-ts09-outside-'), 'outside.test.ts');
    writeFileSync(outside, `import { test } from 'bun:test'; test('EWP-P0A-TS01', () => {});\n`);
    const link = resolve(root, 'tests/ergonomics/phase/.p17-ts09-target.test.ts');
    transientPaths.push(link);
    symlinkSync(outside, link);
    const targetPath = relative(root, link);
    const command = `bun test ${targetPath} --test-name-pattern EWP-P0A-TS01`;
    const evidencePath = writeRepositoryFixture(
      'symlink-receipt.md',
      receipt(command, 0, '1 passed'),
    );
    activateTs01(catalog, targetPath, evidencePath);
    expectRejected(runCatalog(`${JSON.stringify(catalog, null, 2)}\n`));
  });

  test('rejects shell-tailed commands and skipped or mixed-success receipts', () => {
    for (const outcome of ['skipped', '1 passed, 1 failed', 'passed with error']) {
      const catalog = freshBaseline();
      const targetPath = writeRepositoryFixture(
        `passing-${outcome.replace(/\W/g, '-')}.test.ts`,
        `import { test } from 'bun:test'; test('EWP-P0A-TS01 passes', () => {});\n`,
      );
      const command = `bun test ${targetPath} --test-name-pattern EWP-P0A-TS01`;
      const evidencePath = writeRepositoryFixture(
        `receipt-${outcome.replace(/\W/g, '-')}.md`,
        receipt(command, 0, outcome),
      );
      activateTs01(catalog, targetPath, evidencePath);
      expectRejected(runCatalog(`${JSON.stringify(catalog, null, 2)}\n`));
    }

    const catalog = freshBaseline();
    const targetPath = writeRepositoryFixture(
      'shell-tail.test.ts',
      `import { test } from 'bun:test'; test('EWP-P0A-TS01 passes', () => {});\n`,
    );
    const evidencePath = writeRepositoryFixture(
      'shell-tail-receipt.md',
      receipt(`bun test ${targetPath} --test-name-pattern EWP-P0A-TS01; true`, 0, '1 passed'),
    );
    activateTs01(catalog, targetPath, evidencePath);
    const entity = required(
      catalog.entities.find((item) => item.id === 'EWP-P0A-TS01'),
      'TS01',
    );
    const target = required(entity.target ?? undefined, 'TS01 target');
    target.command += '; true';
    expectRejected(runCatalog(`${JSON.stringify(catalog, null, 2)}\n`));
  });

  test('accepts truthful red and skipped-required receipts without allowing green closure', () => {
    for (const [status, outcome] of [
      ['failing', '1 failed'],
      ['skipped-required', 'required suite skipped'],
    ] as const) {
      const catalog = freshBaseline();
      const targetPath = writeRepositoryFixture(
        `${status}.test.ts`,
        `import { test } from 'bun:test'; test('EWP-P0A-TS01 red fixture', () => { throw new Error('red'); });\n`,
      );
      const command = `bun test ${targetPath} --test-name-pattern EWP-P0A-TS01`;
      const evidencePath = writeRepositoryFixture(`${status}.md`, receipt(command, 1, outcome));
      activateTs01(catalog, targetPath, evidencePath, status);
      const result = runCatalog(
        `${JSON.stringify(catalog, null, 2)}\n`,
        baseline().checklist,
        '--write',
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      expect(result.exitCode).toBe(0);
    }
  });

  test('rejects a syntactically exact signed revision that is not a real target commit', () => {
    const catalog = freshBaseline();
    const phase = required(
      catalog.phases.find((item) => item.id === '0'),
      'Phase 0',
    );
    phase.status = 'active';
    phase.entry = {
      status: 'passed',
      evidence: ['projects/p17/evidence/standing-authorization.md'],
    };
    const group = required(
      catalog.groups.find((item) => item.id === 'P17-G0-01'),
      'G0-01',
    );
    group.status = 'signed-off';
    group.ownedFiles = ['scripts/p17-catalog.test.ts'];
    group.testCommands = ['bun test scripts/p17-catalog.test.ts'];
    group.implementers = ['ts09-fixture'];
    group.reviewer = 'independent-ts09-fixture';
    for (const gate of Object.values(group.gates)) pass(gate);

    const receiptSections: string[] = ['# Signed fixture', ''];
    for (const entity of catalog.entities.filter((item) => item.primaryGroup === group.id)) {
      entity.status = 'signed-off';
      entity.evidence = [groupEvidence];
      if (entity.stateModel !== 'validation') continue;
      const path =
        entity.id === 'EWP-P0A-TS01'
          ? 'scripts/p17-catalog.test.ts'
          : `tests/ergonomics/phase/${entity.id}.test.ts`;
      const command = `bun test ${path} --test-name-pattern ${entity.id}`;
      entity.target = { kind: 'test', path, selector: entity.id, command };
      entity.ownedFiles = [path];
      const anchor = entity.id.toLowerCase();
      const evidencePath = 'tests/ergonomics/phase/.p17-ts09-fixtures/signed-receipts.md';
      entity.evidence = [`${evidencePath}#${anchor}`];
      receiptSections.push(
        `## ${entity.id}`,
        '',
        `- Validation ID: \`${entity.id}\``,
        `- Command: \`${command}\``,
        '- Exit status: `0`',
        '- Result: 1 passed',
        `- Revision: \`${'0'.repeat(40)}\``,
        '',
      );
    }
    writeRepositoryFixture('signed-receipts.md', `${receiptSections.join('\n')}\n`);
    const result = runCatalog(`${JSON.stringify(catalog, null, 2)}\n`);
    expectRejected(result);
    expect(result.stderr.toString()).toContain('signed receipt revision');
  });

  test('F01 rejects lifecycle gate drift and identities attached to pending gates', () => {
    expectRejected(
      runMutation((catalog) => {
        const group = required(
          catalog.groups.find((item) => item.id === 'P17-G0-05'),
          'G0-05',
        );
        group.gates.unexpected = { status: 'pending', evidence: [] };
      }),
    );
    expectRejected(
      runMutation((catalog) => {
        required(catalog.phases[1], 'Phase 1').review.reviewer = 'premature-reviewer';
      }),
    );
    expectRejected(
      runMutation((catalog) => {
        catalog.finalApproval.approvedBy = 'premature-approver';
      }),
    );
  });

  test('F02 requires dual target ownership and one executable selector owner', () => {
    for (const missingOwner of ['entity', 'group'] as const) {
      const catalog = freshBaseline();
      const targetPath = writeRepositoryFixture(
        `ownership-${missingOwner}.test.ts`,
        `import { test } from 'bun:test'; test('EWP-P0A-TS01 owner', () => {});\n`,
      );
      const command = `bun test ${targetPath} --test-name-pattern EWP-P0A-TS01`;
      const evidencePath = writeRepositoryFixture(
        `ownership-${missingOwner}.md`,
        receipt(command, 0, '1 passed'),
      );
      activateTs01(catalog, targetPath, evidencePath);
      if (missingOwner === 'entity') {
        required(
          catalog.entities.find((item) => item.id === 'EWP-P0A-TS01'),
          'TS01',
        ).ownedFiles = [];
      } else {
        required(
          catalog.groups.find((item) => item.id === 'P17-G0-01'),
          'G0-01',
        ).ownedFiles = [];
      }
      expectRejected(runCatalog(`${JSON.stringify(catalog, null, 2)}\n`));
    }

    const catalog = freshBaseline();
    const targetPath = writeRepositoryFixture(
      'duplicate-selector.test.ts',
      `import { test } from 'bun:test';\ntest('EWP-P0A-TS01 first', () => {});\ntest('EWP-P0A-TS01 second', () => {});\n`,
    );
    const command = `bun test ${targetPath} --test-name-pattern EWP-P0A-TS01`;
    const evidencePath = writeRepositoryFixture(
      'duplicate-selector.md',
      receipt(command, 0, '2 passed'),
    );
    activateTs01(catalog, targetPath, evidencePath);
    expectRejected(runCatalog(`${JSON.stringify(catalog, null, 2)}\n`));
  });

  test('F03 accepts only exact allowlisted non-test command grammars', () => {
    const makeStatic = (suffix: string, commandFor: (path: string) => string) => {
      const catalog = freshBaseline();
      const targetPath = writeScriptFixture(
        `static-${suffix}.ts`,
        `export const validation = 'EWP-P0A-TS01';\n`,
      );
      const command = commandFor(targetPath);
      const evidencePath = writeRepositoryFixture(
        `static-${suffix}.md`,
        receipt(command, 0, 'static check passed'),
      );
      activateTs01(catalog, targetPath, evidencePath);
      const target = required(
        required(
          catalog.entities.find((item) => item.id === 'EWP-P0A-TS01'),
          'TS01',
        ).target ?? undefined,
        'target',
      );
      target.kind = 'static';
      target.command = command;
      return catalog;
    };
    const valid = makeStatic(
      'valid',
      (path) => `bun run ${path} --check --validation EWP-P0A-TS01`,
    );
    const validResult = runCatalog(
      `${JSON.stringify(valid, null, 2)}\n`,
      baseline().checklist,
      '--write',
    );
    if (validResult.exitCode !== 0) throw new Error(validResult.stderr.toString());
    expect(validResult.exitCode).toBe(0);
    for (const [suffix, commandFor] of [
      ['bogus', (path: string) => `bun run ${path} EWP-P0A-TS01`],
      [
        'trailing',
        (path: string) => `bun run ${path} --check --validation EWP-P0A-TS01 --unexpected`,
      ],
    ] as const) {
      expectRejected(runCatalog(`${JSON.stringify(makeStatic(suffix, commandFor), null, 2)}\n`));
    }
  });

  test('F04 enforces truthful failing, active, and blocked receipt semantics', () => {
    const failing = freshBaseline();
    const failingTarget = writeRepositoryFixture(
      'failing-semantics.test.ts',
      `import { test } from 'bun:test'; test('EWP-P0A-TS01 failure', () => {});\n`,
    );
    const failingCommand = `bun test ${failingTarget} --test-name-pattern EWP-P0A-TS01`;
    const failingEvidence = writeRepositoryFixture(
      'failing-semantics.md',
      receipt(failingCommand, 1, 'execution remains pending'),
    );
    activateTs01(failing, failingTarget, failingEvidence, 'failing');
    expectRejected(runCatalog(`${JSON.stringify(failing, null, 2)}\n`));

    for (const [status, exit, outcome] of [
      ['active', 'not-run', 'execution active'],
      ['blocked', 'blocked', 'execution blocked'],
    ] as const) {
      const catalog = freshBaseline();
      const targetPath = writeRepositoryFixture(
        `${status}-semantics.test.ts`,
        `import { test } from 'bun:test'; test('EWP-P0A-TS01 ${status}', () => {});\n`,
      );
      const command = `bun test ${targetPath} --test-name-pattern EWP-P0A-TS01`;
      const evidencePath = writeRepositoryFixture(
        `${status}-semantics.md`,
        receipt(command, exit, outcome),
      );
      activateTs01(catalog, targetPath, evidencePath, status);
      expect(
        runCatalog(`${JSON.stringify(catalog, null, 2)}\n`, baseline().checklist, '--write')
          .exitCode,
      ).toBe(0);
    }
  });

  test('F05 rejects dependencies on a normalized later phase rank', () => {
    expectRejected(
      runMutation((catalog) => {
        const group = required(
          catalog.groups.find((item) => item.id === 'P17-G3A-01'),
          'G3A-01',
        );
        group.dependsOn = ['P17-G3B-01'];
      }),
    );
  });

  test('F06 rejects the legacy plain-user approval identity', () => {
    const result = runMutation((catalog) => {
      const phase = required(catalog.phases[0], 'Phase 0');
      phase.approval.status = 'passed';
      phase.approval.approvedBy = 'user';
      phase.approval.evidence = ['projects/p17/evidence/standing-authorization.md'];
    });
    expectRejected(result);
    expect(result.stderr.toString()).toContain(
      'approval lacks passed review or canonical standing authorization',
    );
  });

  test('F07 maps P0-08 to future spawned-CLI ownership, never G0-05 or TS09', () => {
    const catalog = freshBaseline();
    const p008 = required(
      catalog.entities.find((item) => item.id === 'P0-08'),
      'P0-08',
    );
    expect(p008.primaryGroup).toBe('P17-G2-05');
    expect(p008.validatedBy).toEqual([
      'EWP-P1-TS01',
      'EWP-P1-TS02',
      'EWP-P1-TS03',
      'EWP-P1-TS04',
      'EWP-P1-TS05',
      'EWP-P1-TS06',
      'EWP-P1-TS07',
      'EWP-P2-TS02',
      'EWP-P2-TS06',
      'EWP-CMD-CONFIG-TS03',
      'EWP-CMD-CONFIG-TS04',
      'EWP-WF14',
    ]);
    expect(p008.secondaryGroups).toEqual([
      'P17-G1-01',
      'P17-G1-02B',
      'P17-G1-02C',
      'P17-G1-02A',
      'P17-G1-03',
      'P17-G2-01',
    ]);
    expect(p008.validatedBy).not.toContain('EWP-P0A-TS09');
    const g005Entities = catalog.entities.filter((item) => item.primaryGroup === 'P17-G0-05');
    expect(g005Entities.every((item) => !item.implements.includes('P0-08'))).toBe(true);

    expectRejected(
      runMutation((mutated) => {
        required(
          mutated.entities.find((item) => item.id === 'P0-08'),
          'P0-08',
        ).primaryGroup = 'P17-G0-05';
      }),
    );
  });
});
