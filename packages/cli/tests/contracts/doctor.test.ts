import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolRegistry } from '../../../core/src/agents/registry.ts';
import { runDoctorApplication } from '../../../core/src/application/read-services.ts';
import type {
  CurrentApplicationContext,
  InteractionPort,
} from '../../../core/src/application/types.ts';
import { artifactMutationError } from '../../../core/src/artifacts/file-state.ts';
import { hashManifestSemantics } from '../../../core/src/artifacts/hash.ts';
import { migrateLegacyManifestBytes } from '../../../core/src/artifacts/legacy-migration.ts';
import { serializePortableLock } from '../../../core/src/artifacts/lock.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../core/src/artifacts/manifest.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../core/src/artifacts/node-coordinator.ts';
import { readLedgerArtifact } from '../../../core/src/artifacts/repository.ts';
import { resolveRuntimeConfiguration } from '../../../core/src/config/runtime.ts';
import type { EffectiveConfig } from '../../../core/src/config/types.ts';
import type { ProjectContext } from '../../../core/src/context/types.ts';
import * as contractsV2 from '../../../core/src/contracts/v2/index.ts';
import { focusDoctorPorts } from '../../../core/src/doctor/run.ts';
import type { ScanEnv } from '../../../core/src/env/types.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../../core/src/observation/index.ts';
import { defaultRuntimePorts } from '../../../core/src/ports/default.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { runtimePorts } from '../../../core/tests/fixtures/runtime-ports.ts';
import * as doctorCommandModule from '../../src/commands/doctor.ts';
import { createCliRuntimeAdapter } from '../../src/runtime/adapter.ts';
import type { CliRuntimeIo } from '../../src/runtime/io.ts';
import { CURRENT_COMMAND_SPECS, validateOptionInvocation } from '../../src/spec/index.ts';
import { validateNonMutatingMode } from '../../src/util/non-mutating-mode.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

type UnknownRecord = Record<string, unknown>;
type DoctorInputResult =
  | {
      readonly ok: true;
      readonly value: Readonly<{
        tools: readonly string[];
        scopes: readonly string[];
        file?: string;
        lockfile?: string;
        fix: boolean;
        dryRun: boolean;
        yes: boolean;
      }>;
    }
  | {
      readonly ok: false;
      readonly error: Readonly<{ code: 'usage'; exitCode: 2; message: string }>;
    };
type DoctorExitInput = Readonly<{
  report: UnknownRecord | null;
  strict: boolean;
  failure: null | 'health' | 'usage' | 'state' | 'source' | 'permission' | 'cancelled';
}>;
interface DoctorCommandApi {
  resolveDoctorInputs(
    input: Readonly<{
      cli: Readonly<{
        tools: readonly string[];
        scope?: string;
        allTools: boolean;
        file?: string;
        lockfile?: string;
        fix: boolean;
        dryRun: boolean;
        yes: boolean;
      }>;
      effectiveConfig: Readonly<{ tool?: string; scope?: string }>;
      effectiveCwd: string;
    }>,
  ): DoctorInputResult;
  resolveDoctorExitCode(input: DoctorExitInput): 0 | 1 | 2 | 3 | 5 | 6 | 130;
}

const doctorCommandApi = doctorCommandModule as unknown as Partial<DoctorCommandApi>;
const healthV2Codec = (contractsV2 as UnknownRecord).healthV2Codec as
  | Readonly<{
      validate(
        value: unknown,
      ):
        | Readonly<{ readonly ok: true; readonly value: UnknownRecord }>
        | Readonly<{ readonly ok: false; readonly error: UnknownRecord }>;
      encode(
        value: UnknownRecord,
      ):
        | Readonly<{ readonly ok: true; readonly value: string }>
        | Readonly<{ readonly ok: false; readonly error: UnknownRecord }>;
    }>
  | undefined;

const CLI_ABSOLUTE_DEADLINE_MS = 30_000;
const CLI_WORK_DEADLINE_MS = 25_000;
const CLI_TERM_GRACE_MS = 750;
const CLI_KILL_GRACE_MS = 2_000;
const CLI_OUTPUT_LIMIT_BYTES = 1_048_576;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sandbox = async (label: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-doctor-${label}-`));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(join(root, 'home'), { recursive: true }),
    mkdir(join(root, 'config'), { recursive: true }),
    mkdir(join(root, 'data'), { recursive: true }),
    mkdir(join(root, 'cache'), { recursive: true }),
  ]);
  return root;
};

interface CappedRead {
  readonly promise: Promise<string>;
  cancel(): Promise<void>;
}

const cappedRead = (stream: ReadableStream<Uint8Array>, label: string): CappedRead => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  const chunks: string[] = [];
  const promise = (async (): Promise<string> => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > CLI_OUTPUT_LIMIT_BYTES) {
          throw new Error(`${label} exceeded ${CLI_OUTPUT_LIMIT_BYTES} bytes`);
        }
        chunks.push(decoder.decode(next.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join('');
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    promise,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // A closed pipe is already cancelled for fixture-cleanup purposes.
      }
    },
  };
};

const settleWithin = async <T>(promise: Promise<T>, milliseconds: number): Promise<boolean> => {
  if (milliseconds <= 0) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const beforeDeadline = async <T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const runBoundedProcess = async (
  root: string,
  command: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
  options: Readonly<{
    workDeadlineMs?: number;
    absoluteDeadlineMs?: number;
    termGraceMs?: number;
    killGraceMs?: number;
    onSpawn?: (pid: number) => void;
  }> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const absoluteDeadlineMs = options.absoluteDeadlineMs ?? CLI_ABSOLUTE_DEADLINE_MS;
  const workDeadlineMs = options.workDeadlineMs ?? CLI_WORK_DEADLINE_MS;
  if (
    absoluteDeadlineMs <= 0 ||
    absoluteDeadlineMs > CLI_ABSOLUTE_DEADLINE_MS ||
    workDeadlineMs <= 0 ||
    workDeadlineMs >= absoluteDeadlineMs
  ) {
    throw new Error('invalid bounded-process deadline');
  }
  const absoluteDeadline = Date.now() + absoluteDeadlineMs;
  const child = Bun.spawn([...command], {
    cwd: root,
    env: hermeticGitEnv({
      CI: '1',
      NO_COLOR: '1',
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      SKILLSMITH_HOME: join(root, 'data', 'skillsmith'),
      SKILLSMITH_CONFIG: undefined,
      SKILLSMITH_TOOL: undefined,
      SKILLSMITH_SCOPE: undefined,
      SKILLSMITH_PATH: undefined,
      CODEX_HOME: undefined,
      ...environment,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  options.onSpawn?.(child.pid);
  let exited = false;
  const exit = child.exited.then((code) => {
    exited = true;
    return code;
  });
  const stdout = cappedRead(child.stdout, 'doctor fixture stdout');
  const stderr = cappedRead(child.stderr, 'doctor fixture stderr');
  const output = Promise.all([stdout.promise, stderr.promise]);
  const outputSettled = Promise.allSettled([stdout.promise, stderr.promise]);
  const outputFailure = output.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(error),
  );
  let response:
    | { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
    | undefined;
  let failure: unknown;

  try {
    const exitCode = await beforeDeadline(
      Promise.race([exit, outputFailure]),
      workDeadlineMs,
      `CLI fixture exceeded ${workDeadlineMs}ms work deadline`,
    );
    const [stdoutText, stderrText] = await beforeDeadline(
      output,
      Math.max(1, absoluteDeadline - Date.now()),
      `CLI fixture did not drain output within ${absoluteDeadlineMs}ms`,
    );
    response = { exitCode, stdout: stdoutText, stderr: stderrText };
  } catch (error) {
    failure = error;
  } finally {
    const termGraceMs = options.termGraceMs ?? CLI_TERM_GRACE_MS;
    const killGraceMs = options.killGraceMs ?? CLI_KILL_GRACE_MS;
    const cleanupDeadline = Date.now() + termGraceMs + killGraceMs;
    if (!exited) {
      child.kill('SIGTERM');
      const terminated = await settleWithin(exit, termGraceMs);
      if (!terminated) {
        child.kill('SIGKILL');
        const killed = await settleWithin(exit, killGraceMs);
        if (!killed) {
          failure = new Error('CLI fixture did not exit after SIGKILL');
        }
      }
    }
    const drained = await settleWithin(outputSettled, Math.max(1, cleanupDeadline - Date.now()));
    if (!drained) {
      await Promise.all([stdout.cancel(), stderr.cancel()]);
      await beforeDeadline(
        outputSettled,
        killGraceMs,
        'CLI fixture readers did not settle after cancellation',
      );
    }
  }
  if (failure !== undefined) throw failure;
  if (response === undefined) throw new Error('CLI fixture completed without a response');
  return response;
};

const runCli = (
  root: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> =>
  runBoundedProcess(root, ['bun', CLI_ENTRYPOINT, ...args], environment);

const json = (result: { readonly stdout: string }): UnknownRecord =>
  JSON.parse(result.stdout) as UnknownRecord;

const records = (value: unknown): UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is UnknownRecord => typeof entry === 'object' && entry !== null)
    : [];

const record = (value: unknown): UnknownRecord =>
  typeof value === 'object' && value !== null ? (value as UnknownRecord) : {};

const exactKeys = (value: unknown, keys: readonly string[]): void => {
  expect(Object.keys(record(value)).sort()).toEqual([...keys].sort());
};

const repairFrom = (dto: UnknownRecord): UnknownRecord => record(dto.repair);

const findingsFromOutcome = (outcome: unknown): UnknownRecord[] => {
  if (typeof outcome !== 'object' || outcome === null) return [];
  const report = (outcome as UnknownRecord).report;
  if (typeof report !== 'object' || report === null) return [];
  const result = (report as UnknownRecord).result;
  if (typeof result !== 'object' || result === null) return [];
  return records((result as UnknownRecord).findings);
};

const findingIds = (value: unknown): string[] =>
  records(value)
    .map((finding) => String(finding.checkId))
    .sort();

const remediationCommand = (remediation: string): string[] => {
  const start = remediation.indexOf('skillsmith ');
  if (start < 0) return [];
  const opener = remediation[start - 1];
  const quoted = opener === "'" || opener === '`' || opener === '"';
  const end = quoted ? remediation.indexOf(opener, start) : remediation.indexOf('\n', start);
  const source = remediation.slice(start, end < 0 ? undefined : end).trim();
  const tokens: string[] = [];
  for (const match of source.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined) tokens.push(token.replace(/[.,;:]$/u, ''));
  }
  return tokens;
};

const v1Ledger = (options: { readonly pendingJournal?: boolean } = {}): string =>
  JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: '2026-07-15T00:00:00.000Z',
      skills: options.pendingJournal
        ? {
            alpha: {
              tools: {
                codex: {
                  placementPath: '/fixture/home/.agents/skills/alpha',
                  mode: 'pinned',
                  dev: null,
                  pinned: {
                    storePath: '/fixture/data/skillsmith/store/acme/alpha@abc/alpha',
                    rev: 'abc',
                    gitSha: null,
                    dirty: false,
                    contentHash:
                      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    snapshotAt: '2026-07-15T00:00:00.000Z',
                    verify: 'passed',
                  },
                  journal: {
                    op: 'install',
                    txId: 'transaction:v1:pending-doctor-fixture',
                    phase: 'prepared',
                    startedAt: '2026-07-15T00:00:00.000Z',
                    completedAt: null,
                    before: { mode: 'absent' },
                    stagingPath: '/fixture/data/skillsmith/transactions/pending/stage',
                    backupPath: '/fixture/data/skillsmith/transactions/pending/backup',
                  },
                },
              },
            },
          }
        : {},
      projects: {},
    },
    null,
    2,
  );

const writeV1Ledger = async (
  root: string,
  options: { readonly pendingJournal?: boolean } = {},
): Promise<string> => {
  const path = join(root, 'data', 'skillsmith', 'placements.json');
  await mkdir(join(root, 'data', 'skillsmith'), { recursive: true });
  await writeFile(path, v1Ledger(options), 'utf8');
  return path;
};

const writeLedgerSource = async (root: string, source: string): Promise<string> => {
  const path = join(root, 'data', 'skillsmith', 'placements.json');
  await mkdir(join(root, 'data', 'skillsmith'), { recursive: true });
  await writeFile(path, source, 'utf8');
  return path;
};

const emptyV2Ledger = (): string =>
  `${JSON.stringify(
    {
      schemaVersion: 2,
      kind: 'skillsmith.placements',
      updatedAt: '2026-07-15T00:00:00.000Z',
      skills: {},
      projects: {},
      projectRegistrations: {},
      transactions: {},
      history: [],
    },
    null,
    2,
  )}\n`;

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;

