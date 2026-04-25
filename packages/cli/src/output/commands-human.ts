import type { CommandEntry, Origin } from '@skillsmith/core';

export interface CommandsHumanOpts {
  long: boolean;
}

const formatOrigin = (o: Origin): string => {
  if (o.kind === 'standalone') return 'standalone';
  if (o.kind === 'plugin') return `plugin:${o.pluginId}@${o.pluginVersion}`;
  return 'policy';
};

export const renderCommandsHuman = (
  entries: readonly CommandEntry[],
  opts: CommandsHumanOpts,
): string => {
  if (entries.length === 0) return 'No commands installed.\n';
  const grouped = new Map<string, Map<string, CommandEntry[]>>();
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
    for (const [scope, cmds] of byScope) {
      lines.push(`  ${scope}:`);
      for (const c of cmds) {
        const desc = c.frontmatter?.description ?? '';
        const status = c.enabled === 'on' ? '' : ` [${c.enabled}]`;
        const origin = formatOrigin(c.origin);
        lines.push(
          opts.long
            ? `    ${c.name}  ${origin}${status}  ${c.path}  ${desc}`
            : `    ${c.name}  ${origin}${status}  ${desc}`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
};
