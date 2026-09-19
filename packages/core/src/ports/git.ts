import { join } from 'node:path';
import type { ExecOptions } from '../env/types.ts';
import { toPortError } from './errors.ts';
import type { GitPort, ProcessPort } from './types.ts';

export const GIT_REPOSITORY_ENVIRONMENT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_QUARANTINE_PATH',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;

const SHA_HEX_40 = /^[0-9a-f]{40}$/i;
const CANONICAL_SHA_HEX_40 = /^[0-9a-f]{40}$/;
const DISCOVERY_TIMEOUT_MS = 2_000;
const PLUMBING_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 120_000;

export interface BinaryExecResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface BinaryProcessPort {
  exec(command: string, args: readonly string[], options?: ExecOptions): Promise<BinaryExecResult>;
}

const assertSafeRevision = (operation: string, ref: string): void => {
  if (ref.length === 0 || ref.startsWith('-') || ref.includes('\0')) {
    throw toPortError(null, {
      capability: 'git',
      operation,
      code: 'invalid',
      message: 'invalid Git revision',
      context: { ref },
    });
  }
};

const stderrTail = (stderr: string): string =>
  stderr
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-5)
    .join('\n');

const hasEmbeddedRemoteCredentials = (remoteUrl: string): boolean => {
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.password.length > 0) return true;
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.username.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0)
    );
  } catch {
    return false;
  }
};

interface RemoteRefRow {
  readonly sha: string;
  readonly name: string;
}

const parseExactRemoteRefRows = (
  stdout: string,
  expectedNames: ReadonlySet<string>,
  context: Readonly<Record<string, string>>,
): readonly RemoteRefRow[] => {
  const rows: RemoteRefRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    const fields = line.split('\t');
    const sha = fields[0] ?? '';
    const name = fields[1] ?? '';
    if (fields.length !== 2 || !CANONICAL_SHA_HEX_40.test(sha) || !expectedNames.has(name)) {
      throw toPortError(null, {
        capability: 'git',
        operation: 'inspectRemoteRef',
        code: 'invalid',
        message: 'git remote-ref inspection returned malformed or unexpected output',
        context,
      });
    }
    rows.push({ sha, name });
  }
  return rows;
};

const uniqueShaFor = (
  rows: readonly RemoteRefRow[],
  name: string,
  context: Readonly<Record<string, string>>,
): string | null => {
  const shas = new Set(rows.filter((row) => row.name === name).map((row) => row.sha));
  if (shas.size > 1) {
    throw toPortError(null, {
      capability: 'git',
      operation: 'inspectRemoteRef',
      code: 'invalid',
      message: 'git remote-ref inspection returned conflicting object identifiers',
      context,
    });
  }
  return shas.values().next().value ?? null;
};

