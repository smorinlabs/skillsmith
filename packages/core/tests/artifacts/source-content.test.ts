import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  SOURCE_CONTENT_EXCLUSIONS_V1,
  SOURCE_CONTENT_EXCLUSIONS_VERSION,
  type SourceContentError,
  type SourceContentProjectionV1,
  type SourceContentReadPort,
  hashSourceContentV1,
  projectSourceContent,
  serializeSourceContentProjection,
} from '../../src/artifacts/source-content.ts';
import type { FileMetadata } from '../../src/ports/types.ts';

const ROOT = '/fixture';
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const accessesGitDirectory = (call: string): boolean =>
  call.endsWith('/.git') || call.includes('/.git/');

type TreeNode =
  | Readonly<{ kind: 'dir'; children: readonly string[]; mode?: number; identity?: string }>
  | Readonly<{ kind: 'file'; bytes: Uint8Array; mode?: number; identity?: string }>
  | Readonly<{ kind: 'symlink'; target: string; mode?: number; identity?: string }>
  | Readonly<{ kind: 'other'; mode?: number; identity?: string }>;

type Observation<T> = T | Error;

interface TreeOptions {
  readonly metadata?: Readonly<Record<string, readonly Observation<FileMetadata>[]>>;
  readonly listings?: Readonly<Record<string, readonly Observation<readonly string[]>[]>>;
  readonly fileBytes?: Readonly<Record<string, readonly Observation<Uint8Array>[]>>;
  readonly targets?: Readonly<Record<string, readonly Observation<string>[]>>;
}

const observation = <T>(values: readonly Observation<T>[] | undefined, index: number): T | null => {
  if (values === undefined || values.length === 0) return null;
  const value = values[Math.min(index, values.length - 1)];
  if (value instanceof Error) throw value;
  return value ?? null;
};

class TreePorts implements SourceContentReadPort {
  readonly calls: string[] = [];
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly nodes: Readonly<Record<string, TreeNode>>,
    private readonly options: TreeOptions = {},
  ) {}

  private call(operation: string, path: string): number {
    this.calls.push(`${operation}:${path}`);
    const key = `${operation}:${path}`;
    const index = this.counts.get(key) ?? 0;
    this.counts.set(key, index + 1);
    return index;
  }

  async readFileMetadata(path: string): Promise<FileMetadata> {
    const index = this.call('metadata', path);
    const injected = observation(this.options.metadata?.[path], index);
    if (injected !== null) return injected;
    const node = this.nodes[path];
    if (node === undefined) return { kind: 'absent', mode: null, identity: null };
    return {
      kind: node.kind,
      mode: node.mode ?? (node.kind === 'file' ? 0o644 : 0o755),
      identity: node.identity ?? `${node.kind}:${path}`,
    };
  }

  async listDir(path: string): Promise<readonly string[]> {
    const index = this.call('list', path);
    const injected = observation(this.options.listings?.[path], index);
    if (injected !== null) return [...injected];
    const node = this.nodes[path];
    if (node?.kind !== 'dir') throw new Error('not a fixture directory');
    return [...node.children];
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const index = this.call('bytes', path);
    const injected = observation(this.options.fileBytes?.[path], index);
    if (injected !== null) return new Uint8Array(injected);
    const node = this.nodes[path];
    if (node?.kind !== 'file') throw new Error('not a fixture file');
    return new Uint8Array(node.bytes);
  }

  async readLink(path: string): Promise<string> {
    const index = this.call('link', path);
    const injected = observation(this.options.targets?.[path], index);
    if (injected !== null) return injected;
    const node = this.nodes[path];
    if (node?.kind !== 'symlink') throw new Error('not a fixture symlink');
    return node.target;
  }
}

const expectError = <T>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: SourceContentError }>,
  reason: SourceContentError['reason'],
  field: SourceContentError['field'],
): SourceContentError => {
  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error('expected source-content refusal');
  expect(result.error).toEqual({
    code: 'source-content',
    reason,
    field,
    message:
      reason === 'invalid-root'
        ? 'source content root is invalid'
        : reason === 'unsafe-path'
          ? 'source content path is unsafe'
          : reason === 'normalization-collision'
            ? 'source content paths collide after normalization'
            : reason === 'unsafe-symlink'
              ? 'source content symlink target is unsafe'
              : reason === 'unsupported-entry'
                ? 'source content entry type is unsupported'
                : reason === 'unstable-read'
                  ? 'source content changed while it was read'
                  : 'source content projection is invalid',
  });
  return result.error;
};

const castProjection = (value: unknown): SourceContentProjectionV1 =>
  value as SourceContentProjectionV1;

