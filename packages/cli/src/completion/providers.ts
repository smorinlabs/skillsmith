import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { FileMetadataReadPort, FileReadPort } from '@skillsmith/core';
import { manifestV1Codec } from '@skillsmith/core/contracts/v1';
import type { CompletionProviderKind } from '../spec/types.ts';

export const COMPLETION_PROVIDER_LIMITS = Object.freeze({
  ancestors: 32,
  directoryEntries: 512,
  manifestBytes: 256 * 1024,
  milliseconds: 500,
});

export interface CompletionCandidate {
  readonly value: string;
  readonly description: string;
}

export type CompletionReadPorts = Pick<FileReadPort, 'pathKind'> &
  FileMetadataReadPort & {
    readonly listDirBounded: (path: string, maxEntries: number) => Promise<readonly string[]>;
    readonly readFileSnapshotNoFollow: (
      path: string,
      maxBytes: number,
    ) => Promise<{
      readonly bytes: Uint8Array;
      readonly metadata: {
        readonly kind: 'file';
        readonly mode: number | null;
        readonly identity: string;
        readonly sizeBytes: number;
      };
    }>;
  };

export interface CompletionProviderContext {
  readonly cwd: string;
  readonly monotonicMilliseconds: () => number;
  readonly ports: CompletionReadPorts;
}

interface ProviderBudget {
  readonly started: number;
  readonly context: CompletionProviderContext;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const checkDeadline = (budget: ProviderBudget): void => {
  if (
    budget.context.monotonicMilliseconds() - budget.started >
    COMPLETION_PROVIDER_LIMITS.milliseconds
  ) {
    throw new Error('completion provider deadline exceeded');
  }
};

const assertSafeDirectory = async (directory: string, budget: ProviderBudget): Promise<void> => {
  const absolute = resolve(directory);
  const root = parsePath(absolute).root;
  const components = relative(root, absolute).split(sep).filter(Boolean);
  if (components.length > COMPLETION_PROVIDER_LIMITS.ancestors) {
    throw new Error('completion path component bound exceeded');
  }
  let current = root;
  for (const component of components) {
    current = join(current, component);
    checkDeadline(budget);
    if ((await budget.context.ports.pathKind(current)) !== 'dir') {
      throw new Error('completion directory path is unsafe');
    }
    checkDeadline(budget);
  }
};

const boundedEntries = async (
  directory: string,
  budget: ProviderBudget,
): Promise<readonly string[]> => {
  await assertSafeDirectory(directory, budget);
  checkDeadline(budget);
  const entries = await budget.context.ports.listDirBounded(
    directory,
    COMPLETION_PROVIDER_LIMITS.directoryEntries,
  );
  checkDeadline(budget);
  return [...entries].sort(compareText);
};

const prefixParts = (
  cwd: string,
  prefix: string,
): { readonly directory: string; readonly displayDirectory: string; readonly leaf: string } => {
  const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf(sep));
  const displayDirectory = slash < 0 ? '' : prefix.slice(0, slash + 1);
  const directoryPart = slash < 0 ? '.' : prefix.slice(0, slash) || sep;
  return {
    directory: isAbsolute(directoryPart) ? directoryPart : resolve(cwd, directoryPart),
    displayDirectory,
    leaf: slash < 0 ? prefix : prefix.slice(slash + 1),
  };
};

const pathCandidates = async (
  prefix: string,
  context: CompletionProviderContext,
  budget: ProviderBudget,
  manifestOnly: boolean,
): Promise<readonly CompletionCandidate[]> => {
  const parts = prefixParts(context.cwd, prefix);
  const candidates: CompletionCandidate[] = [];
  for (const name of await boundedEntries(parts.directory, budget)) {
    checkDeadline(budget);
    if (!name.startsWith(parts.leaf)) continue;
    const path = join(parts.directory, name);
    const kind = await context.ports.pathKind(path);
    checkDeadline(budget);
    if (kind === 'absent' || kind === 'symlink') continue;
    if (manifestOnly && kind !== 'dir' && !name.endsWith('.toml')) continue;
    candidates.push({
      value: `${parts.displayDirectory}${name}${kind === 'dir' ? '/' : ''}`,
      description:
        kind === 'dir' ? 'Local directory' : manifestOnly ? 'Local manifest' : 'Local path',
    });
  }
  return candidates;
};

