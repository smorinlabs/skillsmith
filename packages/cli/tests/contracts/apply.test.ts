import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { appendFile, lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  type CliProduct,
  type PlanFixture,
  createPlanFixture,
  destroyPlanFixture,
  runPlanCli,
} from '../../../../tests/ergonomics/fixtures/p4b-plan/cases.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

setDefaultTimeout(120_000);

type UnknownRecord = Record<string, unknown>;

interface DesiredSkill {
  readonly name: string;
  readonly sourcePath: string;
  readonly tools: readonly ('claude-code' | 'codex')[];
  readonly scope: 'user' | 'project';
}

const fixtures: PlanFixture[] = [];
let remote: RemoteFixture;

beforeAll(async () => {
  remote = await buildRemoteFixture();
});

afterAll(async () => {
  await destroyRemoteFixture(remote);
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(destroyPlanFixture));
});

const desiredManifest = (skills: readonly DesiredSkill[]): string =>
  `${[
    '# G4B-02 hermetic apply fixture',
    'version = 1',
    '',
    ...skills.flatMap((skill) => [
      '[[skills]]',
      `name = "${skill.name}"`,
      `source = "fixture.invalid/acme/multi//${skill.sourcePath}"`,
      `tools = [${skill.tools.map((tool) => `"${tool}"`).join(', ')}]`,
      `scope = "${skill.scope}"`,
      'placement = "copy"',
      '',
    ]),
  ].join('\n')}\n`;