describe('source-content artifact authority', () => {
  test('stays independent from the compatibility-only legacy store hash', () => {
    for (const file of ['hash.ts', 'lock.ts', 'source-content.ts']) {
      const source = readFileSync(new URL(`../../src/artifacts/${file}`, import.meta.url), 'utf8');
      expect(source).not.toContain('place/store');
      expect(source).not.toContain('contentHashOf');
    }
  });

  test('publishes the single frozen exclusion rule', () => {
    expect(SOURCE_CONTENT_EXCLUSIONS_VERSION).toBe(1);
    expect(SOURCE_CONTENT_EXCLUSIONS_V1).toEqual(['.git']);
    expect(Object.isFrozen(SOURCE_CONTENT_EXCLUSIONS_V1)).toBeTrue();
  });

  test('projects exact schema-ordered JSON and digest through paired observations', async () => {
    const ports = new TreePorts({
      [ROOT]: { kind: 'dir', children: ['run.sh', '.git', 'link', 'empty'] },
      [`${ROOT}/empty`]: { kind: 'dir', children: [] },
      [`${ROOT}/link`]: { kind: 'symlink', target: 'a/../run.sh' },
      [`${ROOT}/run.sh`]: { kind: 'file', bytes: bytes('x\n'), mode: 0o755 },
    });
    const projected = await projectSourceContent(ports, ROOT);
    expect(projected.ok).toBeTrue();
    if (!projected.ok) throw new Error(projected.error.message);
    expect(projected.value).toEqual({
      version: 1,
      exclusionsVersion: 1,
      entries: [
        { path: 'empty', type: 'directory' },
        { path: 'link', type: 'symlink', target: 'run.sh' },
        { path: 'run.sh', type: 'file', executable: true, length: 2, bytes: 'eAo=' },
      ],
    });
    expect(Object.isFrozen(projected.value)).toBeTrue();
    expect(Object.isFrozen(projected.value.entries)).toBeTrue();
    expect(projected.value.entries.every(Object.isFrozen)).toBeTrue();

    const serialized = serializeSourceContentProjection(projected.value);
    expect(serialized).toEqual({
      ok: true,
      value:
        '{"version":1,"exclusionsVersion":1,"entries":[{"path":"empty","type":"directory"},{"path":"link","type":"symlink","target":"run.sh"},{"path":"run.sh","type":"file","executable":true,"length":2,"bytes":"eAo="}]}',
    });
    const digest = hashSourceContentV1(projected.value);
    expect(digest.ok).toBeTrue();
    if (digest.ok) {
      expect(String(digest.value)).toBe(
        'sha256:9fdbab7c915aabb2b28ce462d90bc0d6f54c50b38105f1094f230239f7ff1ef4',
      );
    }
    expect(ports.calls).toEqual([
      'metadata:/fixture',
      'metadata:/fixture',
      'list:/fixture',
      'metadata:/fixture',
      'metadata:/fixture/empty',
      'list:/fixture/empty',
      'metadata:/fixture/empty',
      'list:/fixture/empty',
      'metadata:/fixture/empty',
      'metadata:/fixture/link',
      'link:/fixture/link',
      'metadata:/fixture/link',
      'link:/fixture/link',
      'metadata:/fixture/link',
      'metadata:/fixture/run.sh',
      'bytes:/fixture/run.sh',
      'metadata:/fixture/run.sh',
      'bytes:/fixture/run.sh',
      'metadata:/fixture/run.sh',
      'list:/fixture',
      'metadata:/fixture',
    ]);
    expect(ports.calls.some(accessesGitDirectory)).toBeFalse();
  });

  test('normalizes names, sorts by UTF-8 bytes, and excludes only .git', async () => {
    const decomposed = 'e\u0301';
    const ports = new TreePorts({
      [ROOT]: { kind: 'dir', children: ['git', decomposed, '.git', '.github', '.DS_Store'] },
      [`${ROOT}/git`]: { kind: 'dir', children: [] },
      [`${ROOT}/${decomposed}`]: { kind: 'file', bytes: bytes('') },
      [`${ROOT}/.github`]: { kind: 'dir', children: [] },
      [`${ROOT}/.DS_Store`]: { kind: 'file', bytes: bytes('') },
    });
    const result = await projectSourceContent(ports, ROOT);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.entries.map((entry) => entry.path)).toEqual([
      '.DS_Store',
      '.github',
      'git',
      'é',
    ]);
    expect(ports.calls.some(accessesGitDirectory)).toBeFalse();

    const collision = new TreePorts({
      [ROOT]: { kind: 'dir', children: [decomposed, 'é'] },
    });
    expectError(
      await projectSourceContent(collision, ROOT),
      'normalization-collision',
      'entries[].path',
    );
  });

  test('refuses unsafe names, escaping links, and special nodes without following links', async () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'C:drive', 'bad\u0000name']) {
      const ports = new TreePorts({ [ROOT]: { kind: 'dir', children: [name] } });
      expectError(await projectSourceContent(ports, ROOT), 'unsafe-path', 'entries[].path');
    }

    const escaping = new TreePorts({
      [ROOT]: { kind: 'dir', children: ['link'] },
      [`${ROOT}/link`]: { kind: 'symlink', target: '../P17_SECRET' },
    });
    const escapingResult = await projectSourceContent(escaping, ROOT);
    expectError(escapingResult, 'unsafe-symlink', 'entries[].target');
    expect(JSON.stringify(escapingResult)).not.toContain('P17_SECRET');
    expect(escaping.calls.filter((call) => call.startsWith('link:'))).toHaveLength(2);
    expect(escaping.calls.filter((call) => call.startsWith('bytes:'))).toHaveLength(0);

    const special = new TreePorts({
      [ROOT]: { kind: 'dir', children: ['socket'] },
      [`${ROOT}/socket`]: { kind: 'other' },
    });
    expectError(await projectSourceContent(special, ROOT), 'unsupported-entry', 'entries[].type');
  });

  test('refuses changing bytes, metadata, targets, and membership as unstable reads', async () => {
    const fileTree = {
      [ROOT]: { kind: 'dir', children: ['file'] } as const,
      [`${ROOT}/file`]: { kind: 'file', bytes: bytes('a') } as const,
    };
    const byteRace = new TreePorts(fileTree, {
      fileBytes: { [`${ROOT}/file`]: [bytes('a'), bytes('b')] },
    });
    expectError(await projectSourceContent(byteRace, ROOT), 'unstable-read', 'entries');

    const modeRace = new TreePorts(fileTree, {
      metadata: {
        [`${ROOT}/file`]: [
          { kind: 'file', mode: 0o644, identity: 'file' },
          { kind: 'file', mode: 0o755, identity: 'file' },
        ],
      },
    });
    expectError(await projectSourceContent(modeRace, ROOT), 'unstable-read', 'entries');

    const targetRace = new TreePorts(
      {
        [ROOT]: { kind: 'dir', children: ['link'] },
        [`${ROOT}/link`]: { kind: 'symlink', target: 'a' },
      },
      { targets: { [`${ROOT}/link`]: ['a', 'b'] } },
    );
    expectError(await projectSourceContent(targetRace, ROOT), 'unstable-read', 'entries');

    const membershipRace = new TreePorts(
      { [ROOT]: { kind: 'dir', children: [] } },
      { listings: { [ROOT]: [[], ['late']] } },
    );
    expectError(await projectSourceContent(membershipRace, ROOT), 'unstable-read', 'entries');
  });

  test('classifies initial-root failures separately and keeps errors secret-safe', async () => {
    const fixtures = [
      new TreePorts({}),
      new TreePorts({ [ROOT]: { kind: 'file', bytes: bytes('secret') } }),
      new TreePorts(
        { [ROOT]: { kind: 'dir', children: [] } },
        { metadata: { [ROOT]: [new Error('P17_ROOT_SECRET')] } },
      ),
    ];
    for (const ports of fixtures) {
      const result = await projectSourceContent(ports, ROOT);
      expectError(result, 'invalid-root', 'root');
      expect(JSON.stringify(result)).not.toContain('P17_ROOT_SECRET');
      expect(JSON.stringify(result)).not.toContain(ROOT);
    }
  });

  test('owns schema order and refuses fabricated invalid projections without throwing', () => {
    const valid = castProjection({
      entries: [{ bytes: 'eAo=', length: 2, executable: true, type: 'file', path: 'run.sh' }],
      exclusionsVersion: 1,
      version: 1,
    });
    expect(serializeSourceContentProjection(valid)).toEqual({
      ok: true,
      value:
        '{"version":1,"exclusionsVersion":1,"entries":[{"path":"run.sh","type":"file","executable":true,"length":2,"bytes":"eAo="}]}',
    });

    const cases = [
      [{ version: 2, exclusionsVersion: 1, entries: [] }, 'version'],
      [{ version: 1, exclusionsVersion: 2, entries: [] }, 'exclusionsVersion'],
      [{ version: 1, exclusionsVersion: 1, entries: [], extra: true }, 'projection'],
      [
        {
          version: 1,
          exclusionsVersion: 1,
          entries: [
            { path: 'z', type: 'directory' },
            { path: 'a', type: 'directory' },
          ],
        },
        'entries',
      ],
      [
        { version: 1, exclusionsVersion: 1, entries: [{ path: 'e\u0301', type: 'directory' }] },
        'entries[].path',
      ],
      [
        {
          version: 1,
          exclusionsVersion: 1,
          entries: [{ path: 'link', type: 'symlink', target: '../escape' }],
        },
        'entries[].target',
      ],
      [
        {
          version: 1,
          exclusionsVersion: 1,
          entries: [{ path: 'file', type: 'file', executable: false, length: 2, bytes: 'eA==' }],
        },
        'entries[].length',
      ],
      [
        {
          version: 1,
          exclusionsVersion: 1,
          entries: [{ path: 'file', type: 'file', executable: false, length: 1, bytes: '%%%%' }],
        },
        'entries[].bytes',
      ],
    ] as const;
    for (const [projection, field] of cases) {
      expectError(
        serializeSourceContentProjection(castProjection(projection)),
        'invalid-projection',
        field,
      );
      expectError(hashSourceContentV1(castProjection(projection)), 'invalid-projection', field);
    }

    const hostile = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => {
        throw new Error('P17_PROJECTION_SECRET');
      },
    });
    const hostileResult = serializeSourceContentProjection(castProjection(hostile));
    expectError(hostileResult, 'invalid-projection', 'projection');
    expect(JSON.stringify(hostileResult)).not.toContain('P17_PROJECTION_SECRET');
  });
});
