import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RELEASE_TOOL_ARCHIVE_SHA256 } from './release-gates';
import { SCANNER_VERSIONS, parseFindings, scanEnvironment } from './secret-scan';

const root = resolve(import.meta.dir, '..');
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('installers, executable version checks, and release validation use the same official pins', () => {
  for (const tool of ['gitleaks', 'trufflehog'] as const) {
    const pinned = RELEASE_TOOL_ARCHIVE_SHA256[tool];
    const installer = readFileSync(join(root, `scripts/install-${tool}.sh`), 'utf8');
    expect(SCANNER_VERSIONS[tool]).toBe(pinned.version);
    expect(installer).toContain(`${tool.toUpperCase()}_VERSION="${pinned.version}"`);
    for (const checksum of Object.values(pinned.archives)) expect(installer).toContain(checksum);
    expect(installer).toContain('archive SHA-256 mismatch');
  }
});

test('ordinary and common-release CI provision both scanners before the canonical check', () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const content = readFileSync(join(root, file), 'utf8');
    const section = file.endsWith('/ci.yml')
      ? content.split('  native-receipt:')[0]
      : content.split('  common:')[1].split('  native:')[0];
    for (const tool of ['gitleaks', 'trufflehog'])
      expect(section).toContain(`./scripts/install-${tool}.sh`);
  }
  const hooks = readFileSync(join(root, 'lefthook.yml'), 'utf8');
  expect(hooks).toContain('run: ./scripts/check-gitleaks.sh pre-push\n      use_stdin: true');
  const just = readFileSync(join(root, 'justfile'), 'utf8');
  expect(just).toContain('check:\n    just secrets\n');
});

test('TruffleHog exceptions require the exact detector, path, and value digest', () => {
  const raw = `https://${['user', 'pass'].join(':')}@fixture.invalid/skills`;
  const exception = {
    scanner: 'trufflehog' as const,
    detector: 'URI',
    file: 'tests/fixture.txt',
    sha256: createHash('sha256').update(raw).digest('hex'),
    reason: 'Synthetic fixture',
  };
  const report = (file: string, value: string, detector = 'URI') =>
    JSON.stringify({
      DetectorName: detector,
      Raw: value,
      SourceMetadata: { Data: { Filesystem: { file, line: 1 } } },
    });
  expect(parseFindings('trufflehog', report(exception.file, raw), root, [exception])).toEqual([]);
  for (const row of [
    report('src/real.txt', raw),
    report(exception.file, `${raw}-changed`),
    report(exception.file, raw, 'AnotherDetector'),
  ]) {
    expect(parseFindings('trufflehog', row, root, [exception])).toHaveLength(1);
  }
});

test('scanner environment excludes ambient provider credentials and overrides', () => {
  const env = scanEnvironment('/fixture');
  for (const key of [
    'GITHUB_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'SSH_AUTH_SOCK',
    'GITLEAKS_CONFIG',
    'GITLEAKS_CONFIG_TOML',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_CONFIG_COUNT',
  ]) {
    expect(key in env).toBe(false);
  }
  expect(env.HOME).toBe('/fixture');
  expect(env.GIT_TERMINAL_PROMPT).toBe('0');
});

test('scanner errors and signals fail without echoing raw diagnostic content', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'skillsmith-scan-errors-'));
  temporary.push(cwd);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: cwd,
    TMPDIR: cwd,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
  };
  const init = spawnSync('git', ['init', '-b', 'main'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(init.status).toBe(0);
  writeFileSync(join(cwd, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
  const tools = { gitleaks: '8.30.1', trufflehog: 'trufflehog 3.97.5' };
  for (const [tool, version] of Object.entries(tools)) {
    const path = join(bin, tool);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(path, 0o755);
  }
  for (const failure of ['exit 42', 'kill -TERM $$']) {
    writeFileSync(
      join(bin, 'gitleaks'),
      `#!/bin/sh\nif [ "$1" = version ]; then printf '8.30.1\\n'; exit 0; fi\nprintf 'WITHHELD_DIAGNOSTIC\\n' >&2\n${failure}\n`,
    );
    const result = spawnSync(process.execPath, [join(root, 'scripts/secret-scan.ts'), 'files'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain('WITHHELD_DIAGNOSTIC');
  }
  writeFileSync(
    join(bin, 'gitleaks'),
    `#!/bin/sh
if [ "$1" = version ]; then printf '8.30.1\\n'; else printf '[]\\n'; fi
`,
  );
  writeFileSync(
    join(bin, 'trufflehog'),
    `#!/bin/sh
if [ "$1" = --version ]; then printf 'trufflehog 3.97.5\\n'; exit 0; fi
printf '%s\\n' '{"level":"error","msg":"WITHHELD_DIAGNOSTIC"}' >&2
exit 0
`,
  );
  const loggedFailure = spawnSync(
    process.execPath,
    [join(root, 'scripts/secret-scan.ts'), 'files'],
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  expect(loggedFailure.status).toBe(2);
  expect(`${loggedFailure.stdout}${loggedFailure.stderr}`).not.toContain('WITHHELD_DIAGNOSTIC');
}, 60_000);
