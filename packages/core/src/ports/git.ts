import { join } from 'node:path';
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

export const createGitPort = (processPort: ProcessPort): GitPort => {
  const execute = async (
    operation: string,
    args: readonly string[],
    context: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) => {
    try {
      return await processPort.exec('git', args, {
        env: { GIT_TERMINAL_PROMPT: '0' },
        unsetEnv: GIT_REPOSITORY_ENVIRONMENT,
        ...(signal ? { signal } : {}),
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
  ) => {
    const result = await execute(operation, args, context, signal);
    if (result.code !== 0 || result.timedOut) {
      throw toPortError(result.stderr, {
        capability: 'git',
        operation,
        code: result.timedOut ? 'timeout' : 'unavailable',
        message: result.stderr.trim().split('\n')[0] || `git ${operation} failed`,
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
    resolveRemoteRef: async ({ remoteUrl, ref, signal }) => {
      if (ref !== null && SHA_HEX_40.test(ref)) return ref;
      const patterns =
        ref === null ? ['HEAD'] : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
      const result = await execute(
        'resolveRemoteRef',
        ['ls-remote', remoteUrl, ...patterns],
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
        ['init', repositoryRoot],
        { repositoryRoot, remoteUrl },
        signal,
      );
      await required(
        'initializeFetch',
        ['-C', repositoryRoot, 'remote', 'add', 'origin', remoteUrl],
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
          'origin',
          ref ?? 'HEAD',
        ],
        { repositoryRoot, ref: ref ?? 'HEAD' },
        signal,
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
          const match = /^\d+\s+(blob|tree)\s+[0-9a-f]+\t(.+)$/s.exec(row);
          return match?.[1] && match[2]
            ? [{ kind: match[1] as 'blob' | 'tree', path: match[2] }]
            : [];
        });
    },
    readBlob: async ({ repositoryRoot, ref, path, signal }) => {
      const output = await required(
        'readBlob',
        ['-C', repositoryRoot, 'show', `${ref}:${path}`],
        {
          repositoryRoot,
          ref,
          path,
        },
        signal,
      );
      return new TextEncoder().encode(output);
    },
    materializeTree: async ({ repositoryRoot, ref, path, signal }) => {
      if (path.length > 0) {
        await required(
          'materializeTree',
          ['-C', repositoryRoot, 'sparse-checkout', 'init', '--cone'],
          { repositoryRoot, ref, path },
          signal,
        );
        await required(
          'materializeTree',
          ['-C', repositoryRoot, 'sparse-checkout', 'set', path],
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
      );
      return path.length > 0 ? join(repositoryRoot, path) : repositoryRoot;
    },
  };
};
