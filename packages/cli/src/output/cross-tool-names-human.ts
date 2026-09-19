import type { CrossToolNameGroup } from '@skillsmith/core';

export const renderCrossToolNamesHuman = (
  groups: readonly CrossToolNameGroup[],
  matchedEntries: number,
): string => {
  if (groups.length === 0)
    return matchedEntries === 0
      ? 'No skills matched the selected inventory.\n'
      : 'No skill names repeat across the selected tools.\n';
  const blocks = groups.map((group) => {
    const tools = new Set(group.members.map((member) => member.tool)).size;
    const lines = [
      `${group.name} (${tools} tools, ${group.members.length} placements)`,
      ...group.members.map((member) => `  ${member.tool} ${member.scope} ${member.path}`),
    ];
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
};
