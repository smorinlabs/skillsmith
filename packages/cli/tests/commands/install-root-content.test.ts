// SC-I60-R5 Phase A — root-skill content characterization (P17 line only).
//
// Characterizes whether installing a repository-root skill stores Git
// administration (`.git`) in stored/installed bytes and whether independent
// repeat fetches of the same immutable source produce different legacy
// identities. Test-only; no product edits.
//
// Route: real public CLI (`--no-prompt install ...`) with hermetic
// fixture-owned HOME/XDG/PATH, an owned GIT_CONFIG_GLOBAL mapping only the
// accepted fixture URL(s) to owned `file://` bare repos, and
// `GIT_ALLOW_PROTOCOL=file` so unresolved URLs fail closed without network.
// A transparent fixture-owned `git` wrapper forwards argv/env/streams/exit
// unchanged to the pinned real git, proves each install really executed
// init/fetch/checkout, and archives `.git` state after successful checkout
// (read-only copies, no extra git commands) before normal acquisition
// cleanup removes the fetch directory.
//
// Vectors:
//  A. stored/installed bytes include `.git` (RED-1 if present)
//  B. repeat-fetch legacy identity equality + fixed-oracle equality (RED-2)
//  C. same-store recurrence (install -> uninstall -> reinstall)
//  D. --no-save parity, direct-copy parity, changed-source, tamper, nested,
//     unresolved-URL, and help-grammar controls.
//
// Each case emits one `R5CASE {...}` line; the final test emits `R5TABLE {...}`.
// A setup failure throws (never counts as RED). RED-1/RED-2 assert the
// non-defect state, so an authentic defect shows as their failure.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { lockV1Codec } from '../../../core/src/artifacts/lock-codec.ts';
import { runGit } from '../../../core/tests/fixtures/git-env.ts';
import { InstallJsonSchema, UninstallJsonSchema } from '../../src/output/install-json.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';
import { createDetectionIsolation } from '../fixtures/detection.ts';

setDefaultTimeout(120_000);

const ROOT_URL = 'https://root.fixture.invalid/acme/root-skill.git';
const NESTED_URL = 'https://root.fixture.invalid/acme/nested-skills.git';
const TOOL = 'claude-code';
const SKILL = 'root-skill';
const BASE_SHA = '8ae8560dc6b91bbd7cb2e8d29cbb196953118331';

// ---- Fixture payload (explicit manifest; `.git` excluded by construction) ----

const SKILL_MD =
  '---\nname: root-skill\ndescription: Root-skill content fixture.\n---\n\n# root-skill\n';
const README_V1 = '# Root Skill\n\nOrdinary payload file.\n';
const README_V2 = '# Root Skill\n\nOrdinary payload file.\n\nChanged-source revision.\n';
const SETTINGS_V1 = '{"theme":"fixture","level":1}\n';
const SETTINGS_V2 = '{"theme":"fixture","level":2}\n';
const EXAMPLE_JSON = '{"example":true}\n';
const GITIGNORE = 'build/\n*.local\n';
const GITATTRIBUTES = '*.sh text eol=lf\n*.md text\n';
const RUN_SH = '#!/bin/sh\necho root-skill\n';
const OUTPUT_TXT = 'force-added ignored payload\n';

const PAYLOAD_FILES = [
  '.config/example.json',
  '.gitattributes',
  '.gitignore',
  '.settings',
  'README.md',
  'SKILL.md',
  'bin/run.sh',
  'build/output.txt',
] as const;
const PAYLOAD_SYMLINKS = [{ rel: 'link.md', target: 'README.md' }] as const;

const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

const byteCompare = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

interface RootContentFixture {
  readonly base: string;
  readonly rootGitUrl: string;
  readonly nestedGitUrl: string;
  readonly rootSha1: string;
  readonly rootSha2: string;
  readonly nestedSha: string;
  readonly oracleDir: string;
  readonly gitVersion: string;
  readonly bunVersion: string;
  readonly headSha: string;
}

const SHA40 = /^[0-9a-f]{40}$/;

const commitAll = (cwd: string, message: string): void => {
  runGit(cwd, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=r5-fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(cwd, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=r5-fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  ]);
};

const buildRootContentFixture = async (base: string): Promise<RootContentFixture> => {
  const rootWork = join(base, 'root-work');
  await mkdir(join(rootWork, '.config'), { recursive: true });
  await mkdir(join(rootWork, 'bin'), { recursive: true });
  await mkdir(join(rootWork, 'build'), { recursive: true });
  await writeFile(join(rootWork, 'SKILL.md'), SKILL_MD);
  await writeFile(join(rootWork, 'README.md'), README_V1);
  await writeFile(join(rootWork, '.settings'), SETTINGS_V1);
  await writeFile(join(rootWork, '.config', 'example.json'), EXAMPLE_JSON);
  await writeFile(join(rootWork, '.gitignore'), GITIGNORE);
  await writeFile(join(rootWork, '.gitattributes'), GITATTRIBUTES);
  await writeFile(join(rootWork, 'bin', 'run.sh'), RUN_SH);
  await chmod(join(rootWork, 'bin', 'run.sh'), 0o755);
  await symlink('README.md', join(rootWork, 'link.md'));
  await writeFile(join(rootWork, 'build', 'output.txt'), OUTPUT_TXT);

  runGit(rootWork, ['init', '-q', '-b', 'main']);
  commitAll(rootWork, 'fixture: root skill commit 1');
  // `build/` is gitignored by the tracked `.gitignore`; force-add the payload.
  runGit(rootWork, ['add', '-f', '--', 'build/output.txt']);
  runGit(rootWork, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=r5-fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: root skill force-added ignored payload',
    '--amend',
    '--no-edit',
  ]);
  const rootSha1 = runGit(rootWork, ['rev-parse', 'HEAD']).trim();
  if (!SHA40.test(rootSha1)) throw new Error(`invalid rootSha1: ${rootSha1}`);

  // Pristine commit-1 payload copy: explicit file list only, no recursion, no
  // `.git` by construction. This feeds the fixed legacy oracle below.
  const oracleDir = join(base, 'oracle-c1');
  await mkdir(oracleDir, { recursive: true });
  for (const rel of PAYLOAD_FILES) {
    const src = join(rootWork, rel);
    const dest = join(oracleDir, rel);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, await readFile(src));
    await chmod(dest, (await lstat(src)).mode);
  }
  for (const { rel, target } of PAYLOAD_SYMLINKS) {
    await symlink(target, join(oracleDir, rel));
  }

  // Changed-source revision: meaningful dotfile + ordinary source change.
  await writeFile(join(rootWork, '.settings'), SETTINGS_V2);
  await writeFile(join(rootWork, 'README.md'), README_V2);
  commitAll(rootWork, 'fixture: root skill commit 2 (changed source)');
  const rootSha2 = runGit(rootWork, ['rev-parse', 'HEAD']).trim();
  if (!SHA40.test(rootSha2)) throw new Error(`invalid rootSha2: ${rootSha2}`);
  if (rootSha2 === rootSha1) throw new Error('commit 2 must differ from commit 1');

  const rootGit = join(base, 'root.git');
  runGit(base, ['clone', '-q', '--bare', rootWork, rootGit]);

  const nestedWork = join(base, 'nested-work');
  const nestedDir = join(nestedWork, 'plugins', 'acme', 'skills', 'nested');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, 'SKILL.md'), '---\nname: nested\n---\n');
  await writeFile(join(nestedDir, 'notes.txt'), 'nested control payload\n');
  runGit(nestedWork, ['init', '-q', '-b', 'main']);
  commitAll(nestedWork, 'fixture: nested skill');
  const nestedSha = runGit(nestedWork, ['rev-parse', 'HEAD']).trim();
  if (!SHA40.test(nestedSha)) throw new Error(`invalid nestedSha: ${nestedSha}`);
  const nestedGit = join(base, 'nested.git');
  runGit(base, ['clone', '-q', '--bare', nestedWork, nestedGit]);

  for (const bare of [rootGit, nestedGit]) {
    runGit(bare, ['config', 'uploadpack.allowFilter', 'true']);
    runGit(bare, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  }

  const gitVersion = runGit(base, ['--version']).trim();
  const bunVersion = process.versions.bun ?? 'unknown';
  const checkout = join(import.meta.dir, '..', '..', '..', '..');
  const headSha = runGit(checkout, ['rev-parse', 'HEAD']).trim();
  if (headSha !== BASE_SHA) {
    throw new Error(`frozen-base drift: expected ${BASE_SHA}, observed ${headSha}`);
  }
  return {
    base,
    rootGitUrl: `file://${rootGit}`,
    nestedGitUrl: `file://${nestedGit}`,
    rootSha1,
    rootSha2,
    nestedSha,
    oracleDir,
    gitVersion,
    bunVersion,
    headSha,
  };
};

