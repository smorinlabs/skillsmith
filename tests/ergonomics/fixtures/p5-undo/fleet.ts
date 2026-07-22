import {
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
import { basename, join, relative, resolve } from 'node:path';

const CLI_ENTRYPOINT = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'cli',
  'src',
  'index.ts',
);

export const UNDO_SECRET_CANARIES = Object.freeze([
  'P17_SECRET_CANARY_UNDO_ENV',
  'P17_SECRET_CANARY_UNDO_FILE',
] as const);

export type UndoScope = 'user' | 'project';
export type UndoTool = 'claude-code' | 'codex';

export interface UndoCliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface UndoFleet {
  readonly root: string;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly data: string;
  readonly ledger: string;
  readonly source: string;
  readonly sourceRepository: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly paths: Readonly<{
    readonly userClaude: string;
    readonly userCodex: string;
    readonly projectClaude: string;
    readonly projectCodex: string;
  }>;
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const runGit = (cwd: string, args: readonly string[]): string => {
  const product = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Skillsmith undo fixture',
      GIT_AUTHOR_EMAIL: 'undo@skillsmith.test',
      GIT_COMMITTER_NAME: 'Skillsmith undo fixture',
      GIT_COMMITTER_EMAIL: 'undo@skillsmith.test',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (product.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${new TextDecoder().decode(product.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(product.stdout).trim();
};

const initializeRepository = (path: string): void => {
  runGit(path, ['init', '--quiet', '-b', 'main']);
  runGit(path, ['add', '-A']);
  runGit(path, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture: initial']);
};

const toolRoot = (fleet: UndoFleet, scope: UndoScope, tool: UndoTool): string => {
  if (scope === 'project') {
    return tool === 'claude-code'
      ? join(fleet.projectRoot, '.claude', 'skills')
      : join(fleet.projectRoot, '.agents', 'skills');
  }
  return tool === 'claude-code'
    ? join(fleet.home, '.claude', 'skills')
    : join(fleet.home, '.agents', 'skills');
};

const sourceFor = async (fleet: UndoFleet, skill: string): Promise<string> => {
  const path = join(fleet.sourceRepository, 'skills', skill);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${skill}\ndescription: Hermetic P17 undo fixture.\n---\n\n# ${skill}\n`,
  );
  runGit(fleet.sourceRepository, ['add', '-A']);
  const diff = Bun.spawnSync(['git', 'diff', '--cached', '--quiet'], {
    cwd: fleet.sourceRepository,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (diff.exitCode !== 0) {
    runGit(fleet.sourceRepository, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      `fixture: add ${skill}`,
    ]);
  }
  return path;
};

export const createUndoFleet = async (): Promise<UndoFleet> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-p5-undo-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const project = join(root, 'project');
  const sourceRepository = join(root, 'undo-fixture.git');
  const bin = join(root, 'bin');
  const config = join(root, 'xdg', 'config');
  const cache = join(root, 'xdg', 'cache');
  const xdgData = join(root, 'xdg', 'data');
  const gitConfig = join(root, 'gitconfig');
  await Promise.all(
    [
      home,
      data,
      project,
      join(sourceRepository, 'skills', 'review'),
      bin,
      config,
      cache,
      xdgData,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await Promise.all([
    writeFile(join(project, 'README.md'), '# Hermetic undo project\n'),
    writeFile(
      join(sourceRepository, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Hermetic P17 undo fixture.\n---\n\n# review\n',
    ),
    writeFile(join(root, 'canary.txt'), `${UNDO_SECRET_CANARIES[1]}\n`),
    writeFile(
      join(bin, 'claude'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "2.1.202 (Claude Code)"; exit 0; fi',
        'if [ "$1" = "plugin" ] && [ "$2" = "validate" ]; then exit 0; fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    ),
    writeFile(
      join(bin, 'codex'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.142.5"; exit 0; fi',
        'if [ "$1" = "exec" ]; then exit 0; fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    ),
    writeFile(
      gitConfig,
      [
        '[protocol "file"]',
        '\tallow = always',
        `[url "file://${sourceRepository}"]`,
        '\tinsteadOf = https://fixture.invalid/skillsmith/undo-fixture.git',
        '',
      ].join('\n'),
    ),
  ]);
  initializeRepository(project);
  initializeRepository(sourceRepository);
  const projectRoot = await realpath(project);
  const source = join(sourceRepository, 'skills', 'review');
  const fleet: UndoFleet = {
    root,
    cwd: project,
    projectRoot,
    home,
    data,
    ledger: join(data, 'placements.json'),
    source,
    sourceRepository,
    env: Object.freeze({
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: data,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file:https',
      CI: '1',
      NO_COLOR: '1',
      P17_UNDO_TEST_CANARY: UNDO_SECRET_CANARIES[0],
    }),
    paths: Object.freeze({
      userClaude: join(home, '.claude', 'skills', 'review'),
      userCodex: join(home, '.agents', 'skills', 'review'),
      projectClaude: join(projectRoot, '.claude', 'skills', 'review'),
      projectCodex: join(projectRoot, '.agents', 'skills', 'review'),
    }),
  };
  return Object.freeze(fleet);
};

export const destroyUndoFleet = async (fleet: UndoFleet): Promise<void> => {
  await rm(fleet.root, { recursive: true, force: true });
};

export const spawnUndoCli = (
  fleet: UndoFleet,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string | undefined>> = {},
) =>
  Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
    cwd: fleet.cwd,
    env: { ...process.env, ...fleet.env, ...extraEnv },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

export const runUndoCli = async (
  fleet: UndoFleet,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string | undefined>> = {},
): Promise<UndoCliProduct> => {
  const child = spawnUndoCli(fleet, args, extraEnv);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`CLI timed out: ${args.join(' ')}`)), 30_000);
      }),
    ]);
    return {
      exitCode,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const requireSuccessfulSeed = async (
  fleet: UndoFleet,
  args: readonly string[],
): Promise<UnknownRecord> => {
  const product = await runUndoCli(fleet, args);
  if (product.exitCode !== 0) {
    throw new Error(
      `seed command failed (${args.join(' ')}): ${product.stderr}\n${product.stdout}`,
    );
  }
  const parsed: unknown = JSON.parse(product.stdout);
  if (!isRecord(parsed)) throw new Error(`seed command returned a non-object: ${args.join(' ')}`);
  return parsed;
};

export const seedDev = async (
  fleet: UndoFleet,
  options: Readonly<{
    readonly skill?: string;
    readonly scope?: UndoScope;
    readonly tool?: UndoTool;
  }> = {},
): Promise<UnknownRecord> => {
  const skill = options.skill ?? 'review';
  const scope = options.scope ?? 'project';
  const tool = options.tool ?? 'claude-code';
  const source = await sourceFor(fleet, skill);
  return requireSuccessfulSeed(fleet, [
    'dev',
    skill,
    '--source',
    source,
    '--scope',
    scope,
    '--tool',
    tool,
    '--no-verify',
    '--json',
  ]);
};

export const seedPromote = async (
  fleet: UndoFleet,
  options: Readonly<{
    readonly skill?: string;
    readonly scope?: UndoScope;
    readonly tool?: UndoTool;
  }> = {},
): Promise<UnknownRecord> => {
  const skill = options.skill ?? 'review';
  const scope = options.scope ?? 'project';
  const tool = options.tool ?? 'claude-code';
  await seedDev(fleet, { skill, scope, tool });
  return requireSuccessfulSeed(fleet, [
    'promote',
    skill,
    '--scope',
    scope,
    '--tool',
    tool,
    '--no-verify',
    '--json',
  ]);
};

export const seedInstall = async (
  fleet: UndoFleet,
  options: Readonly<{ readonly scope?: UndoScope; readonly tool?: UndoTool }> = {},
): Promise<UnknownRecord> => {
  const scope = options.scope ?? 'project';
  const tool = options.tool ?? 'claude-code';
  const source = 'https://fixture.invalid/skillsmith/undo-fixture.git//skills/review';
  return requireSuccessfulSeed(fleet, [
    'install',
    source,
    '--scope',
    scope,
    '--tool',
    tool,
    '--no-save',
    '--no-verify',
    '--json',
  ]);
};

export const seedUninstall = async (
  fleet: UndoFleet,
  options: Readonly<{ readonly scope?: UndoScope; readonly tool?: UndoTool }> = {},
): Promise<UnknownRecord> => {
  const scope = options.scope ?? 'project';
  const tool = options.tool ?? 'claude-code';
  await seedInstall(fleet, { scope, tool });
  return requireSuccessfulSeed(fleet, [
    'uninstall',
    'review',
    '--scope',
    scope,
    '--tool',
    tool,
    '--no-save',
    '--json',
  ]);
};

export const readUndoLedger = async (fleet: UndoFleet): Promise<UnknownRecord> => {
  const value: unknown = JSON.parse(await readFile(fleet.ledger, 'utf8'));
  if (!isRecord(value)) throw new Error('undo fixture ledger is not an object');
  return value;
};

export const writeUndoLedgerText = async (fleet: UndoFleet, source: string): Promise<void> => {
  await mkdir(fleet.data, { recursive: true });
  await writeFile(fleet.ledger, source);
};

export const writeLegacyPendingDev = async (
  fleet: UndoFleet,
  options: Readonly<{
    readonly scope?: UndoScope;
    readonly tool?: UndoTool;
    readonly skill?: string;
  }> = {},
): Promise<Readonly<{ readonly placementPath: string; readonly transactionId: string }>> => {
  const scope = options.scope ?? 'project';
  const tool = options.tool ?? 'claude-code';
  const skill = options.skill ?? 'review';
  const source = await sourceFor(fleet, skill);
  const placementPath = join(toolRoot(fleet, scope, tool), skill);
  const transactionId = `legacy:${skill}-dev`;
  await mkdir(join(placementPath, '..'), { recursive: true });
  await symlink(resolve(source), placementPath);
  const pair = {
    placementPath,
    mode: 'dev',
    dev: {
      sourcePath: source,
      resolvedPath: source,
      repoRoot: fleet.sourceRepository,
      sourceRelPath: relative(fleet.sourceRepository, source),
      remote: null,
      recordedAt: '2026-07-22T00:00:00.000Z',
    },
    pinned: null,
    journal: {
      op: 'dev',
      txId: transactionId,
      phase: 'live',
      startedAt: '2026-07-22T00:00:00.000Z',
      completedAt: null,
      before: { mode: 'absent' },
      stagingPath: join(placementPath, '..', `.skillsmith-staging-${skill}-legacy`),
      backupPath: join(placementPath, '..', `.skillsmith-backup-${skill}-legacy`),
    },
  };
  const skills = { [skill]: { tools: { [tool]: pair } } };
  const document = {
    schemaVersion: 1,
    kind: 'skillsmith.placements',
    updatedAt: '2026-07-22T00:00:00.000Z',
    skills: scope === 'user' ? skills : {},
    projects: scope === 'project' ? { [fleet.projectRoot]: { skills } } : {},
  };
  await writeUndoLedgerText(fleet, `${JSON.stringify(document, null, 2)}\n`);
  return Object.freeze({ placementPath, transactionId });
};

const ledgerHasPhase = (value: unknown, phase: string): boolean => {
  if (Array.isArray(value)) return value.some((entry) => ledgerHasPhase(entry, phase));
  if (!isRecord(value)) return false;
  if (value.phase === phase) return true;
  return Object.values(value).some((entry) => ledgerHasPhase(entry, phase));
};

export const crashPublicCommandAt = async (
  fleet: UndoFleet,
  args: readonly string[],
  phase: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed',
): Promise<void> => {
  const child = spawnUndoCli(fleet, args, {
    SKILLSMITH_E2E: '1',
    SKILLSMITH_TEST_PAUSE_AT: phase,
  });
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      try {
        if (ledgerHasPhase(await readUndoLedger(fleet), phase)) {
          child.kill('SIGKILL');
          await child.exited;
          return;
        }
      } catch {
        // The ledger may not exist or may be between its atomic rename steps yet.
      }
      await Bun.sleep(20);
    }
    throw new Error(`timed out waiting for ${args.join(' ')} at ${phase}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
};

type TreeEntry = Readonly<{
  readonly path: string;
  readonly kind: 'directory' | 'file' | 'symlink';
  readonly value: string | null;
}>;

const snapshotTree = async (root: string): Promise<readonly TreeEntry[]> => {
  const entries: TreeEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return;
      throw error;
    }
    const name = relative(root, path) || '.';
    if (stat.isSymbolicLink()) {
      entries.push({ path: name, kind: 'symlink', value: await readlink(path) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: name, kind: 'directory', value: null });
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
      return;
    }
    entries.push({ path: name, kind: 'file', value: await readFile(path, 'utf8') });
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};

export const snapshotUndoState = async (fleet: UndoFleet): Promise<string> => {
  const roots = [
    fleet.data,
    join(fleet.home, '.claude', 'skills'),
    join(fleet.home, '.agents', 'skills'),
    join(fleet.projectRoot, '.claude', 'skills'),
    join(fleet.projectRoot, '.agents', 'skills'),
  ];
  const trees = await Promise.all(roots.map(snapshotTree));
  return JSON.stringify(
    roots.map((root, index) => ({ root: basename(root), entries: trees[index] })),
  );
};