const applyFixture = async (
  skills: readonly DesiredSkill[] = [
    {
      name: 'factor-scan',
      sourcePath: 'plugins/fh/skills/factor-scan',
      tools: ['codex'],
      scope: 'user',
    },
  ],
): Promise<PlanFixture> => {
  const fixture = await createPlanFixture([], { writeLock: false });
  fixtures.push(fixture);
  await writeFile(fixture.manifest, desiredManifest(skills));
  const gitConfig = join(fixture.root, 'gitconfig');
  await writeFile(
    gitConfig,
    [
      `[url "${remote.multiUrl}"]`,
      `\tinsteadOf = ${remote.multiSource}`,
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );
  return {
    ...fixture,
    env: {
      ...fixture.env,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_ALLOW_PROTOCOL: 'file:https',
    },
  };
};

const artifactArgs = (fixture: PlanFixture): readonly string[] => [
  '--file',
  fixture.manifest,
  '--lockfile',
  fixture.lock,
];

const runApply = async (fixture: PlanFixture, args: readonly string[]): Promise<CliProduct> =>
  runPlanCli(fixture, ['apply', ...args]);

const runApplyWithSignal = async (
  fixture: PlanFixture,
  args: readonly string[],
): Promise<CliProduct> => {
  const child = Bun.spawn(['bun', CLI_ENTRYPOINT, 'apply', ...args], {
    cwd: fixture.cwd,
    env: hermeticGitEnv(fixture.env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await Bun.sleep(25);
  child.kill('SIGINT');
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

const json = (product: CliProduct, exitCode: number, label: string): UnknownRecord => {
  if (product.exitCode !== exitCode) {
    throw new Error(
      `${label}: expected exit ${exitCode}, received ${product.exitCode}\nstdout:\n${product.stdout}\nstderr:\n${product.stderr}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(product.stdout);
  } catch {
    throw new Error(`${label}: stdout was not one JSON document\n${product.stdout}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: JSON value was not an object`);
  }
  return value as UnknownRecord;
};

const records = (value: unknown, label: string): readonly UnknownRecord[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return entry as UnknownRecord;
  });
};

const operationIds = (report: UnknownRecord): readonly string[] =>
  records(report.operations, 'report.operations').map((operation) => String(operation.operationId));

const exactPlanProjection = (report: UnknownRecord) => ({
  artifactPair: report.artifactPair,
  selection: report.selection,
  operations: report.operations,
  checks: report.checks,
  diagnostics: report.diagnostics,
});

const savePlan = async (fixture: PlanFixture): Promise<UnknownRecord> => {
  const product = await runPlanCli(fixture, [
    'plan',
    ...artifactArgs(fixture),
    '--out',
    fixture.out,
    '--json',
  ]);
  const report = json(product, 0, 'save plan');
  expect(await Bun.file(fixture.out).exists()).toBeTrue();
  return report;
};

const pathState = async (path: string): Promise<unknown> => {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      return { kind: 'symlink', mode: metadata.mode & 0o777, target: await readlink(path) };
    }
    if (metadata.isDirectory()) return { kind: 'dir', mode: metadata.mode & 0o777 };
    return { kind: 'file', mode: metadata.mode & 0o777, bytes: await readFile(path, 'base64') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const stateSnapshot = async (fixture: PlanFixture): Promise<UnknownRecord> => {
  const roots = [fixture.cwd, fixture.home, fixture.data, fixture.config];
  const entries: [string, unknown][] = [];
  for (const root of roots) {
    entries.push([relative(fixture.root, root), await pathState(root)]);
    for (const entry of await readdir(root, { recursive: true, encoding: 'utf8' })) {
      const path = join(root, entry);
      entries.push([relative(fixture.root, path), await pathState(path)]);
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
};

const expectApplyReport = (report: UnknownRecord, mode: string): void => {
  expect(report).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.apply-report',
    command: 'apply',
    mode,
    operations: expect.any(Array),
    checks: expect.any(Array),
    diagnostics: expect.any(Array),
    results: expect.any(Array),
    approval: expect.any(Object),
    validation: expect.any(Object),
    summary: expect.any(Object),
  });
};

describe('EWP-CMD-APPLY-TS01', () => {
  test('fresh preview, approval, under-lock validation, and execution retain one exact plan', async () => {
    const fixture = await applyFixture();
    const plan = json(
      await runPlanCli(fixture, ['plan', ...artifactArgs(fixture), '--json']),
      0,
      'fresh plan',
    );
    const preview = json(
      await runApply(fixture, [...artifactArgs(fixture), '--dry-run', '--json']),
      0,
      'fresh apply dry-run',
    );
    expectApplyReport(preview, 'fresh-dry-run');
    expect(exactPlanProjection(preview)).toEqual(exactPlanProjection(plan));

    const executed = json(
      await runApply(fixture, [...artifactArgs(fixture), '--yes', '--json']),
      0,
      'approved fresh apply',
    );
    expectApplyReport(executed, 'fresh-execute');
    expect(operationIds(executed)).toEqual(operationIds(plan));
    expect(
      records(executed.results, 'execution results').map((result) => result.operationId),
    ).toEqual([...operationIds(plan)]);
    expect(executed.approval).toMatchObject({ required: true, outcome: 'approved' });
    expect(executed.validation).toMatchObject({ outcome: 'valid', replanned: false });
  });
});

describe('EWP-CMD-APPLY-TS02', () => {
  test('changing work defaults to refusal outside approval and only --yes authorizes mutation', async () => {
    const approvalCases = [
      { args: ['--no-prompt'], label: 'explicit noninteraction' },
      { args: [], label: 'non-TTY default' },
    ] as const;
    for (const { args, label } of approvalCases) {
      const fixture = await applyFixture();
      const before = await stateSnapshot(fixture);
      const refused = await runApply(fixture, [...artifactArgs(fixture), ...args, '--json']);
      expect(refused.exitCode, label).toBe(2);
      expect(`${refused.stdout}${refused.stderr}`, label).toMatch(
        /approval|confirm|noninteractive/i,
      );
      expect(await stateSnapshot(fixture), label).toEqual(before);
    }

    const cancelledFixture = await applyFixture();
    const cancelledBefore = await stateSnapshot(cancelledFixture);
    const cancelled = await runApplyWithSignal(cancelledFixture, [
      ...artifactArgs(cancelledFixture),
      '--json',
    ]);
    expect(cancelled.exitCode).toBe(130);
    expect(await stateSnapshot(cancelledFixture)).toEqual(cancelledBefore);

    const approved = await applyFixture();
    expect(
      (await runApply(approved, [...artifactArgs(approved), '--yes', '--json'])).exitCode,
    ).toBe(0);
  });
});

describe('EWP-CMD-APPLY-TS03', () => {
  test('unchanged work never prompts and a second fresh execution is an exact no-op', async () => {
    const empty = await applyFixture([]);
    const unchanged = json(
      await runApply(empty, [...artifactArgs(empty), '--no-prompt', '--json']),
      0,
      'empty apply',
    );
    expectApplyReport(unchanged, 'fresh-execute');
    expect(operationIds(unchanged)).toEqual([]);
    expect(unchanged.approval).toMatchObject({ required: false, outcome: 'not-required' });

    const fixture = await applyFixture();
    expect((await runApply(fixture, [...artifactArgs(fixture), '--yes', '--json'])).exitCode).toBe(
      0,
    );
    const before = await stateSnapshot(fixture);
    const second = json(
      await runApply(fixture, [...artifactArgs(fixture), '--no-prompt', '--json']),
      0,
      'second apply',
    );
    expect(operationIds(second)).toEqual([]);
    expect(await stateSnapshot(fixture)).toEqual(before);
  });
});

describe('EWP-CMD-APPLY-TS04', () => {
  test('default lock resolution is visible while locked mode refuses a missing lock', async () => {
    const fixture = await applyFixture();
    const before = await stateSnapshot(fixture);
    const preview = json(
      await runApply(fixture, [...artifactArgs(fixture), '--dry-run', '--json']),
      0,
      'default lock preview',
    );
    expect(records(preview.operations, 'preview operations').map(({ kind }) => kind)).toContain(
      'write-lock',
    );
    expect(await stateSnapshot(fixture)).toEqual(before);

    const strict = await runApply(fixture, [
      ...artifactArgs(fixture),
      '--locked',
      '--dry-run',
      '--json',
    ]);
    expect(strict.exitCode).toBe(3);
    expect(await stateSnapshot(fixture)).toEqual(before);

    const executed = await runApply(fixture, [...artifactArgs(fixture), '--yes', '--json']);
    expect(executed.exitCode).toBe(0);
    expect(await Bun.file(fixture.lock).exists()).toBeTrue();
  });
});

describe('EWP-CMD-APPLY-TS05', () => {
  test('fresh filters remain bounded and saved selection rejects every widening override', async () => {
    const fixture = await applyFixture([
      {
        name: 'factor-scan',
        sourcePath: 'plugins/fh/skills/factor-scan',
        tools: ['codex'],
        scope: 'user',
      },
      {
        name: 'review',
        sourcePath: 'plugins/web/skills/review',
        tools: ['claude-code'],
        scope: 'project',
      },
    ]);
    const selected = json(
      await runApply(fixture, [
        ...artifactArgs(fixture),
        '--tool',
        'codex',
        '--scope',
        'user',
        '--dry-run',
        '--json',
      ]),
      0,
      'bounded filter preview',
    );
    expect(selected.selection).toMatchObject({
      skills: ['factor-scan'],
      tools: ['codex'],
      scopes: ['user'],
    });
    expect(
      records(selected.operations, 'selected operations').every(({ skill }) =>
        skill === null ? true : skill === 'factor-scan',
      ),
    ).toBeTrue();

    const filteredToZero = json(
      await runApply(fixture, [
        ...artifactArgs(fixture),
        '--tool',
        'opencode',
        '--dry-run',
        '--json',
      ]),
      0,
      'filter-to-zero preview',
    );
    expect(operationIds(filteredToZero)).toEqual([]);
    expect(filteredToZero.selection).toMatchObject({ selectionOutcome: 'filter-noop' });

    await savePlan(fixture);
    for (const override of [
      ['--file', fixture.manifest],
      ['--lockfile', fixture.lock],
      ['--tool', 'codex'],
      ['--scope', 'user'],
      ['--user'],
      ['--project'],
      ['--locked'],
      ['--prune'],
    ] as const) {
      const product = await runApply(fixture, [
        '--plan',
        fixture.out,
        ...override,
        '--dry-run',
        '--json',
      ]);
      expect(product.exitCode, override.join(' ')).toBe(2);
    }
  });
});

describe('EWP-CMD-APPLY-TS06', () => {
  test('saved dry-run/check/execute use exact recorded operations and retain every input byte', async () => {
    const fixture = await applyFixture();
    const planned = await savePlan(fixture);
    const planBytes = await readFile(fixture.out);
    const stateBeforeValidation = await stateSnapshot(fixture);

    const dryRun = json(
      await runApply(fixture, ['--plan', fixture.out, '--dry-run', '--json']),
      0,
      'saved dry-run',
    );
    const check = json(
      await runApply(fixture, ['--plan', fixture.out, '--check', '--json']),
      7,
      'saved check',
    );
    for (const report of [dryRun, check]) {
      expect(operationIds(report)).toEqual(operationIds(planned));
      expect(report.validation).toMatchObject({ outcome: 'valid', replanned: false });
    }
    expect(exactPlanProjection(check)).toEqual(exactPlanProjection(dryRun));
    expect(await stateSnapshot(fixture)).toEqual(stateBeforeValidation);
    expect(await readFile(fixture.out)).toEqual(planBytes);

    const executed = json(
      await runApply(fixture, ['--plan', fixture.out, '--json']),
      0,
      'saved execution',
    );
    expect(operationIds(executed)).toEqual(operationIds(planned));
    expect(executed.approval).toMatchObject({ required: false, outcome: 'prior-authorization' });
    expect(await readFile(fixture.out)).toEqual(planBytes);
  });
});

describe('EWP-CMD-APPLY-TS07', () => {
  test('scoped state and compatibility changes independently retain or stale authorization', async () => {
    const fixture = await applyFixture();
    await savePlan(fixture);
    const planBytes = await readFile(fixture.out, 'utf8');
    const manifestBytes = await readFile(fixture.manifest, 'utf8');

    await writeFile(join(fixture.home, 'unrelated.txt'), 'unselected local state\n');
    expect((await runApply(fixture, ['--plan', fixture.out, '--dry-run', '--json'])).exitCode).toBe(
      0,
    );

    await appendFile(fixture.manifest, '# formatting-only comment\n');
    expect((await runApply(fixture, ['--plan', fixture.out, '--dry-run', '--json'])).exitCode).toBe(
      0,
    );

    await appendFile(
      fixture.manifest,
      '\n[[skills]]\nname = "review"\nsource = "fixture.invalid/acme/multi//plugins/web/skills/review"\ntools = ["codex"]\nscope = "user"\n',
    );
    const semanticallyStale = await runApply(fixture, [
      '--plan',
      fixture.out,
      '--dry-run',
      '--json',
    ]);
    expect(semanticallyStale.exitCode).toBe(3);
    expect(`${semanticallyStale.stdout}${semanticallyStale.stderr}`).toMatch(
      /stale|changed|regenerate/i,
    );
    await writeFile(fixture.manifest, manifestBytes);

    const mutations = [
      ['executorSchemaVersion', 999],
      ['hashSchemaVersion', 999],
    ] as const;
    for (const [field, value] of mutations) {
      const artifact = JSON.parse(planBytes) as UnknownRecord;
      artifact[field] = value;
      await writeFile(fixture.out, `${JSON.stringify(artifact)}\n`);
      const incompatible = await runApply(fixture, ['--plan', fixture.out, '--dry-run', '--json']);
      expect(incompatible.exitCode, field).toBe(3);
      expect(`${incompatible.stdout}${incompatible.stderr}`, field).toMatch(
        /incompatible|unsupported|regenerate|schema/i,
      );
    }
    await writeFile(fixture.out, planBytes);
  });
});

describe('EWP-CMD-APPLY-TS08', () => {
  test('saved dependencies are honored once and results retain deterministic scheduler order', async () => {
    const fixture = await applyFixture([
      {
        name: 'factor-scan',
        sourcePath: 'plugins/fh/skills/factor-scan',
        tools: ['claude-code', 'codex'],
        scope: 'user',
      },
    ]);
    const planned = await savePlan(fixture);
    const operations = records(planned.operations, 'planned operations');
    const ids = operationIds(planned);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, operation] of operations.entries()) {
      for (const dependency of operation.dependsOn as readonly string[]) {
        expect(ids.indexOf(dependency), `${operation.operationId} dependency`).toBeLessThan(index);
      }
    }

    const applied = json(
      await runApply(fixture, ['--plan', fixture.out, '--json']),
      0,
      'dependency execution',
    );
    expect(operationIds(applied)).toEqual(ids);
    const results = records(applied.results, 'scheduler results');
    expect(results.map(({ operationId }) => operationId)).toEqual([...ids]);
    expect(results.every(({ outcome }) => outcome === 'succeeded')).toBeTrue();
  });
});

describe('EWP-CMD-APPLY-TS09', () => {
  test('one tool failure is truthful and a fresh rerun converges the independently successful tool', async () => {
    const fixture = await applyFixture([
      {
        name: 'factor-scan',
        sourcePath: 'plugins/fh/skills/factor-scan',
        tools: ['claude-code', 'codex'],
        scope: 'user',
      },
    ]);
    await mkdir(join(fixture.home, '.claude'), { recursive: true });
    await writeFile(join(fixture.home, '.claude', 'skills'), 'synthetic path conflict\n');

    const partial = json(
      await runApply(fixture, [...artifactArgs(fixture), '--continue-on-error', '--yes', '--json']),
      1,
      'partial multi-tool apply',
    );
    const results = records(partial.results, 'partial results');
    expect(results.some(({ outcome }) => outcome === 'failed')).toBeTrue();
    expect(results.some(({ outcome }) => outcome === 'succeeded')).toBeTrue();

    await Bun.file(join(fixture.home, '.claude', 'skills')).delete();
    const rerun = json(
      await runApply(fixture, [...artifactArgs(fixture), '--yes', '--json']),
      0,
      'fresh convergence rerun',
    );
    expect(
      records(rerun.results, 'rerun results').filter(({ outcome }) => outcome === 'succeeded'),
    ).toHaveLength(1);
  });
});

describe('EWP-CMD-APPLY-TS10', () => {
  test('v1 ledger migration is explicit and preserves original artifact bytes', async () => {
    const fixture = await applyFixture();
    const ledger = join(fixture.data, 'skillsmith', 'placements.json');
    await mkdir(dirname(ledger), { recursive: true });
    const originalLedger = `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'skillsmith.placements',
        updatedAt: '2026-07-19T00:00:00.000Z',
        skills: {},
      },
      null,
      2,
    )}\n`;
    await writeFile(ledger, originalLedger);
    const originalManifest = await readFile(fixture.manifest);

    const preview = json(
      await runApply(fixture, [...artifactArgs(fixture), '--dry-run', '--json']),
      0,
      'v1 migration preview',
    );
    expect(records(preview.operations, 'migration operations').map(({ kind }) => kind)).toContain(
      'migrate-ledger',
    );
    expect(await readFile(ledger, 'utf8')).toBe(originalLedger);
    expect(await readFile(fixture.manifest)).toEqual(originalManifest);

    const applied = await runApply(fixture, [...artifactArgs(fixture), '--yes', '--json']);
    expect(applied.exitCode).toBe(0);
    expect(await readFile(fixture.manifest)).toEqual(originalManifest);
    expect(JSON.parse(await readFile(ledger, 'utf8')).schemaVersion).toBe(2);
  });
});

describe('EWP-CMD-APPLY-TS11', () => {
  test('fresh fail-fast, continue-on-error, and real errors outrank drift', async () => {
    const fixture = await applyFixture([
      {
        name: 'factor-scan',
        sourcePath: 'plugins/fh/skills/factor-scan',
        tools: ['claude-code', 'codex'],
        scope: 'user',
      },
    ]);
    await mkdir(join(fixture.home, '.claude'), { recursive: true });
    await writeFile(join(fixture.home, '.claude', 'skills'), 'synthetic path conflict\n');

    const failFast = json(
      await runApply(fixture, [...artifactArgs(fixture), '--yes', '--json']),
      1,
      'fail-fast apply',
    );
    expect(records(failFast.results, 'fail-fast results')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'failed' }),
        expect.objectContaining({ outcome: 'skipped', reason: 'fail-fast' }),
      ]),
    );

    const continued = json(
      await runApply(fixture, [
        ...artifactArgs(fixture),
        '--continue-on-error',
        '--check',
        '--json',
      ]),
      1,
      'continued check with real error',
    );
    expect(continued.summary).toMatchObject({
      drift: expect.any(Number),
      failed: expect.any(Number),
    });
  });
});

describe('EWP-CMD-APPLY-TS12', () => {
  test('fresh and saved grammar, help, and exact 0/7/3 validation exits are closed', async () => {
    const fixture = await applyFixture();
    const help = await runApply(fixture, ['--help']);
    expect(help.exitCode).toBe(0);
    for (const option of [
      '--file <path>',
      '--lockfile <path>',
      '--plan <path>',
      '--tool <name>',
      '--scope <scope>',
      '--locked',
      '--prune',
      '--yes',
      '--continue-on-error',
      '--dry-run',
      '--check',
      '--json',
    ]) {
      expect(help.stdout, option).toContain(option);
    }

    for (const args of [
      [...artifactArgs(fixture), '--dry-run', '--check'],
      [...artifactArgs(fixture), '--dry-run', '--yes'],
      [...artifactArgs(fixture), '--check', '--yes'],
      ['--lockfile', fixture.lock, '--dry-run'],
      ['unexpected-positional'],
    ] as const) {
      expect((await runApply(fixture, [...args, '--json'])).exitCode, args.join(' ')).toBe(2);
    }

    await savePlan(fixture);
    const planBytes = await readFile(fixture.out, 'utf8');
    expect((await runApply(fixture, ['--plan', fixture.out, '--dry-run', '--json'])).exitCode).toBe(
      0,
    );
    expect((await runApply(fixture, ['--plan', fixture.out, '--check', '--json'])).exitCode).toBe(
      7,
    );
    for (const args of [
      ['--plan', fixture.out, '--dry-run', '--check'],
      ['--plan', fixture.out, '--yes'],
      ['--plan', fixture.out, '--continue-on-error'],
    ] as const) {
      expect((await runApply(fixture, [...args, '--json'])).exitCode, args.join(' ')).toBe(2);
    }
    const stale = JSON.parse(planBytes) as UnknownRecord;
    stale.executorSchemaVersion = 999;
    await writeFile(fixture.out, `${JSON.stringify(stale)}\n`);
    expect((await runApply(fixture, ['--plan', fixture.out, '--check', '--json'])).exitCode).toBe(
      3,
    );
  });
});

describe('EWP-CMD-APPLY-TS13', () => {
  test('human, JSON, quiet, verbose, and SIGINT share one redacted semantic result', async () => {
    const fixture = await applyFixture();
    const base = [...artifactArgs(fixture), '--dry-run'] as const;
    const human = await runApply(fixture, base);
    const jsonProduct = await runApply(fixture, [...base, '--json']);
    const quiet = await runApply(fixture, ['--quiet', ...base]);
    const verbose = await runApply(fixture, ['--verbose', ...base]);
    expect([human.exitCode, jsonProduct.exitCode, quiet.exitCode, verbose.exitCode]).toEqual([
      0, 0, 0, 0,
    ]);
    const report = json(jsonProduct, 0, 'JSON preview');
    expectApplyReport(report, 'fresh-dry-run');
    for (const id of operationIds(report)) expect(human.stdout).toContain(id);
    expect(quiet).toMatchObject({ stdout: '', stderr: '' });
    expect(verbose.stdout).toBe(human.stdout);
    expect(verbose.stderr).toContain('detail: command.started');

    const cancelled = await runApplyWithSignal(fixture, [...artifactArgs(fixture), '--json']);
    expect(cancelled.exitCode).toBe(130);
    expect(`${cancelled.stdout}${cancelled.stderr}`).not.toMatch(/stack|at .*\.ts:/i);
  });
});

describe('EWP-CMD-APPLY-TS14', () => {
  test('multi-tool/scope source reuse binds portably and never leaks nested sensitive values', async () => {
    const canaries = [
      'Bearer G4B02_PRIVATE_TOKEN',
      'https://user:password@fixture.invalid/acme/multi.git',
      'G4B02_SYNTHETIC_SECRET',
    ] as const;
    const fixture = await applyFixture([
      {
        name: 'factor-scan',
        sourcePath: 'plugins/fh/skills/factor-scan',
        tools: ['claude-code', 'codex'],
        scope: 'user',
      },
      {
        name: 'review',
        sourcePath: 'plugins/web/skills/review',
        tools: ['codex'],
        scope: 'project',
      },
    ]);
    const selected: PlanFixture = {
      ...fixture,
      env: { ...fixture.env, G4B02_SYNTHETIC_SECRET: canaries[2] },
    };
    const planned = await savePlan(selected);
    const bytes = await readFile(selected.out, 'utf8');
    expect(planned.selection).toMatchObject({
      skills: ['factor-scan', 'review'],
      tools: ['claude-code', 'codex'],
      scopes: ['project', 'user'],
    });
    expect(JSON.parse(bytes)).toMatchObject({
      schemaVersion: 1,
      kind: 'skillsmith.plan',
      portability: expect.objectContaining({ kind: expect.any(String) }),
    });
    const product = await runApply(selected, ['--plan', selected.out, '--dry-run', '--json']);
    expect(product.exitCode).toBe(0);
    for (const canary of canaries) {
      expect(bytes, canary).not.toContain(canary);
      expect(`${product.stdout}${product.stderr}`, canary).not.toContain(canary);
    }

    const artifact = JSON.parse(bytes) as UnknownRecord;
    const portability = artifact.portability as UnknownRecord;
    if (portability.kind === 'machine-bound') {
      expect(portability).toMatchObject({ reasons: expect.any(Array) });
      expect(records(portability.reasons, 'machine-bound reasons').length).toBeGreaterThan(0);
    } else {
      expect(bytes).not.toContain(selected.root);
    }
  });
});
