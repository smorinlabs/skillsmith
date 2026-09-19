import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { toolRegistry } from '../packages/core/src/agents/registry.ts';

const checkout = resolve(import.meta.dir, '..');
const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const within = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent + sep);
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};
const executable = async (path: string) => {
  const target = await realpath(path);
  if (!(await lstat(target)).isFile()) throw new Error(`not a regular executable: ${target}`);
  await access(target, constants.X_OK);
  return { path, realPath: target, sha256: sha256(await readFile(target)) };
};
interface NativeArtifact {
  url: string;
  sha256: string;
  bytes: number;
}
interface Tool {
  id: string;
  binary: string;
  package: string;
  version: string;
  provider?: 'npm' | 'native';
  artifacts?: Record<string, NativeArtifact>;
}
interface ProcessReceipt {
  label: string;
  argv: string[];
  environment: Record<string, string>;
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  launchCreated: boolean;
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cleanup: { term: boolean; kill: boolean; groupGone: boolean; closed: boolean };
  stdoutPath: string;
  stderrPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  error: string | null;
  errorCode: string | null;
}
interface PackageReceiptBase extends Tool {
  bindingPath: string;
  realPath: string;
  sha256: string;
  versionStdout: string;
  versionStderr: string;
  versionFirstLine: string;
}
interface NpmPackageReceipt extends PackageReceiptBase {
  packageJsonPath: string;
  packageJsonSha256: string;
}
interface NativePackageReceipt extends PackageReceiptBase {
  artifactUrl: string;
  artifactSha256: string;
  artifactBytes: number;
  artifactPlatform: string;
}
type PackageReceipt = NpmPackageReceipt | NativePackageReceipt;

