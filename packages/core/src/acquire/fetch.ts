import { basename, dirname, join } from 'node:path';
import {
  type SkillSmithError,
  errorMessage,
  permissionDeniedError,
  safeErrorCode,
  sourceUnresolvableError,
} from '../errors.ts';
import type { ClockPort, FileReadPort, FileWritePort, GitPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { CandidateSkill } from './types.ts';

const SWEEP_AGE_MS = 60 * 60 * 1000; // .fetch orphans older than 60 minutes are swept
const SHA_HEX_40 = /^[0-9a-f]{40}$/;

type FetchGitPorts = { readonly git: GitPort };
type FetchSweepPorts = Pick<FileReadPort, 'pathKind' | 'listDir' | 'modifiedAt'> &
  Pick<FileWritePort, 'removeTree'> &
  Pick<ClockPort, 'epochMilliseconds'>;

// Preserve the legacy acquisition error contract: only the actionable last five non-empty lines
// are surfaced, in their original order and with their original line contents.
const stderrTail = (message: string): string =>
  message
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-5)
    .join('\n');

const sourceFailure = (error: unknown, message: string): SkillSmithError => {
  const code = safeErrorCode(error);
  return code === 'permission' ||
    code === 'permission-denied' ||
    code === 'EACCES' ||
    code === 'EPERM'
    ? permissionDeniedError(`${message}: permission denied`)
    : sourceUnresolvableError(`${message}: ${stderrTail(errorMessage(error))}`);
};

/** Blobless partial clone of a single ref into a fresh, skillsmith-created git dir. Permission
 *  failures remain permission failures; every other non-zero git exit maps to
 *  `source-unresolvable` (never a half-state): git only ever writes inside `fetchDir`. Returns the
 *  full 40-hex COMMIT SHA of FETCH_HEAD (annotated tags are peeled). */
export const fetchRepo = async (
  ports: FetchGitPorts,
  opts: {
    cloneUrl: string;
    ref: string | null; // null = 'HEAD' (remote default branch); may be a full 40-hex SHA
    fetchDir: string; // <dataDir>/.fetch/<txId> — caller-chosen, one dir per source
    signal?: AbortSignal;
  },
): Promise<Result<{ sha: string }, SkillSmithError>> => {
  const { cloneUrl, ref, fetchDir, signal } = opts;
  try {
    // F9 is enforced inside the GitPort adapter: it initializes only this caller-chosen directory,
    // clears inherited repository state, disables hooks, and never executes fetched content.
    await ports.git.initializeFetch({
      repositoryRoot: fetchDir,
      remoteUrl: cloneUrl,
      ...(signal ? { signal } : {}),
    });
    const fetched = await ports.git.fetchRef({
      repositoryRoot: fetchDir,
      ref,
      ...(signal ? { signal } : {}),
    });
    if (!SHA_HEX_40.test(fetched.sha)) {
      return err(
        sourceUnresolvableError(
          `cannot fetch ${cloneUrl}: FETCH_HEAD did not peel to a 40-hex commit`,
        ),
      );
    }
    return ok({ sha: fetched.sha });
  } catch (e) {
    return err(sourceFailure(e, `cannot fetch ${cloneUrl}`));
  }
};

/** List every skill directory (a dir containing a `SKILL.md` entry, root included) in the fetched
 *  tree. Tree listing needs no blobs, so the clone stays blobless through resolution. Directories
 *  with a dot-prefixed segment are excluded (invisible to placement detection). `scanned` is the
 *  post-exclusion candidate count, surfaced in the zero-match message. */
export const lsTreeSkills = async (
  ports: FetchGitPorts,
  fetchDir: string,
  signal?: AbortSignal,
): Promise<Result<{ candidates: CandidateSkill[]; scanned: number }, SkillSmithError>> => {
  try {
    const entries = await ports.git.listTree({
      repositoryRoot: fetchDir,
      ref: 'FETCH_HEAD',
      ...(signal ? { signal } : {}),
    });
    const candidates: CandidateSkill[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== 'blob' || basename(entry.path) !== 'SKILL.md') continue;
      const parent = dirname(entry.path);
      const path = parent === '.' ? '' : parent;
      if (path !== '' && path.split('/').some((seg) => seg.startsWith('.'))) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      candidates.push({ path, name: basename(path) });
    }
    return ok({ candidates, scanned: candidates.length });
  } catch (e) {
    return err(sourceFailure(e, `cannot list ${fetchDir}`));
  }
};

/** Materialize exactly one skill subtree. For the root skill (`skillPath === ''`) a plain detached
 *  checkout of the whole tree; otherwise a cone sparse-checkout so blobs are fetched lazily for the
 *  selected subtree only. Returns the absolute path of the skill dir. */
