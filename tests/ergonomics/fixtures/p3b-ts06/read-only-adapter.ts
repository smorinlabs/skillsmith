import { join } from 'node:path';
import type {
  InventoryBundle,
  SkillRootsCtx,
  ToolAdapter,
} from '../../../../packages/core/src/agents/adapter-types.ts';
import { readOnlyOperations } from '../../../../packages/core/src/agents/adapter-types.ts';
import type { Scope } from '../../../../packages/core/src/config/types.ts';
import type { PlatformPaths } from '../../../../packages/core/src/ports/types.ts';

export const FIXTURE_P3B_READ_TOOL = 'fixture-p3b-read' as const;

const rootFor = (
  env: PlatformPaths,
  scope: Scope,
  ctx: SkillRootsCtx,
  artifact: 'skills' | 'commands',
): string => {
  switch (scope) {
    case 'system':
      return join(env.xdg.data, 'skillsmith-p3b-read', artifact);
    case 'user':
      return join(env.homeDir, '.skillsmith-p3b-read', artifact);
    case 'project':
      return join(ctx.cwd, '.skillsmith-p3b-read', artifact);
    case 'managed':
      return join(env.xdg.config, 'skillsmith-p3b-read-managed', artifact);
  }
};

const inventory: InventoryBundle<typeof FIXTURE_P3B_READ_TOOL> = {
  tool: FIXTURE_P3B_READ_TOOL,
  installHint: 'install the hermetic fixture-p3b-read executable',
  detect: async () => ({ ok: true, value: [] }),
  getSkillRoots: (env, scope, ctx) => [rootFor(env, scope, ctx, 'skills')],
  getCommandRoots: (env, scope, ctx) => [rootFor(env, scope, ctx, 'commands')],
  getPluginSkillDir: (installPath) => join(installPath, 'fixture-skills'),
  getPluginCommandDir: (installPath) => join(installPath, 'fixture-commands'),
  resolveInventoryCollision: () => null,
};

const definition = {
  descriptor: {
    id: FIXTURE_P3B_READ_TOOL,
    order: 9_001,
    capabilityVersion: 1,
    operations: readOnlyOperations(FIXTURE_P3B_READ_TOOL),
  },
  inventory,
} as const;

const currentToolAdapter = <const Adapter extends ToolAdapter<typeof FIXTURE_P3B_READ_TOOL>>(
  adapter: Adapter,
): Adapter => adapter;

export const readOnlyFixtureAdapter = currentToolAdapter(definition);
