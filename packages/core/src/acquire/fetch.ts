import { basename, dirname, join } from 'node:path';
import { execGit } from '../env/git.ts';
import type { ExecResult, ScanEnv } from '../env/types.ts';
import { type SkillSmithError, sourceUnresolvableError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type { CandidateSkill } from './types.ts';

const PLUMBING_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 120_000;
const SWEEP_AGE_MS = 60 * 60 * 1000; // .fetch orphans older than 60 minutes are swept
const SHA_HEX_40 = /^[0-9a-f]{40}$/;

// F9: every git run is sanitized by execGit and uses a skillsmith-`init`ed dir, so inherited hook
// repository state and repo-supplied config/hooks are never honored. Nothing fetched is executed.
const git = (
  env: ScanEnv,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> =>
  execGit(env, args, {
    timeoutMs,
    ...(signal ? { signal } : {}),
  });

// The last 5 non-empty stderr lines — the actionable tail of a git failure.
const stderrTail = (stderr: string): string =>
  stderr
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-5)
    .join('\n');

/** Blobless partial clone of a single ref into a fresh, skillsmith-created git dir. Any non-zero
 *  git exit maps to `source-unresolvable` (never a half-state): git only ever writes inside
 *  `fetchDir`. Returns the full 40-hex COMMIT SHA of FETCH_HEAD (annotated tags are peeled). */
export const fetchRepo = async (
  env: ScanEnv,
  opts: {
    cloneUrl: string;
    ref: string | null; // null = 'HEAD' (remote default branch); may be a full 40-hex SHA
    fetchDir: string; // <dataDir>/.fetch/<txId> — caller-chosen, one dir per source
    signal?: AbortSignal;
  },
): Promise<Result<{ sha: string }, SkillSmithError>> => {
  const { cloneUrl, ref, fetchDir, signal } = opts;
  const fail = (stderr: string): Result<{ sha: string }, SkillSmithError> =>
    err(sourceUnresolvableError(`cannot fetch ${cloneUrl}: ${stderrTail(stderr)}`));

  const init = await git(env, ['init', '-q', fetchDir], PLUMBING_TIMEOUT_MS, signal);
  if (init.code !== 0) return fail(init.stderr);

  const remote = await git(
    env,
    ['-C', fetchDir, 'remote', 'add', 'origin', cloneUrl],
    PLUMBING_TIMEOUT_MS,
    signal,
  );
  if (remote.code !== 0) return fail(remote.stderr);

  const fetch = await git(
    env,
    ['-C', fetchDir, 'fetch', '-q', '--filter=blob:none', '--depth', '1', 'origin', ref ?? 'HEAD'],
    FETCH_TIMEOUT_MS,
    signal,
  );
  if (fetch.code !== 0) return fail(fetch.stderr);

  // Peel to the underlying COMMIT: for an annotated tag, FETCH_HEAD is the tag-object SHA, but the
  // canonical identity must be a commit SHA (place/store.ts records `git rev-parse HEAD`, and this
  // SHA becomes the store rev and ledger gitSha). `^{commit}` is the identity for a commit already,
  // so lightweight tags / branches / SHAs are unaffected.
  const rev = await git(
    env,
    ['-C', fetchDir, 'rev-parse', 'FETCH_HEAD^{commit}'],
    PLUMBING_TIMEOUT_MS,
    signal,
  );
  if (rev.code !== 0) return fail(rev.stderr);
  const sha = rev.stdout.trim();
  if (!SHA_HEX_40.test(sha)) {
    return err(
      sourceUnresolvableError(
        `cannot fetch ${cloneUrl}: FETCH_HEAD did not peel to a 40-hex commit`,
      ),
    );
  }

  return ok({ sha });
};

/** List every skill directory (a dir containing a `SKILL.md` entry, root included) in the fetched
 *  tree. Tree listing needs no blobs, so the clone stays blobless through resolution. Directories
 *  with a dot-prefixed segment are excluded (invisible to placement detection). `scanned` is the
 *  post-exclusion candidate count, surfaced in the zero-match message. */
export const lsTreeSkills = async (
  env: ScanEnv,
  fetchDir: string,
  signal?: AbortSignal,
): Promise<Result<{ candidates: CandidateSkill[]; scanned: number }, SkillSmithError>> => {
  const res = await git(
    env,
    ['-C', fetchDir, 'ls-tree', '-r', '--name-only', 'FETCH_HEAD'],
    PLUMBING_TIMEOUT_MS,
    signal,
  );
  if (res.code !== 0) {
    return err(sourceUnresolvableError(`cannot list ${fetchDir}: ${stderrTail(res.stderr)}`));
  }

  const candidates: CandidateSkill[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    if (line === '' || basename(line) !== 'SKILL.md') continue;
    const parent = dirname(line);
    const path = parent === '.' ? '' : parent;
    if (path !== '' && path.split('/').some((seg) => seg.startsWith('.'))) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    candidates.push({ path, name: basename(path) });
  }

  return ok({ candidates, scanned: candidates.length });
};

/** Materialize exactly one skill subtree. For the root skill (`skillPath === ''`) a plain detached
 *  checkout of the whole tree; otherwise a cone sparse-checkout so blobs are fetched lazily for the
 *  selected subtree only. Returns the absolute path of the skill dir. */
export const sparseCheckoutSkill = async (
  env: ScanEnv,
  fetchDir: string,
  skillPath: string,
  signal?: AbortSignal,
): Promise<Result<string, SkillSmithError>> => {
  const fail = (stderr: string): Result<string, SkillSmithError> =>
    err(
      sourceUnresolvableError(
        `cannot check out ${skillPath === '' ? '<root>' : skillPath}: ${stderrTail(stderr)}`,
      ),
    );

  if (skillPath !== '') {
    const sparse = await git(
      env,
      ['-C', fetchDir, 'sparse-checkout', 'set', '--cone', skillPath],
      PLUMBING_TIMEOUT_MS,
      signal,
    );
    if (sparse.code !== 0) return fail(sparse.stderr);
  }

  const checkout = await git(
    env,
    ['-C', fetchDir, 'checkout', '-q', '--detach', 'FETCH_HEAD'],
    FETCH_TIMEOUT_MS,
    signal,
  );
  if (checkout.code !== 0) return fail(checkout.stderr);

  return ok(skillPath === '' ? fetchDir : join(fetchDir, skillPath));
};

/** Elision probe: resolve a ref to a full COMMIT SHA without any network round-trip when it is
 *  already a full 40-hex SHA. Otherwise ask the remote via `ls-remote`, preferring the peeled
 *  `refs/tags/<ref>^{}` commit, then the exact tag, then the exact branch, then the first (HEAD)
 *  line. A miss or an `ls-remote` failure is `ok(null)` (not an error): callers fall back to the
 *  full fetch. */
export const resolveRefViaLsRemote = async (
  env: ScanEnv,
  cloneUrl: string,
  ref: string | null,
  signal?: AbortSignal,
): Promise<Result<string | null, SkillSmithError>> => {
  if (ref !== null && SHA_HEX_40.test(ref)) return ok(ref); // fully offline, zero exec calls

  // Request the peeled `<ref>^{}` pseudo-ref alongside `<ref>` so annotated tags surface their
  // COMMIT SHA (matching fetchRepo's `^{commit}` peel and place/store.ts). A single-pattern
  // `ls-remote <url> <ref>` suppresses the peeled line, so it is requested explicitly.
  const patterns = ref === null ? ['HEAD'] : [ref, `${ref}^{}`];
  const res = await git(env, ['ls-remote', cloneUrl, ...patterns], PLUMBING_TIMEOUT_MS, signal);
  if (res.code !== 0) return ok(null);

  const rows = res.stdout
    .split('\n')
    .map((line) => {
      const [sha = '', name = ''] = line.split('\t');
      return { sha: sha.trim(), name: name.trim() };
    })
    .filter((row) => SHA_HEX_40.test(row.sha));
  if (rows.length === 0) return ok(null);

  if (ref !== null) {
    const peeled = rows.find((row) => row.name === `refs/tags/${ref}^{}`);
    if (peeled) return ok(peeled.sha); // annotated tag → underlying commit
    const tag = rows.find((row) => row.name === `refs/tags/${ref}`);
    if (tag) return ok(tag.sha); // lightweight tag → already a commit
    const head = rows.find((row) => row.name === `refs/heads/${ref}`);
    if (head) return ok(head.sha);
  }
  const [firstRow] = rows;
  return ok(firstRow ? firstRow.sha : null);
};

/** Best-effort removal of `.fetch` orphans older than 60 minutes. The age guard (vs sweep-all for
 *  `.staging`) exists because `--dry-run` fetches run WITHOUT the ledger lock — a sweep-all would
 *  delete a concurrent dry-run's working dir mid-scan. Callers run this at the start of every
 *  locked install/uninstall batch. Swallows every error. */
export const sweepFetchOrphans = async (env: ScanEnv, dataDir: string): Promise<void> => {
  try {
    const fetchRoot = join(dataDir, '.fetch');
    if ((await env.pathKind(fetchRoot)) === 'absent') return;
    const now = Date.now();
    for (const entry of await env.listDir(fetchRoot)) {
      const abs = join(fetchRoot, entry);
      try {
        const mtime = await env.modifiedAt(abs);
        if (mtime !== null && now - mtime > SWEEP_AGE_MS) {
          await env.removeTree(abs).catch(() => {});
        }
      } catch {
        // best-effort per entry
      }
    }
  } catch {
    // best-effort
  }
};
