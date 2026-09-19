/**
 * MO2 crash-window child (SC-I60-MO2 Phase A characterization).
 *
 * Runs the EXPORTED PRODUCTION runInstall for a direct-copy A -> B update
 * through the real environment/ports with a narrowly forwarding filesystem
 * decorator. After each forwarded fs call the decorator inspects on-disk
 * state with RAW node:fs (never the decorated env); when the between-swaps
 * gap is durable on disk (B intermediate symlink live + matching B
 * origin/pinned symlink record + cleared first journal, second journal not
 * begun) it writes the ready file and latches: every subsequent fs call
 * blocks forever. The parent SIGKILLs this owned child, then restarts with
 * the unmodified public CLI.
 *
 * Usage: bun mo2-crash-child.ts <params.json>
 * Never resolves when latched (parent kills it). Exits 0 with a completion
 * record only when latchEnabled=false (decorator-neutrality control) or when
 * the rendezvous never triggers (parent treats as missed boundary).
 *
 * latchMode 'gap' (default) rendezvouses on the durable between-swaps gap;
 * latchMode 'pre-swap' rendezvouses on the first uncommitted stage journal
 * instead (pre-first-swap ordinary-resume control).
 */
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  fetchRepo,
  lsTreeSkills,
  resolveRefViaLsRemote,
  sparseCheckoutSkill,
} from '../../../src/acquire/fetch.ts';
import { defaultInstallDeps, runInstall } from '../../../src/acquire/run.ts';
import type {
  InstallOptions,
  InstallSourceTransport,
} from '../../../src/acquire/types.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import { defaultRuntimePorts } from '../../../src/ports/default.ts';
import type { RuntimePorts } from '../../../src/ports/types.ts';

interface Mo2ChildParams {
  remoteBase: string;
  home: string;
  data: string;
  cwd: string;
  source: string;
  refB: string;
  shaB: string;
  skill: string;
  tool: string;
  ledgerPath: string;
  livePath: string;
  readyPath: string;
  logPath: string;
  latchEnabled: boolean;
  latchMode?: 'gap' | 'pre-swap';
}

const FS_METHODS = [
  'fileExists',
  'pathKind',
  'realpath',
  'listDir',
  'readText',
  'readBytes',
  'readLink',
  'isExecutable',
  'modifiedAt',
  'makeDir',
  'writeTextFile',
  'makeSymlink',
  'rename',
  'copyTree',
  'removeTree',
  'removeEmptyDirectory',
  'fsyncFile',
  'fsyncDir',
  'readFileMetadata',
  'setFileMode',
  'makeDirExclusive',
  'writeTextFileExclusive',
  'assertWritableDirectory',
] as const;

const NEVER: Promise<never> = new Promise(() => {});

const params: Mo2ChildParams = JSON.parse(
  readFileSync(process.argv[2] as string, 'utf8'),
);

const logLines: string[] = [];
const log = (line: string): void => {
  logLines.push(`${new Date().toISOString()} ${line}`);
  try {
    writeFileSync(params.logPath, `${logLines.join('\n')}\n`);
  } catch {
    /* best effort */
  }
};

interface GapObservation {
  liveKind: string;
  liveLink: string | null;
  journal: unknown;
  pinnedPlacement: unknown;
  pinnedStorePath: string | null;
  originRefResolved: unknown;
  transactions: readonly string[];
  historyLength: number;
}

/** Raw on-disk read. Returns the observation plus whether each rendezvous holds. */
const observeGap = (): { gap: boolean; preSwap: boolean; obs: GapObservation } => {
  let liveKind = 'unreadable';
  let liveLink: string | null = null;
  try {
    const st = lstatSync(params.livePath);
    liveKind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'other';
    if (liveKind === 'symlink') liveLink = readlinkSync(params.livePath);
  } catch {
    liveKind = 'absent';
  }
  let journal: unknown = 'unreadable';
  let pinnedPlacement: unknown = 'unreadable';
  let pinnedStorePath: string | null = null;
  let originRefResolved: unknown = 'unreadable';
  let transactions: readonly string[] = [];
  let historyLength = -1;
  try {
    const raw = JSON.parse(readFileSync(params.ledgerPath, 'utf8')) as {
      skills?: Record<string, { tools?: Record<string, Record<string, unknown> | undefined> | undefined } | undefined>;
      transactions?: Record<string, unknown>;
      history?: readonly unknown[];
    };
    const pair = raw.skills?.[params.skill]?.tools?.[params.tool];
    journal = pair === undefined ? 'no-pair' : (pair.journal ?? null);
    const pinned = pair?.pinned as { placement?: unknown; storePath?: unknown } | undefined;
    pinnedPlacement = pinned?.placement ?? 'no-pinned';
    pinnedStorePath = typeof pinned?.storePath === 'string' ? pinned.storePath : null;
    originRefResolved = (pair?.origin as { refResolved?: unknown } | undefined)?.refResolved ?? 'no-origin';
    transactions = Object.keys(raw.transactions ?? {});
    historyLength = Array.isArray(raw.history) ? raw.history.length : -1;
  } catch {
    /* mid-write: not the gap */
  }
  const linkMatches =
    liveKind === 'symlink' &&
    liveLink !== null &&
    pinnedStorePath !== null &&
    resolve(dirname(params.livePath), liveLink) === resolve(pinnedStorePath);
  const gap =
    linkMatches &&
    journal === null &&
    pinnedPlacement === 'symlink' &&
    originRefResolved === params.shaB;
  const journalRecord =
    typeof journal === 'object' && journal !== null
      ? (journal as { op?: unknown; phase?: unknown })
      : null;
  const preSwap =
    journalRecord !== null &&
    journalRecord.op === 'install' &&
    journalRecord.phase !== 'committed' &&
    originRefResolved === params.shaB;
  return {
    gap,
    preSwap,
    obs: {
      liveKind,
      liveLink,
      journal,
      pinnedPlacement,
      pinnedStorePath,
      originRefResolved,
      transactions,
      historyLength,
    },
  };
};

