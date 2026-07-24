import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import { validateManifestName } from '../artifacts/identity.ts';
import type { FileMetadata, FileMetadataReadPort, FileReadPort } from '../ports/types.ts';
import type {
  GcEntryIdentity,
  GcInventory,
  GcInventoryIssue,
  GcObjectObservation,
} from './types.ts';

export type GcInventoryPorts = Pick<
  FileReadPort,
  'isExecutable' | 'listDir' | 'modifiedAt' | 'readBytes' | 'readLink' | 'realpath'
> &
  FileMetadataReadPort;

const encoder = new TextEncoder();
const NAMESPACE = /^[A-Za-z0-9._-]+$/u;
const REVISION = /^(.*)@(dirty-[0-9a-f]{12}|content-[0-9a-f]{12}|[0-9a-f]{12})$/u;

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const compare = (left: string, right: string): number =>
  Buffer.from(left).compare(Buffer.from(right));

const hash = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

const issue = (code: GcInventoryIssue['code'], path: string, reason: string): GcInventoryIssue =>
  Object.freeze({ code, path, reason });

const safeMetadata = async (
  ports: GcInventoryPorts,
  path: string,
): Promise<FileMetadata | null> => {
  try {
    return await ports.readFileMetadata(path);
  } catch {
    return null;
  }
};

const sameMetadata = (left: FileMetadata, right: FileMetadata): boolean =>
  left.kind === right.kind &&
  left.mode === right.mode &&
  left.identity === right.identity &&
  left.linkCount === right.linkCount &&
  left.uid === right.uid &&
  left.gid === right.gid;

const safeComponent = (value: string): boolean =>
  value.length > 0 &&
  value !== '.' &&
  value !== '..' &&
  !value.includes('\0') &&
  !value.includes('/') &&
  !value.includes('\\');

const parseRepository = (
  value: string,
): Readonly<{ readonly repository: string; readonly revision: string }> | null => {
  if (!safeComponent(value)) return null;
  const parsed = REVISION.exec(value);
  if (parsed?.[1] === undefined || parsed[2] === undefined || parsed[1].length === 0) return null;
  return { repository: parsed[1], revision: parsed[2] };
};

const safeSymlinkTarget = (entryPath: string, target: string): boolean => {
  if (
    target.length === 0 ||
    isAbsolute(target) ||
    target.includes('\\') ||
    target.includes('\0') ||
    /^[A-Za-z]:/u.test(target)
  ) {
    return false;
  }
  const base = entryPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (base.length === 0) return false;
      base.pop();
    } else {
      base.push(segment);
    }
  }
  return true;
};

interface MeasuredObject {
  readonly contentHash: ArtifactDigest;
  readonly logicalBytes: number;
  readonly entries: readonly GcEntryIdentity[];
}

