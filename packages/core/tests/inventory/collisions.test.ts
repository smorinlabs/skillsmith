import { describe, expect, test } from 'bun:test';
import type { InventoryIdentitySurface } from '../../src/agents/adapter-types.ts';
import {
  inventoryCollisionKey,
  inventoryPlacementKey,
  resolveInventoryWinner,
} from '../../src/inventory/collisions.ts';

const candidate = (
  path: string,
  scope: InventoryIdentitySurface['scope'],
): InventoryIdentitySurface => ({
  name: 'review',
  scope,
  origin: { kind: 'standalone' },
  rootOrdinal: 0,
  root: `${path}/..`,
  path,
  realpath: path,
});

describe('inventory collision authority', () => {
  test('separates raw placement and runtime collision identities', () => {
    const surface = candidate('/user/review', 'user');
    expect(inventoryPlacementKey('codex', surface)).toBe(
      'codex\u0000user\u0000review\u0000/user/review',
    );
    expect(inventoryCollisionKey('codex', 'review')).toBe('codex\u0000review');
    expect(inventoryCollisionKey('claude-code', 'review')).not.toBe(
      inventoryCollisionKey('codex', 'review'),
    );
  });

  test('uses adapter-owned precedence without inventing a generic winner', () => {
    const candidates = [candidate('/user/review', 'user'), candidate('/project/review', 'project')];
    expect(resolveInventoryWinner('codex', 'review', candidates)).toEqual({
      ok: true,
      value: null,
    });

    const claude = resolveInventoryWinner('claude-code', 'review', candidates);
    expect(claude).toEqual({ ok: true, value: '/user/review' });
  });
});