export const createGitPort = (
  processPort: ProcessPort,
  binaryProcessPort: BinaryProcessPort,
): GitPort => {
  const execute = async (
    operation: string,
    args: readonly string[],
    context: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    timeoutMs = PLUMBING_TIMEOUT_MS,
  ) => {
    try {
      return await processPort.exec('git', args, {
        env: { GIT_TERMINAL_PROMPT: '0' },
        unsetEnv: GIT_REPOSITORY_ENVIRONMENT,
        ...(signal ? { signal } : {}),
        timeoutMs,
      });
    } catch (error) {
      throw toPortError(error, { capability: 'git', operation, context });
    }
  };

  const required = async (
    operation: string,
    args: readonly string[],
    context: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    timeoutMs = PLUMBING_TIMEOUT_MS,
  ) => {
    const result = await execute(operation, args, context, signal, timeoutMs);
    if (result.code !== 0 || result.timedOut) {
      throw toPortError(result.stderr, {
        capability: 'git',
        operation,
        code: result.timedOut ? 'timeout' : 'unavailable',
        message: stderrTail(result.stderr) || `git ${operation} failed`,
        context,
      });
    }
    return result.stdout;
  };

  const requiredBytes = async (
    operation: string,
    args: readonly string[],
    context: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    let result: BinaryExecResult;
    try {
      result = await binaryProcessPort.exec('git', args, {
        env: { GIT_TERMINAL_PROMPT: '0' },
        unsetEnv: GIT_REPOSITORY_ENVIRONMENT,
        ...(signal ? { signal } : {}),
        timeoutMs: PLUMBING_TIMEOUT_MS,
      });
    } catch (error) {
      throw toPortError(error, { capability: 'git', operation, context });
    }
    if (result.code !== 0 || result.timedOut) {
      throw toPortError(result.stderr, {
        capability: 'git',
        operation,
        code: result.timedOut ? 'timeout' : 'unavailable',
        message: stderrTail(result.stderr) || `git ${operation} failed`,
        context,
      });
    }
    return result.stdout;
  };

  return {
    findRepositoryRoot: async ({ cwd, signal }) => {
      const result = await execute(
        'findRepositoryRoot',
        ['-C', cwd, 'rev-parse', '--show-toplevel'],
        { cwd },
        signal,
        DISCOVERY_TIMEOUT_MS,
      );
      return result.code === 0 ? result.stdout.trim() || null : null;
    },
    inspectWorktree: async ({ repositoryRoot, signal }) => {
      const headSha = (
        await required(
          'inspectWorktree',
          ['-C', repositoryRoot, 'rev-parse', 'HEAD'],
          {
            repositoryRoot,
          },
          signal,
        )
      ).trim();
      const status = (
        await required(
          'inspectWorktree',
          ['-C', repositoryRoot, 'status', '--porcelain'],
          {
            repositoryRoot,
          },
          signal,
        )
      ).trim();
      const remote = await execute(
        'inspectWorktree',
        ['-C', repositoryRoot, 'remote', 'get-url', 'origin'],
        { repositoryRoot },
        signal,
      );
      return {
        repositoryRoot,
        headSha,
        remoteUrl: remote.code === 0 ? remote.stdout.trim() || null : null,
        dirtySummary: status.length > 0 ? status : null,
      };
    },
    inspectRemoteRef: async ({ remoteUrl, ref, signal }) => {
      const context = { requestedRef: ref ?? 'HEAD' };
      if (hasEmbeddedRemoteCredentials(remoteUrl)) {
        throw toPortError(null, {
          capability: 'git',
          operation: 'inspectRemoteRef',
          code: 'invalid',
          message: 'git remote-ref inspection requires a credential-free remote URL',
          context,
        });
      }
      if (ref !== null && SHA_HEX_40.test(ref)) {
        return Object.freeze({
          kind: 'sha' as const,
          requestedRef: ref,
          resolvedSha: ref.toLowerCase(),
        });
      }

      const names =
        ref === null
          ? (['HEAD'] as const)
          : ([`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`] as const);
      const result = await execute(
        'inspectRemoteRef',
        ['ls-remote', '--', remoteUrl, ...names],
        context,
        signal,
      );
      if (result.code !== 0 || result.timedOut) {
        throw toPortError(null, {
          capability: 'git',
          operation: 'inspectRemoteRef',
          code: result.timedOut ? 'timeout' : 'unavailable',
          message: 'git remote-ref inspection failed',
          context,
        });
      }

      const rows = parseExactRemoteRefRows(result.stdout, new Set(names), context);
      if (ref === null) {
        const resolvedSha = uniqueShaFor(rows, 'HEAD', context);
        if (resolvedSha === null) {
          throw toPortError(null, {
            capability: 'git',
            operation: 'inspectRemoteRef',
            code: 'not-found',
            message: 'remote default ref was not found',
            context,
          });
        }
        return Object.freeze({ kind: 'default' as const, requestedRef: null, resolvedSha });
      }

      const branchName = `refs/heads/${ref}`;
      const tagName = `refs/tags/${ref}`;
      const peeledTagName = `${tagName}^{}`;
      const branchSha = uniqueShaFor(rows, branchName, context);
      const tagSha = uniqueShaFor(rows, tagName, context);
      const peeledTagSha = uniqueShaFor(rows, peeledTagName, context);
      if (branchSha !== null && tagSha !== null) {
        throw toPortError(null, {
          capability: 'git',
          operation: 'inspectRemoteRef',
          code: 'conflict',
          message: 'remote ref name is ambiguous between branch and tag',
          context,
        });
      }
      if (peeledTagSha !== null && tagSha === null) {
        throw toPortError(null, {
          capability: 'git',
          operation: 'inspectRemoteRef',
          code: 'invalid',
          message: 'git remote-ref inspection returned a peeled tag without its tag ref',
          context,
        });
      }
      if (tagSha !== null) {
        return Object.freeze({
          kind: 'tag' as const,
          requestedRef: ref,
          resolvedSha: peeledTagSha ?? tagSha,
        });
      }
      if (branchSha !== null) {
        return Object.freeze({
          kind: 'branch' as const,
          requestedRef: ref,
          resolvedSha: branchSha,
        });
      }
      throw toPortError(null, {
        capability: 'git',
        operation: 'inspectRemoteRef',
        code: 'not-found',
        message: 'remote ref was not found',
        context,
      });
    },
    resolveRemoteRef: async ({ remoteUrl, ref, signal }) => {
      if (ref !== null && SHA_HEX_40.test(ref)) return ref;
      const patterns =
        ref === null ? ['HEAD'] : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
      const result = await execute(
        'resolveRemoteRef',
        ['ls-remote', '--', remoteUrl, ...patterns],
        { remoteUrl, ref: ref ?? 'HEAD' },
        signal,
      );
      if (result.code !== 0) return null;
      const rows = result.stdout
        .split('\n')
        .map((line) => {
          const [sha = '', name = ''] = line.split('\t');
          return { sha: sha.trim(), name: name.trim() };
        })
        .filter((row) => SHA_HEX_40.test(row.sha));
      if (ref !== null) {
        return (
          rows.find((row) => row.name === `refs/tags/${ref}^{}`)?.sha ??
          rows.find((row) => row.name === `refs/tags/${ref}`)?.sha ??
          rows.find((row) => row.name === `refs/heads/${ref}`)?.sha ??
          null
        );
      }
      return rows[0]?.sha ?? null;
    },
    initializeFetch: async ({ repositoryRoot, remoteUrl, signal }) => {
      await required(
        'initializeFetch',
        ['init', '--', repositoryRoot],
        { repositoryRoot, remoteUrl },
        signal,
      );
      await required(
        'initializeFetch',
        ['-C', repositoryRoot, 'remote', 'add', '--', 'origin', remoteUrl],
        { repositoryRoot, remoteUrl },
        signal,
      );
    },
    fetchRef: async ({ repositoryRoot, ref, signal }) => {
      await required(
        'fetchRef',
        [
          '-C',
          repositoryRoot,
          'fetch',
          '--depth=1',
          '--filter=blob:none',
          '--no-tags',
          '--',
          'origin',
          ref ?? 'HEAD',
        ],
        { repositoryRoot, ref: ref ?? 'HEAD' },
        signal,
        FETCH_TIMEOUT_MS,
      );
      const sha = (
        await required(
          'fetchRef',
          ['-C', repositoryRoot, 'rev-parse', 'FETCH_HEAD^{commit}'],
          {
            repositoryRoot,
            ref: ref ?? 'HEAD',
          },
          signal,
        )
      ).trim();
      return { sha };
    },
    listTree: async ({ repositoryRoot, ref, signal }) => {
      assertSafeRevision('listTree', ref);
      const output = await required(
        'listTree',
        ['-C', repositoryRoot, 'ls-tree', '-r', '-z', ref],
        { repositoryRoot, ref },
        signal,
      );
      return output
        .split('\0')
        .filter(Boolean)
        .flatMap((row) => {
          const match = /^([0-7]{6})\s+(blob|tree|commit)\s+[0-9a-f]+\t(.+)$/s.exec(row);
          return match?.[1] && match[2] && match[3]
            ? [
                {
                  mode: match[1],
                  kind: match[2] as 'blob' | 'tree' | 'commit',
                  path: match[3],
                },
              ]
            : [];
        });
    },
    readBlob: async ({ repositoryRoot, ref, path, signal }) => {
      return requiredBytes(
        'readBlob',
        ['-C', repositoryRoot, 'cat-file', 'blob', '--', `${ref}:${path}`],
        {
          repositoryRoot,
          ref,
          path,
        },
        signal,
      );
    },
    materializeTree: async ({ repositoryRoot, ref, path, signal }) => {
      assertSafeRevision('materializeTree', ref);
      if (path.length > 0) {
        await required(
          'materializeTree',
          ['-C', repositoryRoot, 'sparse-checkout', 'init', '--cone'],
          { repositoryRoot, ref, path },
          signal,
        );
        await required(
          'materializeTree',
          ['-C', repositoryRoot, 'sparse-checkout', 'set', '--', path],
          { repositoryRoot, ref, path },
          signal,
        );
      }
      await required(
        'materializeTree',
        ['-C', repositoryRoot, 'checkout', '--detach', ref],
        {
          repositoryRoot,
          ref,
          path,
        },
        signal,
        FETCH_TIMEOUT_MS,
      );
      return path.length > 0 ? join(repositoryRoot, path) : repositoryRoot;
    },
  };
};
