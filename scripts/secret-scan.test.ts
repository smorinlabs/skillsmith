import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseFindings, runScan } from './secret-scan';

const root = resolve(import.meta.dir, '..');
const cli = join(root, 'scripts/secret-scan.ts');
const config = readFileSync(join(root, '.gitleaks.toml'), 'utf8');
const temporary: string[] = [];
// Assembled at runtime: no complete credential-shaped control is committed.
const control = ['ghp', 'A7b9Cd2Ef4Gh6Jk8Lm0Np3Qr5St7Uv9Wx1Yz'].join('_');
const generic = ['Z7pQ4vR9', 'mT2xK8nL', '6wB3cF5h'].join('');
const dummy = ['ghp', 'P17SECRET1'].join('_');

function environment(home: string) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    LANG: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function command(cwd: string, args: string[], input?: string, env = environment(cwd)) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    input,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.signal) throw new Error('Test subprocess did not complete.');
  return result;
}

function git(cwd: string, ...args: string[]): string {
  const result = command(cwd, [
    'git',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Scanner Test',
    '-c',
    'user.email=scanner@example.invalid',
    ...args,
  ]);
  if (result.status !== 0) throw new Error('Fixture Git command failed.');
  return result.stdout.trim();
}

function put(cwd: string, path: string, content: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'skillsmith-scan-test-'));
  temporary.push(cwd);
  git(cwd, 'init', '-b', 'main');
  put(cwd, '.gitleaks.toml', config);
  put(
    cwd,
    '.secret-scan-exceptions.json',
    readFileSync(join(root, '.secret-scan-exceptions.json'), 'utf8'),
  );
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'fixture');
  return cwd;
}

function scan(cwd: string, mode: string, ...args: string[]) {
  return command(cwd, [process.execPath, cli, mode, ...args]);
}

function findingFiles(output: string, scanner: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((row) => row.scanner === scanner)
    .map((row) => row.file);
}