const main = async (): Promise<void> => {
  const latchMode = params.latchMode ?? 'gap';
  log(`child start latchEnabled=${params.latchEnabled} latchMode=${latchMode} shaB=${params.shaB}`);
  const baseEnv = await defaultRuntimePorts();
  const withHome: RuntimePorts = {
    ...baseEnv,
    homeDir: params.home,
    xdg: {
      config: `${params.home}/.config`,
      data: `${params.home}/.local/share`,
      cache: `${params.home}/.cache`,
    },
  };

  let latched = false;
  const callCounts = new Map<string, number>();
  const recent: string[] = [];
  const noteCall = (method: string, args: readonly unknown[]): void => {
    callCounts.set(method, (callCounts.get(method) ?? 0) + 1);
    recent.push(`${method}(${args.map((a) => JSON.stringify(String(a)).slice(0, 120)).join(',')})`);
    if (recent.length > 12) recent.shift();
  };

  const decorated = { ...withHome } as Record<string, unknown>;
  for (const method of FS_METHODS) {
    const original = (withHome as unknown as Record<string, unknown>)[method];
    if (typeof original !== 'function') continue;
    decorated[method] = async (...args: never[]): Promise<unknown> => {
      if (latched) await NEVER;
      // Forward FIRST through the real production implementation.
      const result = await (original as (...a: never[]) => Promise<unknown>).apply(withHome, args);
      noteCall(method, args);
      if (params.latchEnabled && !latched) {
        const { gap, preSwap, obs } = observeGap();
        const hit = latchMode === 'pre-swap' ? preSwap : gap;
        if (hit) {
          latched = true;
          const ready = {
            at: new Date().toISOString(),
            latchMode,
            latchedOn: `${method} #${callCounts.get(method)}`,
            recent,
            callCounts: Object.fromEntries(callCounts),
            observation: obs,
          };
          writeFileSync(params.readyPath, `${JSON.stringify(ready, null, 2)}\n`);
          log(`LATCHED on ${method}: ${JSON.stringify(obs)}`);
          await NEVER;
        }
      }
      return result;
    };
  }
  const env = decorated as unknown as RuntimePorts;

  const multiUrl = `file://${params.remoteBase}/multi.git`;
  const multiSource = 'https://fixture.invalid/acme/multi.git';
  const localClone = (cloneUrl: string): string =>
    cloneUrl === multiSource ? multiUrl : cloneUrl;
  const transportImpl: InstallSourceTransport = {
    resolveRef: (ports, cloneUrl, ref, signal) =>
      resolveRefViaLsRemote(ports, localClone(cloneUrl), ref, signal),
    fetchRepo: (ports, options) =>
      fetchRepo(ports, { ...options, cloneUrl: localClone(options.cloneUrl) }),
    listSkills: lsTreeSkills,
    materializeSkill: sparseCheckoutSkill,
  };
  const transport: InstallSourceTransport = Object.freeze(transportImpl);

  const opts: InstallOptions = {
    sources: [params.source],
    tools: [params.tool as 'claude-code'],
    scope: 'user',
    ref: params.refB,
    direct: true,
    noVerify: true,
    cwd: params.cwd,
    configuration: resolveRuntimeConfiguration({ SKILLSMITH_HOME: params.data }),
  };
  const result = await runInstall(env, opts, { ...defaultInstallDeps, transport });
  if (!result.ok) {
    const e = result.error as { code?: unknown; message?: unknown };
    log(`runInstall ERRORED code=${String(e.code)} message=${String(e.message)}`);
    writeFileSync(
      params.readyPath,
      `${JSON.stringify({ at: new Date().toISOString(), completed: 'error', code: String(e.code), message: String(e.message) })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  log(`runInstall COMPLETED summary=${JSON.stringify(result.value.summary)}`);
  writeFileSync(
    params.readyPath,
    `${JSON.stringify({ at: new Date().toISOString(), completed: 'ok', summary: result.value.summary, results: result.value.results })}\n`,
  );
};

await main();
