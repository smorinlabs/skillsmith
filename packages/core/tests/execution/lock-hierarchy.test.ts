import { describe, expect, test } from 'bun:test';
import * as publicCore from '../../src/index.ts';

type UnknownRecord = Record<string, unknown>;
type LockRequest = Readonly<{ signal?: AbortSignal }>;
type TestLockPort = Readonly<{
  withFileLock<T>(path: string, operation: () => Promise<T>, options?: LockRequest): Promise<T>;
}>;
type WithExecutionLockHierarchy = <T>(
  port: TestLockPort,
  descriptors: readonly UnknownRecord[],
  operation: () => Promise<T>,
  options?: Readonly<{ signal?: AbortSignal; schedulingStarted?: boolean }>,
) => Promise<T>;

const core = publicCore as unknown as UnknownRecord;

const requireHierarchy = (): WithExecutionLockHierarchy => {
  expect(
    typeof core.withExecutionLockHierarchy,
    'missing G3B-02 public withExecutionLockHierarchy behavior',
  ).toBe('function');
  return core.withExecutionLockHierarchy as WithExecutionLockHierarchy;
};

describe('G3B-02 execution lock hierarchy', () => {
  test('acquires canonical rank/key order and releases in exact reverse order', async () => {
    const withExecutionLockHierarchy = requireHierarchy();
    const events: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const port: TestLockPort = {
      withFileLock: async (path, operation, options) => {
        events.push(`acquire:${path}`);
        signals.push(options?.signal);
        try {
          return await operation();
        } finally {
          events.push(`release:${path}`);
        }
      },
    };
    const controller = new AbortController();
    const descriptors = [
      { rank: 'live', key: 'z-live', path: '/fixture/live-z' },
      { rank: 'artifact-member', key: 'z-member', path: '/fixture/member-z' },
      { rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' },
      { rank: 'artifact-group', key: 'group', path: '/fixture/group' },
      { rank: 'live', key: 'a-live', path: '/fixture/live-a' },
      { rank: 'artifact-member', key: 'a-member', path: '/fixture/member-a' },
    ] as const;

    const value = await withExecutionLockHierarchy(
      port,
      descriptors,
      async () => {
        events.push('operation');
        return 'complete';
      },
      { signal: controller.signal },
    );

    expect(value).toBe('complete');
    expect(events).toEqual([
      'acquire:/fixture/group',
      'acquire:/fixture/member-a',
      'acquire:/fixture/member-z',
      'acquire:/fixture/placements.json',
      'acquire:/fixture/live-a',
      'acquire:/fixture/live-z',
      'operation',
      'release:/fixture/live-z',
      'release:/fixture/live-a',
      'release:/fixture/placements.json',
      'release:/fixture/member-z',
      'release:/fixture/member-a',
      'release:/fixture/group',
    ]);
    expect(signals).toEqual(Array(descriptors.length).fill(controller.signal));
  });

  test('refuses duplicate identities, invalid ranks, and acquisition after scheduling starts', async () => {
    const withExecutionLockHierarchy = requireHierarchy();
    let acquisitions = 0;
    const port: TestLockPort = {
      withFileLock: async (_path, operation) => {
        acquisitions += 1;
        return operation();
      },
    };
    const ledger = { rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' };

    await expect(
      withExecutionLockHierarchy(port, [ledger, { ...ledger }], async () => undefined),
    ).rejects.toThrow(/duplicate.*(key|descriptor)|lock.*duplicate/i);
    await expect(
      withExecutionLockHierarchy(
        port,
        [{ rank: 'other', key: 'other', path: '/fixture/other' }],
        async () => undefined,
      ),
    ).rejects.toThrow(/rank.*unsupported|invalid.*rank/i);
    await expect(
      withExecutionLockHierarchy(port, [ledger], async () => undefined, {
        schedulingStarted: true,
      }),
    ).rejects.toThrow(/scheduling.*started|lock.*after.*schedul/i);
    expect(acquisitions).toBe(0);
  });

  test('honors cancellation before acquiring any lock or running work', async () => {
    const withExecutionLockHierarchy = requireHierarchy();
    const controller = new AbortController();
    controller.abort();
    let acquisitions = 0;
    let ran = false;
    const port: TestLockPort = {
      withFileLock: async (_path, operation) => {
        acquisitions += 1;
        return operation();
      },
    };

    await expect(
      withExecutionLockHierarchy(
        port,
        [{ rank: 'ledger', key: 'ledger', path: '/fixture/placements.json' }],
        async () => {
          ran = true;
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(acquisitions).toBe(0);
    expect(ran).toBeFalse();
  });
});
