import { lstat, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { recoverArtifactPair } from '../../../../packages/core/src/artifacts/coordinator.ts';
import {
  type PortableLockV1,
  readPortableLockSource,
  serializePortableLock,
} from '../../../../packages/core/src/artifacts/lock.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../../packages/core/src/artifacts/node-coordinator.ts';
import { resolveLedgerArtifactCodec } from '../../../../packages/core/src/artifacts/registry.ts';
import {
  hashSourceContentV1,
  projectSourceContent,
} from '../../../../packages/core/src/artifacts/source-content.ts';
import { readLedgerState } from '../../../../packages/core/src/place/ledger.ts';
import { defaultRuntimePorts } from '../../../../packages/core/src/ports/default.ts';
import {
  type ApplyFixture,
  type RemoteApplyFixture,
  createApplyFixture,
  createRemoteApplyFixture,
  destroyApplyFixture,
  destroyRemoteApplyFixture,
  runApplyCli,
} from '../p4b-apply/cases.ts';

export const STRICT_WHOLE_PAIR_CASES = Object.freeze([
  'unbounded',
  'bounded-tool',
  'bounded-scope',
  'filter-to-zero',
] as const);

export const SUPPORTED_REPRODUCTION_PLATFORMS = Object.freeze(['darwin', 'linux'] as const);

export const POLICY_SECRET_CANARIES = Object.freeze([
  'P17_G4B03_AUTH_CANARY',
  'P17_G4B03_OUTPUT_CANARY',
] as const);

export interface IncompleteWholePairFixture {
  readonly fixture: ApplyFixture;
  readonly omittedName: 'beta';
  readonly beforeLock: PortableLockV1;
}

type JsonRecord = Record<string, unknown>;

export interface CrossMachineFixture {
  readonly machineA: RemoteApplyFixture;
  readonly machineB: ApplyFixture;
  readonly exported: {
    readonly manifest: string;
    readonly lock: string;
  };
  readonly copied: {
    readonly manifest: string;
    readonly lock: string;
    readonly siblingLock: string;
  };
}

export interface CrossMachineResult {
  readonly fixture: CrossMachineFixture;
  readonly reports: {
    readonly machineASeed: JsonRecord;
    readonly exportPreview: JsonRecord;
    readonly exportApply: JsonRecord;
    readonly machineBPlan: JsonRecord;
    readonly machineBApply: JsonRecord;
    readonly machineBConverged: JsonRecord;
    readonly machineBSiblingPlan: JsonRecord;
  };
  readonly pairBytes: {
    readonly manifest: Uint8Array;
    readonly lock: Uint8Array;
  };
  readonly contentHashes: {
    readonly machineA: string;
    readonly machineB: string;
  };
  readonly machineBLedgerWasAbsent: boolean;
  readonly exportPreviewWasNonMutating: boolean;
}

export interface PoisonedNoSaveExportResult {
  readonly fixture: RemoteApplyFixture;
  readonly reports: {
    readonly install: JsonRecord;
    readonly export: JsonRecord;
  };
  readonly paths: {
    readonly store: string;
    readonly manifest: string;
    readonly lock: string;
  };
}

export type ApplyCrashTarget = 'artifact-manifest' | 'artifact-lock' | 'ledger' | 'live' | 'none';

export interface ApplyCrashRunResult {
  readonly fixture: ApplyFixture;
  readonly coordinationRoot: string;
  readonly message: JsonRecord;
}

const APPLY_CRASH_CHILD = join(import.meta.dir, 'apply-crash-child.ts');

const asJsonReport = (
  product: Awaited<ReturnType<typeof runApplyCli>>,
  label: string,
): JsonRecord => {
  if (product.exitCode !== 0) {
    throw new Error(
      `${label}: expected exit 0, received ${product.exitCode}\nstderr:\n${product.stderr}\nstdout:\n${product.stdout}`,
    );
  }
  const parsed: unknown = JSON.parse(product.stdout);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: stdout was not one JSON object`);
  }
  return parsed as JsonRecord;
};

const gitConfigSource = (fixture: RemoteApplyFixture): string =>
  [
    `[url "${fixture.remote.singleUrl}"]`,
    `\tinsteadOf = ${fixture.remote.singleSource}`,
    `[url "${fixture.remote.multiUrl}"]`,
    `\tinsteadOf = ${fixture.remote.multiSource}`,
    `[url "${fixture.remote.rootUrl}"]`,
    `\tinsteadOf = ${fixture.remote.rootSource}`,
    '[protocol "file"]',
    '\tallow = always',
    '',
  ].join('\n');

export const createCrossMachineFixture = async (): Promise<CrossMachineFixture> => {
  const machineA = await createRemoteApplyFixture();
  try {
    const baseB = await createApplyFixture([], { writeLock: false });
    try {
      const gitConfig = join(baseB.root, 'gitconfig');
      await writeFile(gitConfig, gitConfigSource(machineA), { mode: 0o600 });
      const machineB: ApplyFixture = Object.freeze({
        ...baseB,
        env: Object.freeze({
          ...baseB.env,
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_ALLOW_PROTOCOL: 'file:https',
        }),
      });
      return Object.freeze({
        machineA,
        machineB,
        exported: Object.freeze({
          manifest: join(machineA.cwd, 'portable', 'team.toml'),
          lock: join(machineA.cwd, 'overrides', 'team.lock'),
        }),
        copied: Object.freeze({
          manifest: join(machineB.cwd, 'portable', 'team.toml'),
          lock: join(machineB.cwd, 'overrides', 'team.lock'),
          siblingLock: join(machineB.cwd, 'portable', 'team.lock'),
        }),
      });
    } catch (error) {
      await destroyApplyFixture(baseB);
      throw error;
    }
  } catch (error) {
    await destroyRemoteApplyFixture(machineA);
    throw error;
  }
};

export const destroyCrossMachineFixture = async (fixture: CrossMachineFixture): Promise<void> => {
  await Promise.all([
    destroyRemoteApplyFixture(fixture.machineA),
    destroyApplyFixture(fixture.machineB),
  ]);
};

export const contentHashAt = async (
  path: string,
  platform?: 'darwin' | 'linux',
): Promise<string> => {
  const base = await defaultRuntimePorts();
  const projected = await projectSourceContent(
    platform === undefined ? base : { ...base, platform },
    path,
  );
  if (!projected.ok) throw new Error(projected.error.message);
  const hashed = hashSourceContentV1(projected.value);
  if (!hashed.ok) throw new Error(hashed.error.message);
  return hashed.value;
};

export const runCrossMachineReproduction = async (): Promise<CrossMachineResult> => {
  const fixture = await createCrossMachineFixture();
  try {
    const machineASeed = asJsonReport(
      await runApplyCli(fixture.machineA, [
        'install',
        fixture.machineA.skill.source,
        '--tool',
        'codex',
        '--user',
        '--no-save',
        '--no-verify',
        '--direct',
        '--json',
      ]),
      'Machine A managed seed',
    );
    await Promise.all([
      mkdir(dirname(fixture.exported.manifest), { recursive: true }),
      mkdir(dirname(fixture.exported.lock), { recursive: true }),
    ]);
    const exportArgs = [
      'export',
      '--user',
      '--tool',
      'codex',
      '--file',
      fixture.exported.manifest,
      '--lockfile',
      fixture.exported.lock,
      '--json',
    ] as const;
    const exportPreview = asJsonReport(
      await runApplyCli(fixture.machineA, [...exportArgs.slice(0, -1), '--dry-run', '--json']),
      'Machine A export preview',
    );
    const exportPreviewWasNonMutating =
      !(await Bun.file(fixture.exported.manifest).exists()) &&
      !(await Bun.file(fixture.exported.lock).exists());
    const exportApply = asJsonReport(
      await runApplyCli(fixture.machineA, exportArgs),
      'Machine A export',
    );
    const pairBytes = Object.freeze({
      manifest: new Uint8Array(await readFile(fixture.exported.manifest)),
      lock: new Uint8Array(await readFile(fixture.exported.lock)),
    });
    await Promise.all([
      mkdir(join(fixture.machineB.cwd, 'portable'), { recursive: true }),
      mkdir(join(fixture.machineB.cwd, 'overrides'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(fixture.copied.manifest, pairBytes.manifest, { mode: 0o600 }),
      writeFile(fixture.copied.lock, pairBytes.lock, { mode: 0o600 }),
      writeFile(fixture.copied.siblingLock, pairBytes.lock, { mode: 0o600 }),
    ]);
    const machineBLedgerWasAbsent = !(await Bun.file(fixture.machineB.ledger).exists());
    const machineBPlan = asJsonReport(
      await runApplyCli(fixture.machineB, [
        'plan',
        '--file',
        fixture.copied.manifest,
        '--lockfile',
        fixture.copied.lock,
        '--locked',
        '--out',
        fixture.machineB.plan,
        '--json',
      ]),
      'Machine B locked plan',
    );
    const machineBApply = asJsonReport(
      await runApplyCli(fixture.machineB, ['apply', '--plan', fixture.machineB.plan, '--json']),
      'Machine B locked apply',
    );
    const machineBConverged = asJsonReport(
      await runApplyCli(fixture.machineB, [
        'plan',
        '--file',
        fixture.copied.manifest,
        '--lockfile',
        fixture.copied.lock,
        '--locked',
        '--json',
      ]),
      'Machine B converged locked plan',
    );
    const machineBSiblingPlan = asJsonReport(
      await runApplyCli(fixture.machineB, [
        'plan',
        '--file',
        fixture.copied.manifest,
        '--locked',
        '--json',
      ]),
      'Machine B sibling locked plan',
    );
    return Object.freeze({
      fixture,
      reports: Object.freeze({
        machineASeed,
        exportPreview,
        exportApply,
        machineBPlan,
        machineBApply,
        machineBConverged,
        machineBSiblingPlan,
      }),
      pairBytes,
      contentHashes: Object.freeze({
        machineA: await contentHashAt(fixture.machineA.skill.livePath),
        machineB: await contentHashAt(
          join(fixture.machineB.live.user, fixture.machineA.skill.name),
        ),
      }),
      machineBLedgerWasAbsent,
      exportPreviewWasNonMutating,
    });
  } catch (error) {
    await destroyCrossMachineFixture(fixture);
    throw error;
  }
};

export const runPoisonedNoSaveExport = async (): Promise<PoisonedNoSaveExportResult> => {
  const fixture = await createRemoteApplyFixture();
  try {
    const store = join(
      fixture.store,
      'acme',
      `single@${fixture.remote.singleHead.slice(0, 12)}`,
      fixture.skill.name,
    );
    await mkdir(store, { recursive: true });
    await writeFile(
      join(store, 'SKILL.md'),
      '---\nname: lint\ndescription: poisoned historical store entry\n---\n',
    );
    const install = asJsonReport(
      await runApplyCli(fixture, [
        'install',
        fixture.skill.source,
        '--tool',
        'codex',
        '--user',
        '--no-save',
        '--no-verify',
        '--direct',
        '--json',
      ]),
      'poisoned no-save install',
    );
    const manifest = join(fixture.cwd, 'poisoned-export', 'team.toml');
    const lock = join(fixture.cwd, 'poisoned-export', 'team.lock');
    await mkdir(dirname(manifest), { recursive: true });
    const exported = asJsonReport(
      await runApplyCli(fixture, [
        'export',
        '--user',
        '--tool',
        'codex',
        '--file',
        manifest,
        '--lockfile',
        lock,
        '--json',
      ]),
      'poisoned managed export',
    );
    return Object.freeze({
      fixture,
      reports: Object.freeze({ install, export: exported }),
      paths: Object.freeze({ store, manifest, lock }),
    });
  } catch (error) {
    await destroyRemoteApplyFixture(fixture);
    throw error;
  }
};

export const destroyPoisonedNoSaveExport = async (
  selected: PoisonedNoSaveExportResult,
): Promise<void> => destroyRemoteApplyFixture(selected.fixture);

const readChildLine = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { source: string },
): Promise<JsonRecord> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('G4B-03 crash child timed out')), 20_000);
  });
  const next = async (): Promise<JsonRecord> => {
    while (!state.source.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('G4B-03 crash child exited before its result');
      state.source += new TextDecoder().decode(chunk.value, { stream: true });
    }
    const newline = state.source.indexOf('\n');
    const line = state.source.slice(0, newline);
    state.source = state.source.slice(newline + 1);
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('G4B-03 crash child emitted a non-object');
    }
    return parsed as JsonRecord;
  };
  try {
    return await Promise.race([next(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const runApplyCrashChild = async (
  fixture: ApplyFixture,
  target: ApplyCrashTarget,
  coordinationRoot = join(fixture.root, 'g4b03-coordination'),
): Promise<ApplyCrashRunResult> => {
  const child = Bun.spawn([process.execPath, APPLY_CRASH_CHILD], {
    cwd: fixture.cwd,
    env: fixture.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({
      kind: 'start',
      target,
      root: fixture.root,
      cwd: fixture.cwd,
      home: fixture.home,
      config: fixture.config,
      data: fixture.skillsmithHome,
      cache: fixture.cache,
      manifest: fixture.manifest,
      lock: fixture.lock,
      coordinationRoot,
    })}\n`,
  );
  child.stdin.end();
  const reader = child.stdout.getReader();
  const state = { source: '' };
  try {
    const ready = await readChildLine(reader, state);
    if (ready.kind !== 'ready')
      throw new Error(`G4B-03 child was not ready: ${JSON.stringify(ready)}`);
    const message = await readChildLine(reader, state);
    if (target === 'none') {
      if (message.kind !== 'result') {
        throw new Error(`G4B-03 child did not return a result: ${JSON.stringify(message)}`);
      }
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(`G4B-03 clean child exited ${exitCode}`);
      return Object.freeze({ fixture, coordinationRoot, message });
    }
    if (message.kind !== 'reached' || message.target !== target) {
      throw new Error(`G4B-03 child missed ${target}: ${JSON.stringify(message)}`);
    }
    child.kill('SIGKILL');
    const exitCode = await child.exited;
    if (exitCode === 0) throw new Error(`G4B-03 crash child exited cleanly at ${target}`);
    return Object.freeze({ fixture, coordinationRoot, message });
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited.catch(() => undefined);
    const stderr = await new Response(child.stderr).text().catch(() => '');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  } finally {
    reader.releaseLock();
    child.unref();
  }
};

