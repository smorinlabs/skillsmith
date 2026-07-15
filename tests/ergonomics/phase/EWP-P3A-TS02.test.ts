import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRuntimeConfiguration } from '../../../packages/core/src/config/runtime.ts';

const FIXTURES = join(import.meta.dir, '../fixtures/p3a-ts02');
const CASES_PATH = join(FIXTURES, 'ledger-state-cases.json');
const LEDGER_PATH = '/data/placements.json';
const CASES_SHA256 = 'sha256:89aec2b694e139c7a0bd97488c5c8b4d7ebd60907dd74ced25399497f71b4281';

type UnknownRecord = Readonly<Record<string, unknown>>;
type StatusResult =
  | Readonly<{ readonly ok: true; readonly value: UnknownRecord }>
  | Readonly<{ readonly ok: false; readonly error: UnknownRecord }>;
type ReadStatus = (ports: UnknownRecord, request: UnknownRecord) => Promise<StatusResult>;

interface LedgerCase {
  readonly id: string;
  readonly source:
    | Readonly<{ readonly kind: 'missing' }>
    | Readonly<{ readonly kind: 'golden'; readonly golden: 'v1' | 'v2' }>
    | Readonly<{ readonly kind: 'literal-utf8'; readonly value: string }>;
  readonly expected: Readonly<{
    readonly outcome: 'ok' | 'error';
    readonly state?: 'absent' | 'present';
    readonly sourceVersion?: 1 | 2 | null;
    readonly currentVersion?: 2;
    readonly migrationPending?: boolean;
    readonly reason?: 'invalid-artifact';
    readonly exitClass: 'success' | 'state';
  }>;
}

interface LedgerCasesFixture {
  readonly schemaVersion: 1;
  readonly signedGoldens: Readonly<
    Record<
      'v1' | 'v2',
      Readonly<{ readonly file: string; readonly bytes: number; readonly sha256: string }>
    >
  >;
  readonly rows: readonly LedgerCase[];
  readonly hostileThrowables: readonly string[];
  readonly requiredPublicTypeNames: readonly string[];
}

const bytesOf = (path: string): Uint8Array => readFileSync(path);
const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fixture = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as LedgerCasesFixture;
let readStatus: ReadStatus;

const sourceBytes = (row: LedgerCase): Uint8Array | null => {
  if (row.source.kind === 'missing') return null;
  if (row.source.kind === 'literal-utf8') return new TextEncoder().encode(row.source.value);
  const golden = fixture.signedGoldens[row.source.golden];
  return bytesOf(resolve(FIXTURES, golden.file));
};

const projectContext = Object.freeze({
  invocationCwd: '/repo',
  effectiveCwd: '/repo',
  projectRoot: '/repo',
  projectIdentity: '/repo',
  projectKind: 'git',
  discoveredConfigPath: null,
  explicitConfigPath: null,
});

const request = Object.freeze({
  projectContext,
  projectPlacement: Object.freeze({
    state: 'selected',
    source: 'shared-project',
    root: '/repo',
    identity: '/repo',
  }),
  configuration: resolveRuntimeConfiguration({ SKILLSMITH_HOME: '/data' }),
  targets: Object.freeze([]),
  tools: Object.freeze(['codex']),
  toolSelectionSource: 'explicit',
  scopes: Object.freeze(['user']),
  scopeSelectionSource: 'explicit',
  selectionSource: 'bounded-default',
  artifactSelection: Object.freeze({ state: 'unselected', reason: 'live-only-scope' }),
});

const portsFor = (
  ledgerBytes: Uint8Array | null,
  readOverride?: () => Promise<Uint8Array>,
): UnknownRecord => {
  const present = ledgerBytes !== null;
  const readBytes = async (path: string): Promise<Uint8Array> => {
    if (path !== LEDGER_PATH || !present) throw new Error('unexpected read');
    if (readOverride !== undefined) return readOverride();
    return new Uint8Array(ledgerBytes);
  };
  return Object.freeze({
    homeDir: '/home/test',
    executableSearchPath: Object.freeze([]),
    platform: 'linux',
    xdg: Object.freeze({ config: '/config', data: '/data', cache: '/cache' }),
    fileExists: async (path: string) => path === LEDGER_PATH && present,
    pathKind: async (path: string) => (path === LEDGER_PATH && present ? 'file' : 'absent'),
    realpath: async (path: string) => path,
    listDir: async () => Object.freeze([]),
    readText: async (path: string) => new TextDecoder().decode(await readBytes(path)),
    readBytes,
    readLink: async () => '',
    isExecutable: async () => false,
    modifiedAt: async () => null,
    readFileMetadata: async (path: string) => ({
      kind: path === LEDGER_PATH && present ? 'file' : 'absent',
      mode: present ? 0o600 : null,
      identity: present ? 'ledger-fixture' : null,
    }),
  });
};

const assertRecursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      assertRecursivelyFrozen(descriptor.value, seen);
    }
  }
};

beforeAll(async () => {
  // Literal guards deliberately run before the planned authority is loaded.
  const caseBytes = bytesOf(CASES_PATH);
  expect(sha256(caseBytes)).toBe(CASES_SHA256);
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.rows.map((row) => row.id)).toEqual([
    'missing',
    'canonical-v1',
    'canonical-v2',
    'zero-byte',
    'whitespace-only',
    'truncated-json',
    'schema-invalid',
    'newer-schema',
  ]);
  expect(new Set(fixture.rows.map((row) => row.id)).size).toBe(8);
  for (const golden of Object.values(fixture.signedGoldens)) {
    const bytes = bytesOf(resolve(FIXTURES, golden.file));
    expect(bytes.byteLength).toBe(golden.bytes);
    expect(sha256(bytes)).toBe(golden.sha256);
  }

  const loaded = await import('../../../packages/core/src/status/index.ts').catch(() => null);
  if (loaded === null || typeof loaded.readStatus !== 'function') {
    throw new Error('missing G3A-01 status authority');
  }
  readStatus = loaded.readStatus as ReadStatus;
});

describe('EWP-P3A-TS02', () => {
  test('family 24: exact eight-row ledger matrix, signed golden reuse, and artifact byte identity', async () => {
    for (const row of fixture.rows) {
      const source = sourceBytes(row);
      const before = source === null ? null : sha256(source);
      const result = await readStatus(portsFor(source), request);

      if (row.expected.outcome === 'ok') {
        expect(result.ok, row.id).toBeTrue();
        if (!result.ok) continue;
        const ledger = result.value.ledger as UnknownRecord;
        expect(ledger, row.id).toMatchObject({
          state: row.expected.state,
          sourceVersion: row.expected.sourceVersion,
          currentVersion: row.expected.currentVersion,
          migrationPending: row.expected.migrationPending,
        });
      } else {
        expect(result, row.id).toMatchObject({
          ok: false,
          error: {
            code: 'status-read',
            reason: row.expected.reason,
            exitClass: row.expected.exitClass,
          },
        });
      }
      expect(source === null ? null : sha256(source), `${row.id} source bytes changed`).toBe(
        before,
      );
    }
  });

  test('family 25: hostile throwables, immutable/permutation join, and focused read/public-type gates', async () => {
    const canary = 'P17_STATUS_THROWABLE_SECRET';
    const throwingValues: readonly unknown[] = [
      new Error(canary),
      canary,
      17,
      null,
      Object.defineProperty({}, 'message', {
        get: () => {
          throw new Error(canary);
        },
      }),
      {
        toString: () => {
          throw new Error(canary);
        },
      },
      new Proxy(
        {},
        {
          get: () => {
            throw new Error(canary);
          },
        },
      ),
    ];
    expect(throwingValues).toHaveLength(fixture.hostileThrowables.length);

    for (const hostile of throwingValues) {
      const result = await readStatus(
        portsFor(new TextEncoder().encode('{}'), async () => {
          throw hostile;
        }),
        request,
      );
      expect(result.ok).toBeFalse();
      expect(JSON.stringify(result)).not.toContain(canary);
    }

    const canonicalRow = fixture.rows.find((row) => row.id === 'canonical-v2');
    expect(canonicalRow).toBeDefined();
    if (canonicalRow === undefined) return;
    const canonical = sourceBytes(canonicalRow);
    expect(canonical).not.toBeNull();
    if (canonical === null) return;
    const first = await readStatus(portsFor(canonical), request);
    const second = await readStatus(portsFor(canonical), request);
    expect(second).toEqual(first);
    if (first.ok) assertRecursivelyFrozen(first.value);

    const proc = Bun.spawn(
      ['bun', 'x', 'tsc', '--pretty', 'false', '-p', join(FIXTURES, 'tsconfig.json')],
      { cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(`${stdout}${stderr}`, 'public status type fixture must compile').toBe('');
    expect(exitCode).toBe(0);
  });
});