// ---- Owned workspace (HOME/XDG/PATH/git-config/tool-detection) ----

interface Workspace {
  readonly label: string;
  readonly root: string;
  readonly cwd: string;
  readonly bin: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly env: Record<string, string>;
  readonly preload: string;
  readonly gitTrace: string;
  readonly gitArchive: string;
  readonly manifest: string;
  readonly lockfile: string;
  seq: number;
}

interface ToolPaths {
  readonly git: string;
  readonly cp: string;
  readonly mkdir: string;
  readonly find: string;
  readonly sort: string;
}

const makeWorkspace = async (
  fixture: RootContentFixture,
  tools: ToolPaths,
  label: string,
  roots: string[],
): Promise<Workspace> => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-r5-${label}-`));
  roots.push(root);
  const cwd = join(root, 'repository');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const xdgData = join(root, 'xdgdata');
  const data = join(xdgData, 'skillsmith');
  for (const path of [
    cwd,
    bin,
    home,
    config,
    xdgData,
    data,
    join(root, 'cache'),
    join(root, 'tmp'),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await mkdir(join(home, '.claude', 'skills'), { recursive: true });

  const gitConfig = join(root, 'gitconfig');
  await writeFile(
    gitConfig,
    [
      `[url "${fixture.rootGitUrl}"]`,
      `\tinsteadOf = ${ROOT_URL}`,
      `[url "${fixture.nestedGitUrl}"]`,
      `\tinsteadOf = ${NESTED_URL}`,
      '[commit]',
      '\tgpgsign = false',
      '[tag]',
      '\tgpgsign = false',
      '[core]',
      '\tfsmonitor = false',
      '',
    ].join('\n'),
  );

  const gitTrace = join(root, 'git-trace.log');
  const gitArchive = join(root, 'git-archive');
  await writeFile(gitTrace, '');
  // Transparent archaeology wrapper: forwards argv/env/streams/exit unchanged
  // to the pinned real git, logs every invocation, and after a successful
  // checkout inside an owned fetch root archives `.git` via read-only copies
  // (absolute tool paths since owned PATH has no system dirs; no git
  // commands; no repo mutation). Read-induced atime drift is not a
  // legacy-hash input (bytes/mode/targets/names only).
  await writeFile(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'trace="$R5_GIT_TRACE"',
      'real="$R5_REAL_GIT"',
      'archive="$R5_GIT_ARCHIVE"',
      'owned="$R5_OWNED_ROOT"',
      'printf \'argv: %s\\n\' "$*" >>"$trace"',
      '"$real" "$@"',
      'code=$?',
      'printf \'exit: %s\\n\' "$code" >>"$trace"',
      'if [ "$code" -eq 0 ] && [ "$1" = "-C" ] && [ "$3" = "checkout" ]; then',
      '  repo="$2"',
      '  case "$repo" in',
      '    "$owned"/.fetch/*)',
      `      "${tools.mkdir}" -p "$archive"`,
      '      n=0',
      '      for _ in "$archive"/checkout-*; do',
      '        if [ -e "$_" ]; then n=$((n+1)); fi',
      '      done',
      '      dest="$archive/checkout-$n"',
      `      "${tools.mkdir}" -p "$dest"`,
      `      ( cd "$repo/.git" && "${tools.find}" . | "${tools.sort}" >"$dest/files.txt" )`,
      `      "${tools.cp}" -r "$repo/.git" "$dest/dotgit"`,
      '      printf \'%s\\n\' "$repo" >"$dest/repo.txt"',
      '      ;;',
      '  esac',
      'fi',
      'exit "$code"',
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'git'), 0o755);

  // Harmless tool-version detection executable for claude-code discovery.
  await writeFile(join(bin, 'claude'), '#!/bin/sh\necho "1.0.0-r5-fixture"\n');
  await chmod(join(bin, 'claude'), 0o755);

  const env: Record<string, string> = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: join(root, 'cache'),
    SKILLSMITH_HOME: data,
    TMPDIR: join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    R5_REAL_GIT: tools.git,
    R5_GIT_TRACE: gitTrace,
    R5_GIT_ARCHIVE: gitArchive,
    R5_OWNED_ROOT: data,
  };
  const isolation = await createDetectionIsolation(root, env);
  if (!isolation.blockedPaths.includes(join('/usr/local/bin', 'claude'))) {
    throw new Error('detection isolation must block external claude binaries');
  }
  await writeFile(join(root, 'environment.json'), `${JSON.stringify({ label, env }, null, 2)}\n`);
  return {
    label,
    root,
    cwd,
    bin,
    home,
    config,
    data,
    env,
    preload: isolation.preload,
    gitTrace,
    gitArchive,
    manifest: join(root, 'skillsmith.toml'),
    lockfile: join(root, 'skillsmith.lock'),
    seq: 0,
  };
};

// ---- CLI runner (owned process group, deadline, transcripts) ----

interface CliResult {
  readonly argv: string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

const runCli = async (
  ws: Workspace,
  label: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<CliResult> => {
  const argv = [process.execPath, '--preload', ws.preload, CLI_ENTRYPOINT, ...args];
  const startedAt = Date.now();
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: ws.cwd,
    env: ws.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let closed = false;
  let spawnError: Error | undefined;
  const completed = new Promise<void>((done) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', () => {
      closed = true;
      done();
    });
  });
  const alive = (): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const waitUntil = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while ((!closed || alive()) && Date.now() < end) await Bun.sleep(25);
    return closed && !alive();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = await Promise.race([
    completed.then(() => false),
    new Promise<boolean>((resolveTimer) => {
      timer = setTimeout(() => resolveTimer(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (expired || alive()) {
    if (alive() && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    if (!(await waitUntil(10_000)) && alive() && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL');
      await waitUntil(5_000);
    }
  }
  if (!closed) {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  const stem = join(ws.root, `${++ws.seq}-${label}`);
  await writeFile(`${stem}.stdout`, stdout, { flag: 'wx' });
  await writeFile(`${stem}.stderr`, stderr, { flag: 'wx' });
  const result: CliResult = {
    argv,
    exitCode: child.exitCode,
    stdout,
    stderr,
    elapsedMs: Date.now() - startedAt,
    stdoutPath: `${stem}.stdout`,
    stderrPath: `${stem}.stderr`,
  };
  await writeFile(
    `${stem}.json`,
    `${JSON.stringify({ ...result, stdoutSha256: sha256Hex(stdout), stderrSha256: sha256Hex(stderr) }, null, 2)}\n`,
    { flag: 'wx' },
  );
  if (spawnError) throw spawnError; // setup failure, never RED
  if (expired || !closed || alive()) {
    throw new Error(`child deadline/cleanup failure: ${label}; see ${stem}.json`);
  }
  return result;
};

// ---- Readers: ledger, lockfile, git trace, tree inventory ----

interface LedgerPairView {
  readonly pinnedStorePath: string | null;
  readonly pinnedContentHash: string | null;
  readonly journal: unknown;
}

interface LedgerJsonShape {
  skills?: Record<string, { tools?: Record<string, LedgerPairShape> }>;
}

interface LedgerPairShape {
  pinned?: { storePath?: unknown; contentHash?: unknown } | null;
  journal?: unknown;
}

const readLedgerPair = async (
  dataDir: string,
  skill: string,
  tool: string,
): Promise<LedgerPairView | null> => {
  let raw: LedgerJsonShape;
  try {
    raw = JSON.parse(await readFile(join(dataDir, 'placements.json'), 'utf8')) as LedgerJsonShape;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const pair = raw?.skills?.[skill]?.tools?.[tool];
  if (pair === undefined || pair === null) return null;
  const storePath = pair.pinned?.storePath;
  const contentHash = pair.pinned?.contentHash;
  return {
    pinnedStorePath: typeof storePath === 'string' ? storePath : null,
    pinnedContentHash: typeof contentHash === 'string' ? contentHash : null,
    journal: pair.journal ?? null,
  };
};

const readLockContentHash = async (lockfile: string, skill: string): Promise<string | null> => {
  const bytes = await readFile(lockfile);
  const decoded = lockV1Codec.decode(new Uint8Array(bytes));
  if (!decoded.ok) throw new Error(`lockfile decode failed: ${decoded.error.message}`);
  const row = decoded.value.model.skills.find((entry) => entry.name === skill);
  return row?.contentHash ?? null;
};

interface FetchProof {
  readonly inits: number;
  readonly fetches: number;
  readonly checkouts: number;
  readonly archives: number;
}

const fetchProofOf = async (ws: Workspace): Promise<FetchProof> => {
  const text = await readFile(ws.gitTrace, 'utf8');
  const count = (re: RegExp): number => text.split('\n').filter((line) => re.test(line)).length;
  let archives = 0;
  try {
    archives = (await readdir(ws.gitArchive)).filter((n) => n.startsWith('checkout-')).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    inits: count(/^argv: init -- /),
    fetches: count(/^argv: -C .* fetch --depth=1 /),
    checkouts: count(/^argv: -C .* checkout --detach /),
    archives,
  };
};

interface InventoryEntry {
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: string;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly target: string | null;
}

interface Inventory {
  readonly entries: Record<string, InventoryEntry>;
  readonly totalBytes: number;
  readonly count: number;
  readonly topNames: string[];
}

const inventoryTree = async (root: string): Promise<Inventory> => {
  const entries: Record<string, InventoryEntry> = {};
  let totalBytes = 0;
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of (await readdir(abs)).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = await lstat(childAbs);
      if (st.isSymbolicLink()) {
        entries[childRel] = {
          kind: 'symlink',
          mode: (st.mode & 0o777).toString(8),
          bytes: 0,
          sha256: null,
          target: await readlink(childAbs),
        };
      } else if (st.isDirectory()) {
        entries[childRel] = {
          kind: 'dir',
          mode: (st.mode & 0o777).toString(8),
          bytes: 0,
          sha256: null,
          target: null,
        };
        await walk(childAbs, childRel);
      } else if (st.isFile()) {
        const bytes = await readFile(childAbs);
        totalBytes += bytes.length;
        entries[childRel] = {
          kind: 'file',
          mode: (st.mode & 0o777).toString(8),
          bytes: bytes.length,
          sha256: sha256Hex(bytes),
          target: null,
        };
      }
      if (Object.keys(entries).length > 20_000) throw new Error(`inventory runaway at ${root}`);
    }
  };
  await walk(root, '');
  return {
    entries,
    totalBytes,
    count: Object.keys(entries).length,
    topNames: Object.keys(entries)
      .filter((rel) => !rel.includes('/'))
      .sort(),
  };
};

// Fixed legacy oracle: manually specified expected payload manifest using the
// existing legacy encoding (rel + NUL + F<owner-exec>/L + NUL + sha/target,
// byte-sorted by relpath, sha256 over newline-joined records). Built from the
// explicit PAYLOAD list and pristine fixture bytes only — never by calling
// the production traversal and never from production output.
const expectedLegacyHash = async (
  oracleDir: string,
): Promise<{ hash: string; records: string[] }> => {
  const top = (await readdir(oracleDir)).sort();
  for (const name of top) {
    if (name === '.git') throw new Error('oracle must not contain .git by construction');
  }
  const records: { rel: string; record: string }[] = [];
  for (const rel of PAYLOAD_FILES) {
    const abs = join(oracleDir, rel);
    const st = await lstat(abs);
    if (!st.isFile()) throw new Error(`oracle payload missing file: ${rel}`);
    const bytes = await readFile(abs);
    const exec = (st.mode & 0o100) !== 0 ? '1' : '0';
    records.push({ rel, record: `${rel}\0F${exec}\0${sha256Hex(bytes)}` });
  }
  for (const { rel, target } of PAYLOAD_SYMLINKS) {
    const actual = await readlink(join(oracleDir, rel));
    if (actual !== target) throw new Error(`oracle symlink drift: ${rel} -> ${actual}`);
    records.push({ rel, record: `${rel}\0L\0${target}` });
  }
  records.sort((a, b) => byteCompare(a.rel, b.rel));
  const manifest = records.map((r) => r.record).join('\n');
  return { hash: `sha256:${sha256Hex(manifest)}`, records: records.map((r) => r.record) };
};

// ---- Case records ----

interface CaseRecord {
  readonly case: string;
  readonly exit: number | null;
  readonly action: string | null;
  readonly skillPath: string | null;
  readonly refResolved: string | null;
  readonly storeBytes: number | null;
  readonly storeEntries: number | null;
  readonly gitPresent: boolean | null;
  readonly legacyHash: string | null;
  readonly portableHash: string | null;
  readonly elapsedMs: number;
  readonly note: string;
}

const cases: CaseRecord[] = [];
const record = (entry: CaseRecord): void => {
  cases.push(entry);
  console.log(`R5CASE ${JSON.stringify(entry)}`);
};

// ---- Shared characterization state (filled in file order) ----

interface InstallObservation {
  readonly ws: Workspace;
  readonly result: CliResult;
  readonly row: {
    readonly skill: string | null;
    readonly tool: string | null;
    readonly action: string;
    readonly placement: string | null;
    readonly placementPath: string | null;
    readonly storePath: string | null;
    readonly storeRev: string | null;
    readonly storeGitSha: string | null;
    readonly storeReused: boolean | null;
    readonly skillPath: string | null;
    readonly refResolved: string | null;
    readonly reason: string | null;
  };
  readonly pair: LedgerPairView | null;
  readonly storeInv: Inventory;
  readonly portableHash: string | null;
  readonly proof: FetchProof;
}

const S: {
  fixture: RootContentFixture | null;
  tools: ToolPaths | null;
  roots: string[];
  oracleHash: string;
  nested: InstallObservation | null;
  fetchA: InstallObservation | null;
  fetchB: InstallObservation | null;
  fetchC: InstallObservation | null;
  fetchC2Action: string | null;
} = {
  fixture: null,
  tools: null,
  roots: [],
  oracleHash: '',
  nested: null,
  fetchA: null,
  fetchB: null,
  fetchC: null,
  fetchC2Action: null,
};

const requireFixture = (): RootContentFixture => {
  if (S.fixture === null) throw new Error('fixture not built (setup failure)');
  return S.fixture;
};

const pinTools = async (): Promise<ToolPaths> => {
  const need = (name: string): string => {
    const found = Bun.which(name);
    if (!found) throw new Error(`required fixture executable missing: ${name}`);
    return found;
  };
  const git = await realpath(need('git'));
  return {
    git,
    cp: await realpath(need('cp')),
    mkdir: await realpath(need('mkdir')),
    find: await realpath(need('find')),
    sort: await realpath(need('sort')),
  };
};

beforeAll(async () => {
  S.tools = await pinTools();
  const base = await mkdtemp(join(tmpdir(), 'skillsmith-r5-base-'));
  S.roots.push(base);
  S.fixture = await buildRootContentFixture(base);
  // Fixture integrity: tracked payload is exactly the explicit manifest.
  const tracked = runGit(join(base, 'root-work'), ['ls-files']).trim().split('\n').sort();
  const expected = [...PAYLOAD_FILES, ...PAYLOAD_SYMLINKS.map((s) => s.rel)].sort();
  // root-work is at commit 2; tracked names are unchanged by the content edit.
  expect(tracked).toEqual(expected);
  const oracle = await expectedLegacyHash(S.fixture.oracleDir);
  S.oracleHash = oracle.hash;
  await writeFile(
    join(base, 'fixture.json'),
    `${JSON.stringify(
      {
        baseSha: BASE_SHA,
        headSha: S.fixture.headSha,
        rootSha1: S.fixture.rootSha1,
        rootSha2: S.fixture.rootSha2,
        nestedSha: S.fixture.nestedSha,
        oracleHash: oracle.hash,
        gitVersion: S.fixture.gitVersion,
        bunVersion: S.fixture.bunVersion,
      },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  // Clean only owned fixtures after archives are complete (R5CASE/R5TABLE
  // lines already emitted). Reverse order: workspaces before the base.
  for (const root of [...S.roots].reverse()) {
    await rm(root, { recursive: true, force: true });
  }
});

