import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../../packages/cli/tests/fixtures/cli.ts';
import { hashManifestSemantics } from '../../../../packages/core/src/artifacts/hash.ts';
import {
  type PortableLockV1,
  serializePortableLock,
} from '../../../../packages/core/src/artifacts/lock.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../../packages/core/src/artifacts/manifest.ts';
import {
  hashSourceContentV1,
  projectSourceContent,
} from '../../../../packages/core/src/artifacts/source-content.ts';
import { defaultRuntimePorts } from '../../../../packages/core/src/ports/default.ts';
import type { RemoteFixture } from '../../../../packages/core/tests/fixtures/acquire/remote.ts';
import {
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../../packages/core/tests/fixtures/acquire/remote.ts';
import { hermeticGitEnv, runGit } from '../../../../packages/core/tests/fixtures/git-env.ts';

export const UPDATE_SECRET_CANARIES = Object.freeze([
  'P17_SECRET_CANARY_UPDATE_ENV',
  'P17_SECRET_CANARY_UPDATE_FILE',
] as const);

export interface UpdateCliProduct {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface UpdateFleet {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly data: string;
  readonly manifest: string;
  readonly lock: string;
  readonly ledger: string;
  readonly store: string;
  readonly remote: RemoteFixture & { readonly updateHead: string };
  readonly live: {
    readonly codex: string;
    readonly claude: string;
  };
  readonly env: Readonly<Record<string, string | undefined>>;
}

const movingName = 'factor-scan';
const movingSource = 'fixture.invalid/acme/multi//plugins/fh/skills/factor-scan';
const movingSourcePath = 'plugins/fh/skills/factor-scan';
const fixedName = 'review';
const fixedSource = 'fixture.invalid/acme/multi//plugins/web/skills/review';
const fixedSourcePath = 'plugins/web/skills/review';

const hashContentAt = async (path: string) => {
  const projection = await projectSourceContent(await defaultRuntimePorts(), path);
  if (!projection.ok) throw new Error(projection.error.message);
  const hash = hashSourceContentV1(projection.value);
  if (!hash.ok) throw new Error(hash.error.message);
  return hash.value;
};

const manifestSource = (): string =>
  `${[
    '# P17 G5-02 hermetic update fixture',
    'version = 1',
    '',
    '[[skills]]',
    `name = "${movingName}"`,
    `source = "${movingSource}"`,
    'ref = "main"',
    'tools = ["claude-code", "codex"]',
    'scope = "project"',
    'placement = "copy"',
    '',
    '[[skills]]',
    `name = "${fixedName}"`,
    `source = "${fixedSource}"`,
    'ref = "v1.0.0"',
    'tools = ["codex"]',
    'scope = "project"',
    'placement = "copy"',
    '',
  ].join('\n')}\n`;

const lockSource = async (remote: RemoteFixture, manifest: string): Promise<string> => {
  const document = readManifestSource(manifest);
  if (!document.ok) throw new Error(document.error.message);
  const normalized = normalizeManifestDocument(document.value);
  if (!normalized.ok) throw new Error(normalized.error.message);
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(normalized.value),
    skills: [
      {
        name: movingName,
        source: movingSource,
        requestedRef: 'main',
        resolvedSha: remote.multiHead,
        sourcePath: movingSourcePath,
        contentHash: await hashContentAt(join(remote.multiWork, movingSourcePath)),
      },
      {
        name: fixedName,
        source: fixedSource,
        requestedRef: 'v1.0.0',
        resolvedSha: remote.multiTagSha,
        sourcePath: fixedSourcePath,
        contentHash: await hashContentAt(join(remote.multiWork, fixedSourcePath)),
      },
    ],
  };
  const encoded = serializePortableLock(lock);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value;
};

export const createUpdateFleet = async (): Promise<UpdateFleet> => {
  const [root, remote] = await Promise.all([
    mkdtemp(join(tmpdir(), 'skillsmith-p5-update-')),
    buildRemoteFixture(),
  ]);
  try {
    const cwd = join(root, 'project');
    const home = join(root, 'home');
    const config = join(root, 'xdg', 'config');
    const data = join(root, 'xdg', 'data');
    const cache = join(root, 'xdg', 'cache');
    await Promise.all(
      [cwd, home, config, data, cache].map((path) => mkdir(path, { recursive: true })),
    );
    runGit(cwd, ['init', '--quiet']);

    const manifest = join(cwd, 'skillsmith.toml');
    const lock = join(cwd, 'skillsmith.lock');
    const source = manifestSource();
    const serializedLock = await lockSource(remote, source);
    const live = Object.freeze({
      codex: join(cwd, '.agents', 'skills', movingName),
      claude: join(cwd, '.claude', 'skills', movingName),
    });
    await Promise.all([
      writeFile(manifest, source),
      writeFile(lock, serializedLock),
      cp(join(remote.multiWork, movingSourcePath), live.codex, { recursive: true }),
      cp(join(remote.multiWork, movingSourcePath), live.claude, { recursive: true }),
      writeFile(join(root, 'canary.txt'), `${UPDATE_SECRET_CANARIES[1]}\n`),
    ]);

    await writeFile(
      join(remote.multiWork, movingSourcePath, 'SKILL.md'),
      '---\nname: factor-scan\ndescription: updated fixture candidate\n---\n\n# candidate\n',
    );
    runGit(remote.multiWork, ['add', '-A']);
    runGit(remote.multiWork, [
      '-c',
      'user.email=fixture@skillsmith.test',
      '-c',
      'user.name=fixture',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture: update candidate',
    ]);
    const updateHead = runGit(remote.multiWork, ['rev-parse', 'HEAD']).trim();
    runGit(remote.multiWork, ['push', '--quiet', remote.multiUrl, 'main:main']);

    const skillsmithHome = join(data, 'skillsmith');
    return Object.freeze({
      root,
      cwd,
      home,
      data,
      manifest,
      lock,
      ledger: join(skillsmithHome, 'placements.json'),
      store: join(skillsmithHome, 'store'),
      remote: Object.freeze({ ...remote, updateHead }),
      live,
      env: Object.freeze(
        hermeticGitEnv({
          ...remote.gitRewriteEnv,
          HOME: home,
          XDG_CONFIG_HOME: config,
          XDG_DATA_HOME: data,
          XDG_CACHE_HOME: cache,
          SKILLSMITH_HOME: skillsmithHome,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CODEX_HOME: join(home, '.codex'),
          SKILLSMITH_CONFIG: undefined,
          SKILLSMITH_TOOL: undefined,
          SKILLSMITH_SCOPE: undefined,
          SKILLSMITH_PATH: undefined,
          P17_UPDATE_TEST_CANARY: UPDATE_SECRET_CANARIES[0],
          CI: '1',
          NO_COLOR: '1',
        }),
      ),
    });
  } catch (error) {
    await Promise.all([rm(root, { recursive: true, force: true }), destroyRemoteFixture(remote)]);
    throw error;
  }
};

export const destroyUpdateFleet = async (fleet: UpdateFleet): Promise<void> => {
  await Promise.all([
    rm(fleet.root, { recursive: true, force: true }),
    destroyRemoteFixture(fleet.remote),
  ]);
};

export const runUpdateCli = async (
  fleet: UpdateFleet,
  args: readonly string[],
): Promise<UpdateCliProduct> => {
  const child = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
    cwd: fleet.cwd,
    env: fleet.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return Object.freeze({ exitCode, stdout, stderr });
};

export const snapshotUpdateState = async (
  fleet: UpdateFleet,
): Promise<Readonly<Record<string, Uint8Array | null>>> => {
  const snapshot = async (path: string): Promise<Uint8Array | null> =>
    Bun.file(path)
      .exists()
      .then((exists) => (exists ? readFile(path) : null));
  return Object.freeze({
    manifest: await snapshot(fleet.manifest),
    lock: await snapshot(fleet.lock),
    ledger: await snapshot(fleet.ledger),
    codex: await snapshot(join(fleet.live.codex, 'SKILL.md')),
    claude: await snapshot(join(fleet.live.claude, 'SKILL.md')),
  });
};
