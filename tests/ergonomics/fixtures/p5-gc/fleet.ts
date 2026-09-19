import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../../packages/cli/tests/fixtures/cli.ts';

export const GC_SECRET_CANARIES = Object.freeze([
  'P17_SECRET_CANARY_GC_ENV',
  'P17_SECRET_CANARY_GC_FILE',
] as const);

export interface GcCliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GcStoreObject {
  readonly path: string;
  readonly namespace: string;
  readonly repository: string;
  readonly revision: string;
  readonly skill: string;
  readonly contentHash: string;
  readonly logicalBytes: number;
  readonly modifiedAt: string;
}

export interface GcFleet {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly data: string;
  readonly store: string;
  readonly ledger: string;
  readonly recovery: string;
  readonly projects: Readonly<{
    readonly current: string;
    readonly retired: string;
    readonly missing: string;
  }>;
  readonly artifacts: Readonly<{
    readonly manifest: string;
    readonly lock: string;
    readonly plan: string;
  }>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CreateStoreObjectOptions {
  readonly namespace?: string;
  readonly repository?: string;
  readonly revision?: string;
  readonly skill?: string;
  readonly description?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly symlinks?: Readonly<Record<string, string>>;
  readonly modifiedAt?: Date;
}

type UnknownRecord = Record<string, unknown>;

const encoder = new TextEncoder();

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

const byteCompare = (left: string, right: string): number =>
  Buffer.from(left).compare(Buffer.from(right));

const initializeProject = (path: string): void => {
  const product = Bun.spawnSync(['git', 'init', '--quiet'], {
    cwd: path,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (product.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(product.stderr));
  }
};

const collectObjectFacts = async (
  root: string,
): Promise<{ readonly contentHash: string; readonly logicalBytes: number }> => {
  const entries: Array<{ readonly path: string; readonly record: string; readonly bytes: number }> =
    [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split('\\').join('/');
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        entries.push({
          path: relativePath,
          record: `${relativePath}\0L\0${target}`,
          bytes: encoder.encode(target).byteLength,
        });
      } else if (stat.isFile()) {
        const bytes = new Uint8Array(await readFile(path));
        entries.push({
          path: relativePath,
          record: `${relativePath}\0F${(stat.mode & 0o100) === 0 ? '0' : '1'}\0${sha256(bytes)}`,
          bytes: bytes.byteLength,
        });
      }
    }
  };
  await visit(root);
  entries.sort((left, right) => byteCompare(left.path, right.path));
  return Object.freeze({
    contentHash: `sha256:${sha256(entries.map((entry) => entry.record).join('\n'))}`,
    logicalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  });
};

export const createGcFleet = async (): Promise<GcFleet> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-p5-gc-'));
  const home = join(root, 'home');
  const config = join(root, 'xdg', 'config');
  const cache = join(root, 'xdg', 'cache');
  const data = join(root, 'data');
  const current = join(root, 'current');
  const retired = join(root, 'retired');
  const missing = join(root, 'missing-project');
  await Promise.all(
    [home, config, cache, data, current, retired].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  initializeProject(current);
  initializeProject(retired);
  const canonicalCurrent = await realpath(current);
  const canonicalRetired = await realpath(retired);
  const artifacts = Object.freeze({
    manifest: join(canonicalRetired, 'skillsmith.toml'),
    lock: join(canonicalRetired, 'skillsmith.lock'),
    plan: join(canonicalRetired, '.skillsmith', 'plans', 'saved.json'),
  });
  await mkdir(dirname(artifacts.plan), { recursive: true });
  await Promise.all([
    writeFile(artifacts.manifest, `# ${GC_SECRET_CANARIES[1]}\nversion = 1\n`),
    writeFile(artifacts.lock, '{"version":1}\n'),
    writeFile(artifacts.plan, '{"kind":"skillsmith.plan","schemaVersion":1}\n'),
    writeFile(join(root, 'secret-canary.txt'), `${GC_SECRET_CANARIES[1]}\n`),
  ]);
  return Object.freeze({
    root,
    cwd: canonicalCurrent,
    home,
    data,
    store: join(data, 'store'),
    ledger: join(data, 'placements.json'),
    recovery: join(data, '.gc-recovery', 'v1'),
    projects: Object.freeze({
      current: canonicalCurrent,
      retired: canonicalRetired,
      missing,
    }),
    artifacts,
    env: Object.freeze({
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: join(root, 'xdg', 'data'),
      SKILLSMITH_HOME: data,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
      CI: '1',
      NO_COLOR: '1',
      P17_GC_TEST_CANARY: GC_SECRET_CANARIES[0],
    }),
  });
};

export const destroyGcFleet = async (fleet: GcFleet): Promise<void> => {
  await rm(fleet.root, { recursive: true, force: true });
};