const ageDirectories = async (path: string): Promise<void> => {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  for (const entry of await readdir(path)) await ageDirectories(join(path, entry));
  const expired = new Date(0);
  await utimes(path, expired, expired);
};

export const expireApplyCrashLocks = async (selected: ApplyCrashRunResult): Promise<void> => {
  await Promise.all([
    ageDirectories(selected.coordinationRoot),
    ageDirectories(`${selected.fixture.ledger}.lock`),
  ]);
};

export const replacePendingApplyOperationId = async (
  selected: ApplyCrashRunResult,
): Promise<string> => {
  const ports = await defaultRuntimePorts();
  const state = await readLedgerState(ports, selected.fixture.ledger);
  if (!state.ok || state.value.state !== 'present') {
    throw new Error('G4B-03 pending ledger is unavailable');
  }
  const replacement = `operation:v1:${'f'.repeat(64)}`;
  let replaced = false;
  const transactions = Object.fromEntries(
    Object.entries(state.value.model.transactions).map(([transactionId, journal]) => {
      if (replaced || journal.disposition !== 'forward') return [transactionId, journal];
      replaced = true;
      return [
        transactionId,
        {
          ...journal,
          intent: { ...journal.intent, operationId: replacement },
          context: { ...journal.context, parentOperationId: replacement },
        },
      ];
    }),
  );
  if (!replaced) throw new Error('G4B-03 pending transaction is unavailable');
  const encoded = resolveLedgerArtifactCodec(2).encode({
    ...state.value.model,
    transactions,
  });
  if (!encoded.ok)
    throw new Error(`G4B-03 pending ledger mutation failed: ${encoded.error.reason}`);
  await writeFile(selected.fixture.ledger, encoded.value);
  return replacement;
};