const cleanupHistoryJournal = (
  index: number,
  retained: boolean,
  retainedPath?: string,
): UnknownRecord => {
  const skill = 'cleanup-shared';
  const operationId = `operation:cleanup-${String(index).padStart(4, '0')}`;
  const transactionId = `transaction:cleanup-${String(index).padStart(4, '0')}`;
  const livePath = `/fixture/live/${skill}`;
  const retainedId = `backup:${transactionId}`;
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
  const liveResource = {
    kind: 'live',
    skill,
    tool: 'codex',
    scope: 'user',
    projectRoot: null,
    location: { kind: 'machine-bound', path: livePath },
  };
  const liveActual = (state: 'absent' | 'present') => ({
    resourceId: `live:${skill}`,
    role: 'live',
    state,
    repositoryRevision: state === 'present' ? { kind: 'resource', digest: digestB } : null,
    placementPath: livePath,
    liveKind: state === 'present' ? 'directory' : null,
    mode: state === 'present' ? 'pinned' : null,
    symlinkTarget: null,
    contentHash: state === 'present' ? digestB : null,
  });
  const ledgerActual = (after: boolean) => ({
    resourceId: 'ledger:placements',
    role: 'ledger',
    state: 'present',
    repositoryRevision: { kind: 'artifact-bytes', digest: after ? digestB : digestA },
    schemaVersion: 2,
    semanticHash: after ? digestB : digestA,
  });
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId,
    intent: {
      operationId,
      groupId: `group:${skill}`,
      pairId: `pair:${skill}:codex:user`,
      kind: 'install',
      skill,
      source: {
        kind: 'portable',
        identity: { host: 'example.test', repository: 'fixture/skills', path: skill },
        requestedRef: null,
        resolvedSha: 'c'.repeat(40),
        sourcePath: skill,
        contentHash: digestA,
      },
      tool: 'codex',
      scope: 'user',
      before: { kind: 'absent', resource: liveResource },
      after: {
        kind: 'placement',
        resource: liveResource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source: null,
        contentHash: digestB,
      },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      reversibility: retained
        ? { kind: 'conditional', retentionResourceIds: [retainedId] }
        : { kind: 'none', retentionResourceIds: [] },
      conflict: null,
    },
    context: {
      parentOperationId: null,
      command: 'doctor-contract-fixture',
      workflow: 'doctor-retention-cleanup',
      attempt: 1,
      startedAt,
    },
    disposition: 'forward',
    phase: 'committed',
    actual: {
      before: [ledgerActual(false), liveActual('absent')],
      after: [ledgerActual(true), liveActual('present')],
      retained: retained
        ? [
            {
              resourceId: retainedId,
              role: 'backup',
              sourceRole: 'live',
              path: retainedPath ?? `/fixture/.skillsmith-transaction-${transactionId}/live.backup`,
              repositoryRevision: { kind: 'resource', digest: digestA },
              contentHash: digestA,
              retainUntil: null,
            },
          ]
        : [],
    },
    updatedAt: startedAt,
    completedAt: startedAt,
  };
};

const legacyProjectSource =
  '# retained owner\ntool = "codex"\nscope = "project"\npath = "./skills"\n';

const writeLegacyProject = async (root: string): Promise<string> => {
  const path = join(root, 'skillsmith.toml');
  await writeFile(path, legacyProjectSource, 'utf8');
  return path;
};

const healthArgs = (root: string, command: 'doctor' | 'check' = 'doctor'): readonly string[] => [
  '-C',
  root,
  command,
  '--tool',
  'codex',
  '--scope',
  'user',
  ...(command === 'doctor' ? ['--offline'] : []),
  '--json',
];

const projectContext: ProjectContext = {
  invocationCwd: '/fixture/project',
  effectiveCwd: '/fixture/project',
  projectRoot: '/fixture/project',
  projectIdentity: '/fixture/project',
  projectKind: 'git',
  discoveredConfigPath: null,
  explicitConfigPath: null,
};

const effectiveConfig: EffectiveConfig = {
  value: {},
  sources: {},
  layers: {
    defaults: {},
    system: {},
    user: {},
    project: {},
    'explicit-file': {},
    env: {},
    cli: {},
  },
  paths: {},
};

const interaction: InteractionPort = {
  mode: 'noninteractive',
  choose: async () => ({ status: 'refused', reason: 'fixture is noninteractive' }),
  confirm: async () => ({ status: 'refused', reason: 'fixture is noninteractive' }),
};

const detectedCodexEnv = (): ScanEnv => ({
  homeDir: '/fixture/home',
  path: ['/fixture/bin'],
  platform: 'linux',
  xdg: { config: '/fixture/config', data: '/fixture/data', cache: '/fixture/cache' },
  fileExists: async (path) => path === '/fixture/bin/codex',
  realpath: async (path) => path,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'fixture',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async (path) =>
    path === '/fixture/bin/codex'
      ? 'file'
      : path === '/' || path === '/fixture' || path === '/fixture/project'
        ? 'dir'
        : 'absent',
  isExecutable: async (path) => path === '/fixture/bin/codex',
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  modifiedAt: async () => null,
  withFileLock: (_path, operation) => operation(),
});

const doctorContext = (
  options: {
    readonly env?: ScanEnv;
    readonly ports?: CurrentApplicationContext['ports'];
    readonly artifactCoordinator?: CurrentApplicationContext['artifactCoordinator'];
    readonly interaction?: InteractionPort;
    readonly signal?: AbortSignal;
    readonly configuration?: ReturnType<typeof resolveRuntimeConfiguration>;
    readonly project?: ProjectContext;
    readonly config?: EffectiveConfig;
  } = {},
): CurrentApplicationContext => ({
  observation: Object.freeze({
    context: createOperationContext({
      command: 'skillsmith doctor',
      workflow: 'doctor',
      operationId: 'operation:v1:doctor-selector-fixture',
      clock: {
        wallNowIso: () => '2026-07-15T00:00:00.000Z',
        monotonicMilliseconds: () => 0,
      },
      id: { nextId: () => 'doctor-selector-fixture' },
    }),
    emitter: createObservationEmitter({ observer: noopObserver }),
  }),
  ports: options.ports ?? runtimePorts(options.env ?? detectedCodexEnv()),
  artifactCoordinator:
    options.artifactCoordinator ?? ({} as CurrentApplicationContext['artifactCoordinator']),
  configuration:
    options.configuration ??
    resolveRuntimeConfiguration({ SKILLSMITH_HOME: '/fixture/data/skillsmith' }),
  interaction: options.interaction ?? interaction,
  invocationCwd: '/fixture/project',
  globalOptions: {},
  projectContext: options.project ?? projectContext,
  effectiveConfig: options.config ?? effectiveConfig,
  ...(options.signal === undefined ? {} : { signal: options.signal }),
});

const runDoctorThroughCliAdapter = async (
  request: Parameters<typeof runDoctorApplication>[0],
  context: Parameters<typeof runDoctorApplication>[1],
) => {
  const exits: number[] = [];
  const io: CliRuntimeIo = {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    exit: (code) => exits.push(code),
  };
  const adapter = createCliRuntimeAdapter({
    applications: {
      doctor: (applicationRequest, applicationContext) =>
        runDoctorApplication(
          applicationRequest as Parameters<typeof runDoctorApplication>[0],
          applicationContext as Parameters<typeof runDoctorApplication>[1],
        ),
    },
    renderers: {
      doctor: {
        human: () => '',
        json: () => '',
      },
    },
    io,
  });
  const result = await adapter.execute({
    application: 'doctor',
    reportKind: 'doctor',
    request,
    context,
    observation: context.observation,
    format: 'json',
  });
  return { ...result, exits };
};

describe('EWP-CMD-DOCTOR-TS01', () => {
  test('doctor command helper normalizes explicit selection and artifact paths', () => {
    expect(typeof doctorCommandApi.resolveDoctorInputs).toBe('function');
    if (doctorCommandApi.resolveDoctorInputs === undefined) return;
    expect(
      doctorCommandApi.resolveDoctorInputs({
        cli: {
          tools: ['codex'],
          scope: 'project',
          allTools: false,
          file: './config/skillsmith.toml',
          lockfile: './locks/custom.lock',
          fix: true,
          dryRun: true,
          yes: false,
        },
        effectiveConfig: { tool: 'claude-code', scope: 'user' },
        effectiveCwd: '/workspace/repo',
      }),
    ).toEqual({
      ok: true,
      value: {
        tools: ['codex'],
        scopes: ['project'],
        file: '/workspace/repo/config/skillsmith.toml',
        lockfile: '/workspace/repo/locks/custom.lock',
        fix: true,
        dryRun: true,
        yes: false,
      },
    });
  });

  test('detected default stays narrow while --all-tools diagnoses every known adapter', async () => {
    const invoke = (allTools: boolean) =>
      runDoctorApplication(
        {
          arguments: [],
          options: { tool: [], scope: 'user', allTools, offline: true, json: true },
        },
        doctorContext(),
      );
    const [detected, all] = await Promise.all([invoke(false), invoke(true)]);
    const missingTools = (outcome: Awaited<ReturnType<typeof invoke>>): string[] => {
      const report = outcome.report as unknown as UnknownRecord;
      const result = report.result as UnknownRecord;
      return records(result.findings)
        .filter((finding) => finding.checkId === 'tool-detected')
        .map((finding) => String(finding.tool))
        .sort();
    };

    expect(missingTools(detected)).toEqual([]);
    expect(missingTools(all)).toEqual(['claude-code', 'kilo-code', 'opencode']);
  });

  test('an explicit tool remains bounded and does not diagnose unselected adapters', async () => {
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'user',
          allTools: false,
          offline: true,
          json: true,
        },
      },
      doctorContext(),
    );
    const tools = findingsFromOutcome(outcome)
      .map((finding) => finding.tool)
      .filter((tool): tool is string => typeof tool === 'string');

    expect(outcome.exitClass).not.toBe('usage');
    expect(new Set(tools)).toEqual(new Set(['codex']));
  });

  test('every known adapter advertises the diagnostics capability used by doctor', () => {
    expect(toolRegistry.ids).toEqual(['claude-code', 'codex', 'kilo-code', 'opencode']);
    expect(toolRegistry.toolsFor('diagnostics')).toEqual(toolRegistry.ids);
    for (const tool of toolRegistry.ids) {
      const capability = toolRegistry.capability(tool, 'diagnostics');
      if ('code' in capability) {
        throw new Error(
          `expected ${tool} diagnostics capability fact, received ${capability.code}`,
        );
      }
      expect(capability.supported).toBeTrue();
      expect(Array.isArray(capability.scopes)).toBeTrue();
      expect(capability.scopes).toContain('user');
      expect(capability.scopes).toContain('project');
      expect(capability.scopes).toContain('system');
    }
  });

  test('detected Codex is affirmatively probed before it becomes the narrow default', async () => {
    let codexProbes = 0;
    const base = detectedCodexEnv();
    const env: ScanEnv = {
      ...base,
      fileExists: async (path) => {
        if (path === '/fixture/bin/codex') codexProbes += 1;
        return base.fileExists(path);
      },
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: { tool: [], scope: 'user', allTools: false, offline: true, json: true },
      },
      doctorContext({ env }),
    );

    expect(codexProbes).toBeGreaterThan(0);
    expect(findingsFromOutcome(outcome)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'tool-detected', tool: 'codex' }),
      ]),
    );
  });

  test('focused health ports structurally exclude every mutation capability', () => {
    const focused = focusDoctorPorts(runtimePorts(detectedCodexEnv())) as unknown as UnknownRecord;
    expect(Object.keys(focused).sort()).toEqual(
      [
        'assertWritableDirectory',
        'executableSearchPath',
        'fileExists',
        'homeDir',
        'http',
        'isExecutable',
        'listDir',
        'modifiedAt',
        'pathKind',
        'platform',
        'readBytes',
        'readLink',
        'readText',
        'realpath',
        'xdg',
      ].sort(),
    );
    for (const capability of [
      'makeDir',
      'writeTextFile',
      'rename',
      'removeTree',
      'fsyncFile',
      'fsyncDir',
      'withFileLock',
      'exec',
      'interaction',
    ]) {
      expect(capability in focused).toBeFalse();
    }
  });
});

