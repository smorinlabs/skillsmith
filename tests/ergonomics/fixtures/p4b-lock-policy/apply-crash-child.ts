import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { runApplyApplication } from '../../../../packages/core/src/application/apply-service.ts';
import type { CurrentApplicationContext } from '../../../../packages/core/src/application/types.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../../packages/core/src/artifacts/node-coordinator.ts';
import { resolveRuntimeConfiguration } from '../../../../packages/core/src/config/runtime.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../../../packages/core/src/observation/index.ts';
import { readLedgerState } from '../../../../packages/core/src/place/ledger.ts';
import { ledgerPathOf } from '../../../../packages/core/src/place/paths.ts';
import { defaultRuntimePorts } from '../../../../packages/core/src/ports/default.ts';

const MAX_MESSAGE_BYTES = 64 * 1024;

type CrashTarget = 'artifact-manifest' | 'artifact-lock' | 'ledger' | 'live' | 'none';

interface StartMessage {
  readonly kind: 'start';
  readonly target: CrashTarget;
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly manifest: string;
  readonly lock: string;
  readonly coordinationRoot: string;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const iterator = lines[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done || Buffer.byteLength(first.value) > MAX_MESSAGE_BYTES) {
  throw new Error('invalid G4B-03 crash-child message');
}

const message = JSON.parse(first.value) as Partial<StartMessage>;
const targets = new Set<CrashTarget>([
  'artifact-manifest',
  'artifact-lock',
  'ledger',
  'live',
  'none',
]);
if (
  message.kind !== 'start' ||
  typeof message.target !== 'string' ||
  !targets.has(message.target as CrashTarget) ||
  [
    message.root,
    message.cwd,
    message.home,
    message.config,
    message.data,
    message.cache,
    message.manifest,
    message.lock,
    message.coordinationRoot,
  ].some((value) => typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
) {
  throw new Error('invalid G4B-03 crash-child protocol');
}

const start = message as StartMessage;
let reached = false;
const stop = async (barrier: Readonly<Record<string, unknown>>): Promise<never> => {
  if (reached) return new Promise<never>(() => undefined);
  reached = true;
  process.stdout.write(`${JSON.stringify({ kind: 'reached', target: start.target, barrier })}\n`);
  return new Promise<never>(() => undefined);
};

const basePorts = await defaultRuntimePorts();
const ports = {
  ...basePorts,
  homeDir: start.home,
  xdg: { config: start.config, data: start.data, cache: start.cache },
  afterLedgerBarrier: async (barrier: Readonly<{ readonly kind: string }>) => {
    if (
      reached ||
      (start.target !== 'ledger' && start.target !== 'live') ||
      barrier.kind !== 'writer-live-parent-fsync'
    ) {
      return;
    }
    const state = await readLedgerState(ports, ledgerPathOf(start.data));
    if (!state.ok || state.value.state !== 'present') return;
    const transaction = Object.values(state.value.model.transactions).find(
      ({ intent }) => intent.kind === 'install' && intent.skill === 'lint',
    );
    const phase = transaction?.phase;
    if (
      (start.target === 'ledger' && phase === 'prepared') ||
      (start.target === 'live' && phase === 'live')
    ) {
      await stop({
        kind: barrier.kind,
        phase,
        operationId: transaction.intent.operationId,
        intent: transaction.intent,
      });
    }
  },
};

const baseCoordinator = await createTestNodeArtifactCoordinatorPorts(start.coordinationRoot);
const artifactRole =
  start.target === 'artifact-manifest'
    ? 'manifest'
    : start.target === 'artifact-lock'
      ? 'lock'
      : null;
const artifactCoordinator = {
  ...baseCoordinator,
  afterBarrier: async (
    barrier: Parameters<NonNullable<typeof baseCoordinator.afterBarrier>>[0],
  ) => {
    if (
      !reached &&
      artifactRole !== null &&
      barrier.kind === 'mutation-returned' &&
      barrier.cursor === `${artifactRole}-install` &&
      barrier.operation === 'fsync-directory' &&
      barrier.role === artifactRole &&
      barrier.object === 'live'
    ) {
      await stop(barrier);
    }
  },
};

const configuration = resolveRuntimeConfiguration({
  HOME: start.home,
  XDG_CONFIG_HOME: start.config,
  XDG_DATA_HOME: start.data,
  XDG_CACHE_HOME: start.cache,
  SKILLSMITH_HOME: start.data,
});
const context: CurrentApplicationContext = {
  observation: {
    context: createOperationContext({
      command: 'skillsmith apply',
      workflow: 'apply',
      clock: ports,
      id: ports,
    }),
    emitter: createObservationEmitter({ observer: noopObserver }),
  },
  ports,
  artifactCoordinator,
  configuration,
  interaction: {
    mode: 'noninteractive',
    choose: async () => ({ status: 'refused', reason: 'choice is unused' }),
    confirm: async () => ({ status: 'resolved', value: true }),
  },
  invocationCwd: start.cwd,
  globalOptions: {},
  projectContext: {
    invocationCwd: start.cwd,
    effectiveCwd: start.cwd,
    projectRoot: start.cwd,
    projectIdentity: start.cwd,
    projectKind: 'non-git',
    discoveredConfigPath: null,
    explicitConfigPath: null,
  },
};

process.stdout.write(`${JSON.stringify({ kind: 'ready', protocolVersion: 1 })}\n`);
const outcome = await runApplyApplication(
  {
    arguments: [],
    options: { file: start.manifest, lockfile: start.lock, yes: true },
  },
  context,
);
if (start.target !== 'none') {
  throw new Error(
    `G4B-03 crash child completed before ${start.target}: ${JSON.stringify({
      exitClass: outcome.exitClass,
      report: outcome.report.result,
      diagnostics: outcome.diagnostics,
    })}`,
  );
}
process.stdout.write(
  `${JSON.stringify({
    kind: 'result',
    exitClass: outcome.exitClass,
    report: outcome.report.result,
    diagnostics: outcome.diagnostics,
  })}\n`,
);
