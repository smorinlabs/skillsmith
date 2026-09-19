import { toolRegistry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';

export const compareInventoryText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const toolOrder = new Map(toolRegistry.ids.map((tool, index) => [tool, index] as const));
const scopeOrder = new Map(SCOPES.map((scope, index) => [scope, index] as const));
const commandScopeOrder = new Map<Scope, number>([
  ['user', 0],
  ['project', 1],
]);

export interface SkillOrderSurface {
  readonly tool: SupportedTool;
  readonly scope: Scope;
  readonly name: string;
  readonly path: string;
}

export interface CommandOrderSurface extends SkillOrderSurface {
  readonly scope: 'user' | 'project';
}

export const compareSkillInventoryEntries = (
  left: SkillOrderSurface,
  right: SkillOrderSurface,
): number =>
  (toolOrder.get(left.tool) ?? Number.MAX_SAFE_INTEGER) -
    (toolOrder.get(right.tool) ?? Number.MAX_SAFE_INTEGER) ||
  (scopeOrder.get(left.scope) ?? Number.MAX_SAFE_INTEGER) -
    (scopeOrder.get(right.scope) ?? Number.MAX_SAFE_INTEGER) ||
  compareInventoryText(left.name, right.name) ||
  compareInventoryText(left.path, right.path);

export const compareCommandInventoryEntries = (
  left: CommandOrderSurface,
  right: CommandOrderSurface,
): number =>
  (toolOrder.get(left.tool) ?? Number.MAX_SAFE_INTEGER) -
    (toolOrder.get(right.tool) ?? Number.MAX_SAFE_INTEGER) ||
  (commandScopeOrder.get(left.scope) ?? Number.MAX_SAFE_INTEGER) -
    (commandScopeOrder.get(right.scope) ?? Number.MAX_SAFE_INTEGER) ||
  compareInventoryText(left.name, right.name) ||
  compareInventoryText(left.path, right.path);

export const canonicalInventoryTools = (
  tools: readonly SupportedTool[] | undefined,
): readonly SupportedTool[] => {
  const selected = new Set(tools ?? toolRegistry.ids);
  return Object.freeze(toolRegistry.ids.filter((tool) => selected.has(tool)));
};

export const canonicalInventoryScopes = (
  scopes: readonly Scope[] | undefined,
): readonly Scope[] => {
  const selected = new Set(scopes ?? SCOPES);
  return Object.freeze(SCOPES.filter((scope) => selected.has(scope)));
};