const measureObject = async (
  ports: GcInventoryPorts,
  root: string,
): Promise<MeasuredObject | GcInventoryIssue> => {
  const entries: GcEntryIdentity[] = [];
  const records: string[] = [];
  let logicalBytes = 0;
  const addBytes = (path: string, bytes: number): GcInventoryIssue | null => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(logicalBytes + bytes)) {
      return issue('byte-overflow', path, 'logical byte total is not a safe integer');
    }
    logicalBytes += bytes;
    return null;
  };
  const visit = async (directory: string): Promise<GcInventoryIssue | null> => {
    const directoryMetadataA = await safeMetadata(ports, directory);
    if (directoryMetadataA?.kind !== 'dir' || directoryMetadataA.identity === null) {
      return issue('unstable-observation', directory, 'directory identity is unavailable');
    }
    let namesA: readonly string[];
    try {
      namesA = [...(await ports.listDir(directory))].sort(compare);
    } catch {
      return issue('unreadable', directory, 'directory listing could not be read');
    }
    for (const name of namesA) {
      if (!safeComponent(name)) return issue('unsafe-entry', directory, 'entry name is unsafe');
      const path = `${directory}${sep}${name}`;
      const projected = relative(root, path).split(sep).join('/');
      const metadataA = await safeMetadata(ports, path);
      if (metadataA?.identity == null) {
        return issue('unstable-observation', path, 'entry metadata is unavailable');
      }
      if (metadataA.kind === 'dir') {
        const nested = await visit(path);
        if (nested !== null) return nested;
      } else if (metadataA.kind === 'file') {
        if (metadataA.linkCount !== 1) {
          return issue('unsafe-hard-link', path, 'regular file link count must equal one');
        }
        let bytesA: Uint8Array;
        let bytesB: Uint8Array;
        let executable: boolean;
        try {
          bytesA = new Uint8Array(await ports.readBytes(path));
          executable = await ports.isExecutable(path);
          bytesB = new Uint8Array(await ports.readBytes(path));
        } catch {
          return issue('unreadable', path, 'regular file could not be measured');
        }
        const metadataB = await safeMetadata(ports, path);
        if (
          metadataB === null ||
          !sameMetadata(metadataA, metadataB) ||
          !Buffer.from(bytesA).equals(Buffer.from(bytesB))
        ) {
          return issue('unstable-observation', path, 'regular file changed during measurement');
        }
        const overflow = addBytes(path, bytesA.byteLength);
        if (overflow !== null) return overflow;
        entries.push({
          path: projected,
          kind: 'file',
          identity: metadataA.identity,
          linkCount: 1,
          logicalBytes: bytesA.byteLength,
          executable,
          target: null,
        });
        records.push(`${projected}\0F${executable ? '1' : '0'}\0${hash(bytesA)}`);
      } else if (metadataA.kind === 'symlink') {
        if (metadataA.linkCount !== 1) {
          return issue('unsafe-hard-link', path, 'symlink link count must equal one');
        }
        let targetA: string;
        let targetB: string;
        try {
          targetA = await ports.readLink(path);
          targetB = await ports.readLink(path);
        } catch {
          return issue('unreadable', path, 'symlink target could not be measured');
        }
        const metadataB = await safeMetadata(ports, path);
        if (metadataB === null || !sameMetadata(metadataA, metadataB) || targetA !== targetB) {
          return issue('unstable-observation', path, 'symlink changed during measurement');
        }
        if (!safeSymlinkTarget(projected, targetA)) {
          return issue('unsafe-symlink', path, 'symlink target escapes the object');
        }
        const bytes = encoder.encode(targetA).byteLength;
        const overflow = addBytes(path, bytes);
        if (overflow !== null) return overflow;
        entries.push({
          path: projected,
          kind: 'symlink',
          identity: metadataA.identity,
          linkCount: 1,
          logicalBytes: bytes,
          executable: null,
          target: targetA,
        });
        records.push(`${projected}\0L\0${targetA}`);
      } else {
        return issue('unsafe-entry', path, 'special filesystem entries are unsupported');
      }
    }
    let namesB: readonly string[];
    try {
      namesB = [...(await ports.listDir(directory))].sort(compare);
    } catch {
      return issue('unstable-observation', directory, 'directory changed during measurement');
    }
    if (JSON.stringify(namesA) !== JSON.stringify(namesB)) {
      return issue('unstable-observation', directory, 'directory changed during measurement');
    }
    const directoryMetadataB = await safeMetadata(ports, directory);
    if (directoryMetadataB === null || !sameMetadata(directoryMetadataA, directoryMetadataB)) {
      return issue(
        'unstable-observation',
        directory,
        'directory metadata changed during measurement',
      );
    }
    return null;
  };
  const measured = await visit(root);
  if (measured !== null) return measured;
  const paired = entries.map((entry, index) => ({ entry, record: records[index] ?? '' }));
  paired.sort((left, right) => compare(left.entry.path, right.entry.path));
  return deepFreeze({
    contentHash: `sha256:${hash(paired.map(({ record }) => record).join('\n'))}` as ArtifactDigest,
    logicalBytes,
    entries: paired.map(({ entry }) => entry),
  });
};

const readStableDirectory = async (
  ports: GcInventoryPorts,
  path: string,
): Promise<
  (FileMetadata & { readonly kind: 'dir'; readonly identity: string }) | GcInventoryIssue
> => {
  const first = await safeMetadata(ports, path);
  const second = await safeMetadata(ports, path);
  if (
    first === null ||
    second === null ||
    first.kind !== 'dir' ||
    first.identity === null ||
    !sameMetadata(first, second)
  ) {
    return issue('unstable-observation', path, 'stable real-directory identity is required');
  }
  return first as FileMetadata & { readonly kind: 'dir'; readonly identity: string };
};

