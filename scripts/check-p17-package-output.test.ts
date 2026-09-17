import { describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const checker = resolve(root, 'scripts/check-p17-package.ts');
const catalog = JSON.parse(readFileSync(resolve(root, 'projects/p17/catalog.json'), 'utf8')) as {
  readonly entities: readonly { readonly status: string; readonly tier: string }[];
  readonly groups: readonly {
    readonly id: string;
    readonly phase: string;
    readonly status: string;
    readonly gates: Readonly<Record<string, { readonly status: string }>>;
  }[];
  readonly phases: readonly { readonly id: string; readonly status: string }[];
  readonly finalReview: { readonly status: string };
  readonly finalApproval: { readonly status: string };
  readonly finalSignoff: { readonly status: string };
};

const lifecycleGateNames = [
  'mapped',
  'ready',
  'test-first',
  'minimal-implementation',
  'targeted-green',
  'impacted-green',
  'refactor',
  'adversarial-review',
  'traceability-closure',
  'signed-off',
] as const;

const expectedV1 =
  'structurally valid; preparation/PR/merge readiness was not asserted: 86 prep IDs, 25 local links, valid: 426 entities (419 required, 7 deferred; 244 validation obligations), 45 groups, deterministic checklist';

const run = (version?: '1' | '2' | 'invalid') =>
  Bun.spawnSync(['bun', checker, '--check'], {
    cwd: root,
    env: {
      ...process.env,
      ...(version === undefined ? {} : { P17_CHECK_OUTPUT_VERSION: version }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

describe('P17 package-check output compatibility', () => {
  test('v1 remains an exact one-line compatibility output', () => {
    const result = run('1');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe('');
    const output = result.stdout.toString().trimEnd();
    expect(output.split('\n')).toHaveLength(1);
    expect(output).toBe(expectedV1);
    expect(output).not.toContain('recorded progress:');
  });

  test('the atomic default selects v2 while preserving the complete v1 first line', () => {
    const before = run('1');
    const explicitV2 = run('2');
    const stable = run();
    const after = run('1');
    for (const result of [before, explicitV2, stable, after]) {
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toBe('');
    }

    const v1 = before.stdout.toString().trimEnd();
    const v2 = explicitV2.stdout.toString().trimEnd();
    expect(after.stdout.toString().trimEnd()).toBe(v1);
    expect(stable.stdout.toString().trimEnd()).toBe(v2);
    expect(v2.split('\n')[0]).toBe(v1);

    const requiredEntities = catalog.entities.filter((entity) => entity.tier !== 'deferred');
    const signedEntities = requiredEntities.filter(
      (entity) => entity.status === 'signed-off',
    ).length;
    const requiredGroups = catalog.groups.filter((group) => group.phase !== '7');
    const signedGroups = requiredGroups.filter((group) => group.status === 'signed-off').length;
    const requiredPhases = catalog.phases.filter((phase) => phase.id !== '7');
    const approvedPhases = requiredPhases.filter((phase) => phase.status === 'approved').length;
    expect(v2).toContain('recorded progress:');
    expect(v2).toContain(`phases:   ${approvedPhases}/${requiredPhases.length} approved`);
    expect(v2).toContain(
      `groups:   ${signedGroups}/${requiredGroups.length} required groups signed off`,
    );
    expect(v2).toContain(
      `entities: ${signedEntities}/${requiredEntities.length} required entities signed off`,
    );

    for (const group of requiredGroups.filter(
      (item) => !['planned', 'signed-off', 'deferred'].includes(item.status),
    )) {
      const passed = lifecycleGateNames.filter(
        (name) => group.gates[name]?.status === 'passed',
      ).length;
      const next = lifecycleGateNames.find((name) => group.gates[name]?.status !== 'passed');
      expect(v2).toContain(
        `current:  ${group.id} — ${group.status} — ${passed}/${lifecycleGateNames.length} lifecycle gates passed`,
      );
      if (next) expect(v2).toContain(`next:     ${group.id}:${next}`);
    }
    expect(v2).toContain(
      `final:    review ${catalog.finalReview.status}; approval ${catalog.finalApproval.status}; sign-off ${catalog.finalSignoff.status}`,
    );
  }, 55_000);

  test('an unknown output version fails closed', () => {
    const result = run('invalid');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'unsupported P17_CHECK_OUTPUT_VERSION invalid; use 1 or 2',
    );
  });
});

// Each observation runs the current checker in an independent repository. In
// particular, stale index stat data must never be manufactured in the source tree.
const fixturePaths = {
  P17_PROJECT_PATH: 'projects/P17-skillsmith-ergonomics-and-declarative-workflow.md',
  P17_PREP_PATH: 'projects/p17/PREP.md',
  P17_REVIEW_PATH: 'projects/p17/evidence/preparation-review.md',
  P17_TRUNK_PATH: 'PROJECTS.md',
  P17_CATALOG_PATH: 'projects/p17/catalog.json',
  P17_CHECKLIST_PATH: 'projects/p17/CHECKLIST.md',
};

function fixtureEnvironment(base: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(base).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('P17_')),
  );
  return {
    ...env,
    HOME: resolve(directory, 'home'),
    XDG_CONFIG_HOME: resolve(directory, 'home'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...Object.fromEntries(
      Object.entries(fixturePaths).map(([key, path]) => [key, resolve(directory, 'repo', path)]),
    ),
    P17_CHECK_OUTPUT_VERSION: '1',
  };
}

type GitEvent = { event: string; sid: string; argv?: string[]; code?: number };

async function withCheckerFixture(
  name: string,
  check: (fixture: Awaited<ReturnType<typeof checkerFixture>>) => Promise<void>,
): Promise<void> {
  const fixture = await checkerFixture(name);
  try {
    await check(fixture);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

async function checkerFixture(name: string) {
  const directory = mkdtempSync(resolve(tmpdir(), 'skillsmith-checker-observation-'));
  const repo = resolve(directory, 'repo');
  const evidence = process.env.SC_I17_R3_EVIDENCE_DIR
    ? mkdtempSync(resolve(process.env.SC_I17_R3_EVIDENCE_DIR, `${name}-`))
    : resolve(directory, 'evidence');
  mkdirSync(evidence, { recursive: true });
  mkdirSync(resolve(directory, 'home'));
  const env = fixtureEnvironment(process.env, directory);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.autoRefreshIndex=false',
        ...args,
      ],
      {
        cwd: existsSync(repo) ? repo : directory,
        env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git('clone', '--no-local', '--no-hardlinks', '--quiet', root, repo);
    copyFileSync(checker, resolve(repo, 'scripts/check-p17-package.ts'));
    git('add', '--', 'scripts/check-p17-package.ts');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'test: overlay current checker',
    );
    git('update-index', '--refresh');
    expect(realpathSync(git('rev-parse', '--show-toplevel'))).toBe(realpathSync(repo));
    expect(realpathSync(repo)).not.toBe(realpathSync(root));
    for (const option of ['--absolute-git-dir', '--git-common-dir']) {
      expect(realpathSync(resolve(repo, git('rev-parse', option)))).toBe(
        realpathSync(resolve(repo, '.git')),
      );
    }
    expect(existsSync(resolve(repo, '.git/objects/info/alternates'))).toBe(false);
    for (const key of Object.keys(fixturePaths)) {
      expect(realpathSync(env[key] ?? '').startsWith(`${realpathSync(repo)}/`)).toBe(true);
    }
    const bin = resolve(directory, 'bin');
    mkdirSync(bin);
    const ghLog = resolve(evidence, 'gh.jsonl');
    const gh = resolve(bin, 'gh');
    writeFileSync(
      gh,
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\nconsole.error('SC_R3_GH_SENTINEL_REACHED');\nprocess.exit(86);\n`,
      { mode: 0o755 },
    );
    env.PATH = `${bin}:${env.PATH ?? ''}`;
    expect(Bun.which('gh', { PATH: env.PATH })).toBe(gh);
    writeFileSync(
      resolve(evidence, 'setup.json'),
      JSON.stringify(
        {
          repo,
          outer: root,
          gitRoot: git('rev-parse', '--show-toplevel'),
          gh: Bun.which('gh', { PATH: env.PATH }),
          overrides: Object.fromEntries(
            Object.entries(env).filter(([key]) => key.startsWith('P17_')),
          ),
        },
        null,
        2,
      ),
    );
    const identity = () => ({
      index: readFileSync(resolve(repo, '.git/index')).toString('hex'),
      config: readFileSync(resolve(repo, '.git/config')).toString('hex'),
      head: git('rev-parse', 'HEAD'),
      ref: git('symbolic-ref', 'HEAD'),
      stage: git('ls-files', '--stage'),
    });
    const staleLicense = async () => {
      const license = resolve(repo, 'LICENSE');
      const bytes = readFileSync(license);
      const mode = statSync(license).mode;
      const cached = Number(
        git('ls-files', '--debug', '--', 'LICENSE').match(/ctime: (\d+):/)?.[1],
      );
      expect(Number.isFinite(cached)).toBe(true);
      const deadline = Date.now() + 3000;
      while (Math.floor(statSync(license).ctimeMs / 1000) <= cached && Date.now() < deadline) {
        renameSync(license, `${license}.held`);
        renameSync(`${license}.held`, license);
        await Bun.sleep(20);
      }
      expect(Math.floor(statSync(license).ctimeMs / 1000)).toBeGreaterThan(cached);
      expect(readFileSync(license)).toEqual(bytes);
      expect(statSync(license).mode).toBe(mode);
    };
    const observe = (label: string, mode: '--check' | '--merge-ready') => {
      const trace = resolve(evidence, `${label}.trace.jsonl`);
      const before = identity();
      writeFileSync(resolve(evidence, `${label}.before.index`), Buffer.from(before.index, 'hex'));
      writeFileSync(ghLog, '');
      const command = [process.execPath, resolve(repo, 'scripts/check-p17-package.ts'), mode];
      const result = Bun.spawnSync(command, {
        cwd: repo,
        env: { ...env, GIT_TRACE2_EVENT: trace },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const after = identity();
      writeFileSync(resolve(evidence, `${label}.after.index`), Buffer.from(after.index, 'hex'));
      const events: GitEvent[] = readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const commands = events
        .filter((event) => event.event === 'start')
        .map((event) => ({
          argv: event.argv ?? [],
          exit: events.find((end) => end.sid === event.sid && end.event === 'exit')?.code,
        }));
      const calls = readFileSync(ghLog, 'utf8').trim();
      writeFileSync(
        resolve(evidence, `${label}.json`),
        JSON.stringify(
          { command, cwd: repo, exit: result.exitCode, commands, ghCalls: calls, before, after },
          null,
          2,
        ),
      );
      writeFileSync(resolve(evidence, `${label}.stdout`), result.stdout);
      writeFileSync(resolve(evidence, `${label}.stderr`), result.stderr);
      return { result, before, after, commands, calls };
    };
    return { directory, repo, env, git, identity, staleLicense, observe };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function expectUnchanged(
  observation: ReturnType<Awaited<ReturnType<typeof checkerFixture>>['observe']>,
) {
  // Keep the raw-byte assertion separate so a stale-stat write is an explicit RED.
  expect(
    observation.after.index === observation.before.index,
    'checker changed raw index bytes',
  ).toBe(true);
  expect(observation.after).toEqual(observation.before);
}

describe('P17 checker Git observations', () => {
  test('fixture overrides discard poisoned paths and output version', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'skillsmith-checker-poison-'));
    try {
      const poison = resolve(directory, 'poison');
      writeFileSync(poison, 'owned fixture canary');
      const env = fixtureEnvironment(
        {
          ...process.env,
          ...Object.fromEntries(Object.keys(fixturePaths).map((key) => [key, poison])),
          P17_CHECK_OUTPUT_VERSION: 'invalid',
          P17_UNKNOWN_CANARY: 'poison',
          GIT_DIR: poison,
        },
        resolve(directory, 'fixture'),
      );
      expect(env.P17_CHECK_OUTPUT_VERSION).toBe('1');
      expect(env.P17_UNKNOWN_CANARY).toBeUndefined();
      expect(env.GIT_DIR).toBeUndefined();
      expect(
        Object.keys(env)
          .filter((key) => key.startsWith('P17_'))
          .sort(),
      ).toEqual([...Object.keys(fixturePaths), 'P17_CHECK_OUTPUT_VERSION'].sort());
      for (const [key, path] of Object.entries(fixturePaths)) {
        expect(env[key]).toBe(resolve(directory, 'fixture/repo', path));
      }
      expect(readFileSync(poison, 'utf8')).toBe('owned fixture canary');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const optional of [undefined, '0', '1']) {
    test(`preserves stale raw index with optional locks ${optional ?? 'absent'}`, async () => {
      await withCheckerFixture(`optional-${optional ?? 'absent'}`, async (fixture) => {
        if (optional !== undefined) fixture.env.GIT_OPTIONAL_LOCKS = optional;
        await fixture.staleLicense();
        const observed = fixture.observe('check', '--check');
        expect(observed.result.exitCode, observed.result.stderr.toString()).toBe(0);
        expect(observed.result.stdout.toString().trim()).toBe(expectedV1);
        expectUnchanged(observed);
      });
    }, 15_000);
  }

  test('command policy overrides repository, global and inherited refresh settings', async () => {
    await withCheckerFixture('precedence', async (fixture) => {
      fixture.git('config', 'diff.autoRefreshIndex', 'true');
      const global = resolve(fixture.directory, 'global.config');
      writeFileSync(global, '[diff]\n\tautoRefreshIndex = true\n');
      fixture.env.GIT_CONFIG_GLOBAL = global;
      fixture.env.GIT_CONFIG_COUNT = '1';
      fixture.env.GIT_CONFIG_KEY_0 = 'diff.autoRefreshIndex';
      fixture.env.GIT_CONFIG_VALUE_0 = 'true';
      fixture.env.GIT_OPTIONAL_LOCKS = '1';
      const beforeGlobal = readFileSync(global);
      await fixture.staleLicense();
      const observed = fixture.observe('check', '--check');
      expect(observed.result.exitCode, observed.result.stderr.toString()).toBe(0);
      expect(readFileSync(global)).toEqual(beforeGlobal);
      expectUnchanged(observed);
    });
  }, 15_000);

  test('Git rejects noncanonical whitespace without changing raw index', async () => {
    await withCheckerFixture('whitespace', async (fixture) => {
      appendFileSync(resolve(fixture.repo, 'LICENSE'), 'fixture whitespace   \n');
      await fixture.staleLicense();
      const observed = fixture.observe('whitespace', '--check');
      const stderr = observed.result.stderr.toString();
      expect(observed.result.exitCode).toBe(1);
      expect(stderr).toContain('git diff --check failed');
      expect(stderr).toMatch(/LICENSE:\d+: trailing whitespace\./);
      expect(stderr).not.toContain('has trailing whitespace');
      expect(
        observed.commands.some(({ argv, exit }) => argv.includes('--check') && exit === 2),
      ).toBe(true);
      expect(observed.calls).toBe('');
      expectUnchanged(observed);
    });
  }, 15_000);

  test('merge-ready reaches Git gates before gh and rejects dirty canonical content', async () => {
    await withCheckerFixture('canonical', async (fixture) => {
      await fixture.staleLicense();
      const clean = fixture.observe('clean', '--merge-ready');
      expect(clean.result.exitCode).toBe(1);
      expect(clean.result.stderr.toString()).toContain('SC_R3_GH_SENTINEL_REACHED');
      const calls = clean.calls.split('\n').map((line) => JSON.parse(line));
      expect(calls).toEqual([
        { argv: ['api', 'repos/smorinlabs/skillsmith/pulls/31'], cwd: fixture.repo },
      ]);
      expect(
        clean.commands.filter(({ argv }) => argv.includes('--exit-code')).map(({ exit }) => exit),
      ).toEqual([0, 0]);
      expect(
        clean.commands.some(({ argv, exit }) => argv.includes('--error-unmatch') && exit === 0),
      ).toBe(true);
      appendFileSync(resolve(fixture.repo, 'CLAUDE.md'), '\nFixture-only content change.\n');
      await fixture.staleLicense();
      const dirty = fixture.observe('dirty', '--merge-ready');
      expect(dirty.result.exitCode).toBe(1);
      expect(dirty.result.stderr.toString()).toContain('git diff --exit-code');
      expect(dirty.result.stderr.toString()).toContain('diff --git a/CLAUDE.md b/CLAUDE.md');
      expect(
        dirty.commands.some(
          ({ argv, exit }) =>
            argv.includes('--exit-code') && !argv.includes('--cached') && exit === 1,
        ),
      ).toBe(true);
      expect(dirty.calls).toBe('');
      expectUnchanged(clean);
      expectUnchanged(dirty);
    });
  }, 15_000);
});
