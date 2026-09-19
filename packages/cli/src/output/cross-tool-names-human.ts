import { type CrossToolNamesReport, redactSensitiveString } from '@skillsmith/core';

const safeLine = (value: string): string => redactSensitiveString(value).replace(/[\r\n]+/g, ' ');

export const renderCrossToolNamesHuman = (report: CrossToolNamesReport): string => {
  if (report.groups.length === 0)
    return report.matchedEntries === 0
      ? 'No skills matched the selected inventory.\n'
      : 'No skill names repeat across the selected tools.\n';
  const blocks = report.groups.map((group) => {
    const tools = new Set(group.members.map((member) => member.tool)).size;
    const lines = [
      `${group.name} (${tools} tools, ${group.members.length} placements)`,
      ...group.members.map((member) => `  ${member.tool} ${member.scope} ${member.path}`),
    ];
    return lines.map(safeLine).join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
};
