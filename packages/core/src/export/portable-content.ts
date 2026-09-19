import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import {
  SOURCE_CONTENT_EXCLUSIONS_V1,
  type SourceContentEntryV1,
  type SourceContentProjectionV1,
  type SourceContentReadPort,
  hashSourceContentV1,
  projectSourceContent,
} from '../artifacts/source-content.ts';
import type { GitPort, GitTreeEntry, GitWorktreeInspection } from '../ports/types.ts';

type ExactGitContentPorts = SourceContentReadPort & { readonly git: GitPort };

export interface ExactGitContentObservation {
  readonly inspection: GitWorktreeInspection;
  readonly contentHash: ArtifactDigest | null;
}

const SHA1 = /^[0-9a-f]{40}$/u;
const decoder = new TextDecoder('utf-8', { fatal: true });

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

const safeRepositoryPath = (value: string): boolean => {
  if (value === '' || value === '.') return true;
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\')) return false;
  return value.split('/').every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      ![...segment].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }),
  );
};

const selectedRelativePath = (path: string, sourcePath: string): string | null => {
  const root = sourcePath === '.' ? '' : sourcePath;
  if (root === '') return path;
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
};

const excluded = (path: string): boolean =>
  path
    .split('/')
    .some((segment) => (SOURCE_CONTENT_EXCLUSIONS_V1 as readonly string[]).includes(segment));

const addParentDirectories = (path: string, directories: Set<string>): void => {
  const segments = path.split('/');
  for (let length = 1; length < segments.length; length += 1) {
    directories.add(segments.slice(0, length).join('/'));
  }
};

const gitBlobEntry = async (
  git: GitPort,
  repositoryRoot: string,
  ref: string,
  relativePath: string,
  treePath: string,
  entry: GitTreeEntry,
  signal?: AbortSignal,
): Promise<SourceContentEntryV1 | null> => {
  if (entry.kind !== 'blob' || entry.mode === undefined) return null;
  const bytes = await git.readBlob({
    repositoryRoot,
    ref,
    path: treePath,
    ...(signal === undefined ? {} : { signal }),
  });
  if (entry.mode === '120000') {
    let target: string;
    try {
      target = decoder.decode(bytes);
    } catch {
      return null;
    }
    return Object.freeze({ path: relativePath, type: 'symlink' as const, target });
  }
  if (entry.mode !== '100644' && entry.mode !== '100755') return null;
  return Object.freeze({
    path: relativePath,
    type: 'file' as const,
    executable: entry.mode === '100755',
    length: bytes.byteLength,
    bytes: Buffer.from(bytes).toString('base64'),
  });
};

/** Hash the exact selected subtree represented by immutable Git objects at one full commit SHA. */
export const hashGitPortableContent = async (
  git: GitPort,
  input: Readonly<{
    repositoryRoot: string;
    ref: string;
    sourcePath: string;
    signal?: AbortSignal;
  }>,
): Promise<ArtifactDigest | null> => {
  if (!SHA1.test(input.ref) || !safeRepositoryPath(input.sourcePath)) return null;
  const tree = await git.listTree({
    repositoryRoot: input.repositoryRoot,
    ref: input.ref,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const directories = new Set<string>();
  const members: SourceContentEntryV1[] = [];
  for (const entry of tree) {
    const relativePath = selectedRelativePath(entry.path, input.sourcePath);
    if (relativePath === null || relativePath.length === 0 || excluded(relativePath)) continue;
    if (!safeRepositoryPath(relativePath)) return null;
    if (entry.kind === 'tree') continue;
    if (entry.kind === 'commit') return null;
    addParentDirectories(relativePath, directories);
    const projected = await gitBlobEntry(
      git,
      input.repositoryRoot,
      input.ref,
      relativePath,
      entry.path,
      entry,
      input.signal,
    );
    if (projected === null) return null;
    members.push(projected);
  }
  if (members.length === 0) return null;
  const entries: SourceContentEntryV1[] = [
    ...[...directories].map((path) => ({ path, type: 'directory' as const })),
    ...members,
  ];
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const projection: SourceContentProjectionV1 = Object.freeze({
    version: 1,
    exclusionsVersion: 1,
    entries: Object.freeze(entries),
  });
  const hashed = hashSourceContentV1(projection);
  return hashed.ok ? hashed.value : null;
};

/** Hash a stable live projection using the portable source-content domain. */
export const hashLivePortableContent = async (
  ports: SourceContentReadPort,
  root: string,
): Promise<ArtifactDigest | null> => {
  const projected = await projectSourceContent(ports, root);
  if (!projected.ok) return null;
  const hashed = hashSourceContentV1(projected.value);
  return hashed.ok ? hashed.value : null;
};

const sameInspection = (left: GitWorktreeInspection, right: GitWorktreeInspection): boolean =>
  resolve(left.repositoryRoot) === resolve(right.repositoryRoot) &&
  left.headSha === right.headSha &&
  left.remoteUrl === right.remoteUrl &&
  left.dirtySummary === right.dirtySummary;

/** Bind exact Git object content to one clean, unchanged before/after live worktree observation. */
export const observeExactGitPortableContent = async (
  ports: ExactGitContentPorts,
  input: Readonly<{
    repositoryRoot: string;
    liveRoot: string;
    sourcePath: string;
    signal?: AbortSignal;
  }>,
): Promise<ExactGitContentObservation> => {
  const inspection = await ports.git.inspectWorktree({
    repositoryRoot: input.repositoryRoot,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (inspection.dirtySummary !== null || !SHA1.test(inspection.headSha)) {
    return Object.freeze({ inspection, contentHash: null });
  }
  const [gitContentHash, liveContentHash] = await Promise.all([
    hashGitPortableContent(ports.git, {
      repositoryRoot: input.repositoryRoot,
      ref: inspection.headSha,
      sourcePath: input.sourcePath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
    hashLivePortableContent(ports, input.liveRoot),
  ]);
  const closing = await ports.git.inspectWorktree({
    repositoryRoot: input.repositoryRoot,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return Object.freeze({
    inspection: closing,
    contentHash:
      sameInspection(inspection, closing) &&
      closing.dirtySummary === null &&
      gitContentHash !== null &&
      gitContentHash === liveContentHash
        ? gitContentHash
        : null,
  });
};