const manifestSkillNames = async (
  context: CompletionProviderContext,
  budget: ProviderBudget,
): Promise<readonly CompletionCandidate[]> => {
  let directory = context.cwd;
  await assertSafeDirectory(directory, budget);
  for (let depth = 0; depth < COMPLETION_PROVIDER_LIMITS.ancestors; depth += 1) {
    checkDeadline(budget);
    const manifestPath = join(directory, 'skillsmith.toml');
    const before = await context.ports.readFileMetadata(manifestPath);
    checkDeadline(budget);
    if (before.kind !== 'absent') {
      if (
        before.kind !== 'file' ||
        !Number.isSafeInteger(before.sizeBytes) ||
        (before.sizeBytes ?? -1) < 0 ||
        (before.sizeBytes ?? Number.POSITIVE_INFINITY) > COMPLETION_PROVIDER_LIMITS.manifestBytes
      ) {
        throw new Error('completion manifest metadata is unsafe');
      }
      const snapshot = await context.ports.readFileSnapshotNoFollow(
        manifestPath,
        COMPLETION_PROVIDER_LIMITS.manifestBytes,
      );
      checkDeadline(budget);
      if (
        snapshot.bytes.byteLength > COMPLETION_PROVIDER_LIMITS.manifestBytes ||
        snapshot.bytes.byteLength !== before.sizeBytes ||
        snapshot.metadata.kind !== 'file' ||
        snapshot.metadata.identity !== before.identity ||
        snapshot.metadata.sizeBytes !== snapshot.bytes.byteLength
      ) {
        throw new Error('completion manifest changed while reading');
      }
      const decoded = manifestV1Codec.decode(snapshot.bytes);
      if (!decoded.ok) throw new Error('completion manifest is invalid');
      return decoded.value.model.skills.map((skill) => ({
        value: skill.name,
        description: 'Declared skill',
      }));
    }
    const parent = dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
  return [];
};

const nearbySkillNames = async (
  context: CompletionProviderContext,
  budget: ProviderBudget,
): Promise<readonly CompletionCandidate[]> => {
  const candidates: CompletionCandidate[] = [];
  for (const name of await boundedEntries(context.cwd, budget)) {
    checkDeadline(budget);
    const directory = join(context.cwd, name);
    const relativeDirectory = relative(context.cwd, directory);
    if (relativeDirectory.startsWith('..') || isAbsolute(relativeDirectory)) continue;
    if ((await context.ports.pathKind(directory)) !== 'dir') continue;
    checkDeadline(budget);
    if ((await context.ports.readFileMetadata(join(directory, 'SKILL.md'))).kind !== 'file')
      continue;
    checkDeadline(budget);
    candidates.push({ value: basename(directory), description: 'Nearby local skill' });
  }
  return candidates;
};

const skillCandidates = async (
  prefix: string,
  context: CompletionProviderContext,
  budget: ProviderBudget,
): Promise<readonly CompletionCandidate[]> => {
  const candidates = [
    ...(await manifestSkillNames(context, budget)),
    ...(await nearbySkillNames(context, budget)),
  ];
  const byValue = new Map<string, CompletionCandidate>();
  for (const candidate of candidates) {
    if (!candidate.value.startsWith(prefix)) continue;
    if (!byValue.has(candidate.value)) byValue.set(candidate.value, candidate);
  }
  return [...byValue.values()].sort((left, right) => compareText(left.value, right.value));
};

export const completeLocalProvider = async (
  kind: CompletionProviderKind,
  prefix: string,
  context: CompletionProviderContext,
): Promise<readonly CompletionCandidate[]> => {
  const budget = { started: context.monotonicMilliseconds(), context };
  checkDeadline(budget);
  if (kind === 'path') return pathCandidates(prefix, context, budget, false);
  if (kind === 'manifest') return pathCandidates(prefix, context, budget, true);
  return skillCandidates(prefix, context, budget);
};
