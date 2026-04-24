import type { SkillEntry } from '@skillsmith/core';

export interface ListHumanOpts {
  long: boolean;
}

export const renderListHuman = (entries: readonly SkillEntry[], opts: ListHumanOpts): string => {
  if (entries.length === 0) return 'No skills installed.\n';
  const grouped = new Map<string, Map<string, SkillEntry[]>>();
  for (const e of entries) {
    if (!grouped.has(e.tool)) grouped.set(e.tool, new Map());
    const byScope = grouped.get(e.tool);
    if (!byScope) continue;
    if (!byScope.has(e.scope)) byScope.set(e.scope, []);
    byScope.get(e.scope)?.push(e);
  }
  const lines: string[] = [];
  for (const [tool, byScope] of grouped) {
    lines.push(`# ${tool}`);
    for (const [scope, skills] of byScope) {
      lines.push(`  ${scope}:`);
      for (const s of skills) {
        const desc = s.frontmatter?.description ?? '';
        lines.push(opts.long ? `    ${s.name}  ${s.path}  ${desc}` : `    ${s.name}  ${desc}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
};
