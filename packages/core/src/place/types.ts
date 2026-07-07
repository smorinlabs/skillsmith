export const FLIP_TOOLS = ['claude-code', 'codex'] as const;
export type FlipTool = (typeof FLIP_TOOLS)[number];
export type FlipOp = 'promote' | 'dev' | 'rollback';
export type { Placement, PlacementClass } from '../agents/placement-shared.ts';
