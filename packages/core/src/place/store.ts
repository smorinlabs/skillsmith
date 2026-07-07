import { createHash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import type { ScanEnv } from '../env/types.ts';
import {
  type SkillSmithError,
  errorMessage,
  flipFailedError,
  genericError,
  permissionDeniedError,
} from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type { Provenance } from './types.ts';

const HASH_PREFIX = 'sha256:';
const SHA_HEX_40 = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();

const isPermError = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  'code' in e &&
  ((e as { code: unknown }).code === 'EACCES' || (e as { code: unknown }).code === 'EPERM');

const mapFsError = (e: unknown, context: string): SkillSmithError =>
  isPermError(e)
    ? permissionDeniedError(`${context}: ${errorMessage(e)}`)
    : genericError(`${context}: ${errorMessage(e)}`, e);

const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

// Byte-wise comparison of two UTF-8 strings (stable, platform-independent sort).
const byteCompare = (a: string, b: string): number => {
  const ba = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ba[i] ?? 0) - (bb[i] ?? 0);
    if (d !== 0) return d;
  }
  return ba.length - bb.length;
};

interface ManifestEntry {
  relpath: string;
  record: string;
}

const collectEntries = async (
  env: ScanEnv,
  absDir: string,
  relBase: string,
  out: ManifestEntry[],
): Promise<void> => {
  const names = await env.listDir(absDir);
  for (const name of names) {
    const abs = join(absDir, name);
    const rel = relBase === '' ? name : `${relBase}/${name}`;
    const kind = await env.pathKind(abs);
    if (kind === 'symlink') {
      const target = await env.readLink(abs);
      out.push({ relpath: rel, record: `${rel}\0L\0${target}` });
    } else if (kind === 'dir') {
      await collectEntries(env, abs, rel, out);
    } else if (kind === 'file') {
      const bytes = await env.readBytes(abs);
      const exec = (await env.isExecutable(abs)) ? '1' : '0';
      out.push({ relpath: rel, record: `${rel}\0F${exec}\0${sha256Hex(bytes)}` });
    }
    // 'absent' (a racing removal) contributes no record.
  }
};

/** Canonical content hash of a skill directory (spec §6.2): sha256 over a sorted manifest of
 *  per-file records (relpath, owner-exec bit, sha256 of bytes) and symlink records (relpath,
 *  literal link target). Symlinks are NOT followed. Returns `sha256:<64hex>`. */
export const contentHashOf = async (
  env: ScanEnv,
  dir: string,
): Promise<Result<string, SkillSmithError>> => {
  try {
    const entries: ManifestEntry[] = [];
    await collectEntries(env, dir, '', entries);
    entries.sort((a, b) => byteCompare(a.relpath, b.relpath));
    const manifest = entries.map((e) => e.record).join('\n');
    return ok(`${HASH_PREFIX}${sha256Hex(encoder.encode(manifest))}`);
  } catch (e) {
    return err(mapFsError(e, `cannot hash ${dir}`));
  }
};

const parseRemote = (url: string): { owner: string; repo: string } | null => {
  const trimmed = url.trim();
  const stripGit = (s: string): string => s.replace(/\.git$/, '');
  // scp-like ssh form: git@host:owner/repo(.git)
  const ssh = trimmed.match(/^[^@\s]+@[^:\s]+:([^/\s]+)\/(.+)$/);
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: stripGit(ssh[2]) };
  // url form: scheme://[user@]host/owner/repo(.git)
  const url2 = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?[^/\s]+\/([^/\s]+)\/(.+)$/);
  if (url2?.[1] && url2[2]) return { owner: url2[1], repo: stripGit(url2[2]) };
  return null;
};

/** Resolve provenance of a dev source directory via git (cwd-independent `-C`). Non-git trees,
 *  or git trees with an unparseable/absent origin remote, fall back to the `local` namespace. */
