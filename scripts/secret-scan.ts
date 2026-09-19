#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCANNER_VERSIONS = { gitleaks: '8.30.1', trufflehog: '3.97.5' } as const;
type Scanner = keyof typeof SCANNER_VERSIONS;
export type DetectorException = {
  scanner: Scanner;
  detector: string;
  file: string;
  sha256: string;
  reason: string;
};
type Finding = { scanner: Scanner; rule: string; file: string; line: number; commit?: string };
type Context = {
  root: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
  exceptions?: DetectorException[];
};

class ScanError extends Error {}

function fail(message: string): never {
  throw new ScanError(message);
}

// No inherited provider credentials, scanner overrides, or Git configuration.
export function scanEnvironment(scratch: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: scratch,
    TMPDIR: scratch,
    LANG: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Git can supply a temporary index for partial commits. Scan that index.
    ...(process.env.GIT_INDEX_FILE ? { GIT_INDEX_FILE: resolve(process.env.GIT_INDEX_FILE) } : {}),
  };
}

function execute(context: Context, command: string[], cwd = context.root, input?: string) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: context.env,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || result.status === null) {
    fail('Secret scan could not complete: missing tool, timeout, signal, or output limit.');
  }
  return result;
}

function git(context: Context, args: string[]): string {
  const result = execute(context, ['git', '-c', 'core.fsmonitor=false', ...args]);
  if (result.status !== 0) fail('Git inspection failed; no clean-scan result was produced.');
  return result.stdout;
}