const installArgs = (
  source: string,
  opts: { ref: string; save: 'manifest' | 'nosave'; ws: Workspace; direct?: boolean },
): string[] => [
  '--no-prompt',
  'install',
  source,
  '--tool',
  TOOL,
  '--scope',
  'user',
  '--no-verify',
  '--json',
  '--ref',
  opts.ref,
  ...(opts.save === 'manifest'
    ? ['--file', opts.ws.manifest, '--lockfile', opts.ws.lockfile]
    : ['--no-save']),
  ...(opts.direct ? ['--direct'] : []),
];

const observeInstall = async (
  ws: Workspace,
  result: CliResult,
  opts: { save: 'manifest' | 'nosave'; skill: string },
): Promise<InstallObservation> => {
  if (result.exitCode !== 0) {
    throw new Error(
      `install failed (setup failure, not RED): exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  const report = InstallJsonSchema.parse(JSON.parse(result.stdout));
  const row = report.results[0];
  if (!row) throw new Error('install report has no results (setup failure)');
  if (row.action !== 'installed') {
    throw new Error(
      `install not completed (setup failure, not RED): action=${row.action} reason=${row.reason}\n--- stderr ---\n${result.stderr}`,
    );
  }
  const pair = await readLedgerPair(ws.data, opts.skill, TOOL);
  const storePath = row.store?.path ?? null;
  if (storePath === null) throw new Error('installed row has no store path (setup failure)');
  if (!storePath.startsWith(ws.data + sep)) {
    throw new Error(`store path escapes owned data dir: ${storePath}`);
  }
  const storeInv = await inventoryTree(storePath);
  await writeFile(join(ws.root, 'store-inventory.json'), `${JSON.stringify(storeInv, null, 2)}\n`);
  const portableHash =
    opts.save === 'manifest' ? await readLockContentHash(ws.lockfile, opts.skill) : null;
  const proof = await fetchProofOf(ws);
  return {
    ws,
    result,
    row: {
      skill: row.skill,
      tool: row.tool,
      action: row.action,
      placement: row.placement,
      placementPath: row.placementPath,
      storePath,
      storeRev: row.store?.rev ?? null,
      storeGitSha: row.store?.gitSha ?? null,
      storeReused: row.store?.reused ?? null,
      skillPath: row.origin?.skillPath ?? null,
      refResolved: row.origin?.refResolved ?? null,
      reason: row.reason,
    },
    pair,
    storeInv,
    portableHash,
    proof,
  };
};

const gitPresentIn = (inv: Inventory): boolean => inv.topNames.includes('.git');

// Best-effort failure summary: with --json, failing runs may still emit a
// parsed report on stdout; otherwise fall back to stream tails.
const summarizeFailure = (
  result: CliResult,
): { action: string; reason: string; stdoutTail: string; stderrTail: string } => {
  const stdoutTail = result.stdout.slice(-500);
  const stderrTail = result.stderr.slice(-500);
  try {
    const parsed = JSON.parse(result.stdout) as {
      results?: readonly { action?: unknown; reason?: unknown }[];
    };
    const row = parsed.results?.[0];
    if (row !== undefined) {
      return {
        action: typeof row.action === 'string' ? row.action : `exit-${result.exitCode}`,
        reason: typeof row.reason === 'string' ? row.reason : '',
        stdoutTail,
        stderrTail,
      };
    }
  } catch {
    // fall through to tails
  }
  return { action: `exit-${result.exitCode}`, reason: '', stdoutTail, stderrTail };
};

// Digest of the wrapper-archived `.git` state captured after checkout.
const archiveDigest = async (ws: Workspace, index = 0): Promise<string> => {
  const dotgit = join(ws.gitArchive, `checkout-${index}`, 'dotgit');
  const shaOf = async (rel: string): Promise<string> => {
    try {
      return sha256Hex(await readFile(join(dotgit, rel)));
    } catch {
      return 'absent';
    }
  };
  const inv = await inventoryTree(dotgit).catch(() => null);
  return `index=${await shaOf('index')} config=${await shaOf('config')} head=${await shaOf('HEAD')} entries=${inv?.count ?? 'n/a'} bytes=${inv?.totalBytes ?? 'n/a'}`;
};

describe('SC-I60-R5 Phase A — root-skill content characterization (P17)', () => {
  test('T0 help grammar (source build)', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'help', S.roots);
    const rootHelp = await runCli(ws, 'root-help', ['--help']);
    const installHelp = await runCli(ws, 'install-help', ['install', '--help']);
    expect(rootHelp.exitCode).toBe(0);
    expect(installHelp.exitCode).toBe(0);
    expect(installHelp.stdout).toContain('ALIASES');
    expect(installHelp.stdout).toContain('EXIT CODES');
    record({
      case: 'T0-help',
      exit: installHelp.exitCode,
      action: null,
      skillPath: null,
      refResolved: null,
      storeBytes: null,
      storeEntries: null,
      gitPresent: null,
      legacyHash: null,
      portableHash: null,
      elapsedMs: rootHelp.elapsedMs + installHelp.elapsedMs,
      note: `rootHelpBytes=${rootHelp.stdout.length} installHelpBytes=${installHelp.stdout.length} installHelpSha=${sha256Hex(installHelp.stdout)}`,
    });
  });

  test('T1 nested-skill control installs without Git administration', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'nested', S.roots);
    const source = `${NESTED_URL}//plugins/acme/skills/nested`;
    const result = await runCli(
      ws,
      'install-nested',
      installArgs(source, { ref: fx.nestedSha, save: 'manifest', ws }),
    );
    const obs = await observeInstall(ws, result, { save: 'manifest', skill: 'nested' });
    expect(obs.row.skill).toBe('nested');
    expect(obs.row.tool).toBe(TOOL);
    expect(obs.row.skillPath).toBe('plugins/acme/skills/nested');
    expect(obs.row.refResolved).toBe(fx.nestedSha);
    expect(obs.row.storeGitSha).toBe(fx.nestedSha);
    expect(obs.pair?.journal ?? null).toBeNull();
    expect(obs.proof.inits).toBeGreaterThanOrEqual(1);
    expect(obs.proof.fetches).toBeGreaterThanOrEqual(1);
    expect(obs.proof.checkouts).toBeGreaterThanOrEqual(1);
    expect(obs.storeInv.entries['SKILL.md']?.kind).toBe('file');
    S.nested = obs;
    record({
      case: 'T1-nested',
      exit: result.exitCode,
      action: obs.row.action,
      skillPath: obs.row.skillPath,
      refResolved: obs.row.refResolved,
      storeBytes: obs.storeInv.totalBytes,
      storeEntries: obs.storeInv.count,
      gitPresent: gitPresentIn(obs.storeInv),
      legacyHash: obs.pair?.pinnedContentHash ?? null,
      portableHash: obs.portableHash,
      elapsedMs: result.elapsedMs,
      note: `store=${obs.row.storePath} top=${obs.storeInv.topNames.join(',')}`,
    });
  });

  test('T2 fetch A: root skill, default desired-state (owned manifest/lock)', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'fetch-a', S.roots);
    const result = await runCli(
      ws,
      'install-a',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'manifest', ws }),
    );
    const obs = await observeInstall(ws, result, { save: 'manifest', skill: SKILL });
    expect(obs.row.skill).toBe(SKILL);
    expect(obs.row.tool).toBe(TOOL);
    expect(obs.row.skillPath).toBe('');
    expect(obs.row.refResolved).toBe(fx.rootSha1);
    expect(obs.row.storeGitSha).toBe(fx.rootSha1);
    expect(obs.row.storeRev).toBe(fx.rootSha1.slice(0, 12));
    expect(obs.row.storePath).toBe(
      join(ws.data, 'store', 'acme', `root-skill@${fx.rootSha1.slice(0, 12)}`, SKILL),
    );
    expect(obs.row.placement).toBe('symlink');
    expect(obs.pair?.journal ?? null).toBeNull();
    expect(obs.proof.inits).toBeGreaterThanOrEqual(1);
    expect(obs.proof.fetches).toBeGreaterThanOrEqual(1);
    expect(obs.proof.checkouts).toBeGreaterThanOrEqual(1);
    expect(obs.proof.archives).toBeGreaterThanOrEqual(1);
    // Live placement is a symlink into the owned store (store-linked).
    if (obs.row.placementPath === null || obs.row.storePath === null) {
      throw new Error('installed row lacks placement/store paths (setup failure)');
    }
    const liveSt = await lstat(obs.row.placementPath);
    expect(liveSt.isSymbolicLink()).toBe(true);
    expect(await readlink(obs.row.placementPath)).toBe(obs.row.storePath);
    S.fetchA = obs;
    const digestA = await archiveDigest(ws);
    record({
      case: 'T2-fetch-A',
      exit: result.exitCode,
      action: obs.row.action,
      skillPath: obs.row.skillPath,
      refResolved: obs.row.refResolved,
      storeBytes: obs.storeInv.totalBytes,
      storeEntries: obs.storeInv.count,
      gitPresent: gitPresentIn(obs.storeInv),
      legacyHash: obs.pair?.pinnedContentHash ?? null,
      portableHash: obs.portableHash,
      elapsedMs: result.elapsedMs,
      note: `store=${obs.row.storePath} top=${obs.storeInv.topNames.join(',')} proof=${JSON.stringify(obs.proof)} archive=[${digestA}]`,
    });
  });

  test('T3 fetch B: independent repeat (same URL+SHA, fresh HOME/data/store/ledger)', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'fetch-b', S.roots);
    const result = await runCli(
      ws,
      'install-b',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'manifest', ws }),
    );
    const obs = await observeInstall(ws, result, { save: 'manifest', skill: SKILL });
    expect(obs.row.skill).toBe(SKILL);
    expect(obs.row.skillPath).toBe('');
    expect(obs.row.refResolved).toBe(fx.rootSha1);
    expect(obs.proof.inits).toBeGreaterThanOrEqual(1);
    expect(obs.proof.fetches).toBeGreaterThanOrEqual(1);
    expect(obs.proof.checkouts).toBeGreaterThanOrEqual(1);
    expect(obs.proof.archives).toBeGreaterThanOrEqual(1);
    S.fetchB = obs;
    // Equal tracked payload across A/B (payload entries identical by bytes).
    const a = S.fetchA;
    if (a === null) throw new Error('fetch A missing (setup failure)');
    for (const rel of [...PAYLOAD_FILES, ...PAYLOAD_SYMLINKS.map((s) => s.rel)]) {
      const ea = a.storeInv.entries[rel];
      const eb = obs.storeInv.entries[rel];
      expect(`${rel}: ${JSON.stringify(eb)}`).toBe(`${rel}: ${JSON.stringify(ea)}`);
    }
    const digestB = await archiveDigest(ws);
    record({
      case: 'T3-fetch-B',
      exit: result.exitCode,
      action: obs.row.action,
      skillPath: obs.row.skillPath,
      refResolved: obs.row.refResolved,
      storeBytes: obs.storeInv.totalBytes,
      storeEntries: obs.storeInv.count,
      gitPresent: gitPresentIn(obs.storeInv),
      legacyHash: obs.pair?.pinnedContentHash ?? null,
      portableHash: obs.portableHash,
      elapsedMs: result.elapsedMs,
      note: `store=${obs.row.storePath} top=${obs.storeInv.topNames.join(',')} proof=${JSON.stringify(obs.proof)} archive=[${digestB}]`,
    });
  });

  test('T4 fetch C: --no-save parity + same-install no-op control', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'fetch-c', S.roots);
    const sentinels = [
      join(ws.cwd, 'skillsmith.toml'),
      join(ws.cwd, 'skillsmith.lock'),
      join(ws.config, 'skillsmith', 'skillsmith.toml'),
      join(ws.config, 'skillsmith', 'skillsmith.lock'),
    ];
    for (const path of sentinels) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'owned no-save sentinel: deliberately not parsed\n');
    }
    const before = await Promise.all(sentinels.map((p) => readFile(p, 'utf8')));
    const result = await runCli(
      ws,
      'install-c',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'nosave', ws }),
    );
    const obs = await observeInstall(ws, result, { save: 'nosave', skill: SKILL });
    expect(obs.row.skillPath).toBe('');
    const after = await Promise.all(sentinels.map((p) => readFile(p, 'utf8')));
    expect(after).toEqual(before);
    S.fetchC = obs;
    record({
      case: 'T4-fetch-C-nosave',
      exit: result.exitCode,
      action: obs.row.action,
      skillPath: obs.row.skillPath,
      refResolved: obs.row.refResolved,
      storeBytes: obs.storeInv.totalBytes,
      storeEntries: obs.storeInv.count,
      gitPresent: gitPresentIn(obs.storeInv),
      legacyHash: obs.pair?.pinnedContentHash ?? null,
      portableHash: null,
      elapsedMs: result.elapsedMs,
      note: `store=${obs.row.storePath} top=${obs.storeInv.topNames.join(',')}`,
    });
    // Same-install no-op control on the identical request.
    const rerun = await runCli(
      ws,
      'install-c-noop',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'nosave', ws }),
    );
    expect(rerun.exitCode).toBe(0);
    const rerow = InstallJsonSchema.parse(JSON.parse(rerun.stdout)).results[0];
    if (!rerow) throw new Error('noop rerun has no results (setup failure)');
    S.fetchC2Action = rerow.action;
    record({
      case: 'T4-noop-rerun',
      exit: rerun.exitCode,
      action: rerow.action,
      skillPath: rerow.origin?.skillPath ?? null,
      refResolved: rerow.origin?.refResolved ?? null,
      storeBytes: null,
      storeEntries: null,
      gitPresent: null,
      legacyHash: null,
      portableHash: null,
      elapsedMs: rerun.elapsedMs,
      note: `reason=${rerow.reason ?? ''}`,
    });
    expect(rerow.action).toBe('noop');
  });

  test('RED-1 stored bytes exclude Git administration (root A/B/C + nested control)', async () => {
    const a = S.fetchA;
    const b = S.fetchB;
    const c = S.fetchC;
    const n = S.nested;
    if (a === null || b === null || c === null || n === null) {
      throw new Error('characterization observations missing (setup failure, not RED)');
    }
    // Exact top-level entry match (`.gitattributes` must NOT trip the check).
    // Nested control first (expected to hold: sparse materialization).
    expect(n.storeInv.topNames).not.toContain('.git');
    // Load-bearing: root-skill stores must not carry `.git`.
    expect(a.storeInv.topNames).not.toContain('.git');
    expect(b.storeInv.topNames).not.toContain('.git');
    expect(c.storeInv.topNames).not.toContain('.git');
  });

  test('RED-2 repeat-fetch legacy identity equals fixed payload oracle', async () => {
    const a = S.fetchA;
    const b = S.fetchB;
    if (a === null || b === null) {
      throw new Error('characterization observations missing (setup failure, not RED)');
    }
    const ha = a.pair?.pinnedContentHash ?? null;
    const hb = b.pair?.pinnedContentHash ?? null;
    expect(ha).not.toBeNull();
    expect(hb).not.toBeNull();
    // Same immutable source, identical tracked payload: one legacy identity,
    // equal to the manually specified payload manifest (no `.git`).
    expect(hb).toBe(ha);
    expect(ha).toBe(S.oracleHash);
    expect(hb).toBe(S.oracleHash);
  });

  test('T5 portable-identity parity across A/B (honest split, not cross-algorithm equality)', async () => {
    const a = S.fetchA;
    const b = S.fetchB;
    if (a === null || b === null) throw new Error('observations missing (setup failure)');
    expect(a.portableHash).not.toBeNull();
    expect(b.portableHash).not.toBeNull();
    record({
      case: 'T5-portable-parity',
      exit: null,
      action: null,
      skillPath: null,
      refResolved: null,
      storeBytes: null,
      storeEntries: null,
      gitPresent: null,
      legacyHash: null,
      portableHash: null,
      elapsedMs: 0,
      note: `portableA=${a.portableHash} portableB=${b.portableHash} equal=${a.portableHash === b.portableHash}`,
    });
    expect(b.portableHash).toBe(a.portableHash);
  });

  test('T6 same-store recurrence: install -> uninstall -> reinstall', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'recur', S.roots);
    const r1 = await runCli(
      ws,
      'install-r1',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'manifest', ws }),
    );
    const o1 = await observeInstall(ws, r1, { save: 'manifest', skill: SKILL });
    const storePath1 = o1.row.storePath as string;
    const hash1 = o1.pair?.pinnedContentHash ?? null;
    record({
      case: 'T6-R1-install',
      exit: r1.exitCode,
      action: o1.row.action,
      skillPath: o1.row.skillPath,
      refResolved: o1.row.refResolved,
      storeBytes: o1.storeInv.totalBytes,
      storeEntries: o1.storeInv.count,
      gitPresent: gitPresentIn(o1.storeInv),
      legacyHash: hash1,
      portableHash: o1.portableHash,
      elapsedMs: r1.elapsedMs,
      note: `store=${storePath1}`,
    });
    const proof1 = await fetchProofOf(ws);

    const un = await runCli(ws, 'uninstall-r', [
      '--no-prompt',
      'uninstall',
      SKILL,
      '--tool',
      TOOL,
      '--scope',
      'user',
      '--json',
      '--file',
      ws.manifest,
      '--lockfile',
      ws.lockfile,
    ]);
    expect(un.exitCode).toBe(0);
    const unReport = UninstallJsonSchema.parse(JSON.parse(un.stdout));
    const unRow = unReport.results[0] as { action?: unknown } | undefined;
    const unAction = typeof unRow?.action === 'string' ? unRow.action : null;
    // Ledger + live cleared; immutable store preserved.
    expect(await readLedgerPair(ws.data, SKILL, TOOL)).toBeNull();
    expect((await lstat(o1.row.placementPath as string).catch(() => null)) === null).toBe(true);
    const storeSt = await lstat(storePath1);
    expect(storeSt.isDirectory()).toBe(true);
    record({
      case: 'T6-RU-uninstall',
      exit: un.exitCode,
      action: unAction,
      skillPath: null,
      refResolved: null,
      storeBytes: null,
      storeEntries: null,
      gitPresent: null,
      legacyHash: null,
      portableHash: null,
      elapsedMs: un.elapsedMs,
      note: 'ledger/live cleared, store preserved',
    });

    // Reinstall the same immutable source into the same store. Outcome is NOT
    // predeclared: reuse/noop and integrity refusal are both characterization.
    const r2 = await runCli(
      ws,
      'install-r2',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'manifest', ws }),
    );
    const proof2 = await fetchProofOf(ws);
    const freshRefetch = proof2.checkouts > proof1.checkouts && proof2.fetches > proof1.fetches;
    let r2action: string | null = null;
    let r2reason = '';
    let r2hash: string | null = null;
    let r2store: string | null = null;
    if (r2.exitCode === 0) {
      const parsed = InstallJsonSchema.parse(JSON.parse(r2.stdout)).results[0];
      r2action = parsed?.action ?? null;
      r2reason = parsed?.reason ?? '';
      const pair2 = await readLedgerPair(ws.data, SKILL, TOOL);
      r2hash = pair2?.pinnedContentHash ?? null;
      r2store = pair2?.pinnedStorePath ?? null;
    } else {
      const summary = summarizeFailure(r2);
      r2action = summary.action;
      r2reason = summary.reason || summary.stderrTail || summary.stdoutTail;
    }
    // Same-workspace fetch archaeology: did R1 and R2 checkouts carry
    // identical `.git` state? (Equal state here would be inconclusive.)
    const digestR1 = proof2.archives >= 1 ? await archiveDigest(ws, 0) : 'missing';
    const digestR2 = proof2.archives >= 2 ? await archiveDigest(ws, 1) : 'missing';
    record({
      case: 'T6-R2-reinstall',
      exit: r2.exitCode,
      action: r2action,
      skillPath: null,
      refResolved: null,
      storeBytes: null,
      storeEntries: null,
      gitPresent: null,
      legacyHash: r2hash,
      portableHash: null,
      elapsedMs: r2.elapsedMs,
      note: `freshRefetch=${freshRefetch} proof1=${JSON.stringify(proof1)} proof2=${JSON.stringify(proof2)} store1=${storePath1} store2=${r2store} hash1=${hash1} hash2=${r2hash} reason=${r2reason} archiveR1=[${digestR1}] archiveR2=[${digestR2}] archivesEqual=${digestR1 === digestR2}`.slice(
        0,
        3000,
      ),
    });
    expect(freshRefetch).toBe(true);
    expect(r2.exitCode).toBe(0);
    expect(r2hash).toBe(hash1);
    expect(r2store).toBe(storePath1);
  });

  test('T7 changed-source control: payload edit changes legacy identity', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'changed', S.roots);
    const result = await runCli(
      ws,
      'install-d',
      installArgs(ROOT_URL, { ref: fx.rootSha2, save: 'manifest', ws }),
    );
    const obs = await observeInstall(ws, result, { save: 'manifest', skill: SKILL });
    expect(obs.row.refResolved).toBe(fx.rootSha2);
    const hashD = obs.pair?.pinnedContentHash ?? null;
    const hashA = S.fetchA?.pair?.pinnedContentHash ?? null;
    record({
      case: 'T7-changed-source',
      exit: result.exitCode,
      action: obs.row.action,
      skillPath: obs.row.skillPath,
      refResolved: obs.row.refResolved,
      storeBytes: obs.storeInv.totalBytes,
      storeEntries: obs.storeInv.count,
      gitPresent: gitPresentIn(obs.storeInv),
      legacyHash: hashD,
      portableHash: obs.portableHash,
      elapsedMs: result.elapsedMs,
      note: `store=${obs.row.storePath} hashA=${hashA}`,
    });
    expect(hashD).not.toBeNull();
    expect(hashA).not.toBeNull();
    expect(hashD).not.toBe(hashA);
  });

  test('T8 direct-copy placement control', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'direct', S.roots);
    const result = await runCli(
      ws,
      'install-e',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'manifest', ws, direct: true }),
    );
    const obs = await observeInstall(ws, result, { save: 'manifest', skill: SKILL });
    expect(obs.row.placement).toBe('copy');
    const liveInv = await inventoryTree(obs.row.placementPath as string);
    await writeFile(join(ws.root, 'live-inventory.json'), `${JSON.stringify(liveInv, null, 2)}\n`);
    record({
      case: 'T8-direct-copy',
      exit: result.exitCode,
      action: obs.row.action,
      skillPath: obs.row.skillPath,
      refResolved: obs.row.refResolved,
      storeBytes: obs.storeInv.totalBytes,
      storeEntries: obs.storeInv.count,
      gitPresent: gitPresentIn(obs.storeInv),
      legacyHash: obs.pair?.pinnedContentHash ?? null,
      portableHash: obs.portableHash,
      elapsedMs: result.elapsedMs,
      note: `live=${obs.row.placementPath} liveBytes=${liveInv.totalBytes} liveEntries=${liveInv.count} liveGit=${gitPresentIn(liveInv)} liveTop=${liveInv.topNames.join(',')}`,
    });
    expect(obs.storeInv.topNames).not.toContain('.git');
    expect(gitPresentIn(liveInv)).toBe(false);
  });

  test('T9 tamper control: payload tampering at an existing store', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'tamper', S.roots);
    const f1 = await runCli(
      ws,
      'install-f1',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'manifest', ws }),
    );
    const o1 = await observeInstall(ws, f1, { save: 'manifest', skill: SKILL });
    const storePath = o1.row.storePath as string;
    const hash1 = o1.pair?.pinnedContentHash ?? null;
    // Genuine payload tamper of the immutable entry (not .git).
    const victim = join(storePath, 'README.md');
    const before = await readFile(victim, 'utf8');
    await writeFile(victim, `${before}\nTAMPERED\n`);
    const un = await runCli(ws, 'uninstall-f', [
      '--no-prompt',
      'uninstall',
      SKILL,
      '--tool',
      TOOL,
      '--scope',
      'user',
      '--json',
      '--file',
      ws.manifest,
      '--lockfile',
      ws.lockfile,
    ]);
    // Uninstall-after-tamper is itself characterization: record exit/reason
    // instead of assuming success, then always attempt the reinstall probe.
    const unSummary = un.exitCode === 0 ? null : summarizeFailure(un);
    const unPairAfter = await readLedgerPair(ws.data, SKILL, TOOL);
    record({
      case: 'T9-tamper-uninstall',
      exit: un.exitCode,
      action: unSummary?.action ?? 'removed',
      skillPath: null,
      refResolved: null,
      storeBytes: null,
      storeEntries: null,
      gitPresent: null,
      legacyHash: null,
      portableHash: null,
      elapsedMs: un.elapsedMs,
      note: `store=${storePath} tampered=README.md pairAfter=${unPairAfter === null ? 'cleared' : 'present'} reason=${unSummary?.reason || unSummary?.stderrTail || unSummary?.stdoutTail || ''}`.slice(
        0,
        1500,
      ),
    });
    const f2 = await runCli(
      ws,
      'install-f2',
      installArgs(ROOT_URL, { ref: fx.rootSha1, save: 'manifest', ws }),
    );
    let action: string | null = null;
    let reason = '';
    if (f2.exitCode === 0) {
      const parsed = InstallJsonSchema.parse(JSON.parse(f2.stdout)).results[0];
      action = parsed?.action ?? null;
      reason = parsed?.reason ?? '';
    } else {
      const summary = summarizeFailure(f2);
      action = summary.action;
      reason = summary.reason || summary.stderrTail || summary.stdoutTail;
    }
    record({
      case: 'T9-tamper-reinstall',
      exit: f2.exitCode,
      action,
      skillPath: null,
      refResolved: null,
      storeBytes: null,
      storeEntries: null,
      gitPresent: null,
      legacyHash: hash1,
      portableHash: null,
      elapsedMs: f2.elapsedMs,
      note: `store=${storePath} tampered=README.md reason=${reason}`.slice(0, 1500),
    });
    // Required control: genuine tamper must surface as a refusal in either
    // the uninstall or the reinstall step — never silent acceptance.
    const uninstallRefused = un.exitCode !== 0;
    const reinstallRefused =
      f2.exitCode !== 0 || (action !== null && action !== 'installed' && action !== 'noop');
    expect(uninstallRefused || reinstallRefused).toBe(true);
  });

  test('T10 unresolved URL fails closed without network', async () => {
    const fx = requireFixture();
    const ws = await makeWorkspace(fx, S.tools as ToolPaths, 'unresolved', S.roots);
    const started = Date.now();
    const result = await runCli(
      ws,
      'install-unresolved',
      installArgs('https://root.fixture.invalid/acme/does-not-exist.git', {
        ref: fx.rootSha1,
        save: 'nosave',
        ws,
      }),
    );
    const wallMs = Date.now() - started;
    record({
      case: 'T10-unresolved-url',
      exit: result.exitCode,
      action: null,
      skillPath: null,
      refResolved: null,
      storeBytes: null,
      storeEntries: null,
      gitPresent: null,
      legacyHash: null,
      portableHash: null,
      elapsedMs: result.elapsedMs,
      note: `wallMs=${wallMs} stderrTail=${result.stderr.slice(-300)}`,
    });
    expect(result.exitCode).toBe(5);
    expect(wallMs).toBeLessThan(60_000);
  });

  test('R5TABLE evidence bundle', async () => {
    const fx = requireFixture();
    const { fileURLToPath } = await import('node:url');
    const selfPath = fileURLToPath(import.meta.url);
    const selfBytes = await readFile(selfPath);
    const checkout = join(import.meta.dir, '..', '..', '..', '..');
    const owners = [
      'packages/core/src/acquire/fetch.ts',
      'packages/core/src/acquire/resolve.ts',
      'packages/core/src/acquire/run.ts',
      'packages/core/src/place/store.ts',
      'packages/core/src/ports/git.ts',
      'packages/core/src/ports/default.ts',
      'packages/core/src/artifacts/source-content.ts',
    ];
    const ownerHashes: Record<string, string> = {};
    for (const rel of owners) {
      ownerHashes[rel] = sha256Hex(await readFile(join(checkout, rel)));
    }
    const table = {
      baseSha: BASE_SHA,
      headSha: fx.headSha,
      testFile: 'packages/cli/tests/commands/install-root-content.test.ts',
      testFileBytes: selfBytes.length,
      testFileSha256: sha256Hex(selfBytes),
      gitVersion: fx.gitVersion,
      bunVersion: fx.bunVersion,
      rootSha1: fx.rootSha1,
      rootSha2: fx.rootSha2,
      nestedSha: fx.nestedSha,
      oracleHash: S.oracleHash,
      ownerHashes,
      cases,
    };
    console.log(`R5TABLE ${JSON.stringify(table)}`);
    expect(fx.headSha).toBe(BASE_SHA);
  });
});
