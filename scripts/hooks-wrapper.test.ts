import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WRAPPER = join(import.meta.dir, 'hooks', 'hook-wrapper.sh');
const RESOLVER = join(import.meta.dir, 'hooks', 'resolve-lefthook.sh');
const HOOK_NAMES = ['pre-push', 'pre-commit', 'commit-msg'] as const;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed with ${code}`);
}

interface Fixture {
  root: string;
  farm: string;
  link: (hook: string) => string;
}

// Fixture: a temp git repo carrying copies of the wrapper + resolver under
// scripts/hooks (the layout the wrapper resolves through git), hook-name
// symlinks to exercise $0 dispatch, and a tool farm holding only the binaries
// the wrapper needs — never lefthook unless the case installs a stub there.
async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'skillsmith-hooks-fixture-'));
  tempDirs.push(root);
  await runGit(['init', '-q'], root);
  await runGit(['config', 'user.email', 'fixture@example.invalid'], root);
  await runGit(['config', 'user.name', 'fixture'], root);
  const scriptsDir = join(root, 'scripts', 'hooks');
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(WRAPPER, join(scriptsDir, 'hook-wrapper.sh'));
  copyFileSync(RESOLVER, join(scriptsDir, 'resolve-lefthook.sh'));
  chmodSync(join(scriptsDir, 'hook-wrapper.sh'), 0o755);
  const farm = join(root, 'farm');
  mkdirSync(farm);
  for (const tool of ['git', 'uname', 'tr', 'basename']) {
    const found = Bun.which(tool);
    if (found === null) throw new Error(`fixture requires ${tool} on PATH`);
    symlinkSync(found, join(farm, tool));
  }
  return {
    root,
    farm,
    link: (hook: string) => {
      // Exact hook name so $0 dispatch is exercised.
      const named = join(root, hook);
      symlinkSync(join(scriptsDir, 'hook-wrapper.sh'), named);
      return named;
    },
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runHook(
  path: string,
  env: Record<string, string>,
  cwd: string,
  args: string[] = [],
  stdin?: string,
): Promise<RunResult> {
  const proc = Bun.spawn([path, ...args], {
    env,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin === undefined ? 'ignore' : 'pipe',
  });
  if (stdin !== undefined) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function stubLefthook(farm: string, exitCode: number): void {
  const stub = join(farm, 'lefthook');
  writeFileSync(
    stub,
    `#!/bin/sh\nif [ "$1" = "-h" ]; then exit 0; fi\necho "ARGS:$*"\ncat\nexit ${exitCode}\n`,
  );
  chmodSync(stub, 0o755);
}

describe('fail-closed hook wrapper', () => {
  test('case A: missing binary refuses loudly on all three hook names', async () => {
    const fixture = await makeFixture();
    const env = {
      PATH: `${fixture.farm}:/usr/bin:/bin`,
      HOME: fixture.root,
    };
    for (const hook of HOOK_NAMES) {
      const result = await runHook(fixture.link(hook), env, fixture.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lefthook binary not found');
      expect(result.stderr).toContain('bun install');
      expect(result.stderr).toContain('verify-hooks');
    }
  });

  test('case B: stub binary receives delegation with args, stdin, and exit code', async () => {
    const fixture = await makeFixture();
    stubLefthook(fixture.farm, 0);
    const payload = 'deadbeef cafef00d refs/heads/main 0000000000000000000000000000000000000000\n';
    const env = {
      PATH: `${fixture.farm}:/usr/bin:/bin`,
      HOME: fixture.root,
    };
    const prePush = fixture.link('pre-push');
    const result = await runHook(
      prePush,
      env,
      fixture.root,
      ['origin', 'https://example.invalid/repo.git'],
      payload,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ARGS:run pre-push origin https://example.invalid/repo.git');
    expect(result.stdout).toContain(payload.trimEnd());

    stubLefthook(fixture.farm, 3);
    const failing = await runHook(prePush, env, fixture.root);
    expect(failing.code).toBe(3);
  });

  test('case B2: LEFTHOOK_BIN override takes precedence over PATH', async () => {
    const fixture = await makeFixture();
    const overrideDir = join(fixture.root, 'override');
    mkdirSync(overrideDir);
    stubLefthook(overrideDir, 0);
    const env = {
      PATH: `${fixture.farm}:/usr/bin:/bin`,
      HOME: fixture.root,
      LEFTHOOK_BIN: join(overrideDir, 'lefthook'),
    };
    const result = await runHook(fixture.link('commit-msg'), env, fixture.root, [
      '.git/COMMIT_EDITMSG',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ARGS:run commit-msg .git/COMMIT_EDITMSG');
  });

  test('case C: LEFTHOOK=0 exits 0 with a bypass notice', async () => {
    const fixture = await makeFixture();
    const env = {
      PATH: `${fixture.farm}:/usr/bin:/bin`,
      HOME: fixture.root,
      LEFTHOOK: '0',
    };
    const result = await runHook(fixture.link('pre-commit'), env, fixture.root);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('bypassed via LEFTHOOK=0');
  });
});