describe('EWP-CMD-DOCTOR-TS02', () => {
  test('fix-only approval flags refuse before project discovery or filesystem I/O', async () => {
    const root = await sandbox('option-policy');
    const missing = join(root, 'must-not-be-discovered');
    const result = await runCli(root, ['-C', missing, 'doctor', '--yes', '--json']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    expect(json(result)).toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('--yes requires --fix'),
    });
    expect(result.stdout).not.toContain(missing);
  });

  test('registry and utility option policy agree on fix, dry-run, and yes relations', () => {
    const cases = [
      {
        args: ['--dry-run'],
        options: { dryRun: true },
        message: '--dry-run requires --fix',
      },
      { args: ['--yes'], options: { yes: true }, message: '--yes requires --fix' },
      {
        args: ['--fix', '--yes', '--dry-run'],
        options: { fix: true, yes: true, dryRun: true },
        message: '--yes cannot be combined with --dry-run',
      },
    ] as const;
    for (const fixture of cases) {
      const registry = validateOptionInvocation('skillsmith doctor', fixture.args);
      const utility = validateNonMutatingMode('doctor', fixture.options);
      expect(registry).toEqual({
        ok: false,
        error: { code: 'usage', exitCode: 2, message: fixture.message },
      });
      expect(utility).toEqual({ ok: false, exitCode: 2, message: fixture.message });
    }
  });

  test('doctor input helper applies the same option policy before normalization', () => {
    expect(typeof doctorCommandApi.resolveDoctorInputs).toBe('function');
    if (doctorCommandApi.resolveDoctorInputs === undefined) return;
    for (const fixture of [
      {
        flags: { fix: false, dryRun: true, yes: false },
        message: '--dry-run requires --fix',
      },
      { flags: { fix: false, dryRun: false, yes: true }, message: '--yes requires --fix' },
      {
        flags: { fix: true, dryRun: true, yes: true },
        message: '--yes cannot be combined with --dry-run',
      },
    ]) {
      expect(
        doctorCommandApi.resolveDoctorInputs({
          cli: {
            tools: [],
            allTools: false,
            ...fixture.flags,
          },
          effectiveConfig: { tool: 'codex', scope: 'user' },
          effectiveCwd: '/workspace/repo',
        }),
      ).toEqual({
        ok: false,
        error: { code: 'usage', exitCode: 2, message: fixture.message },
      });
    }
    expect(
      doctorCommandApi.resolveDoctorInputs({
        cli: { tools: [], allTools: false, fix: false, dryRun: false, yes: false },
        effectiveConfig: { tool: 'codex', scope: 'user' },
        effectiveCwd: '/workspace/repo',
      }),
    ).toEqual({
      ok: true,
      value: {
        tools: ['codex'],
        scopes: ['user'],
        fix: false,
        dryRun: false,
        yes: false,
      },
    });
  });

  test('dry-run without fix and yes plus dry-run both refuse before discovery', async () => {
    const root = await sandbox('pre-discovery-relations');
    const missing = join(root, 'must-not-be-read');
    for (const fixture of [
      { args: ['--dry-run'], message: '--dry-run requires --fix' },
      {
        args: ['--fix', '--yes', '--dry-run'],
        message: '--yes cannot be combined with --dry-run',
      },
    ]) {
      const result = await runCli(root, ['-C', missing, 'doctor', ...fixture.args, '--json']);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(json(result)).toMatchObject({ exitCode: 2, message: fixture.message });
      expect(result.stdout).not.toContain(missing);
    }
  });

  test('fix true is normalized as mutating execution, never read-only doctor', () => {
    expect(typeof doctorCommandApi.resolveDoctorInputs).toBe('function');
    if (doctorCommandApi.resolveDoctorInputs === undefined) return;
    const result = doctorCommandApi.resolveDoctorInputs({
      cli: {
        tools: ['codex'],
        scope: 'user',
        allTools: false,
        fix: true,
        dryRun: false,
        yes: true,
      },
      effectiveConfig: {},
      effectiveCwd: '/workspace/repo',
    });
    expect(result).toMatchObject({
      ok: true,
      value: { fix: true, dryRun: false, yes: true },
    });
    const mode = validateNonMutatingMode('doctor', { fix: true } as never) as unknown;
    expect(mode).toEqual({
      ok: true,
      mutating: true,
    });
  });

  test('project scope and an explicit artifact pair use the selected project context', async () => {
    const manifest = '/fixture/project/custom.toml';
    const lock = '/fixture/project/custom.lock';
    const reads: string[] = [];
    const base = detectedCodexEnv();
    const env: ScanEnv = {
      ...base,
      fileExists: async (path) => path === manifest || base.fileExists(path),
      pathKind: async (path) => (path === manifest ? 'file' : base.pathKind(path)),
      readText: async (path) => {
        reads.push(path);
        return path === manifest ? 'version = 1\n' : '';
      },
      readBytes: async (path) => new TextEncoder().encode(path === manifest ? 'version = 1\n' : ''),
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'project',
          file: manifest,
          lockfile: lock,
          offline: true,
          json: true,
        },
      },
      doctorContext({ env }),
    );

    expect(outcome.exitClass).not.toBe('usage');
    expect(reads).toContain(manifest);
    expect(findingsFromOutcome(outcome).filter((finding) => finding.scope !== undefined)).toEqual(
      expect.arrayContaining([expect.objectContaining({ scope: 'project' })]),
    );
  });

  test('missing XDG context is an error while offline suppresses the network check', async () => {
    const xdgOutcome = await runDoctorApplication(
      {
        arguments: [],
        options: { tool: ['codex'], scope: 'user', offline: true, json: true },
      },
      doctorContext({
        env: { ...detectedCodexEnv(), xdg: { config: '', data: '/fixture/data', cache: '' } },
      }),
    );
    expect(findingsFromOutcome(xdgOutcome)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'xdg-paths', severity: 'error' }),
      ]),
    );

    let requests = 0;
    const basePorts = runtimePorts(detectedCodexEnv());
    const ports = {
      ...basePorts,
      http: {
        request: async () => {
          requests += 1;
          throw new Error('synthetic offline fixture');
        },
      },
    };
    const request = (offline: boolean) =>
      runDoctorApplication(
        {
          arguments: [],
          options: { tool: ['codex'], scope: 'user', offline, json: true },
        },
        doctorContext({ ports }),
      );
    const offline = await request(true);
    expect(requests).toBe(0);
    expect(findingIds(findingsFromOutcome(offline))).not.toContain('network-reach');
    const online = await request(false);
    expect(requests).toBe(1);
    expect(findingIds(findingsFromOutcome(online))).toContain('network-reach');
  });
});

