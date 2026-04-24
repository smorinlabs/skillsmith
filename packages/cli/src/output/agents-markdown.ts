import type { InstallRecord, SupportedTool } from '@skillsmith/core';

export interface RenderOptions {
  detectedOnly: boolean;
}

export const renderAgentsMarkdown = (
  results: Map<SupportedTool, InstallRecord[]>,
  opts: RenderOptions,
): string => {
  const lines: string[] = ['# Tools detected', ''];
  const detected: [SupportedTool, InstallRecord[]][] = [];
  const notDetected: SupportedTool[] = [];

  for (const [tool, records] of results) {
    if (records.length > 0) detected.push([tool, records]);
    else notDetected.push(tool);
  }

  for (const [tool, records] of detected) {
    lines.push(`## ${tool}`, '', '| Path | Version | Install method |', '|---|---|---|');
    for (const r of records) {
      lines.push(`| ${r.path} | ${r.version} | ${r.installMethod} |`);
    }
    lines.push('');
  }

  if (!opts.detectedOnly && notDetected.length > 0) {
    lines.push('## Not detected', '');
    for (const t of notDetected) lines.push(`- ${t}`);
    lines.push('');
  }

  return lines.join('\n');
};
