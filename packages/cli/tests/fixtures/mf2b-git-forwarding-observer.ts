// MF2B owned forwarding observer fixture (SC-I60-MF2B Phase A characterization).
//
// Installs an owned executable named `git` at the front of PATH that recognizes
// production Git invocations, records the exact init boundary
// (exe/argv/cwd/exit/stdout/stderr) as JSONL, then forwards to the fixed real
// Git binary with byte-identical stdout/stderr and the same exit code.
//
// No barrier is needed: the denied destination is established deterministically
// by pre-creating the owned `<data>/.fetch` parent with mode 555 (the fetch tx
// leaf never pre-exists, so real `git init` always attempts the denied mkdir).
// No fake Git failure is ever produced: every recorded invocation is forwarded.

export const MF2B_REAL_GIT = '/usr/bin/git';

export interface Mf2bObservedCall {
  readonly startedAt: string;
  readonly exe: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exit: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Source text of the forwarding observer, installed as `<owned-bin>/git`. */
export const mf2bObserverScript = (realGit: string): string => `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const REAL_GIT = ${JSON.stringify(realGit)};
const logPath = process.env.MF2B_GIT_LOG;
if (!logPath) {
  process.stderr.write('mf2b-git-observer: MF2B_GIT_LOG not set\\n');
  process.exit(99);
}
const args = process.argv.slice(2);
const proc = Bun.spawn([REAL_GIT, ...args], { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
const [code, stdoutBuf, stderrText] = await Promise.all([
  proc.exited,
  new Response(proc.stdout).arrayBuffer(),
  new Response(proc.stderr).text(),
]);
process.stdout.write(Buffer.from(stdoutBuf));
process.stderr.write(stderrText);
appendFileSync(
  logPath,
  JSON.stringify({
    startedAt: new Date().toISOString(),
    exe: REAL_GIT,
    argv: ['git', ...args],
    cwd: process.cwd(),
    exit: code,
    timedOut: false,
    stdout: new TextDecoder().decode(stdoutBuf),
    stderr: stderrText,
  }) + '\\n',
);
process.exit(code);
`;

export const readMf2bObserverLog = async (logPath: string): Promise<Mf2bObservedCall[]> => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(logPath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Mf2bObservedCall);
};
