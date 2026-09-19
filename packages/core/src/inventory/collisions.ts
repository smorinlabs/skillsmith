import type { InventoryIdentitySurface } from '../agents/adapter-types.ts';
import { toolRegistry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { type SkillSmithError, configError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';

export const inventoryPlacementKey = (
  tool: SupportedTool,
  surface: InventoryIdentitySurface,
): string => [tool, surface.scope, surface.name, surface.path].join('\u0000');

export const inventoryCollisionKey = (tool: SupportedTool, name: string): string =>
  `${tool}\u0000${name}`;

export const resolveInventoryWinner = (
  tool: SupportedTool,
  name: string,
  candidates: readonly InventoryIdentitySurface[],
): Result<string | null, SkillSmithError> => {
  let winner: string | null;
  try {
    winner = toolRegistry.get(tool)?.inventory.resolveInventoryCollision?.(candidates) ?? null;
  } catch (cause) {
    return err(
      configError(cause instanceof Error ? cause.message : 'inventory collision resolver failed'),
    );
  }
  if (winner !== null && !candidates.some((candidate) => candidate.path === winner)) {
    return err(configError(`inventory resolver returned a non-member winner for ${name}`));
  }
  return ok(winner);
};