function assertRedacted(output: string) {
  expect(output.includes(control)).toBe(false);
  expect(output.includes(generic)).toBe(false);
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('credential scanner boundaries', () => {
  test('detects provider controls in every previously excluded directory with both scanners', () => {
    const cwd = fixture();
    const paths = [
      'src/control.txt',
      'docs/nested/control.md',
      'research/control.txt',
      'packages/core/tests/control.ts',
      'packages/cli/tests/control.ts',
      'packages/core/tests/fixtures/control.txt',
      'packages/cli/tests/fixtures/control.txt',
      'tests/ergonomics/fixtures/control.txt',
      'projects/p17/evidence/control.md',
      '.env',
    ];
    for (const path of paths) put(cwd, path, `github_token = "${control}"\n`);
    put(cwd, '.gitleaks.toml', `${config}\n# github_token = "${control}"\n`);
    git(cwd, 'add', '.');
    const result = scan(cwd, 'files');
    assertRedacted(result.stdout + result.stderr);
    expect(result.status).toBe(1);
    for (const scanner of ['gitleaks', 'trufflehog']) {
      expect(new Set(findingFiles(result.stdout, scanner))).toEqual(
        new Set([...paths, '.gitleaks.toml']),
      );
    }
  }, 180_000);

  test('detects generic assignments and disposable private keys without provider calls', () => {
    const cwd = fixture();
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    put(cwd, 'docs/credentials.txt', `api_key = "${generic}"\n`);
    put(cwd, 'research/disposable.pem', privateKey);
    git(cwd, 'add', '.');
    const result = scan(cwd, 'files');
    expect(result.status).toBe(1);
    expect(findingFiles(result.stdout, 'gitleaks')).toContain('docs/credentials.txt');
    expect(findingFiles(result.stdout, 'gitleaks')).toContain('research/disposable.pem');
    expect(findingFiles(result.stdout, 'trufflehog')).toContain('research/disposable.pem');
    assertRedacted(result.stdout + result.stderr);
    expect((result.stdout + result.stderr).includes(privateKey)).toBe(false);
  }, 120_000);

  test('allows only the reviewed values in their exact files and reports adjacent credentials', () => {
    const cwd = fixture();
    const path = 'packages/core/tests/artifacts/manifest.test.ts';
    put(cwd, path, `token = ${dummy}\n`);
    git(cwd, 'add', '.');
    expect(scan(cwd, 'staged').status).toBe(0);
    put(cwd, path, `token = ${dummy}; github_token = "${control}"\napi_key = "${generic}"\n`);
    put(cwd, 'docs/outside.txt', `token = ${dummy}\n`);
    put(cwd, 'packages/core/tests/artifacts/manifest-edit.test.ts', `token = ${dummy}X\n`);
    git(cwd, 'add', '.');
    const result = scan(cwd, 'staged');
    expect(result.status).toBe(1);
    expect(new Set(findingFiles(result.stdout, 'gitleaks'))).toEqual(
      new Set([path, 'docs/outside.txt', 'packages/core/tests/artifacts/manifest-edit.test.ts']),
    );
    expect(result.stdout).toContain('github-pat');
    expect(result.stdout).toContain('generic-api-key');
    assertRedacted(result.stdout + result.stderr);
  }, 120_000);

  test('scans index content and index configuration despite clean or permissive unstaged edits', () => {
    const cwd = fixture();
    put(cwd, 'docs/index.txt', `github_token = "${control}"\n`);
    git(cwd, 'add', '.');
    put(cwd, 'docs/index.txt', 'clean working copy\n');
    put(cwd, '.gitleaks.toml', '[extend]\nuseDefault = true\n[[allowlists]]\npaths = [".*"]\n');
    const result = scan(cwd, 'staged');
    expect(result.status).toBe(1);
    expect(findingFiles(result.stdout, 'gitleaks')).toContain('docs/index.txt');
    git(cwd, 'reset', '--', 'docs/index.txt');
    expect(scan(cwd, 'staged').status).toBe(0);
  }, 120_000);

  test('the detection controls reject weakened OR conditions and restored directory exclusions', () => {
    for (const weak of [
      config.replaceAll('condition = "AND"', 'condition = "OR"'),
      `${config}\n[[allowlists]]\npaths = ['^packages/core/tests/']\n`,
    ]) {
      const cwd = fixture();
      put(cwd, '.gitleaks.toml', weak);
      put(
        cwd,
        'packages/core/tests/artifacts/manifest.test.ts',
        `github_token = "${control}"\napi_key = "${generic}"\n`,
      );
      git(cwd, 'add', '.');
      const result = scan(cwd, 'staged');
      // Weakening the rule-scoped exception hides the generic control; a global
      // directory exclusion hides both controls. The positive suite requires both.
      expect(result.stdout.includes('generic-api-key')).toBe(false);
    }
  }, 120_000);

  test('finds committed then deleted credentials, including on another fetched ref', () => {
    const cwd = fixture();
    const base = git(cwd, 'rev-parse', 'HEAD');
    put(cwd, 'research/removed.txt', `github_token = "${control}"\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'synthetic control');
    git(cwd, 'rm', 'research/removed.txt');
    git(cwd, 'commit', '-m', 'delete control');
    const head = git(cwd, 'rev-parse', 'HEAD');
    for (const result of [scan(cwd, 'history', base, head), scan(cwd, 'history')]) {
      expect(result.status).toBe(1);
      for (const scanner of ['gitleaks', 'trufflehog'])
        expect(findingFiles(result.stdout, scanner)).toContain('research/removed.txt');
      assertRedacted(result.stdout + result.stderr);
    }
    git(cwd, 'update-ref', 'refs/remotes/origin/retained', head);
    git(cwd, 'reset', '--hard', base);
    const result = scan(cwd, 'history');
    expect(findingFiles(result.stdout, 'trufflehog')).toContain('research/removed.txt');
    expect(findingFiles(result.stdout, 'gitleaks')).toContain('research/removed.txt');
  }, 300_000);

  test('Gitleaks covers merge-only additions and historical configuration contents', () => {
    const cwd = fixture();
    const base = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'checkout', '-b', 'side');
    put(cwd, 'side.txt', 'side\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'side');
    git(cwd, 'checkout', 'main');
    put(cwd, 'main.txt', 'main\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'main');
    git(cwd, 'merge', '--no-commit', '--no-ff', 'side');
    put(cwd, 'docs/merge.txt', `github_token = "${control}"\n`);
    put(cwd, '.gitleaks.toml', `${config}\n# github_token = "${control}"\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'merge with synthetic controls');
    git(cwd, 'rm', 'docs/merge.txt');
    put(cwd, '.gitleaks.toml', config);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'remove controls');
    const result = scan(cwd, 'history', base, 'HEAD');
    expect(result.status, result.stdout + result.stderr).toBe(1);
    // TruffleHog's native Git diff traversal omits merge-only additions.
    // Gitleaks explicitly scans merge diffs and is the required coverage here.
    expect(findingFiles(result.stdout, 'gitleaks')).toContain('docs/merge.txt');
    expect(findingFiles(result.stdout, 'gitleaks')).toContain('.gitleaks.toml');
    assertRedacted(result.stdout + result.stderr);
  }, 180_000);

  test('the configuration placeholder exception requires its exact value and staged policy', () => {
    const cwd = fixture();
    const placeholder = ['secret', 'key', '12345'].join('-');
    put(cwd, '.gitleaks.toml', `${config}\n# token = "${placeholder}"\n`);
    git(cwd, 'add', '.');
    expect(scan(cwd, 'staged').status).toBe(0);
    put(cwd, 'docs/config-copy.txt', `token = "${placeholder}"\n`);
    put(
      cwd,
      '.gitleaks.toml',
      `${config}\n# token = "${placeholder}X"\n# github_token = "${control}"\n`,
    );
    git(cwd, 'add', '.');
    const result = scan(cwd, 'staged');
    expect(result.status).toBe(1);
    expect(findingFiles(result.stdout, 'gitleaks')).toContain('docs/config-copy.txt');
    expect(findingFiles(result.stdout, 'gitleaks')).toContain('.gitleaks.toml');
    assertRedacted(result.stdout + result.stderr);
    // An unstaged exception must not suppress a newly staged configuration value.
    put(
      cwd,
      '.secret-scan-exceptions.json',
      JSON.stringify([
        {
          scanner: 'gitleaks',
          detector: 'github-pat',
          file: '.gitleaks.toml',
          reason: 'must not apply from working copy',
          sha256: createHash('sha256').update(control).digest('hex'),
        },
      ]),
    );
    expect(scan(cwd, 'staged').stdout).toContain('github-pat');
  }, 120_000);

  test('refuses incomplete history in history scans and pre-push scans', () => {
    const cwd = fixture();
    const head = git(cwd, 'rev-parse', 'HEAD');
    put(cwd, '.git/shallow', `${head}\n`);
    expect(scan(cwd, 'history').status).toBe(2);
    const result = command(
      cwd,
      [process.execPath, cli, 'pre-push'],
      `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('complete Git history');
  }, 120_000);

  test('pre-push scans each supplied ref, covers new or unavailable remote refs, and skips deletions', () => {
    const cwd = fixture();
    const base = git(cwd, 'rev-parse', 'HEAD');
    put(cwd, 'docs/pushed.txt', `github_token = "${control}"\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'synthetic control');
    const head = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'reset', '--hard', base);
    for (const remote of [base, '0'.repeat(40), 'e'.repeat(40)]) {
      const input = `refs/heads/clean ${base} refs/heads/clean ${base}\nrefs/heads/other ${head} refs/heads/other ${remote}\n`;
      const result = command(cwd, [process.execPath, cli, 'pre-push'], input);
      expect(result.status).toBe(1);
      expect(findingFiles(result.stdout, 'gitleaks')).toContain('docs/pushed.txt');
    }
    expect(
      command(
        cwd,
        [process.execPath, cli, 'pre-push'],
        `(delete) ${'0'.repeat(40)} refs/heads/old ${head}\n`,
      ).status,
    ).toBe(0);
    expect(command(cwd, [process.execPath, cli, 'pre-push'], '').status).toBe(2);
  }, 120_000);

  test('fails closed on malformed configuration, missing tools, invalid ranges, and malformed output', () => {
    const cwd = fixture();
    expect(scan(cwd, 'history', 'missing-ref', 'HEAD').status).toBe(2);
    put(cwd, '.gitleaks.toml', '[broken');
    git(cwd, 'add', '.');
    expect(scan(cwd, 'staged').status).toBe(2);
    const emptyPath = join(cwd, 'empty-path');
    mkdirSync(emptyPath);
    expect(
      command(cwd, [process.execPath, cli, 'files'], undefined, {
        ...environment(cwd),
        PATH: emptyPath,
      }).status,
    ).toBe(2);
    expect(() => parseFindings('trufflehog', 'not json', cwd)).toThrow();
    expect(() => parseFindings('gitleaks', '{}', cwd)).toThrow();
  }, 120_000);

  test('report filtering never forwards secret, raw, or extra-data fields', () => {
    const result = parseFindings(
      'trufflehog',
      JSON.stringify({
        DetectorName: 'Github',
        Raw: control,
        RawV2: generic,
        ExtraData: { sensitive: control },
        SourceMetadata: { Data: { Filesystem: { file: 'docs/control.txt', line: 1 } } },
      }),
      '/fixture',
    );
    expect(result).toEqual([
      { scanner: 'trufflehog', rule: 'Github', file: 'docs/control.txt', line: 1 },
    ]);
    assertRedacted(JSON.stringify(result));
    expect(() => runScan(['unknown'])).toThrow();
  });

  test('scans tracked ignored files but does not follow links into unrelated files', () => {
    const cwd = fixture();
    put(cwd, 'untracked.txt', `github_token = "${control}"\n`);
    symlinkSync(join(cwd, 'untracked.txt'), join(cwd, 'link.txt'));
    git(cwd, 'add', 'link.txt');
    expect(scan(cwd, 'files').status).toBe(0);
    put(cwd, '.gitignore', '*.env\n');
    put(cwd, 'tracked.env', `github_token = "${control}"\n`);
    git(cwd, 'add', '-f', 'tracked.env');
    const result = scan(cwd, 'files');
    expect(result.status).toBe(1);
    for (const scanner of ['gitleaks', 'trufflehog'])
      expect(findingFiles(result.stdout, scanner)).toContain('tracked.env');
    assertRedacted(result.stdout + result.stderr);
  }, 240_000);

  test('the installed Lefthook pre-commit command blocks a synthetic credential', () => {
    const cwd = fixture();
    put(cwd, 'scripts/secret-scan.ts', readFileSync(cli, 'utf8'));
    copyFileSync(join(root, 'scripts/check-gitleaks.sh'), join(cwd, 'scripts/check-gitleaks.sh'));
    const hookConfig = readFileSync(join(root, 'lefthook.yml'), 'utf8');
    const gitleaksCommand = / {4}gitleaks:\n {6}run: (.+)/.exec(hookConfig)?.[1];
    expect(gitleaksCommand).toBe('./scripts/check-gitleaks.sh staged');
    put(
      cwd,
      'lefthook.yml',
      `pre-commit:\n  commands:\n    gitleaks:\n      run: ${gitleaksCommand}\n`,
    );
    const lefthook = join(root, 'node_modules/.bin/lefthook');
    expect(command(cwd, [lefthook, 'install']).status).toBe(0);
    put(cwd, 'docs/blocked.txt', `github_token = "${control}"\n`);
    git(cwd, 'add', '.');
    const result = command(
      cwd,
      [
        'git',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Scanner Test',
        '-c',
        'user.email=scanner@example.invalid',
        'commit',
        '-m',
        'must be blocked',
      ],
      undefined,
      { ...environment(cwd), PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}` },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('github-pat');
    assertRedacted(result.stdout + result.stderr);
  }, 120_000);

  test('the installed Lefthook pre-push command receives Git ref updates and blocks publication', () => {
    const cwd = fixture();
    const remote = mkdtempSync(join(tmpdir(), 'skillsmith-scan-remote-'));
    temporary.push(remote);
    git(cwd, 'init', '--bare', remote);
    git(cwd, 'push', remote, 'main');
    const base = git(cwd, 'rev-parse', 'HEAD');
    put(cwd, 'scripts/secret-scan.ts', readFileSync(cli, 'utf8'));
    copyFileSync(join(root, 'scripts/check-gitleaks.sh'), join(cwd, 'scripts/check-gitleaks.sh'));
    const hookConfig = readFileSync(join(root, 'lefthook.yml'), 'utf8');
    const commandBlock = /pre-push:[\s\S]*? {4}gitleaks:\n((?: {6}.+\n)+)/.exec(hookConfig)?.[1];
    expect(commandBlock).toContain('use_stdin: true');
    put(cwd, 'lefthook.yml', `pre-push:\n  commands:\n    gitleaks:\n${commandBlock}`);
    put(cwd, 'docs/blocked.txt', `github_token = "${control}"\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'synthetic push control');
    expect(command(cwd, [join(root, 'node_modules/.bin/lefthook'), 'install']).status).toBe(0);
    const result = command(cwd, ['git', 'push', remote, 'main'], undefined, {
      ...environment(cwd),
      PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('github-pat');
    expect(git(cwd, '--git-dir', remote, 'rev-parse', 'refs/heads/main')).toBe(base);
    assertRedacted(result.stdout + result.stderr);
  }, 120_000);
});
