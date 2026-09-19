import { SUPPORTED_TOOLS, type SupportedTool } from '../agents/types.ts';
import { SCOPES, type Scope } from '../config/types.ts';
import type { SkillEntry } from '../skills/types.ts';

export interface CrossToolNameMember {
  readonly tool: SupportedTool;
  readonly scope: Scope;
  readonly path: string;
}

export interface CrossToolNameGroup {
  readonly name: string;
  readonly members: readonly CrossToolNameMember[];
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const toolOrder = new Map<SupportedTool, number>(
  SUPPORTED_TOOLS.map((tool, index) => [tool, index]),
);
const scopeOrder = new Map<Scope, number>(SCOPES.map((scope, index) => [scope, index]));

const compareMembers = (
  left: Pick<SkillEntry, 'tool' | 'scope' | 'path'>,
  right: Pick<SkillEntry, 'tool' | 'scope' | 'path'>,
): number =>
  (toolOrder.get(left.tool) ?? Number.MAX_SAFE_INTEGER) -
    (toolOrder.get(right.tool) ?? Number.MAX_SAFE_INTEGER) ||
  (scopeOrder.get(left.scope) ?? Number.MAX_SAFE_INTEGER) -
    (scopeOrder.get(right.scope) ?? Number.MAX_SAFE_INTEGER) ||
  compareText(left.path, right.path);

/**
 * Group selected inventory names reused across tools. Grouping is exact and
 * case-sensitive on the raw reported name: a group requires placements under
 * at least two distinct tools. One tool across several scopes is not a group,
 * and a shared real path never suppresses one. Name reuse only: no conflict,
 * winner, or precedence claim. Groups sort by raw name; members by supported
 * tool order, canonical scope order, then path. Sort is stable.
 */
export const groupCrossToolNames = (
  entries: readonly SkillEntry[],
): readonly CrossToolNameGroup[] => {
  const byName = new Map<string, SkillEntry[]>();
  for (const entry of entries) {
    const bucket = byName.get(entry.name);
    if (bucket === undefined) byName.set(entry.name, [entry]);
    else bucket.push(entry);
  }
  const groups: CrossToolNameGroup[] = [];
  for (const [name, members] of byName) {
    if (new Set(members.map((member) => member.tool)).size < 2) continue;
    groups.push({
      name,
      members: [...members].sort(compareMembers).map((member) => ({
        tool: member.tool,
        scope: member.scope,
        path: member.path,
      })),
    });
  }
  return groups.sort((left, right) => compareText(left.name, right.name));
};