function commit(context: Context, ref: string): string {
  return git(context, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}

function requireVersion(context: Context, scanner: Scanner): void {
  const result = execute(context, [scanner, scanner === 'gitleaks' ? 'version' : '--version']);
  const actual = `${result.stdout}\n${result.stderr}`.trim();
  const expected = SCANNER_VERSIONS[scanner];
  if (
    result.status !== 0 ||
    !new RegExp(`^(?:${scanner} )?${expected.replaceAll('.', '\\.')}\\s*$`).test(actual)
  ) {
    fail(`${scanner} ${expected} is required; run just install-${scanner}.`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid scanner report.');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string') fail('Invalid scanner report field.');
  return value;
}

function lineNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('Invalid scanner line number.');
  return value as number;
}

// Construct output from an allowlist of metadata. Never forward raw reports,
// stdout, stderr, verification errors, Match, Secret, Raw, RawV2, or ExtraData.
export function parseFindings(
  scanner: Scanner,
  output: string,
  root: string,
  exceptions: readonly DetectorException[] = [],
  sourceOverride?: { file: string; commit?: string },
): Finding[] {
  let entries: unknown[];
  try {
    if (scanner === 'gitleaks') {
      const parsed: unknown = JSON.parse(output);
      if (!Array.isArray(parsed)) fail('Invalid Gitleaks report.');
      entries = parsed;
    } else {
      entries = output
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    }
  } catch {
    fail(`${scanner} returned an invalid report; raw output withheld.`);
  }
  return entries.flatMap((entry): Finding[] => {
    const row = object(entry);
    if (scanner === 'gitleaks') {
      const file = string(row.File);
      const normalizedFile =
        sourceOverride?.file ?? (isAbsolute(file) ? relative(root, file) : file);
      const rule = string(row.RuleID);
      // stdin covers the configuration filename omitted by upstream defaults.
      // Its raw JSON stays in memory so this one exact value can be compared.
      if (
        sourceOverride &&
        isExcepted(scanner, rule, normalizedFile, string(row.Secret), exceptions)
      )
        return [];
      return [
        {
          scanner,
          rule,
          file: normalizedFile,
          line: lineNumber(row.StartLine),
          ...(sourceOverride?.commit
            ? { commit: sourceOverride.commit }
            : row.Commit
              ? { commit: string(row.Commit) }
              : {}),
        },
      ];
    }
    const metadata = object(object(row.SourceMetadata).Data);
    const source = object(metadata.Filesystem ?? metadata.Git);
    const file = string(source.file);
    const normalizedFile = isAbsolute(file) ? relative(root, file) : file;
    const detector = string(row.DetectorName);
    if (isExcepted(scanner, detector, normalizedFile, string(row.Raw), exceptions)) return [];
    return [
      {
        scanner,
        rule: detector,
        file: normalizedFile,
        line: lineNumber(source.line),
        ...(source.commit ? { commit: string(source.commit) } : {}),
      },
    ];
  });
}

function isExcepted(
  scanner: Scanner,
  detector: string,
  file: string,
  value: string,
  exceptions: readonly DetectorException[],
): boolean {
  const digest = createHash('sha256').update(value).digest('hex');
  return exceptions.some(
    (entry) =>
      entry.scanner === scanner &&
      entry.detector === detector &&
      entry.file === file &&
      entry.sha256 === digest,
  );
}

function loadExceptions(context: Context, staged: boolean): DetectorException[] {
  const filename = '.secret-scan-exceptions.json';
  let content: string;
  if (staged) {
    if (!git(context, ['ls-files', '--', filename]).trim()) return [];
    content = git(context, ['show', `:${filename}`]);
  } else {
    const path = join(context.root, filename);
    if (!existsSync(path)) return [];
    content = readFileSync(path, 'utf8');
  }
  const entries: unknown = JSON.parse(content);
  if (!Array.isArray(entries)) fail('Invalid scanner exceptions.');
  return entries.map((value) => {
    const row = object(value);
    if (Object.keys(row).sort().join(',') !== 'detector,file,reason,scanner,sha256')
      fail('Invalid scanner exception fields.');
    const scanner = string(row.scanner);
    const detector = string(row.detector);
    const file = string(row.file);
    const sha256 = string(row.sha256);
    const reason = string(row.reason);
    if (
      !['gitleaks', 'trufflehog'].includes(scanner) ||
      !detector ||
      !reason ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      isAbsolute(file) ||
      file.split('/').some((part) => !part || part === '.' || part === '..')
    )
      fail('Invalid scanner exception.');
    return { scanner: scanner as Scanner, detector, file, sha256, reason };
  });
}

function scan(
  context: Context,
  scanner: Scanner,
  args: string[],
  cwd = context.root,
  input?: string,
  configurationCommit?: string,
): number {
  const flags =
    scanner === 'gitleaks'
      ? [
          input === undefined ? '--redact=100' : '--redact=0',
          '--report-format=json',
          '--report-path=-',
          '--no-banner',
          '--log-level=error',
          '--ignore-gitleaks-allow',
          `--gitleaks-ignore-path=${join(context.scratch, 'empty.ignore')}`,
          `--config=${join(context.scratch, 'gitleaks.toml')}`,
          '--timeout=120',
          '--max-decode-depth=5',
        ]
      : [
          '--no-verification',
          '--no-update',
          '--no-ignore-tag',
          '--json',
          '--fail',
          '--fail-on-scan-errors',
          '--log-level=2',
          '--results=verified,unknown,unverified',
          '--concurrency=4',
        ];
  const result = execute(context, [scanner, ...args, ...flags], cwd, input);
  const findingStatus = scanner === 'gitleaks' ? 1 : 183;
  if (result.status !== 0 && result.status !== findingStatus) {
    fail(`${scanner} scan failed (exit ${result.status}); raw output withheld.`);
  }
  // Gitleaks also uses exit 1 for configuration and Git errors. Do not mistake
  // those for a successful scan with findings or an empty clean report.
  if (scanner === 'gitleaks' && result.stderr.trim()) {
    fail('Gitleaks reported an error; check the configuration and Git scope. Raw output withheld.');
  }
  if (scanner === 'trufflehog') {
    // Some Git parser failures are logged without changing TruffleHog's exit
    // status. Do not report a clean scan when the parser recovered by skipping.
    for (const line of result.stderr.split('\n').filter((line) => line.trim())) {
      const log = object(JSON.parse(line));
      if (log.level === 'error' || log.level === 'fatal' || log.error) {
        fail('TruffleHog reported a scan error; raw diagnostic output withheld.');
      }
    }
  }
  const allFindings = parseFindings(scanner, result.stdout, cwd);
  const findings = parseFindings(
    scanner,
    result.stdout,
    cwd,
    context.exceptions,
    input === undefined ? undefined : { file: '.gitleaks.toml', commit: configurationCommit },
  );
  if (result.status === findingStatus && allFindings.length === 0)
    fail(`${scanner} failed without findings.`);
  for (const finding of findings) console.log(JSON.stringify(finding));
  console.log(`${scanner}: ${findings.length} finding(s).`);
  return findings.length;
}

// The upstream default rules omit files named gitleaks.toml. stdin has no
// filename, so this additional scan covers configuration content as well.
function scanConfiguration(context: Context, content: string, revision?: string): number {
  return scan(context, 'gitleaks', ['stdin'], context.root, content, revision);
}

function scanHistoricalConfigurations(context: Context, revisions: string[]): number {
  const commits = new Set(
    git(context, [
      'log',
      '--full-history',
      '--diff-merges=first-parent',
      '--no-patch',
      '--format=%H',
      ...revisions,
      '--',
      '.gitleaks.toml',
    ])
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  let findings = 0;
  for (const revision of commits) {
    const exists = git(context, ['ls-tree', revision, '--', '.gitleaks.toml']).trim();
    if (!exists) continue; // Configuration deleted in this commit.
    findings += scanConfiguration(
      context,
      git(context, ['show', `${revision}:.gitleaks.toml`]),
      revision,
    );
  }
  return findings;
}

export function trackedSnapshot(context: Context): string {
  const snapshot = join(context.scratch, 'tracked');
  mkdirSync(snapshot);
  const entries = git(context, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^(\d+) [0-9a-f]+ (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== '0') fail('Resolve unmerged index entries before scanning.');
    const [, mode, , path] = match;
    if (!['100644', '100755', '120000'].includes(mode))
      fail('Tracked submodules require a separate scan.');
    const components = path.split('/');
    if (isAbsolute(path) || components.some((part) => !part || part === '.' || part === '..')) {
      fail('Unsafe tracked path.');
    }
    let source = context.root;
    let missing = false;
    for (let i = 0; i < components.length; i++) {
      source = join(source, components[i]);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(source);
      } catch (error) {
        if (object(error).code === 'ENOENT') {
          missing = true;
          break;
        }
        fail('Unable to inspect a tracked file.');
      }
      if (i < components.length - 1 && !stat.isDirectory())
        fail('Tracked path crosses a symlink or non-directory.');
      if (i === components.length - 1 && !stat.isFile() && !stat.isSymbolicLink())
        fail('Unsupported tracked file type.');
    }
    if (missing) continue; // An unstaged deletion has no current file content.
    const target = join(snapshot, path);
    mkdirSync(dirname(target), { recursive: true });
    if (lstatSync(source).isSymbolicLink()) writeFileSync(target, readlinkSync(source));
    else copyFileSync(source, target);
  }
  return snapshot;
}

export function pushRanges(context: Context, input: string): string[] {
  const lines = input.trim().split('\n').filter(Boolean);
  if (!lines.length)
    fail('pre-push requires Git ref updates on stdin. Use history for a manual scan.');
  const ranges = new Set<string>();
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== 4 ||
      !fields[0].length ||
      !fields[2].startsWith('refs/') ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[1]) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[3])
    )
      fail('Invalid pre-push ref update.');
    const [, localOid, , remoteOid] = fields;
    if (/^0+$/.test(localOid)) continue; // Deletion publishes no content.
    const head = commit(context, localOid);
    const old = execute(context, [
      'git',
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${remoteOid}^{commit}`,
    ]);
    // A new ref or an unavailable remote object needs the whole pushed ancestry.
    ranges.add(old.status === 0 ? `${old.stdout.trim()}..${head}` : head);
  }
  return [...ranges];
}

export function runScan(args: string[], cwd = process.cwd()): number {
  const [mode, ...refs] = args;
  if (
    !['staged', 'pre-push', 'files', 'history'].includes(mode) ||
    (mode !== 'history' && refs.length !== 0) ||
    (mode === 'history' && ![0, 2].includes(refs.length))
  ) {
    fail('Usage: secret-scan.ts staged|pre-push|files|history [base head]');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'skillsmith-secrets-'));
  try {
    const context: Context = { root: cwd, scratch, env: scanEnvironment(scratch) };
    context.root = git(context, ['rev-parse', '--show-toplevel']).trim();
    context.exceptions = loadExceptions(context, mode === 'staged');
    writeFileSync(join(scratch, 'empty.ignore'), '');
    const config =
      mode === 'staged'
        ? git(context, ['show', ':.gitleaks.toml'])
        : readFileSync(join(context.root, '.gitleaks.toml'), 'utf8');
    writeFileSync(join(scratch, 'gitleaks.toml'), config);
    requireVersion(context, 'gitleaks');
    if (mode === 'files' || mode === 'history') requireVersion(context, 'trufflehog');
    if (
      (mode === 'history' || mode === 'pre-push') &&
      git(context, ['rev-parse', '--is-shallow-repository']).trim() !== 'false'
    ) {
      fail('History scanning requires complete Git history; fetch with fetch-depth: 0.');
    }
    let findings = 0;
    if (mode === 'staged') {
      findings += scan(context, 'gitleaks', ['git', '.', '--staged']);
      findings += scanConfiguration(context, config);
    } else if (mode === 'pre-push') {
      for (const range of pushRanges(context, readFileSync(0, 'utf8'))) {
        findings += scan(context, 'gitleaks', [
          'git',
          '.',
          `--log-opts=--full-history --diff-merges=first-parent ${range}`,
        ]);
        findings += scanHistoricalConfigurations(context, [range]);
      }
    } else if (mode === 'files') {
      const snapshot = trackedSnapshot(context);
      findings += scan(context, 'gitleaks', ['dir', '.'], snapshot);
      findings += scanConfiguration(context, config);
      findings += scan(context, 'trufflehog', ['filesystem', '.'], snapshot);
    } else {
      const base = refs.length ? commit(context, refs[0]) : undefined;
      const head = refs.length ? commit(context, refs[1]) : undefined;
      const revision = base ? `${base}..${head}` : '--all';
      findings += scan(context, 'gitleaks', [
        'git',
        '.',
        `--log-opts=--full-history --diff-merges=first-parent ${revision}`,
      ]);
      findings += scanHistoricalConfigurations(context, [revision]);
      findings += scan(context, 'trufflehog', [
        'git',
        pathToFileURL(context.root + sep).href,
        ...(base && head ? [`--since-commit=${base}`, `--branch=${head}`] : []),
      ]);
    }
    return findings > 0 ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = runScan(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof ScanError
        ? error.message
        : 'Secret scan failed; no clean-scan result was produced.',
    );
    process.exitCode = 2;
  }
}