describe('EWP-CMD-DOCTOR-TS03', () => {
  test('live registry reports duplicate, legacy, and multi-install states without write authority', async () => {
    const base = detectedCodexEnv();
    const userRoot = '/fixture/home/.agents/skills';
    const legacyRoot = '/fixture/home/.codex/skills';
    const projectRoot = '/fixture/project/.agents/skills';
    const roots = new Set([userRoot, legacyRoot, projectRoot]);
    const skillFiles = new Set([
      join(userRoot, 'shared', 'SKILL.md'),
      join(legacyRoot, 'legacy', 'SKILL.md'),
      join(projectRoot, 'shared', 'SKILL.md'),
    ]);
    const env: ScanEnv = {
      ...base,
      fileExists: async (path) =>
        path === '/fixture/bin/codex' ||
        path === '/usr/local/bin/codex' ||
        roots.has(path) ||
        skillFiles.has(path),
      listDir: async (path) =>
        path === userRoot
          ? ['shared']
          : path === legacyRoot
            ? ['legacy']
            : path === projectRoot
              ? ['shared']
              : [],
      readText: async (path) => (skillFiles.has(path) ? '---\nname: shared\n---\nfixture\n' : ''),
      readBytes: async (path) =>
        new TextEncoder().encode(skillFiles.has(path) ? '---\nname: shared\n---\nfixture\n' : ''),
      pathKind: async (path) =>
        path === '/fixture/bin/codex' || path === '/usr/local/bin/codex'
          ? 'file'
          : roots.has(path) ||
              [...roots].some((root) => path.startsWith(`${root}/`) && !path.endsWith('SKILL.md'))
            ? 'dir'
            : skillFiles.has(path)
              ? 'file'
              : base.pathKind(path),
    };
    const mutations: string[] = [];
    const record = (name: string) => async () => {
      mutations.push(name);
    };
    const ports = {
      ...runtimePorts(env),
      makeDir: record('makeDir'),
      writeTextFile: record('writeTextFile'),
      makeSymlink: record('makeSymlink'),
      rename: record('rename'),
      copyTree: record('copyTree'),
      removeTree: record('removeTree'),
      fsyncFile: record('fsyncFile'),
      fsyncDir: record('fsyncDir'),
      setFileMode: record('setFileMode'),
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: { tool: ['codex'], offline: true, json: true },
      },
      doctorContext({ ports }),
    );

    expect(findingIds(findingsFromOutcome(outcome))).toEqual(
      expect.arrayContaining(['cross-scope-duplicate', 'legacy-install', 'multi-install']),
    );
    expect(mutations).toEqual([]);
  });

  test('ledger absence and every existing corrupt or future state are distinguished exactly', async () => {
    const cases = [
      { id: 'missing', source: null, exitCode: 0 },
      { id: 'zero', source: '', exitCode: 3 },
      { id: 'whitespace', source: ' \n\t', exitCode: 3 },
      { id: 'truncated', source: '{"schemaVersion":1', exitCode: 3 },
      { id: 'malformed', source: 'not-json', exitCode: 3 },
      {
        id: 'wrong-kind',
        source: JSON.stringify({
          schemaVersion: 1,
          kind: 'skillsmith.not-placements',
          updatedAt: '2026-07-15T00:00:00.000Z',
          skills: {},
        }),
        exitCode: 3,
      },
      {
        id: 'newer',
        source: JSON.stringify({
          schemaVersion: 3,
          kind: 'skillsmith.placements',
          updatedAt: '2026-07-15T00:00:00.000Z',
          skills: {},
        }),
        exitCode: 3,
      },
      { id: 'canonical-v2', source: emptyV2Ledger(), exitCode: 0 },
    ] as const;
    const observed: Array<{
      readonly id: string;
      readonly exitCode: number;
      readonly bytesPreserved: boolean;
      readonly upgradeGuidance: boolean | null;
    }> = [];
    for (const fixture of cases) {
      const root = await sandbox(`ledger-${fixture.id}`);
      const path = join(root, 'data', 'skillsmith', 'placements.json');
      if (fixture.source !== null) await writeLedgerSource(root, fixture.source);
      const result = await runCli(root, healthArgs(root));
      observed.push({
        id: fixture.id,
        exitCode: result.exitCode,
        bytesPreserved:
          fixture.source === null
            ? !(await Bun.file(path).exists())
            : (await readFile(path, 'utf8')) === fixture.source,
        upgradeGuidance:
          fixture.id === 'newer' ? result.stdout.toLowerCase().includes('upgrade') : null,
      });
    }
    expect(observed).toEqual(
      cases.map((fixture) => ({
        id: fixture.id,
        exitCode: fixture.exitCode,
        bytesPreserved: true,
        upgradeGuidance: fixture.id === 'newer' ? true : null,
      })),
    );
  });

  test('project shape matrix separates exact migration from invalid or manual states', async () => {
    const cases = [
      { id: 'canonical', source: 'version = 1\n', exitCode: 0, operation: null },
      {
        id: 'legacy',
        source: legacyProjectSource,
        exitCode: 0,
        operation: 'migrate-project-config',
      },
      { id: 'mixed', source: 'version = 1\ntool = "codex"\n', exitCode: 3, operation: null },
      { id: 'empty', source: '', exitCode: 3, operation: null },
      { id: 'malformed', source: 'version = [\n', exitCode: 3, operation: null },
      {
        id: 'nonportable',
        source: 'tool = "codex"\nscope = "project"\npath = "/opt/shared/skills"\n',
        exitCode: 3,
        operation: null,
      },
    ] as const;
    for (const fixture of cases) {
      const root = await sandbox(`project-${fixture.id}`);
      const manifest = join(root, 'skillsmith.toml');
      await writeFile(manifest, fixture.source, 'utf8');
      const result = await runCli(root, [
        '-C',
        root,
        'doctor',
        '--tool',
        'codex',
        '--scope',
        'project',
        '--offline',
        '--file',
        manifest,
        '--json',
      ]);
      expect(result.exitCode, fixture.id).toBe(fixture.exitCode);
      expect(await readFile(manifest, 'utf8')).toBe(fixture.source);
      if (fixture.operation !== null) {
        expect(records(json(result).findings)).toEqual([
          expect.objectContaining({ operation: fixture.operation, path: manifest }),
        ]);
      }
    }
  });

  test('unknown lock hash schema and digest domain diagnose canonical regeneration', async () => {
    for (const fixture of [
      {
        id: 'hash-schema',
        lock: 'version = 1\nhash_schema_version = 99\nmanifest_hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nskills = []\n',
      },
      {
        id: 'hash-domain',
        lock: 'version = 1\nhash_schema_version = 1\nmanifest_hash = "unknown:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nskills = []\n',
      },
    ]) {
      const root = await sandbox(`lock-${fixture.id}`);
      const manifest = join(root, 'skillsmith.toml');
      const lock = join(root, 'skillsmith.lock');
      await writeFile(manifest, 'version = 1\n', 'utf8');
      await writeFile(lock, fixture.lock, 'utf8');
      const result = await runCli(root, [
        '-C',
        root,
        'doctor',
        '--tool',
        'codex',
        '--scope',
        'project',
        '--offline',
        '--file',
        manifest,
        '--lockfile',
        lock,
        '--json',
      ]);
      expect(records(json(result).findings)).toEqual([
        expect.objectContaining({ operation: 'write-lock', path: lock }),
      ]);
      expect(await readFile(lock, 'utf8')).toBe(fixture.lock);
    }
  }, 30_000);

  test('sibling and explicit custom pair selection diagnose identical artifact bytes', async () => {
    const root = await sandbox('pair-equivalence');
    const manifest = await writeLegacyProject(root);
    const lock = join(root, 'skillsmith.lock');
    const lockSource = 'not canonical lock\n';
    await writeFile(lock, lockSource, 'utf8');
    const base = [
      '-C',
      root,
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--json',
    ];
    const [sibling, custom] = await Promise.all([
      runCli(root, base),
      runCli(root, [...base.slice(0, -1), '--lockfile', lock, '--json']),
    ]);
    const project = (result: ReturnType<typeof json>) =>
      records(result.findings).map(({ operation, path, remediation }) => ({
        operation,
        path,
        remediation,
      }));
    expect(project(json(sibling))).toEqual(project(json(custom)));
    expect(project(json(sibling))).toEqual([
      expect.objectContaining({ operation: 'migrate-project-config', path: manifest }),
      expect.objectContaining({ operation: 'write-lock', path: lock }),
    ]);
  }, 40_000);

  test('a supported v1 ledger is diagnosed as migration-pending without changing its bytes', async () => {
    const root = await sandbox('v1-diagnosis');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    const result = await runCli(root, healthArgs(root));
    const dto = json(result);
    const migration = records(dto.findings).find(
      (finding) => finding.operation === 'migrate-ledger',
    );

    expect(result.exitCode).toBe(0);
    expect(
      migration,
      'doctor did not expose the supported-v1 migrate-ledger finding',
    ).toBeDefined();
    if (migration === undefined) return;
    expect(migration).toMatchObject({
      findingId: expect.stringMatching(/^finding:v1:[0-9a-f]{64}$/),
      path,
      operation: 'migrate-ledger',
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('a pending legacy journal is reported separately from the visible ledger migration', async () => {
    const root = await sandbox('pending-journal');
    const path = await writeV1Ledger(root, { pendingJournal: true });
    const before = await readFile(path, 'utf8');
    const result = await runCli(root, healthArgs(root));
    const findings = records(json(result).findings);
    const migration = findings.find((finding) => finding.operation === 'migrate-ledger');
    const pending = findings.find((finding) => finding.checkId === 'journal-pending');

    expect(migration).toMatchObject({
      findingId: expect.stringMatching(/^finding:v1:[0-9a-f]{64}$/),
      operation: 'migrate-ledger',
      path,
    });
    expect(pending).toMatchObject({
      findingId: expect.stringMatching(/^finding:v1:[0-9a-f]{64}$/),
      checkId: 'journal-pending',
      tool: 'codex',
      path: '/fixture/home/.agents/skills/alpha',
      reason: expect.stringContaining('transaction:v1:pending-doctor-fixture'),
    });
    expect(pending?.findingId).not.toBe(migration?.findingId);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('retention cleanup selects an ordinary shared-anchor victim with an owned backup tombstone', async () => {
    const root = await sandbox('cleanup-tombstone');
    const victimTransaction = 'transaction:cleanup-0000';
    const transactionDirectory = join(
      root,
      'data',
      'skillsmith',
      `.skillsmith-transaction-${victimTransaction}`,
    );
    const backupPath = join(transactionDirectory, 'live.backup');
    await mkdir(transactionDirectory, { recursive: true, mode: 0o700 });
    const model = JSON.parse(emptyV2Ledger()) as UnknownRecord;
    model.history = Array.from({ length: 257 }, (_, index) =>
      cleanupHistoryJournal(index, index === 0, index === 0 ? backupPath : undefined),
    );
    const source = `${JSON.stringify(model, null, 2)}\n`;
    const path = await writeLedgerSource(root, source);
    const result = await runCli(root, healthArgs(root));
    const findings = records(json(result).findings);
    const tombstone = findings.find(
      (finding) =>
        finding.checkId === 'retention-missing' || finding.checkId === 'history-cleanup-tombstone',
    );

    expect(tombstone).toMatchObject({
      findingId: expect.stringMatching(/^finding:v1:[0-9a-f]{64}$/),
      severity: 'error',
      reason: expect.stringContaining(victimTransaction),
    });
    expect(records(model.history)).toHaveLength(257);
    expect(record(records(model.history)[0]?.intent).pairId).toBe(
      record(records(model.history)[256]?.intent).pairId,
    );
    expect(record(records(model.history)[0]?.actual).retained).toEqual([
      expect.objectContaining({ path: backupPath, retainUntil: null }),
    ]);
    expect(await Bun.file(backupPath).exists()).toBeFalse();
    expect(JSON.stringify(findings).toLowerCase()).toMatch(
      /retention.*cleanup|cleanup.*retention/u,
    );
    expect(await readFile(path, 'utf8')).toBe(source);
  }, 30_000);

  test('legacy manifest and noncanonical lock bytes receive bounded canonical repair findings', async () => {
    const root = await sandbox('artifact-pair');
    const manifest = await writeLegacyProject(root);
    const lock = join(root, 'skillsmith.lock');
    await writeFile(lock, '{"schemaVersion":1,"skills":{}}\n', 'utf8');
    const manifestBefore = await readFile(manifest, 'utf8');
    const lockBefore = await readFile(lock, 'utf8');
    const result = await runCli(root, [
      '-C',
      root,
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--lockfile',
      lock,
      '--json',
    ]);
    const findings = records(json(result).findings);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'migrate-project-config', path: manifest }),
        expect.objectContaining({ operation: 'write-lock', path: lock }),
      ]),
    );
    expect(await readFile(manifest, 'utf8')).toBe(manifestBefore);
    expect(await readFile(lock, 'utf8')).toBe(lockBefore);
  });
});

describe('EWP-CMD-DOCTOR-TS04', () => {
  test('command exit helper owns the exact doctor exit inventory', () => {
    expect(typeof doctorCommandApi.resolveDoctorExitCode).toBe('function');
    if (doctorCommandApi.resolveDoctorExitCode === undefined) return;
    const failures = [
      ['health', 1],
      ['usage', 2],
      ['state', 3],
      ['source', 5],
      ['permission', 6],
      ['cancelled', 130],
    ] as const;
    for (const [failure, exitCode] of failures) {
      expect(doctorCommandApi.resolveDoctorExitCode({ report: null, strict: false, failure })).toBe(
        exitCode,
      );
    }
    expect(
      doctorCommandApi.resolveDoctorExitCode({
        report: {
          counts: { ok: 1, warning: 0, error: 0 },
          repair: { mode: 'not-requested', operations: [], results: [] },
          mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
        },
        strict: false,
        failure: null,
      }),
    ).toBe(0);
  });

  test('doctor is unconditionally health@2 while check remains strict health@1', async () => {
    const root = await sandbox('wire-split');
    const [doctor, check] = await Promise.all([
      runCli(root, healthArgs(root, 'doctor')),
      runCli(root, healthArgs(root, 'check')),
    ]);
    const doctorDto = json(doctor);
    const checkDto = json(check);

    expect(doctorDto).toMatchObject({
      schemaVersion: 2,
      repair: { mode: 'not-requested', operations: [], results: [] },
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
    });
    expect(checkDto.schemaVersion).toBe(1);
    expect(checkDto).not.toHaveProperty('repair');
    expect(checkDto).not.toHaveProperty('mutation');
  });

  test('health@2 is recursively strict, canonically encoded, and cross-validates repair identity', async () => {
    const root = await sandbox('health-v2-codec');
    await writeV1Ledger(root);
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
      '--dry-run',
      '--json',
    ]);
    const dto = json(result);

    expect(healthV2Codec, 'contracts/v2 must export the health@2 runtime codec').toBeDefined();
    if (healthV2Codec === undefined) return;
    expect(healthV2Codec.validate(dto)).toMatchObject({ ok: true });
    exactKeys(dto, ['schemaVersion', 'experimental', 'findings', 'counts', 'repair', 'mutation']);
    exactKeys(dto.counts, ['ok', 'warning', 'error']);
    exactKeys(dto.repair, ['mode', 'operations', 'results']);
    exactKeys(dto.mutation, ['kind', 'planned', 'changed', 'unchanged', 'failed']);
    expect(result.stdout).toContain('\n  "experimental"');
    expect(result.stdout.endsWith('\n')).toBeFalse();

    const findings = records(dto.findings);
    const ids = findings.map((finding) => String(finding.findingId));
    expect(ids).toHaveLength(new Set(ids).size);
    for (const finding of findings) {
      expect(finding.findingId).toMatch(/^finding:v1:[0-9a-f]{64}$/);
      expect(
        Object.keys(finding).every((key) =>
          [
            'findingId',
            'checkId',
            'severity',
            'title',
            'message',
            'remediation',
            'tool',
            'scope',
            'path',
            'operation',
            'reason',
            'scopeInUse',
          ].includes(key),
        ),
      ).toBeTrue();
    }

    const repair = repairFrom(dto);
    const operations = records(repair.operations);
    expect(operations).toHaveLength(1);
    for (const operation of operations) {
      exactKeys(operation, [
        'operationId',
        'kind',
        'artifact',
        'path',
        'before',
        'after',
        'findingIds',
      ]);
      expect(operation.operationId).toMatch(/^operation:v1:[0-9a-f]{64}$/);
      exactKeys(operation.before, ['state', 'schemaVersion', 'byteRevision', 'semanticRevision']);
      exactKeys(operation.after, ['state', 'schemaVersion', 'byteRevision', 'semanticRevision']);
      for (const summary of [record(operation.before), record(operation.after)]) {
        if (summary.state === 'present') {
          expect(summary.byteRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
          if (summary.semanticRevision !== null) {
            expect(summary.semanticRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
          }
        }
      }
      expect(operation.findingIds).toEqual(
        [...((operation.findingIds as readonly string[]) ?? [])].sort(),
      );
    }

    const encoded = healthV2Codec.encode(dto);
    expect(encoded).toMatchObject({ ok: true });
    if (encoded.ok) expect(encoded.value).toBe(result.stdout);

    const recursivelyUnknown = structuredClone(dto);
    record(recursivelyUnknown.repair).unexpected = true;
    expect(healthV2Codec.validate(recursivelyUnknown)).toMatchObject({ ok: false });

    const operation = operations[0] as UnknownRecord;
    const applied = structuredClone(dto);
    record(applied.repair).mode = 'execute';
    record(applied.repair).results = [
      { operationId: operation.operationId, outcome: 'unchanged', error: null },
    ];
    applied.mutation = { kind: 'applied', planned: 1, changed: 0, unchanged: 1, failed: 0 };
    expect(healthV2Codec.validate(applied)).toMatchObject({ ok: true });
    exactKeys(records(record(applied.repair).results)[0], ['operationId', 'outcome', 'error']);

    const badCorrelation = structuredClone(applied);
    const badResult = records(record(badCorrelation.repair).results)[0];
    expect(badResult).toBeDefined();
    if (badResult === undefined) return;
    badResult.operationId = `operation:v1:${'f'.repeat(64)}`;
    expect(healthV2Codec.validate(badCorrelation)).toMatchObject({ ok: false });
    const badCounters = structuredClone(applied);
    record(badCounters.mutation).changed = 1;
    expect(healthV2Codec.validate(badCounters)).toMatchObject({ ok: false });
    const impossibleCanonicalBefore = structuredClone(dto);
    const impossibleOperation = records(record(impossibleCanonicalBefore.repair).operations)[0];
    expect(impossibleOperation).toBeDefined();
    if (impossibleOperation === undefined) return;
    const impossibleBefore = record(impossibleOperation.before);
    impossibleBefore.schemaVersion = 1;
    impossibleBefore.semanticRevision = null;
    expect(healthV2Codec.validate(impossibleCanonicalBefore)).toMatchObject({ ok: false });

    const failed = structuredClone(dto);
    record(failed.repair).mode = 'execute';
    record(failed.repair).results = [
      {
        operationId: operation.operationId,
        outcome: 'failed',
        error: {
          code: 'permission-denied',
          message: 'repair could not write the selected artifact',
          remediation: 'check ownership and rerun doctor',
        },
      },
    ];
    failed.mutation = { kind: 'applied', planned: 1, changed: 0, unchanged: 0, failed: 1 };
    expect(healthV2Codec.validate(failed)).toMatchObject({ ok: true });
    exactKeys(record(records(record(failed.repair).results)[0]?.error), [
      'code',
      'message',
      'remediation',
    ]);
  });

  test('health@2 rejects inactive mutation counters and unrelated finding authorization', () => {
    expect(healthV2Codec).toBeDefined();
    if (healthV2Codec === undefined) return;
    const findingId = `finding:v1:${'1'.repeat(64)}`;
    const operationId = `operation:v1:${'2'.repeat(64)}`;
    const digest = `sha256:${'3'.repeat(64)}`;
    const inactive = {
      schemaVersion: 2,
      experimental: true,
      findings: [],
      counts: { ok: 0, warning: 0, error: 0 },
      repair: { mode: 'not-requested', operations: [], results: [] },
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
    };
    for (const counter of ['changed', 'unchanged', 'failed'] as const) {
      const candidate = structuredClone(inactive);
      candidate.mutation[counter] = 1;
      expect(healthV2Codec.validate(candidate), counter).toMatchObject({ ok: false });
    }

    const authorized = {
      schemaVersion: 2,
      experimental: true,
      findings: [
        {
          findingId,
          checkId: 'lock-regeneration',
          severity: 'info',
          title: 'portable lock regeneration is available',
          message: 'the selected lock has one canonical repair',
          operation: 'write-lock',
          path: '/workspace/skillsmith.lock',
        },
      ],
      counts: { ok: 1, warning: 0, error: 0 },
      repair: {
        mode: 'preview',
        operations: [
          {
            operationId,
            kind: 'write-lock',
            artifact: 'lock',
            path: '/workspace/skillsmith.lock',
            before: {
              state: 'absent',
              schemaVersion: null,
              byteRevision: null,
              semanticRevision: null,
            },
            after: {
              state: 'present',
              schemaVersion: 1,
              byteRevision: digest,
              semanticRevision: digest,
            },
            findingIds: [findingId],
          },
        ],
        results: [],
      },
      mutation: { kind: 'preview', planned: 1, changed: 0, unchanged: 0, failed: 0 },
    };
    expect(healthV2Codec.validate(authorized)).toMatchObject({ ok: true });
    for (const mutation of [
      { key: 'operation', value: 'migrate-ledger' },
      { key: 'path', value: '/workspace/other.lock' },
    ] as const) {
      const candidate = structuredClone(authorized);
      const candidateFinding = candidate.findings[0];
      if (candidateFinding === undefined) throw new Error('fixture finding is missing');
      candidateFinding[mutation.key] = mutation.value;
      expect(healthV2Codec.validate(candidate), mutation.key).toMatchObject({ ok: false });
    }
  });

  test('strict changes warning exit semantics identically for human and JSON output', async () => {
    const root = await sandbox('strict');
    const codexHome = join(root, 'codex-home');
    await mkdir(join(codexHome, 'skills', 'legacy-skill'), { recursive: true });
    const base = ['-C', root, 'doctor', '--tool', 'codex', '--scope', 'user', '--offline'];
    const environment = { CODEX_HOME: codexHome };
    const [human, strictHuman, strictJson] = await Promise.all([
      runCli(root, base, environment),
      runCli(root, [...base, '--strict'], environment),
      runCli(root, [...base, '--strict', '--json'], environment),
    ]);

    expect(human.exitCode).toBe(0);
    expect(strictHuman.exitCode).toBe(1);
    expect(strictJson.exitCode).toBe(1);
    expect(human.stdout).toContain('deprecated skills path in use');
    expect(strictHuman.stdout).toContain('deprecated skills path in use');
    expect(human.stderr).toBe('');
    expect(strictHuman.stderr).toBe('');
    expect(strictJson.stderr).toBe('');
    const strictDto = json(strictJson);
    expect(strictDto).toMatchObject({
      counts: { warning: expect.any(Number) },
    });
    for (const finding of records(strictDto.findings)) {
      expect(finding.findingId).toMatch(/^finding:v1:[0-9a-f]{64}$/);
    }
  });

  test('error findings use exit 1 and remain on the selected output stream', async () => {
    const root = await sandbox('exit-semantics');
    const base = ['-C', root, 'doctor', '--tool', 'codex', '--scope', 'user', '--offline'];
    const environment = { XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '' };
    const [human, machine] = await Promise.all([
      runCli(root, base, environment),
      runCli(root, [...base, '--json'], environment),
    ]);

    expect(human.exitCode).toBe(1);
    expect(machine.exitCode).toBe(1);
    expect(human.stdout).toContain('XDG path not resolvable');
    expect(human.stderr).toBe('');
    expect(machine.stderr).toBe('');
    expect(findingIds(json(machine).findings)).toContain('xdg-paths');
  });
});