export const inventoryGcStore = async (
  ports: GcInventoryPorts,
  storeRoot: string,
): Promise<GcInventory> => {
  const root = resolve(storeRoot);
  const initial = await safeMetadata(ports, root);
  if (initial?.kind === 'absent') {
    return deepFreeze({ state: 'ok', root, rootIdentity: null, objects: [], issues: [] });
  }
  const rootMetadata = await readStableDirectory(ports, root);
  if ('code' in rootMetadata) {
    return deepFreeze({
      state: 'refused',
      root,
      rootIdentity: null,
      objects: [],
      issues: [rootMetadata],
    });
  }
  try {
    if ((await ports.realpath(root)) !== root) {
      return deepFreeze({
        state: 'refused',
        root,
        rootIdentity: rootMetadata.identity,
        objects: [],
        issues: [
          issue('unsafe-root', root, 'store root has a symlinked or non-canonical ancestor'),
        ],
      });
    }
  } catch {
    return deepFreeze({
      state: 'refused',
      root,
      rootIdentity: rootMetadata.identity,
      objects: [],
      issues: [issue('unsafe-root', root, 'store root canonical path is unavailable')],
    });
  }

  const issues: GcInventoryIssue[] = [];
  const objects: GcObjectObservation[] = [];
  let namespaces: readonly string[];
  try {
    namespaces = [...(await ports.listDir(root))].sort(compare);
  } catch {
    namespaces = [];
    issues.push(issue('unreadable', root, 'store root could not be listed'));
  }
  for (const namespace of namespaces) {
    if (namespace === '.staging' || namespace === '.gc-tombstones') continue;
    const namespacePath = `${root}${sep}${namespace}`;
    if (!NAMESPACE.test(namespace) || namespace === '.' || namespace === '..') {
      issues.push(issue('unsafe-component', namespacePath, 'namespace is not canonical'));
      continue;
    }
    const namespaceMetadata = await readStableDirectory(ports, namespacePath);
    if ('code' in namespaceMetadata) {
      issues.push(
        issue('unsafe-layout', namespacePath, 'namespace must be a stable real directory'),
      );
      continue;
    }
    let repositories: readonly string[];
    try {
      repositories = [...(await ports.listDir(namespacePath))].sort(compare);
    } catch {
      issues.push(issue('unreadable', namespacePath, 'namespace could not be listed'));
      continue;
    }
    for (const repositoryComponent of repositories) {
      const repositoryPath = `${namespacePath}${sep}${repositoryComponent}`;
      const parsed = parseRepository(repositoryComponent);
      if (parsed === null) {
        issues.push(
          issue('unsafe-component', repositoryPath, 'repository revision is not canonical'),
        );
        continue;
      }
      const repositoryMetadata = await readStableDirectory(ports, repositoryPath);
      if ('code' in repositoryMetadata) {
        issues.push(
          issue('unsafe-layout', repositoryPath, 'repository must be a stable real directory'),
        );
        continue;
      }
      let skills: readonly string[];
      try {
        skills = [...(await ports.listDir(repositoryPath))].sort(compare);
      } catch {
        issues.push(issue('unreadable', repositoryPath, 'repository could not be listed'));
        continue;
      }
      for (const skill of skills) {
        const objectPath = `${repositoryPath}${sep}${skill}`;
        if (!validateManifestName(skill, 'gc.skill').ok) {
          issues.push(issue('unsafe-component', objectPath, 'skill name is not canonical'));
          continue;
        }
        const objectMetadata = await readStableDirectory(ports, objectPath);
        if ('code' in objectMetadata) {
          issues.push(
            issue('unsafe-layout', objectPath, 'store object must be a stable real directory'),
          );
          continue;
        }
        const modifiedAtA = await ports.modifiedAt(objectPath).catch(() => null);
        const measured = await measureObject(ports, objectPath);
        const modifiedAtB = await ports.modifiedAt(objectPath).catch(() => null);
        const objectMetadataB = await safeMetadata(ports, objectPath);
        if ('code' in measured) {
          issues.push(measured);
          continue;
        }
        if (
          modifiedAtA === null ||
          modifiedAtB !== modifiedAtA ||
          !Number.isFinite(modifiedAtA) ||
          objectMetadataB === null ||
          !sameMetadata(objectMetadata, objectMetadataB)
        ) {
          issues.push(
            issue('unstable-observation', objectPath, 'object changed during observation'),
          );
          continue;
        }
        const relativePath = `${namespace}/${repositoryComponent}/${skill}`;
        const id = hash(`${relativePath}\0${measured.contentHash}`);
        objects.push(
          deepFreeze({
            id,
            kind: 'store',
            path: objectPath,
            relativePath,
            namespace,
            repository: parsed.repository,
            revision: parsed.revision,
            skill,
            contentHash: measured.contentHash,
            modifiedAt: modifiedAtA,
            logicalBytes: measured.logicalBytes,
            rootIdentity: rootMetadata.identity,
            namespaceIdentity: namespaceMetadata.identity,
            repositoryIdentity: repositoryMetadata.identity,
            directoryIdentity: objectMetadata.identity,
            directoryLinkCount: objectMetadata.linkCount ?? -1,
            entries: measured.entries,
          }),
        );
      }
    }
  }
  if (issues.length > 0) {
    return deepFreeze({
      state: 'refused',
      root,
      rootIdentity: rootMetadata.identity,
      objects: [],
      issues: issues.sort((left, right) => compare(left.path, right.path)),
    });
  }
  objects.sort((left, right) => compare(left.path, right.path));
  return deepFreeze({
    state: 'ok',
    root,
    rootIdentity: rootMetadata.identity,
    objects,
    issues: [],
  });
};