export const recoverApplyArtifactCrash = async (
  selected: ApplyCrashRunResult,
): Promise<'clean' | 'rolled-back' | 'finalized'> => {
  await expireApplyCrashLocks(selected);
  const coordinator = await createTestNodeArtifactCoordinatorPorts(selected.coordinationRoot);
  const result = await recoverArtifactPair(
    coordinator,
    {
      file: {
        token: selected.fixture.manifest,
        path: selected.fixture.manifest,
        portability: 'machine-bound',
        portableToken: null,
      },
      lockfile: {
        token: selected.fixture.lock,
        path: selected.fixture.lock,
        portability: 'machine-bound',
        portableToken: null,
      },
      lockfileSource: 'explicit',
    },
    'rollback',
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

export const collectResiduePaths = async (root: string): Promise<readonly string[]> => {
  const output: string[] = [];
  const visit = async (path: string): Promise<void> => {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    for (const name of await readdir(path)) {
      const child = join(path, name);
      if (/\.skillsmith-(?:staging|backup|transaction)|\.journal$/u.test(name)) {
        output.push(child);
      }
      await visit(child);
    }
  };
  await visit(root);
  return output.sort();
};

export const absoluteStringsUnder = (value: unknown, root: string): readonly string[] =>
  collectStrings(value).filter(
    (candidate) =>
      isAbsolute(candidate) &&
      (candidate === root ||
        (!relative(root, candidate).startsWith('..') && relative(root, candidate) !== '')),
  );

export const collectStrings = (value: unknown): readonly string[] => {
  const output: string[] = [];
  const pending = [value];
  while (pending.length > 0) {
    const selected = pending.pop();
    if (typeof selected === 'string') output.push(selected);
    else if (Array.isArray(selected)) pending.push(...selected);
    else if (typeof selected === 'object' && selected !== null) {
      pending.push(...Object.keys(selected), ...Object.values(selected));
    }
  }
  return output;
};

export const createIncompleteWholePairFixture = async (): Promise<IncompleteWholePairFixture> => {
  const fixture = await createApplyFixture([
    { name: 'alpha', tool: 'codex', scope: 'user' },
    { name: 'beta', tool: 'claude-code', scope: 'project' },
  ]);
  try {
    const decoded = readPortableLockSource(await readFile(fixture.lock));
    if (!decoded.ok) throw new Error(decoded.error.message);
    const replacement: PortableLockV1 = {
      ...decoded.value,
      skills: decoded.value.skills.filter(({ name }) => name !== 'beta'),
    };
    const encoded = serializePortableLock(replacement);
    if (!encoded.ok) throw new Error(encoded.error.message);
    await writeFile(fixture.lock, encoded.value);
    return { fixture, omittedName: 'beta', beforeLock: decoded.value };
  } catch (error) {
    await destroyApplyFixture(fixture);
    throw error;
  }
};

export const destroyIncompleteWholePairFixture = async (
  selected: IncompleteWholePairFixture,
): Promise<void> => destroyApplyFixture(selected.fixture);

export const runBoundedLockedPreview = (
  selected: IncompleteWholePairFixture,
  command: 'apply' | 'plan',
) =>
  runApplyCli(selected.fixture, [
    command,
    '--file',
    selected.fixture.manifest,
    '--lockfile',
    selected.fixture.lock,
    '--tool',
    'codex',
    '--locked',
    ...(command === 'apply' ? ['--dry-run'] : []),
    '--json',
  ]);