export const spawnGcCli = (
  fleet: GcFleet,
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

export const runGcCli = async (
  fleet: GcFleet,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string | undefined>> = {},
): Promise<GcCliProduct> => {
  const child = spawnGcCli(fleet, args, extraEnv);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      Promise.race([
        child.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`CLI timed out: ${args.join(' ')}`)), 30_000);
        }),
      ]),
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return Object.freeze({ exitCode, stdout, stderr });
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const createStoreObject = async (
  fleet: GcFleet,
  options: CreateStoreObjectOptions = {},
): Promise<GcStoreObject> => {
  const namespace = options.namespace ?? 'fixture';
  const repository = options.repository ?? 'repository';
  const revision = options.revision ?? 'content-0123456789ab';
  const skill = options.skill ?? 'review';
  const path = join(fleet.store, namespace, `${repository}@${revision}`, skill);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${skill}\ndescription: ${options.description ?? 'GC fixture skill'}\n---\n`,
  );
  for (const [name, contents] of Object.entries(options.files ?? {})) {
    const target = join(path, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  for (const [name, target] of Object.entries(options.symlinks ?? {})) {
    const linkPath = join(path, name);
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(target, linkPath);
  }
  const modifiedAt = options.modifiedAt ?? new Date(Date.now() - 3_600_000);
  await utimes(path, modifiedAt, modifiedAt);
  const facts = await collectObjectFacts(path);
  return Object.freeze({
    path,
    namespace,
    repository,
    revision,
    skill,
    contentHash: facts.contentHash,
    logicalBytes: facts.logicalBytes,
    modifiedAt: modifiedAt.toISOString(),
  });
};

export const makeUnsafeHardLink = async (
  object: GcStoreObject,
  name = 'hard-link',
): Promise<void> => {
  await link(join(object.path, 'SKILL.md'), join(object.path, name));
};

export const setObjectModifiedAt = async (
  object: GcStoreObject,
  modifiedAt: Date,
): Promise<void> => {
  await utimes(object.path, modifiedAt, modifiedAt);
};

export const writeLedgerDocument = async (fleet: GcFleet, document: unknown): Promise<void> => {
  await mkdir(dirname(fleet.ledger), { recursive: true });
  await writeFile(fleet.ledger, `${JSON.stringify(document, null, 2)}\n`);
};

export const writeEmptyLedgerV1 = (fleet: GcFleet): Promise<void> =>
  writeLedgerDocument(fleet, {
    schemaVersion: 1,
    kind: 'skillsmith.placements',
    updatedAt: '2026-07-23T00:00:00.000Z',
    skills: {},
    projects: {},
  });

export const writeLedgerV2 = (
  fleet: GcFleet,
  fields: Readonly<{
    readonly skills?: UnknownRecord;
    readonly projects?: UnknownRecord;
    readonly projectRegistrations?: UnknownRecord;
    readonly transactions?: UnknownRecord;
    readonly history?: readonly unknown[];
  }> = {},
): Promise<void> =>
  writeLedgerDocument(fleet, {
    schemaVersion: 2,
    kind: 'skillsmith.placements',
    updatedAt: '2026-07-23T00:00:00.000Z',
    skills: fields.skills ?? {},
    projects: fields.projects ?? {},
    projectRegistrations: fields.projectRegistrations ?? {},
    transactions: fields.transactions ?? {},
    history: fields.history ?? [],
  });

export const pinnedPair = (placementPath: string, object: GcStoreObject): UnknownRecord => ({
  placementPath,
  mode: 'pinned',
  dev: null,
  pinned: {
    storePath: object.path,
    rev: object.revision.replace(/^(?:dirty-|content-)/, ''),
    gitSha: null,
    dirty: object.revision.startsWith('dirty-'),
    contentHash: object.contentHash,
    snapshotAt: object.modifiedAt,
    verify: 'passed',
    placement: 'symlink',
  },
  journal: null,
});

export const projectLedgerFields = (
  projectRoot: string,
  skill: string,
  tool: 'claude-code' | 'codex',
  pair: UnknownRecord,
  object: GcStoreObject,
): Readonly<{
  readonly projects: UnknownRecord;
  readonly projectRegistrations: UnknownRecord;
}> => ({
  projects: {
    [projectRoot]: { skills: { [skill]: { tools: { [tool]: pair } } } },
  },
  projectRegistrations: {
    [projectRoot]: {
      consumers: [
        {
          skill,
          tool,
          placementPath: pair.placementPath,
          store: { path: object.path, contentHash: object.contentHash },
        },
      ],
    },
  },
});

export const readLedgerText = (fleet: GcFleet): Promise<string> => readFile(fleet.ledger, 'utf8');

export const removeRetiredProject = async (fleet: GcFleet): Promise<void> => {
  await rm(fleet.projects.retired, { recursive: true, force: true });
};

const snapshotPath = async (root: string): Promise<readonly string[]> => {
  try {
    const rows: string[] = [];
    const visit = async (path: string): Promise<void> => {
      const stat = await lstat(path);
      const rel = relative(root, path).split('\\').join('/') || '.';
      if (stat.isSymbolicLink()) {
        rows.push(`${rel}:link:${await readlink(path)}`);
        return;
      }
      if (stat.isFile()) {
        rows.push(`${rel}:file:${sha256(new Uint8Array(await readFile(path)))}`);
        return;
      }
      rows.push(`${rel}:dir`);
      for (const name of (await readdir(path)).sort(byteCompare)) await visit(join(path, name));
    };
    await visit(root);
    return Object.freeze(rows);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
};

export const snapshotGcState = async (fleet: GcFleet): Promise<UnknownRecord> =>
  Object.freeze({
    data: await snapshotPath(fleet.data),
    retired: await snapshotPath(fleet.projects.retired),
  });

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};