export const install = async (args: string[]): Promise<void> => {
  if (args.length !== 2 || args[0] !== '--root' || !args[1]) {
    throw new Error('usage: bun scripts/install-ci-agent-tools.ts --root ABSOLUTE_NEW_ROOT');
  }
  const root = args[1];
  const home = await realpath(homedir());
  const repo = await realpath(checkout);
  if (
    !isAbsolute(root) ||
    root !== resolve(root) ||
    root === '/' ||
    within(root, home) ||
    within(root, repo) ||
    within(repo, root) ||
    ['/usr', '/bin', '/sbin', '/etc', '/opt'].some((tree) => within(tree, root))
  ) {
    throw new Error(`unsafe installer root: ${root}`);
  }
  const parent = await realpath(dirname(root));
  if (
    join(parent, basename(root)) !== root ||
    !(await lstat(parent)).isDirectory() ||
    (await exists(root))
  ) {
    throw new Error('installer root must be new, with an existing canonical parent');
  }
  const manifestBytes = await readFile(join(checkout, '.github/ci-agent-tools.json'));
  const manifest = JSON.parse(manifestBytes.toString()) as { schemaVersion: number; tools: Tool[] };
  const expected: Record<
    string,
    { binary: string; package: string; provider: 'npm' | 'native'; version: RegExp }
  > = {
    'claude-code': {
      binary: 'claude',
      package: '@anthropic-ai/claude-code',
      provider: 'npm',
      version: /^\d+\.\d+\.\d+$/,
    },
    codex: {
      binary: 'codex',
      package: '@openai/codex',
      provider: 'npm',
      version: /^\d+\.\d+\.\d+$/,
    },
    'kilo-code': {
      binary: 'kilo',
      package: '@kilocode/cli',
      provider: 'npm',
      version: /^\d+\.\d+\.\d+$/,
    },
    opencode: {
      binary: 'opencode',
      package: 'opencode-ai',
      provider: 'npm',
      version: /^\d+\.\d+\.\d+$/,
    },
    muse: {
      binary: 'muse',
      package: 'muse',
      provider: 'native',
      version: /^\d+\.\d+\.\d+-R\d+\.\d+$/,
    },
  };
  const nativePlatforms = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
  const validNative = (tool: Tool): boolean => {
    if (tool.provider !== 'native' || !tool.artifacts) return false;
    if (
      JSON.stringify(Object.keys(tool.artifacts).sort()) !==
      JSON.stringify([...nativePlatforms].sort())
    )
      return false;
    return nativePlatforms.every((platform) => {
      const artifact = tool.artifacts?.[platform];
      return (
        !!artifact &&
        artifact.url.startsWith('https://lookaside.facebook.com/lookaside/muse/download/') &&
        artifact.url.includes(`version=${tool.version}`) &&
        /^[0-9a-f]{64}$/.test(artifact.sha256) &&
        Number.isInteger(artifact.bytes) &&
        artifact.bytes > 0
      );
    });
  };
  if (
    manifest.schemaVersion !== 2 ||
    !Array.isArray(manifest.tools) ||
    JSON.stringify(manifest.tools.map((tool) => tool.id).sort()) !==
      JSON.stringify([...toolRegistry.ids].sort()) ||
    new Set(manifest.tools.map((tool) => tool.binary)).size !== manifest.tools.length ||
    manifest.tools.some((tool) => {
      const want = expected[tool.id];
      if (!want || want.binary !== tool.binary || want.package !== tool.package) return true;
      if (!want.version.test(tool.version)) return true;
      if ((tool.provider ?? 'npm') !== want.provider) return true;
      return want.provider === 'npm' ? tool.artifacts !== undefined : !validNative(tool);
    })
  ) {
    throw new Error(
      'agent manifest must match the five registry IDs and exact supported packages/versions',
    );
  }
  const hostPlatform = `${process.platform}-${process.arch}`;
  const nodeFound = Bun.which('node');
  const npmFound = Bun.which('npm');
  const gitFound = Bun.which('git');
  if (!nodeFound || !npmFound || !gitFound)
    throw new Error('Node, npm and Git are required before isolation');
  const node = await executable(nodeFound);
  const npm = await executable(npmFound);
  const git = await executable(gitFound);
  const bun = await executable(process.execPath);
  if (!npm.realPath.endsWith('/npm/bin/npm-cli.js'))
    throw new Error('npm must resolve to its JavaScript npm-cli.js launcher');
  const lockBefore = sha256(await readFile(join(checkout, 'bun.lock')));
  await mkdir(root, { mode: 0o700 }); // exclusive: no recursive creation or reuse
  const prefix = join(root, 'prefix');
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const processes: ProcessReceipt[] = [];
  const packages: PackageReceipt[] = [];
  const runtimes: Record<string, unknown> = { node, bootstrapNpm: npm, bun, git };
  let failure: unknown;
  let lockAfter: string | null = null;
  const run = async (
    label: string,
    argv: string[],
    env: Record<string, string>,
    deadlineMs: number,
  ) => {
    const began = Date.now();
    const stem = join(root, 'logs', `${processes.length + 1}-${label}`);
    const startChild = () =>
      spawn(argv[0] as string, argv.slice(1), {
        cwd: root,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let child: ReturnType<typeof startChild>;
    try {
      child = startChild();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = (error as NodeJS.ErrnoException).code ?? null;
      const diagnostic = `${errorCode ?? 'spawn-error'}: ${message}\n`;
      await writeFile(`${stem}.stdout`, '', { flag: 'wx' });
      await writeFile(`${stem}.stderr`, diagnostic, { flag: 'wx' });
      processes.push({
        label,
        argv,
        environment: env,
        cwd: root,
        startedAt: new Date(began).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - began,
        launchCreated: false,
        pid: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        cleanup: { term: false, kill: false, groupGone: true, closed: true },
        stdoutPath: `${stem}.stdout`,
        stderrPath: `${stem}.stderr`,
        stdoutSha256: sha256(''),
        stderrSha256: sha256(diagnostic),
        error: message,
        errorCode,
      });
      throw error;
    }
    let stdout = '';
    let stderr = '';
    let closed = false;
    let childError: Error | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const done = new Promise<void>((finish) => {
      child.once('error', (error) => {
        childError = error;
      });
      child.once('close', () => {
        closed = true;
        finish();
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
    const wait = async (ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      while ((!closed || alive()) && Date.now() < end) await Bun.sleep(25);
      return closed && !alive();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      done.then(() => false),
      new Promise<boolean>((finish) => {
        timer = setTimeout(() => finish(true), deadlineMs);
      }),
    ]);
    clearTimeout(timer);
    const cleanup = { term: false, kill: false, groupGone: false, closed };
    if (timedOut || alive()) {
      if (alive() && child.pid !== undefined) {
        process.kill(-child.pid, 'SIGTERM');
        cleanup.term = true;
      }
      if (!(await wait(10_000))) {
        if (alive() && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
          cleanup.kill = true;
        }
        await wait(5_000);
      }
    }
    cleanup.closed = closed;
    cleanup.groupGone = !alive();
    if (!closed) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    await writeFile(`${stem}.stdout`, stdout, { flag: 'wx' });
    await writeFile(`${stem}.stderr`, stderr, { flag: 'wx' });
    const receipt: ProcessReceipt = {
      label,
      argv,
      environment: env,
      cwd: root,
      startedAt: new Date(began).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - began,
      launchCreated: child.pid !== undefined,
      pid: child.pid ?? null,
      exitCode: child.exitCode,
      signal: child.signalCode,
      timedOut,
      cleanup,
      stdoutPath: `${stem}.stdout`,
      stderrPath: `${stem}.stderr`,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      error: childError?.message ?? null,
      errorCode: (childError as NodeJS.ErrnoException | undefined)?.code ?? null,
    };
    processes.push(receipt);
    if (
      childError ||
      timedOut ||
      !closed ||
      !cleanup.groupGone ||
      cleanup.term ||
      child.exitCode !== 0
    ) {
      throw new Error(
        `preparation failed: ${label}; exit=${child.exitCode}, timeout=${timedOut}, cleanup=${JSON.stringify(cleanup)}; ${stem}`,
      );
    }
    return { stdout, stderr };
  };
  try {
    for (const name of ['bootstrap', 'prefix', 'bin', 'home', 'config', 'cache', 'tmp', 'logs'])
      await mkdir(join(root, name));
    for (const name of ['user.npmrc', 'global.npmrc'])
      await writeFile(join(root, name), '', { flag: 'wx' });
    await symlink(node.realPath, join(root, 'bin/node'));
    await symlink(npm.realPath, join(root, 'bin/npm'));
    const env: Record<string, string> = {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'home/data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      TMPDIR: join(root, 'tmp'),
      NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(root, 'global.npmrc'),
      NPM_CONFIG_CACHE: join(root, 'cache'),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      CI: '1',
      NO_COLOR: '1',
    };
    const nodeVersion = (
      await run('node-version', [node.realPath, '--version'], env, 30_000)
    ).stdout.trim();
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
    if (!match) throw new Error(`unrecognized Node version: ${nodeVersion}`);
    const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
    if (
      !(
        major >= 26 ||
        (major === 24 && minor >= 15) ||
        (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)))
      )
    ) {
      throw new Error(
        `Node ${nodeVersion} does not satisfy npm 12.0.1 engines ^22.22.2 || ^24.15.0 || >=26.0.0`,
      );
    }
    runtimes.node = { ...node, version: nodeVersion };
    runtimes.bootstrapNpm = {
      ...npm,
      version: (
        await run('bootstrap-npm-version', [node.realPath, npm.realPath, '--version'], env, 30_000)
      ).stdout.trim(),
    };
    runtimes.bun = {
      ...bun,
      version: (await run('bun-version', [bun.realPath, '--version'], env, 30_000)).stdout.trim(),
    };
    await run(
      'bootstrap-npm',
      [
        node.realPath,
        npm.realPath,
        'install',
        '--global',
        '--prefix',
        join(root, 'bootstrap'),
        '--cache',
        join(root, 'cache'),
        '--registry=https://registry.npmjs.org/',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        'npm@12.0.1',
      ],
      env,
      120_000,
    );
    const npmJs = join(root, 'bootstrap/lib/node_modules/npm/bin/npm-cli.js');
    if (!within(join(root, 'bootstrap'), await realpath(npmJs)))
      throw new Error('bootstrapped npm escaped its owned root');
    const pinnedVersion = (
      await run('pinned-npm-version', [node.realPath, npmJs, '--version'], env, 30_000)
    ).stdout.trim();
    if (pinnedVersion !== '12.0.1')
      throw new Error(`unexpected pinned npm version: ${pinnedVersion}`);
    runtimes.pinnedNpm = {
      path: npmJs,
      sha256: sha256(await readFile(npmJs)),
      version: pinnedVersion,
    };
    await unlink(join(root, 'bin/npm'));
    await symlink(npmJs, join(root, 'bin/npm'));
    await run(
      'agent-install',
      [
        node.realPath,
        npmJs,
        'install',
        '--global',
        '--prefix',
        prefix,
        '--cache',
        join(root, 'cache'),
        '--registry=https://registry.npmjs.org/',
        '--no-audit',
        '--no-fund',
        '--include=optional',
        '--ignore-scripts=false',
        '--allow-scripts=@anthropic-ai/claude-code,@kilocode/cli,opencode-ai',
        ...manifest.tools
          .filter((tool) => (tool.provider ?? 'npm') === 'npm')
          .map((tool) => `${tool.package}@${tool.version}`),
      ],
      env,
      900_000,
    );
    await mkdir(join(prefix, 'bin'), { recursive: true });
    for (const tool of manifest.tools.filter((candidate) => candidate.provider === 'native')) {
      const artifact = tool.artifacts?.[hostPlatform];
      if (!artifact) throw new Error(`no native ${tool.id} artifact for ${hostPlatform}`);
      const response = await fetch(artifact.url, { signal: AbortSignal.timeout(900_000) });
      if (!response.ok)
        throw new Error(`native ${tool.id} download failed: HTTP ${response.status}`);
      const payload = new Uint8Array(await response.arrayBuffer());
      if (payload.byteLength !== artifact.bytes)
        throw new Error(
          `native ${tool.id} size mismatch: observed ${payload.byteLength}, pinned ${artifact.bytes}`,
        );
      if (sha256(payload) !== artifact.sha256)
        throw new Error(`native ${tool.id} checksum mismatch`);
      await writeFile(join(prefix, 'bin', tool.binary), payload, { flag: 'wx', mode: 0o755 });
    }
    await unlink(join(root, 'bin/npm'));
    await symlink(git.realPath, join(root, 'bin/git'));
    await writeFile(join(root, 'config/gitconfig'), '', { flag: 'wx' });
    const versionEnv: Record<string, string> = {
      PATH: join(root, 'bin'),
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'home/data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      SKILLSMITH_HOME: join(root, 'home/data/skillsmith'),
      TMPDIR: join(root, 'tmp'),
      GIT_CONFIG_GLOBAL: join(root, 'config/gitconfig'),
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      CI: '1',
      NO_COLOR: '1',
    };
    for (const tool of manifest.tools)
      await symlink(join(prefix, 'bin', tool.binary), join(root, 'bin', tool.binary));
    for (const tool of manifest.tools) {
      if (tool.provider === 'native') {
        const artifact = tool.artifacts?.[hostPlatform];
        if (!artifact) throw new Error(`no native ${tool.id} artifact for ${hostPlatform}`);
        const binding = await executable(join(prefix, 'bin', tool.binary));
        if (!within(prefix, binding.realPath))
          throw new Error(`executable escapes prefix: ${tool.id}`);
        if (binding.sha256 !== artifact.sha256)
          throw new Error(`native executable checksum mismatch: ${tool.id}`);
        const version = await run(
          `${tool.binary}-version`,
          [join(root, 'bin', tool.binary), '--version'],
          { ...versionEnv, MUSE_NO_AUTO_UPDATE: '1' },
          30_000,
        );
        if (
          !new RegExp(
            `(?:^|[^0-9A-Za-z.])${tool.version.replaceAll('.', '\\.')}($|[^0-9A-Za-z.])`,
          ).test(version.stdout)
        )
          throw new Error(`wrong direct version: ${tool.id}`);
        const firstLine = version.stdout.trim().split(/\r?\n/)[0];
        if (!firstLine) throw new Error(`empty direct version: ${tool.id}`);
        packages.push({
          ...tool,
          bindingPath: binding.path,
          realPath: binding.realPath,
          sha256: binding.sha256,
          artifactUrl: artifact.url,
          artifactSha256: artifact.sha256,
          artifactBytes: artifact.bytes,
          artifactPlatform: hostPlatform,
          versionStdout: version.stdout,
          versionStderr: version.stderr,
          versionFirstLine: firstLine,
        });
        continue;
      }
      const packageJsonPath = join(prefix, 'lib/node_modules', tool.package, 'package.json');
      if (!within(prefix, await realpath(packageJsonPath)))
        throw new Error(`package metadata escapes prefix: ${tool.id}`);
      const bytes = await readFile(packageJsonPath);
      const metadata = JSON.parse(bytes.toString()) as { name: string; version: string };
      if (metadata.name !== tool.package || metadata.version !== tool.version)
        throw new Error(`package metadata mismatch: ${tool.id}`);
      const binding = await executable(join(prefix, 'bin', tool.binary));
      if (!within(prefix, binding.realPath))
        throw new Error(`executable escapes prefix: ${tool.id}`);
      const version = await run(
        `${tool.binary}-version`,
        [join(root, 'bin', tool.binary), '--version'],
        versionEnv,
        30_000,
      );
      if (
        !new RegExp(
          `(?:^|[^0-9A-Za-z.])${tool.version.replaceAll('.', '\\.')}($|[^0-9A-Za-z.])`,
        ).test(version.stdout)
      )
        throw new Error(`wrong direct version: ${tool.id}`);
      const firstLine = version.stdout.trim().split(/\r?\n/)[0];
      if (!firstLine) throw new Error(`empty direct version: ${tool.id}`);
      packages.push({
        ...tool,
        packageJsonPath,
        packageJsonSha256: sha256(bytes),
        bindingPath: binding.path,
        realPath: binding.realPath,
        sha256: binding.sha256,
        versionStdout: version.stdout,
        versionStderr: version.stderr,
        versionFirstLine: firstLine,
      });
    }
  } catch (error) {
    failure = error;
  }
  try {
    lockAfter = sha256(await readFile(join(checkout, 'bun.lock')));
    if (lockAfter !== lockBefore)
      throw new Error('repository lockfile changed during external tool preparation');
  } catch (error) {
    failure ??= error;
  }
  const receipt = {
    schemaVersion: 2,
    status: failure ? 'preparation-failed' : 'success',
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    os: process.platform,
    architecture: process.arch,
    manifestSha256: sha256(manifestBytes),
    root,
    prefix,
    runtimes,
    processes,
    packages,
    repositoryLock: {
      path: join(checkout, 'bun.lock'),
      beforeSha256: lockBefore,
      afterSha256: lockAfter,
    },
    error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
  };
  await writeFile(join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      status: receipt.status,
      receipt: join(root, 'receipt.json'),
      packages: packages.map(({ id, version }) => ({ id, version })),
      error: receipt.error,
    }),
  );
  if (failure) throw failure;
};

if (import.meta.main) {
  try {
    await install(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