export const resolveProvenance = async (
  env: ScanEnv,
  sourceDir: string,
): Promise<Result<Provenance, SkillSmithError>> => {
  const top = await env.exec('git', ['-C', sourceDir, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    return ok({
      kind: 'non-git',
      repoRoot: null,
      sourceRelPath: null,
      remote: null,
      gitSha: null,
      ns: 'local',
      name: basename(sourceDir),
      dirtySummary: null,
    });
  }
  const repoRoot = top.stdout.trim();

  const status = await env.exec('git', ['-C', repoRoot, 'status', '--porcelain']);
  const statusOut = status.stdout.trim();
  const dirty = statusOut.length > 0;
  const dirtySummary = dirty ? statusOut.split('\n').slice(0, 10).join('\n') : null;

  const head = await env.exec('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  const gitSha = head.stdout.trim();
  if (head.code !== 0 || !SHA_HEX_40.test(gitSha)) {
    return err(genericError(`could not resolve git HEAD for ${repoRoot}`));
  }

  const remoteRes = await env.exec('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']);
  const parsed = remoteRes.code === 0 ? parseRemote(remoteRes.stdout) : null;

  // git's --show-toplevel is a realpath; resolve the source too so `relative` stays clean
  // across symlinked prefixes (e.g. macOS /var -> /private/var temp dirs).
  let realSource = sourceDir;
  try {
    realSource = await env.realpath(sourceDir);
  } catch {
    realSource = sourceDir;
  }

  return ok({
    kind: dirty ? 'git-dirty' : 'git-clean',
    repoRoot,
    sourceRelPath: relative(repoRoot, realSource),
    remote: parsed ? `${parsed.owner}/${parsed.repo}` : null,
    gitSha,
    ns: parsed ? parsed.owner : 'local',
    name: parsed ? parsed.repo : basename(repoRoot),
    dirtySummary,
  });
};

export interface SnapshotResult {
  storePath: string;
  rev: string;
  contentHash: string;
  reused: boolean;
}

const revFor = (provenance: Provenance, hash12: string): Result<string, SkillSmithError> => {
  if (provenance.kind === 'git-clean') {
    if (!provenance.gitSha) return err(genericError('git-clean provenance without a gitSha'));
    return ok(provenance.gitSha.slice(0, 12));
  }
  if (provenance.kind === 'git-dirty') return ok(`dirty-${hash12}`);
  return ok(`content-${hash12}`);
};

const fsyncTreeFiles = async (env: ScanEnv, dir: string): Promise<void> => {
  const names = await env.listDir(dir);
  for (const name of names) {
    const abs = join(dir, name);
    const kind = await env.pathKind(abs);
    if (kind === 'dir') await fsyncTreeFiles(env, abs);
    else if (kind === 'file') await env.fsyncFile(abs);
  }
};

/** Write-once, atomic snapshot of a dev source directory into the content-addressed store
 *  (spec §6.3). Existing entries are reused when their content matches; a content mismatch is a
 *  hard integrity violation. Store entries are immutable and never deleted. */
export const snapshotToStore = async (
  env: ScanEnv,
  opts: {
    sourceDir: string;
    skill: string;
    storeRoot: string;
    provenance: Provenance;
    txId: string;
  },
): Promise<Result<SnapshotResult, SkillSmithError>> => {
  const { sourceDir, skill, storeRoot, provenance, txId } = opts;

  const srcHash = await contentHashOf(env, sourceDir);
  if (!srcHash.ok) return srcHash;
  const contentHash = srcHash.value;
  const hash12 = contentHash.slice(HASH_PREFIX.length, HASH_PREFIX.length + 12);

  const revRes = revFor(provenance, hash12);
  if (!revRes.ok) return revRes;
  const rev = revRes.value;

  const storePath = join(storeRoot, provenance.ns, `${provenance.name}@${rev}`, skill);

  try {
    // Step 1: reuse or integrity check.
    if ((await env.pathKind(storePath)) !== 'absent') {
      const existing = await contentHashOf(env, storePath);
      if (!existing.ok) return existing;
      if (existing.value === contentHash) {
        return ok({ storePath, rev, contentHash, reused: true });
      }
      return err(
        flipFailedError(`store integrity violation: ${storePath} exists with different content`),
      );
    }

    // Step 2: stage on the same filesystem, then verify the copy against a fresh source hash.
    const stagingBase = join(storeRoot, '.staging', txId);
    const stagingSkillDir = join(stagingBase, skill);
    let staged = false;
    for (let attempt = 0; attempt < 2 && !staged; attempt++) {
      await env.removeTree(stagingSkillDir);
      await env.makeDir(stagingBase);
      await env.copyTree(sourceDir, stagingSkillDir);
      await fsyncTreeFiles(env, stagingSkillDir);
      const stagedHash = await contentHashOf(env, stagingSkillDir);
      if (!stagedHash.ok) return stagedHash;
      const freshSrc = await contentHashOf(env, sourceDir);
      if (!freshSrc.ok) return freshSrc;
      staged = stagedHash.value === freshSrc.value && stagedHash.value === contentHash;
    }
    if (!staged) {
      await env.removeTree(stagingBase);
      return err(
        flipFailedError(`snapshot staging failed: source changed during copy for ${skill}`),
      );
    }

    // Step 3: publish atomically, then sweep the txId staging root.
    await env.makeDir(dirname(storePath));
    await env.rename(stagingSkillDir, storePath);
    await env.fsyncDir(dirname(storePath));
    await env.removeTree(stagingBase);

    return ok({ storePath, rev, contentHash, reused: false });
  } catch (e) {
    return err(mapFsError(e, `cannot snapshot ${skill} to store`));
  }
};

/** Remove every `store/.staging/<txId>` directory (crash orphans). Best-effort; swallows errors.
 *  Callers run this at the start of a flip batch while holding the ledger lock. */
export const sweepStaging = async (env: ScanEnv, storeRoot: string): Promise<void> => {
  try {
    const stagingRoot = join(storeRoot, '.staging');
    if ((await env.pathKind(stagingRoot)) === 'absent') return;
    const entries = await env.listDir(stagingRoot);
    for (const entry of entries) {
      await env.removeTree(join(stagingRoot, entry)).catch(() => {});
    }
  } catch {
    // best-effort
  }
};