export const sparseCheckoutSkill = async (
  ports: FetchGitPorts,
  fetchDir: string,
  skillPath: string,
  signal?: AbortSignal,
): Promise<Result<string, SkillSmithError>> => {
  try {
    return ok(
      await ports.git.materializeTree({
        repositoryRoot: fetchDir,
        ref: 'FETCH_HEAD',
        path: skillPath,
        ...(signal ? { signal } : {}),
      }),
    );
  } catch (e) {
    return err(sourceFailure(e, `cannot check out ${skillPath === '' ? '<root>' : skillPath}`));
  }
};

const ROOT_PAYLOAD_SCRATCH_NAME = '.skillsmith-payload';
const GIT_DIR_NAME = '.git';

type RootPayloadExportPorts = Pick<FileReadPort, 'listDir'> &
  Pick<FileWritePort, 'copyTree' | 'makeDir'>;

/** Export the tracked payload of a root skill (`skillPath === ''`) into an acquisition-owned
 *  scratch dir inside `fetchDir`, excluding the top-level entry named exactly `.git`. The root
 *  materialization is the repository root itself, so its `.git/` administration would otherwise
 *  be hashed and stored as skill bytes. Every other top-level entry — dotfiles, symlinks, modes,
 *  and names merely containing `.git` — copies verbatim via per-entry `copyTree`. Failures map
 *  through `sourceFailure` (permission stays permission); the caller retains
 *  `cleanupDirectory: fetchDirectory`, so a partial scratch dies with the whole fetch dir. */
export const exportRootPayload = async (
  ports: RootPayloadExportPorts,
  opts: { fetchDir: string; materializedDir: string },
): Promise<Result<string, SkillSmithError>> => {
  const { fetchDir, materializedDir } = opts;
  const scratchDir = join(fetchDir, ROOT_PAYLOAD_SCRATCH_NAME);
  let entries: readonly string[];
  try {
    entries = await ports.listDir(materializedDir);
  } catch (e) {
    return err(sourceFailure(e, `cannot export root skill payload from ${materializedDir}`));
  }
  // Enumerate-before-clean: the fetch dir is fresh per fetch, so a pre-existing scratch entry
  // can only be tracked payload sharing the reserved name — fail closed rather than deleting a
  // payload entry. This helper never calls removeTree.
  if (entries.includes(ROOT_PAYLOAD_SCRATCH_NAME)) {
    return err(
      sourceUnresolvableError(
        `cannot export root skill payload from ${materializedDir}: payload contains reserved entry ${ROOT_PAYLOAD_SCRATCH_NAME}`,
      ),
    );
  }
  try {
    await ports.makeDir(scratchDir);
    for (const entry of entries) {
      if (entry === GIT_DIR_NAME) continue;
      if (entry === ROOT_PAYLOAD_SCRATCH_NAME) continue; // self-skip: never copy the scratch into itself
      await ports.copyTree(join(materializedDir, entry), join(scratchDir, entry));
    }
  } catch (e) {
    return err(sourceFailure(e, `cannot export root skill payload from ${materializedDir}`));
  }
  return ok(scratchDir);
};

/** Elision probe: resolve a ref to a full COMMIT SHA without any network round-trip when it is
 *  already a full 40-hex SHA. Otherwise ask the remote via `ls-remote`, preferring the peeled
 *  `refs/tags/<ref>^{}` commit, then the exact tag, then the exact branch, then the first (HEAD)
 *  line. A miss or an `ls-remote` failure is `ok(null)` (not an error): callers fall back to the
 *  full fetch. */
export const resolveRefViaLsRemote = async (
  ports: FetchGitPorts,
  cloneUrl: string,
  ref: string | null,
  signal?: AbortSignal,
): Promise<Result<string | null, SkillSmithError>> => {
  if (ref !== null && SHA_HEX_40.test(ref)) return ok(ref); // fully offline, zero exec calls

  try {
    return ok(
      await ports.git.resolveRemoteRef({
        remoteUrl: cloneUrl,
        ref,
        ...(signal ? { signal } : {}),
      }),
    );
  } catch {
    return ok(null);
  }
};

/** Best-effort removal of `.fetch` orphans older than 60 minutes. The age guard (vs sweep-all for
 *  `.staging`) exists because `--dry-run` fetches run WITHOUT the ledger lock — a sweep-all would
 *  delete a concurrent dry-run's working dir mid-scan. Callers run this at the start of every
 *  locked install/uninstall batch. Swallows every error. */
export const sweepFetchOrphans = async (ports: FetchSweepPorts, dataDir: string): Promise<void> => {
  try {
    const fetchRoot = join(dataDir, '.fetch');
    if ((await ports.pathKind(fetchRoot)) === 'absent') return;
    const now = ports.epochMilliseconds();
    for (const entry of await ports.listDir(fetchRoot)) {
      const abs = join(fetchRoot, entry);
      try {
        const mtime = await ports.modifiedAt(abs);
        if (mtime !== null && now - mtime > SWEEP_AGE_MS) {
          await ports.removeTree(abs).catch(() => {});
        }
      } catch {
        // best-effort per entry
      }
    }
  } catch {
    // best-effort
  }
};