describe('EWP-CMD-DOCTOR-TS05', () => {
  test('fix dry-run previews the exact safe migration and preserves ledger bytes', async () => {
    const root = await sandbox('preview');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
      '--dry-run',
      '--json',
    ]);
    const dto = json(result);
    const repair =
      typeof dto.repair === 'object' && dto.repair !== null
        ? (dto.repair as UnknownRecord)
        : ({} as UnknownRecord);
    const operations = records(repair.operations);

    expect(result.exitCode).toBe(0);
    expect(dto.repair, 'doctor fix preview did not return a repair product').toBeDefined();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      operationId: expect.stringMatching(/^operation:v1:[0-9a-f]{64}$/),
      kind: 'migrate-ledger',
      artifact: 'ledger',
      path,
      before: { state: 'present', schemaVersion: 1 },
      after: { state: 'present', schemaVersion: 2 },
    });
    expect(repair.results).toEqual([]);
    expect(dto.mutation).toEqual({
      kind: 'preview',
      planned: 1,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('JSON execution refuses approval without --yes and performs no write', async () => {
    const root = await sandbox('json-refusal');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    const result = await runCli(root, [
      '-C',
      root,
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
      '--json',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    expect(json(result)).toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('--yes'),
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('--no-prompt human execution refuses approval without --yes and performs no write', async () => {
    const root = await sandbox('no-prompt-refusal');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('--yes');
    expect(result.stderr).toBe('');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('non-TTY human execution independently refuses approval without --yes', async () => {
    const root = await sandbox('non-tty-refusal');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    const result = await runCli(root, [
      '-C',
      root,
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('--yes');
    expect(result.stderr).toBe('');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('ledger repair matches the first-mutator projection, identity, journal, and recovery path', async () => {
    const root = await sandbox('execute-ledger');
    const path = await writeV1Ledger(root);
    const ports = await defaultRuntimePorts();
    const sourceEnvelope = await readLedgerArtifact(ports, path);
    expect(sourceEnvelope.ok).toBeTrue();
    if (!sourceEnvelope.ok || sourceEnvelope.value.state !== 'present') return;
    expect(sourceEnvelope.value.sourceVersion).toBe(1);
    const migration = sourceEnvelope.value.migration;
    expect(migration).not.toBeNull();
    if (migration === null) return;
    expect(migration.kind).toBe('ledger-v1-to-v2');
    if (migration.kind !== 'ledger-v1-to-v2') return;
    expect(migration.targetCanonicalSource.endsWith('\n')).toBeTrue();
    const expectedProjection = JSON.parse(migration.targetCanonicalSource) as UnknownRecord;
    const preview = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
      '--dry-run',
      '--json',
    ]);
    const previewOperation = records(repairFrom(json(preview)).operations)[0];
    expect(previewOperation).toMatchObject({
      operationId: expect.stringMatching(/^operation:v1:[0-9a-f]{64}$/),
      kind: 'migrate-ledger',
      path,
      before: {
        schemaVersion: 1,
        byteRevision: migration.sourceByteRevision,
        semanticRevision: migration.sourceSemanticRevision,
      },
      after: {
        schemaVersion: 2,
        byteRevision: migration.targetByteRevision,
        semanticRevision: migration.targetSemanticRevision,
      },
    });
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
      '--yes',
      '--json',
    ]);
    const dto = json(result);
    const repair =
      typeof dto.repair === 'object' && dto.repair !== null
        ? (dto.repair as UnknownRecord)
        : ({} as UnknownRecord);

    expect(result.exitCode).toBe(0);
    const executionOperation = records(repair.operations)[0];
    expect(executionOperation).toEqual(previewOperation);
    expect(records(repair.results)).toEqual([
      {
        operationId: previewOperation?.operationId,
        outcome: 'changed',
        error: null,
      },
    ]);
    expect(dto.mutation).toEqual({
      kind: 'applied',
      planned: 1,
      changed: 1,
      unchanged: 0,
      failed: 0,
    });
    const finalSource = await readFile(path, 'utf8');
    const finalLedger = JSON.parse(finalSource) as UnknownRecord;
    expect(finalSource.endsWith('\n')).toBeTrue();
    expect({
      schemaVersion: finalLedger.schemaVersion,
      kind: finalLedger.kind,
      skills: finalLedger.skills,
      projects: finalLedger.projects,
      projectRegistrations: finalLedger.projectRegistrations,
    }).toEqual({
      schemaVersion: expectedProjection.schemaVersion,
      kind: expectedProjection.kind,
      skills: expectedProjection.skills,
      projects: expectedProjection.projects,
      projectRegistrations: expectedProjection.projectRegistrations,
    });
    expect(finalLedger.transactions).toEqual({});
    expect(records(finalLedger.history)).toEqual([
      expect.objectContaining({
        phase: 'committed',
        intent: expect.objectContaining({
          operationId: previewOperation?.operationId,
          kind: 'migrate-ledger',
        }),
      }),
    ]);
    const canonicalLedgerPath = await ports.realpath(path);
    const pointerName = `v1-${createHash('sha256').update(canonicalLedgerPath).digest('hex')}.json`;
    const recoveryPath = join(root, 'data', 'skillsmith', 'recovery', 'ledger', pointerName);
    expect(recoveryPath).toMatch(/\/recovery\/ledger\/v1-[0-9a-f]{64}\.json$/u);
    expect(await Bun.file(recoveryPath).exists()).toBeFalse();
  });

  test('exact legacy project migration is byte-equivalent to the shared Phase-2 editor', async () => {
    const root = await sandbox('execute-project');
    const manifest = await writeLegacyProject(root);
    const expected = migrateLegacyManifestBytes(new TextEncoder().encode(legacyProjectSource));
    expect(expected.ok).toBeTrue();
    if (!expected.ok) return;
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--fix',
      '--yes',
      '--json',
    ]);
    const dto = json(result);
    const repair =
      typeof dto.repair === 'object' && dto.repair !== null
        ? (dto.repair as UnknownRecord)
        : ({} as UnknownRecord);

    expect(result.exitCode).toBe(0);
    expect(records(repair.operations)).toEqual([
      expect.objectContaining({
        kind: 'migrate-project-config',
        artifact: 'manifest',
        path: manifest,
      }),
    ]);
    expect(await readFile(manifest, 'utf8')).toBe(expected.value.source);
    expect(await Bun.file(join(root, 'skillsmith.lock')).exists()).toBeFalse();
  });

  test('write-lock preview and execution share identity and the canonical automatic writer', async () => {
    const root = await sandbox('write-lock-equivalence');
    const manifest = join(root, 'custom.toml');
    const lock = join(root, 'custom.lock');
    const siblingLock = join(root, 'skillsmith.lock');
    const manifestSource = 'version = 1\n';
    const invalidLock = 'not a portable lock\n';
    const siblingSource = '# not selected\n';
    await Promise.all([
      writeFile(manifest, manifestSource, 'utf8'),
      writeFile(lock, invalidLock, 'utf8'),
      writeFile(siblingLock, siblingSource, 'utf8'),
    ]);
    const readable = readManifestSource(manifestSource);
    expect(readable.ok).toBeTrue();
    if (!readable.ok) return;
    const normalized = normalizeManifestDocument(readable.value);
    expect(normalized.ok).toBeTrue();
    if (!normalized.ok) return;
    const serialized = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(normalized.value),
      skills: [],
    });
    expect(serialized.ok).toBeTrue();
    if (!serialized.ok) return;
    const base = [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--lockfile',
      lock,
      '--fix',
    ];
    const preview = await runCli(root, [...base, '--dry-run', '--json']);
    const previewOperations = records(repairFrom(json(preview)).operations);
    expect(previewOperations).toEqual([
      expect.objectContaining({
        operationId: expect.stringMatching(/^operation:v1:[0-9a-f]{64}$/),
        kind: 'write-lock',
        artifact: 'lock',
        path: lock,
      }),
    ]);
    expect(await readFile(lock, 'utf8')).toBe(invalidLock);

    const executed = await runCli(root, [...base, '--yes', '--json']);
    const executionRepair = repairFrom(json(executed));
    const executionOperations = records(executionRepair.operations);
    expect(executionOperations.map((operation) => operation.operationId)).toEqual(
      previewOperations.map((operation) => operation.operationId),
    );
    expect(records(executionRepair.results)).toEqual([
      {
        operationId: previewOperations[0]?.operationId,
        outcome: 'changed',
        error: null,
      },
    ]);
    expect(await readFile(lock, 'utf8')).toBe(serialized.value);
    expect(await readFile(siblingLock, 'utf8')).toBe(siblingSource);
  });

  test('project migration keeps lock diagnosis visible but defers lock repair to the converged rerun', async () => {
    const root = await sandbox('project-lock-converged-rerun');
    const manifest = await writeLegacyProject(root);
    const lock = join(root, 'skillsmith.lock');
    const invalidLock = 'not a portable lock\n';
    await writeFile(lock, invalidLock, 'utf8');
    const base = [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--lockfile',
      lock,
      '--fix',
    ];

    const preview = await runCli(root, [...base, '--dry-run', '--json']);
    expect(records(json(preview).findings).map((finding) => finding.operation)).toEqual(
      expect.arrayContaining(['migrate-project-config', 'write-lock']),
    );
    expect(
      records(repairFrom(json(preview)).operations).map((operation) => operation.kind),
    ).toEqual(['migrate-project-config']);
    expect(await readFile(lock, 'utf8')).toBe(invalidLock);

    const migrated = await runCli(root, [...base, '--yes', '--json']);
    expect(
      records(repairFrom(json(migrated)).operations).map((operation) => operation.kind),
    ).toEqual(['migrate-project-config']);
    const migratedSource = await readFile(manifest, 'utf8');
    const readable = readManifestSource(migratedSource);
    expect(readable).toMatchObject({ ok: true, value: { shape: 'canonical' } });
    expect(await readFile(lock, 'utf8')).toBe(invalidLock);

    const converged = await runCli(root, [...base, '--dry-run', '--json']);
    expect(
      records(repairFrom(json(converged)).operations).map((operation) => operation.kind),
    ).toEqual(['write-lock']);
  });

  test('failed project migration never attempts the deferred lock repair coordinator path', async () => {
    const root = await sandbox('project-lock-migration-failure');
    const manifest = await writeLegacyProject(root);
    const lock = join(root, 'skillsmith.lock');
    const invalidLock = 'not a portable lock\n';
    await writeFile(lock, invalidLock, 'utf8');
    const ports = await defaultRuntimePorts();
    const backing = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    let firstManifestRead = true;
    let lockCoordinatorCalls = 0;
    const artifactCoordinator: CurrentApplicationContext['artifactCoordinator'] = {
      ...backing,
      observe: async (path) => {
        if (path === lock) lockCoordinatorCalls += 1;
        return backing.observe(path);
      },
      readBytes: async (path) => {
        if (path === lock) lockCoordinatorCalls += 1;
        if (path === manifest && firstManifestRead) {
          firstManifestRead = false;
          throw Object.assign(new Error('synthetic migration refusal'), { code: 'EACCES' });
        }
        return backing.readBytes(path);
      },
      withFileLock: async (target, options, operation) => {
        if (target === lock) lockCoordinatorCalls += 1;
        return backing.withFileLock(target, options, operation);
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'project',
          offline: true,
          file: manifest,
          lockfile: lock,
          fix: true,
          yes: true,
          json: true,
        },
      },
      doctorContext({ ports, artifactCoordinator, project }),
    );
    const repair = repairFrom(record(record(outcome.report).result));

    expect(records(repair.operations).map((operation) => operation.kind)).toEqual([
      'migrate-project-config',
    ]);
    expect(records(repair.results)).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    expect(lockCoordinatorCalls).toBe(0);
    expect(await readFile(lock, 'utf8')).toBe(invalidLock);
  });

  test('project repair uses the injected coordinator and never a host filesystem adapter', async () => {
    const root = await sandbox('injected-project-coordinator');
    const manifest = await writeLegacyProject(root);
    const before = await readFile(manifest, 'utf8');
    const basePorts = await defaultRuntimePorts();
    const backing = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    let observations = 0;
    const artifactCoordinator: CurrentApplicationContext['artifactCoordinator'] = {
      ...backing,
      observe: async (path) => {
        observations += 1;
        throw artifactMutationError('permission-denied', { path });
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'project',
          offline: true,
          file: manifest,
          fix: true,
          yes: true,
          json: true,
        },
      },
      doctorContext({ ports: basePorts, artifactCoordinator, project }),
    );

    expect(observations).toBeGreaterThan(0);
    expect(outcome.exitClass).toBe('failure');
    expect(records(repairFrom(record(record(outcome.report).result)).results)).toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    expect(await readFile(manifest, 'utf8')).toBe(before);
  });

  test('write-lock passes the exact previewed canonical revision to the injected coordinator', async () => {
    const root = await sandbox('exact-lock-before');
    const manifest = join(root, 'skillsmith.toml');
    const lock = join(root, 'skillsmith.lock');
    await writeFile(manifest, 'version = 1\n', 'utf8');
    const stale = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics({
        version: 1,
        defaults: { scope: 'project' },
        skills: [],
      }),
      skills: [],
    });
    const external = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics({
        version: 1,
        defaults: { tools: ['codex'] },
        skills: [],
      }),
      skills: [],
    });
    expect(stale.ok && external.ok).toBeTrue();
    if (!stale.ok || !external.ok) return;
    await writeFile(lock, stale.value, 'utf8');
    const basePorts = await defaultRuntimePorts();
    const backing = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    let changed = false;
    const artifactCoordinator: CurrentApplicationContext['artifactCoordinator'] = {
      ...backing,
      observe: async (path) => {
        if (path === lock && !changed) {
          changed = true;
          await writeFile(lock, external.value, 'utf8');
        }
        return backing.observe(path);
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'project',
          offline: true,
          file: manifest,
          lockfile: lock,
          fix: true,
          yes: true,
          json: true,
        },
      },
      doctorContext({ ports: basePorts, artifactCoordinator, project }),
    );
    const dto = record(record(outcome.report).result);

    expect(changed).toBeTrue();
    expect(outcome.exitClass).toBe('state');
    expect(records(repairFrom(dto).results)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        error: expect.objectContaining({ code: 'stale-state' }),
      }),
    ]);
    expect(await readFile(lock, 'utf8')).toBe(external.value);
  });

  test('offline lock repair refuses unresolved sources without guessing an after-image', async () => {
    const root = await sandbox('offline-lock-resolution');
    const manifest = join(root, 'skillsmith.toml');
    const lock = join(root, 'skillsmith.lock');
    const source =
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "alpha"\nsource = "example.test/acme/skills//alpha"\nref = "main"\n';
    await writeFile(manifest, source, 'utf8');
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--lockfile',
      lock,
      '--fix',
      '--dry-run',
      '--json',
    ]);
    const dto = json(result);

    expect(result.exitCode).toBe(1);
    expect(records(repairFrom(dto).operations)).toEqual([]);
    expect(records(dto.findings)).toEqual([
      expect.objectContaining({ operation: 'write-lock', path: lock }),
    ]);
    expect(await Bun.file(lock).exists()).toBeFalse();
  });

  test('stale under-lock ledger revalidation refuses with state semantics and exact source bytes', async () => {
    const root = await sandbox('stale-revalidation');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    const changed = v1Ledger().replace('2026-07-15T00:00:00.000Z', '2026-07-15T00:00:01.000Z');
    const basePorts = await defaultRuntimePorts();
    let reads = 0;
    const ports: CurrentApplicationContext['ports'] = {
      ...basePorts,
      readBytes: async (candidate) => {
        if (candidate !== path) return basePorts.readBytes(candidate);
        reads += 1;
        return new TextEncoder().encode(reads === 1 ? before : changed);
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'user',
          offline: true,
          fix: true,
          yes: true,
          json: true,
        },
      },
      doctorContext({
        ports,
        project,
        configuration: resolveRuntimeConfiguration({
          SKILLSMITH_HOME: join(root, 'data', 'skillsmith'),
        }),
      }),
    );

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(outcome.exitClass).toBe('state');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('permission failure emits a correlated failed result, counters, and numeric adapter exit 6', async () => {
    const root = await sandbox('permission-failure');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    const basePorts = await defaultRuntimePorts();
    let attempts = 0;
    const ports: CurrentApplicationContext['ports'] = {
      ...basePorts,
      writeTextFile: async () => {
        attempts += 1;
        throw Object.assign(new Error('synthetic local permission fixture'), { code: 'EACCES' });
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const execution = await runDoctorThroughCliAdapter(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'user',
          offline: true,
          fix: true,
          yes: true,
          json: true,
        },
      },
      doctorContext({
        ports,
        project,
        configuration: resolveRuntimeConfiguration({
          SKILLSMITH_HOME: join(root, 'data', 'skillsmith'),
        }),
      }),
    );
    const outcome = execution.outcome;
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;

    const dto = record(record(outcome.report).result);
    const repair = repairFrom(dto);
    const operation = records(repair.operations)[0];
    expect(attempts).toBeGreaterThan(0);
    expect(outcome.exitClass).toBe('permission');
    expect(records(repair.results)).toEqual([
      {
        operationId: operation?.operationId,
        outcome: 'failed',
        error: expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          remediation: expect.any(String),
        }),
      },
    ]);
    expect(dto.mutation).toEqual({
      kind: 'applied',
      planned: 1,
      changed: 0,
      unchanged: 0,
      failed: 1,
    });
    expect({ exitCode: execution.exitCode, exits: execution.exits }).toEqual({
      exitCode: 6,
      exits: [6],
    });
    expect(JSON.stringify(outcome)).not.toContain('synthetic local permission fixture');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('online lock source-resolution failure emits numeric adapter exit 5 and never guesses a lock', async () => {
    const root = await sandbox('source-failure');
    const manifest = join(root, 'skillsmith.toml');
    const lock = join(root, 'skillsmith.lock');
    await writeFile(
      manifest,
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "alpha"\nsource = "example.test/acme/skills//alpha"\nref = "main"\n',
      'utf8',
    );
    const basePorts = await defaultRuntimePorts();
    let resolutions = 0;
    const ports: CurrentApplicationContext['ports'] = {
      ...basePorts,
      http: { request: async () => ({ status: 200, ok: true }) },
      git: {
        ...basePorts.git,
        resolveRemoteRef: async () => {
          resolutions += 1;
          throw new Error('synthetic credential-free resolution fixture');
        },
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const execution = await runDoctorThroughCliAdapter(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'project',
          file: manifest,
          lockfile: lock,
          offline: false,
          fix: true,
          dryRun: true,
          json: true,
        },
      },
      doctorContext({ ports, project }),
    );
    const outcome = execution.outcome;
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;

    expect(resolutions).toBe(1);
    expect(outcome.exitClass).toBe('source');
    expect({ exitCode: execution.exitCode, exits: execution.exits }).toEqual({
      exitCode: 5,
      exits: [5],
    });
    expect(await Bun.file(lock).exists()).toBeFalse();
  });

  test('online exact source resolution rebuilds the write-lock preview from verified lock facts', async () => {
    const root = await sandbox('source-success');
    const manifest = join(root, 'skillsmith.toml');
    const lock = join(root, 'skillsmith.lock');
    const manifestSource =
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "alpha"\nsource = "example.test/acme/skills//alpha"\nref = "main"\n';
    await writeFile(manifest, manifestSource, 'utf8');
    const readable = readManifestSource(manifestSource);
    expect(readable.ok).toBeTrue();
    if (!readable.ok) return;
    const normalized = normalizeManifestDocument(readable.value);
    expect(normalized.ok).toBeTrue();
    if (!normalized.ok) return;
    const resolvedSha = '1'.repeat(40);
    const stale = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics({ version: 1, skills: [] }),
      skills: [
        {
          name: 'alpha',
          source: 'example.test/acme/skills//alpha',
          requestedRef: 'main',
          resolvedSha,
          sourcePath: 'alpha',
          contentHash: hashManifestSemantics(normalized.value),
        },
      ],
    });
    expect(stale.ok).toBeTrue();
    if (!stale.ok) return;
    await writeFile(lock, stale.value, 'utf8');
    const basePorts = await defaultRuntimePorts();
    let resolutions = 0;
    const ports: CurrentApplicationContext['ports'] = {
      ...basePorts,
      git: {
        ...basePorts.git,
        resolveRemoteRef: async ({ remoteUrl, ref }) => {
          resolutions += 1;
          expect({ remoteUrl, ref }).toEqual({
            remoteUrl: 'https://example.test/acme/skills.git',
            ref: 'main',
          });
          return resolvedSha;
        },
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'project',
          file: manifest,
          lockfile: lock,
          offline: false,
          fix: true,
          dryRun: true,
          json: true,
        },
      },
      doctorContext({ ports, project }),
    );
    const dto = record(record(outcome.report).result);

    expect(resolutions).toBe(1);
    expect(outcome.exitClass).toBe('success');
    expect(records(repairFrom(dto).operations)).toEqual([
      expect.objectContaining({ kind: 'write-lock', artifact: 'lock', path: lock }),
    ]);
    expect(records(dto.findings)).toEqual([
      expect.objectContaining({
        severity: 'info',
        operation: 'write-lock',
        path: lock,
      }),
    ]);
    expect(await readFile(lock, 'utf8')).toBe(stale.value);
  });

  test('execute-mode source refusal matrix preserves a canonical lock without coordinator activity', async () => {
    for (const fixture of [
      { id: 'null', resolved: null },
      { id: 'malformed', resolved: 'not-a-commit-sha' },
      { id: 'changed', resolved: '2'.repeat(40) },
    ] as const) {
      const root = await sandbox(`source-refusal-${fixture.id}`);
      const manifest = join(root, 'skillsmith.toml');
      const lock = join(root, 'skillsmith.lock');
      const manifestSource =
        'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "alpha"\nsource = "example.test/acme/skills//alpha"\nref = "main"\n';
      await writeFile(manifest, manifestSource, 'utf8');
      const readable = readManifestSource(manifestSource);
      expect(readable.ok, fixture.id).toBeTrue();
      if (!readable.ok) continue;
      const normalized = normalizeManifestDocument(readable.value);
      expect(normalized.ok, fixture.id).toBeTrue();
      if (!normalized.ok) continue;
      const lockedSha = '1'.repeat(40);
      const stale = serializePortableLock({
        version: 1,
        hashSchemaVersion: 1,
        manifestHash: hashManifestSemantics({ version: 1, skills: [] }),
        skills: [
          {
            name: 'alpha',
            source: 'example.test/acme/skills//alpha',
            requestedRef: 'main',
            resolvedSha: lockedSha,
            sourcePath: 'alpha',
            contentHash: hashManifestSemantics(normalized.value),
          },
        ],
      });
      expect(stale.ok, fixture.id).toBeTrue();
      if (!stale.ok) continue;
      await writeFile(lock, stale.value, 'utf8');
      const before = await readFile(lock, 'utf8');
      const basePorts = await defaultRuntimePorts();
      let resolutions = 0;
      let runtimeWrites = 0;
      const ports: CurrentApplicationContext['ports'] = {
        ...basePorts,
        http: { request: async () => ({ status: 200, ok: true }) },
        git: {
          ...basePorts.git,
          resolveRemoteRef: async () => {
            resolutions += 1;
            return fixture.resolved;
          },
        },
        makeDir: async (path) => {
          runtimeWrites += 1;
          await basePorts.makeDir(path);
        },
        writeTextFile: async (path, source) => {
          runtimeWrites += 1;
          await basePorts.writeTextFile(path, source);
        },
        rename: async (from, to) => {
          runtimeWrites += 1;
          await basePorts.rename(from, to);
        },
        copyTree: async (from, to) => {
          runtimeWrites += 1;
          await basePorts.copyTree(from, to);
        },
        removeTree: async (path) => {
          runtimeWrites += 1;
          await basePorts.removeTree(path);
        },
        fsyncFile: async (path) => {
          runtimeWrites += 1;
          await basePorts.fsyncFile(path);
        },
        fsyncDir: async (path) => {
          runtimeWrites += 1;
          await basePorts.fsyncDir(path);
        },
      };
      const backing = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      let coordinatorCalls = 0;
      const artifactCoordinator = new Proxy(backing, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            coordinatorCalls += 1;
            return Reflect.apply(value, target, args);
          };
        },
      }) as CurrentApplicationContext['artifactCoordinator'];
      const project: ProjectContext = {
        ...projectContext,
        invocationCwd: root,
        effectiveCwd: root,
        projectRoot: root,
        projectIdentity: root,
      };
      const execution = await runDoctorThroughCliAdapter(
        {
          arguments: [],
          options: {
            tool: ['codex'],
            scope: 'project',
            file: manifest,
            lockfile: lock,
            offline: false,
            fix: true,
            yes: true,
            json: true,
          },
        },
        doctorContext({ ports, artifactCoordinator, project }),
      );
      const outcome = execution.outcome;
      expect(outcome, fixture.id).toBeDefined();
      if (outcome === undefined) continue;
      const dto = record(record(outcome.report).result);

      expect(resolutions, fixture.id).toBe(1);
      expect(outcome.exitClass, fixture.id).toBe('source');
      expect({ exitCode: execution.exitCode, exits: execution.exits }, fixture.id).toEqual({
        exitCode: 5,
        exits: [5],
      });
      expect(records(repairFrom(dto).operations), fixture.id).toEqual([]);
      expect(records(repairFrom(dto).results), fixture.id).toEqual([]);
      expect(coordinatorCalls, fixture.id).toBe(0);
      expect(runtimeWrites, fixture.id).toBe(0);
      expect(await readFile(lock, 'utf8'), fixture.id).toBe(before);
    }
  });

  test('one interactive bulk approval authorizes the nonempty repair plan', async () => {
    const root = await sandbox('interactive-approval');
    const path = await writeV1Ledger(root);
    let confirmations = 0;
    const approving: InteractionPort = {
      mode: 'interactive',
      choose: async () => ({ status: 'refused', reason: 'not used' }),
      confirm: async () => {
        confirmations += 1;
        return { status: 'resolved', value: true };
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const execution = await runDoctorThroughCliAdapter(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'user',
          offline: true,
          fix: true,
          json: true,
        },
      },
      doctorContext({
        ports: await defaultRuntimePorts(),
        artifactCoordinator: await createTestNodeArtifactCoordinatorPorts(
          join(root, 'coordination'),
        ),
        interaction: approving,
        project,
        configuration: resolveRuntimeConfiguration({
          SKILLSMITH_HOME: join(root, 'data', 'skillsmith'),
        }),
      }),
    );
    const outcome = execution.outcome;
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;

    expect(confirmations).toBe(1);
    expect(outcome.exitClass).toBe('success');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 2 });
  });

  test('two independent repair operations still receive exactly one bulk approval', async () => {
    const root = await sandbox('multi-operation-approval');
    const ledger = await writeV1Ledger(root);
    const manifest = await writeLegacyProject(root);
    const expectedManifest = migrateLegacyManifestBytes(
      new TextEncoder().encode(legacyProjectSource),
    );
    expect(expectedManifest.ok).toBeTrue();
    if (!expectedManifest.ok) return;
    let confirmations = 0;
    const approving: InteractionPort = {
      mode: 'interactive',
      choose: async () => ({ status: 'refused', reason: 'not used' }),
      confirm: async () => {
        confirmations += 1;
        return { status: 'resolved', value: true };
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'project',
          file: manifest,
          offline: true,
          fix: true,
          json: true,
        },
      },
      doctorContext({
        ports: await defaultRuntimePorts(),
        artifactCoordinator: await createTestNodeArtifactCoordinatorPorts(
          join(root, 'coordination'),
        ),
        interaction: approving,
        project,
        configuration: resolveRuntimeConfiguration({
          SKILLSMITH_HOME: join(root, 'data', 'skillsmith'),
        }),
      }),
    );
    const operations = records(record(record(record(outcome.report).result).repair).operations).map(
      (item) => item.kind,
    );

    expect(confirmations).toBe(1);
    expect(operations).toEqual(['migrate-ledger', 'migrate-project-config']);
    expect(JSON.parse(await readFile(ledger, 'utf8'))).toMatchObject({ schemaVersion: 2 });
    expect(await readFile(manifest, 'utf8')).toBe(expectedManifest.value.source);
  });

  test('a failed first repair stays correlated while the independent second repair succeeds', async () => {
    const root = await sandbox('independent-repair-failure');
    const ledger = await writeV1Ledger(root);
    const ledgerBefore = await readFile(ledger, 'utf8');
    const manifest = await writeLegacyProject(root);
    const expectedManifest = migrateLegacyManifestBytes(
      new TextEncoder().encode(legacyProjectSource),
    );
    expect(expectedManifest.ok).toBeTrue();
    if (!expectedManifest.ok) return;
    const basePorts = await defaultRuntimePorts();
    const ledgerDirectory = join(root, 'data', 'skillsmith');
    let deniedWrites = 0;
    const ports: CurrentApplicationContext['ports'] = {
      ...basePorts,
      writeTextFile: async (candidate, source) => {
        if (candidate === ledger || candidate.startsWith(`${ledgerDirectory}/`)) {
          deniedWrites += 1;
          throw Object.assign(new Error('synthetic first-operation denial'), { code: 'EACCES' });
        }
        await basePorts.writeTextFile(candidate, source);
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'project',
          file: manifest,
          offline: true,
          fix: true,
          yes: true,
          json: true,
        },
      },
      doctorContext({
        ports,
        artifactCoordinator: await createTestNodeArtifactCoordinatorPorts(
          join(root, 'coordination'),
        ),
        project,
        configuration: resolveRuntimeConfiguration({
          SKILLSMITH_HOME: ledgerDirectory,
        }),
      }),
    );
    const dto = record(record(outcome.report).result);
    const repair = repairFrom(dto);
    const operations = records(repair.operations);
    const results = records(repair.results);

    expect(deniedWrites).toBeGreaterThan(0);
    expect(operations.map((operation) => operation.kind)).toEqual([
      'migrate-ledger',
      'migrate-project-config',
    ]);
    expect(results).toEqual([
      {
        operationId: operations[0]?.operationId,
        outcome: 'failed',
        error: expect.objectContaining({ code: expect.any(String) }),
      },
      { operationId: operations[1]?.operationId, outcome: 'changed', error: null },
    ]);
    expect(dto.mutation).toEqual({
      kind: 'applied',
      planned: 2,
      changed: 1,
      unchanged: 0,
      failed: 1,
    });
    expect(await readFile(ledger, 'utf8')).toBe(ledgerBefore);
    expect(await readFile(manifest, 'utf8')).toBe(expectedManifest.value.source);
  });

  test('an explicit false approval refuses the whole plan and retains exact bytes', async () => {
    const root = await sandbox('interactive-refusal');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    let confirmations = 0;
    const refusing: InteractionPort = {
      mode: 'interactive',
      choose: async () => ({ status: 'refused', reason: 'not used' }),
      confirm: async () => {
        confirmations += 1;
        return { status: 'resolved', value: false };
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'user',
          offline: true,
          fix: true,
          json: true,
        },
      },
      doctorContext({
        ports: await defaultRuntimePorts(),
        interaction: refusing,
        project,
        configuration: resolveRuntimeConfiguration({
          SKILLSMITH_HOME: join(root, 'data', 'skillsmith'),
        }),
      }),
    );

    expect(confirmations).toBe(1);
    expect(outcome.exitClass).toBe('usage');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('an interactive cancelled approval returns numeric 130 through the CLI adapter with no writes', async () => {
    const root = await sandbox('interactive-cancelled');
    const path = await writeV1Ledger(root);
    const before = await readFile(path, 'utf8');
    const basePorts = await defaultRuntimePorts();
    const writes: string[] = [];
    const ports: CurrentApplicationContext['ports'] = {
      ...basePorts,
      writeTextFile: async (candidate, source) => {
        writes.push(candidate);
        await basePorts.writeTextFile(candidate, source);
      },
    };
    let confirmations = 0;
    const cancelled: InteractionPort = {
      mode: 'interactive',
      choose: async () => ({ status: 'refused', reason: 'not used' }),
      confirm: async () => {
        confirmations += 1;
        return { status: 'cancelled' };
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const execution = await runDoctorThroughCliAdapter(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'user',
          offline: true,
          fix: true,
          json: true,
        },
      },
      doctorContext({
        ports,
        interaction: cancelled,
        project,
        configuration: resolveRuntimeConfiguration({
          SKILLSMITH_HOME: join(root, 'data', 'skillsmith'),
        }),
      }),
    );
    const outcome = execution.outcome;
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;

    expect(confirmations).toBe(1);
    expect(outcome.exitClass).toBe('cancelled');
    expect({ exitCode: execution.exitCode, exits: execution.exits }).toEqual({
      exitCode: 130,
      exits: [130],
    });
    expect(writes).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test("a clean fix no-op reports exact human 'No repairs needed' and an empty mutation", async () => {
    const root = await sandbox('clean-noop');
    const base = [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
    ];
    const [human, result] = await Promise.all([
      runCli(root, base),
      runCli(root, [...base, '--json']),
    ]);

    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe('No repairs needed\n');
    expect(human.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(json(result)).toMatchObject({
      repair: { mode: 'execute', operations: [], results: [] },
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
    });
  });

  test('unsafe ledger state refuses before repair and retains exact source bytes', async () => {
    const root = await sandbox('failed-byte-identity');
    const path = join(root, 'data', 'skillsmith', 'placements.json');
    await mkdir(join(root, 'data', 'skillsmith'), { recursive: true });
    const before = '{"schemaVersion":1';
    await writeFile(path, before, 'utf8');
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--fix',
      '--yes',
      '--json',
    ]);

    expect(result.exitCode).toBe(3);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('nonportable legacy project state remains manual and is never normalized', async () => {
    const root = await sandbox('manual-project');
    const manifest = join(root, 'skillsmith.toml');
    const before = 'tool = "codex"\nscope = "project"\npath = "/opt/shared/skills"\n';
    await writeFile(manifest, before, 'utf8');
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--fix',
      '--dry-run',
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('No automatic repairs available');
    expect(await readFile(manifest, 'utf8')).toBe(before);
  });

  test('--fix refuses a mixed canonical-and-legacy project shape and preserves the artifact pair', async () => {
    const root = await sandbox('mixed-project-fix-refusal');
    const manifest = join(root, 'skillsmith.toml');
    const lock = join(root, 'skillsmith.lock');
    const manifestBefore = 'version = 1\ntool = "codex"\nscope = "project"\npath = "./skills"\n';
    const lockBefore = 'ambiguous lock bytes\n';
    await Promise.all([
      writeFile(manifest, manifestBefore, 'utf8'),
      writeFile(lock, lockBefore, 'utf8'),
    ]);
    const result = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--lockfile',
      lock,
      '--fix',
      '--yes',
      '--json',
    ]);

    expect(result.exitCode).toBe(3);
    expect(records(repairFrom(json(result)).operations)).toEqual([]);
    expect(await readFile(manifest, 'utf8')).toBe(manifestBefore);
    expect(await readFile(lock, 'utf8')).toBe(lockBefore);
  });

  test('pre-aborted repair returns cancellation and never invokes a write capability', async () => {
    const controller = new AbortController();
    controller.abort();
    const path = '/fixture/data/skillsmith/placements.json';
    const source = v1Ledger();
    const base = detectedCodexEnv();
    const env: ScanEnv = {
      ...base,
      fileExists: async (candidate) => candidate === path || base.fileExists(candidate),
      pathKind: async (candidate) => (candidate === path ? 'file' : base.pathKind(candidate)),
      readText: async (candidate) => (candidate === path ? source : ''),
      readBytes: async (candidate) => new TextEncoder().encode(candidate === path ? source : ''),
    };
    const writes: string[] = [];
    const record = (name: string) => async () => {
      writes.push(name);
    };
    const ports = {
      ...runtimePorts(env),
      makeDir: record('makeDir'),
      writeTextFile: record('writeTextFile'),
      rename: record('rename'),
      removeTree: record('removeTree'),
      fsyncFile: record('fsyncFile'),
      fsyncDir: record('fsyncDir'),
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'user',
          offline: true,
          fix: true,
          yes: true,
          json: true,
        },
      },
      doctorContext({ ports, signal: controller.signal }),
    );

    expect(outcome.exitClass).toBe('cancelled');
    expect(writes).toEqual([]);
  });

  test('post-start cancellation stops at a durable boundary and emits no partial health product', async () => {
    const root = await sandbox('post-start-cancellation');
    const path = await writeV1Ledger(root);
    const controller = new AbortController();
    const basePorts = await defaultRuntimePorts();
    let writes = 0;
    const ports: CurrentApplicationContext['ports'] = {
      ...basePorts,
      writeTextFile: async (candidate, source) => {
        writes += 1;
        await basePorts.writeTextFile(candidate, source);
        controller.abort();
      },
    };
    const project: ProjectContext = {
      ...projectContext,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
    };
    const outcome = await runDoctorApplication(
      {
        arguments: [],
        options: {
          tool: ['codex'],
          scope: 'user',
          offline: true,
          fix: true,
          yes: true,
          json: true,
        },
      },
      doctorContext({
        ports,
        signal: controller.signal,
        project,
        configuration: resolveRuntimeConfiguration({
          SKILLSMITH_HOME: join(root, 'data', 'skillsmith'),
        }),
      }),
    );

    expect(writes).toBeGreaterThan(0);
    expect(outcome.exitClass).toBe('cancelled');
    expect(record(outcome.report).result).toBeNull();
    expect(await Bun.file(path).exists()).toBeTrue();
  });

  test('bounded fixture drains both pipes concurrently below the output cap', async () => {
    const root = await sandbox('bounded-drain');
    const result = await runBoundedProcess(
      root,
      [
        'bun',
        '-e',
        "process.stdout.write('o'.repeat(400000)); process.stderr.write('e'.repeat(400000));",
      ],
      {},
      { workDeadlineMs: 2_000, absoluteDeadlineMs: 4_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(400_000);
    expect(result.stderr).toHaveLength(400_000);
  });

  test('one rejected output reader cannot leave its sibling reader or child unawaited', async () => {
    const root = await sandbox('bounded-reader-rejection');
    let pid: number | undefined;
    await expect(
      runBoundedProcess(
        root,
        [
          'bun',
          '-e',
          `process.stdout.write('o'.repeat(${CLI_OUTPUT_LIMIT_BYTES + 1})); setInterval(() => process.stderr.write('e'), 25);`,
        ],
        {},
        {
          workDeadlineMs: 1_000,
          absoluteDeadlineMs: 2_000,
          termGraceMs: 100,
          killGraceMs: 500,
          onSpawn: (spawned) => {
            pid = spawned;
          },
        },
      ),
    ).rejects.toThrow('stdout exceeded');
    const childPid = pid;
    expect(childPid).toBeDefined();
    if (childPid !== undefined) expect(() => process.kill(childPid, 0)).toThrow();
  });

  test('bounded fixture awaits KILL after the work absolute deadline is exhausted', async () => {
    const root = await sandbox('bounded-kill');
    let pid: number | undefined;
    const startedAt = Date.now();
    await expect(
      runBoundedProcess(
        root,
        [
          'bun',
          '-e',
          "process.on('SIGTERM', () => process.stderr.write('term\\n')); setInterval(() => {}, 1000);",
        ],
        {},
        {
          workDeadlineMs: 150,
          absoluteDeadlineMs: 300,
          termGraceMs: 250,
          killGraceMs: 750,
          onSpawn: (spawned) => {
            pid = spawned;
          },
        },
      ),
    ).rejects.toThrow('work deadline');
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(pid).toBeDefined();
    const childPid = pid;
    if (childPid !== undefined) expect(() => process.kill(childPid, 0)).toThrow();
  });
});

describe('EWP-CMD-DOCTOR-TS06', () => {
  test('ledger remediation parses and previews the exact finding target', async () => {
    const root = await sandbox('remediation');
    const path = await writeV1Ledger(root);
    const result = await runCli(root, healthArgs(root));
    const migration = records(json(result).findings).find(
      (finding) => finding.operation === 'migrate-ledger',
    );
    expect(migration, 'doctor did not expose migrate-ledger remediation').toBeDefined();
    if (migration === undefined) return;
    const remediation = String(migration.remediation ?? '');
    const command = remediationCommand(remediation);

    expect(remediation).toBe("run 'skillsmith doctor --fix' to migrate the selected ledger");
    expect(command).toEqual(['skillsmith', 'doctor', '--fix']);
    expect(remediation).not.toMatch(/skillsmith\s+(?:ledger\s+)?migrate/u);
    expect(remediation).not.toMatch(/skillsmith\s+migrate(?:-project-config|-ledger)?/u);
    const preview = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      ...command.slice(1),
      '--tool',
      'codex',
      '--scope',
      'user',
      '--offline',
      '--dry-run',
      '--json',
    ]);
    const dto = json(preview);
    const repair =
      typeof dto.repair === 'object' && dto.repair !== null
        ? (dto.repair as UnknownRecord)
        : ({} as UnknownRecord);
    expect(preview.exitCode).toBe(0);
    expect(
      records(repair.operations).map(({ kind, path: target }) => ({ kind, path: target })),
    ).toEqual([{ kind: 'migrate-ledger', path }]);
  });

  test('custom project remediation preserves the explicit artifact-pair target', async () => {
    const root = await sandbox('project-remediation');
    const manifest = await writeLegacyProject(root);
    const lock = join(root, 'custom.lock');
    const diagnosed = await runCli(root, [
      '-C',
      root,
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--lockfile',
      lock,
      '--json',
    ]);
    const finding = records(json(diagnosed).findings).find(
      (candidate) => candidate.operation === 'migrate-project-config',
    );
    expect(finding, 'doctor did not expose project migration remediation').toBeDefined();
    if (finding === undefined) return;
    const remediation = String(finding.remediation ?? '');
    const command = remediationCommand(remediation);

    expect(remediation).toBe(
      `run 'skillsmith doctor --fix --file "${manifest}" --lockfile "${lock}"' to migrate the selected project configuration`,
    );
    expect(command).toEqual([
      'skillsmith',
      'doctor',
      '--fix',
      '--file',
      manifest,
      '--lockfile',
      lock,
    ]);
    const preview = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      ...command.slice(1),
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--dry-run',
      '--json',
    ]);
    const dto = json(preview);
    const repair =
      typeof dto.repair === 'object' && dto.repair !== null
        ? (dto.repair as UnknownRecord)
        : ({} as UnknownRecord);
    expect(
      records(repair.operations).map(({ kind, path: target }) => ({ kind, path: target })),
    ).toEqual([{ kind: 'migrate-project-config', path: manifest }]);
  });

  test('custom write-lock remediation preserves the exact manifest and lock ownership pair', async () => {
    const root = await sandbox('write-lock-remediation');
    const manifest = join(root, 'custom.toml');
    const lock = join(root, 'custom.lock');
    await writeFile(manifest, 'version = 1\n', 'utf8');
    await writeFile(lock, 'not a canonical lock\n', 'utf8');
    const diagnosed = await runCli(root, [
      '-C',
      root,
      'doctor',
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--file',
      manifest,
      '--lockfile',
      lock,
      '--json',
    ]);
    const finding = records(json(diagnosed).findings).find(
      (candidate) => candidate.operation === 'write-lock',
    );
    expect(finding, 'doctor did not expose write-lock remediation').toBeDefined();
    if (finding === undefined) return;
    const remediation = String(finding.remediation ?? '');
    const command = remediationCommand(remediation);

    expect(remediation).toBe(
      `run 'skillsmith doctor --fix --file "${manifest}" --lockfile "${lock}"' to regenerate the selected lock`,
    );
    expect(command).toEqual([
      'skillsmith',
      'doctor',
      '--fix',
      '--file',
      manifest,
      '--lockfile',
      lock,
    ]);
    const preview = await runCli(root, [
      '-C',
      root,
      '--no-prompt',
      ...command.slice(1),
      '--tool',
      'codex',
      '--scope',
      'project',
      '--offline',
      '--dry-run',
      '--json',
    ]);
    expect(
      records(repairFrom(json(preview)).operations).map(({ kind, path: target }) => ({
        kind,
        path: target,
      })),
    ).toEqual([{ kind: 'write-lock', path: lock }]);
  });

  test('the live command catalog contains no standalone migration command', () => {
    const paths = CURRENT_COMMAND_SPECS.map((spec) => spec.path);
    expect(paths).toContain('skillsmith doctor');
    expect(paths.filter((path) => /(?:^|\s)migrate(?:-|\s|$)/u.test(path))).toEqual([]);
  });
});
