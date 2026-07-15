import { type InstallRecord, SUPPORTED_TOOLS, type SupportedTool } from '@skillsmith/core';

export interface RenderOptions {
  detectedOnly: boolean;
  capabilities?: boolean;
  capabilitySnapshot?: Readonly<{
    readonly tools: ReadonlyArray<
      Readonly<{
        readonly id: string;
        readonly operations: Readonly<
          Record<
            string,
            Readonly<{
              readonly supported: boolean;
              readonly scopes: readonly string[];
              readonly remediation: string | null;
            }>
          >
        >;
      }>
    >;
  }>;
}

const escapeCell = (s: string): string =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareInstallRecords = (left: InstallRecord, right: InstallRecord): number =>
  compareText(left.path, right.path) ||
  compareText(left.version, right.version) ||
  compareText(left.installMethod, right.installMethod);

export const renderAgentsMarkdown = (
  results: ReadonlyMap<SupportedTool, readonly InstallRecord[]>,
  opts: RenderOptions,
): string => {
  const lines: string[] = ['# Tools detected', ''];
  const selectedTools = SUPPORTED_TOOLS.filter((tool) => results.has(tool));
  for (const tool of selectedTools) {
    const records = results.get(tool) ?? [];
    if (records.length === 0) {
      if (!opts.detectedOnly) lines.push(`## ${tool} — not detected`, '');
      continue;
    }

    const classification =
      records.length === 1 ? 'one installation' : `multiple installations (${records.length})`;
    lines.push(
      `## ${tool} — ${classification}`,
      '',
      '| Path | Version | Install method |',
      '|---|---|---|',
    );
    for (const record of [...records].sort(compareInstallRecords)) {
      lines.push(
        `| ${escapeCell(record.path)} | ${escapeCell(record.version)} | ${escapeCell(record.installMethod)} |`,
      );
    }
    lines.push('');
  }

  if (opts.capabilities && opts.capabilitySnapshot !== undefined) {
    lines.push('# Capabilities', '');
    for (const tool of opts.capabilitySnapshot.tools) {
      lines.push(
        `## ${tool.id}`,
        '',
        '| Operation | Supported | Scopes | Remediation |',
        '|---|---|---|---|',
      );
      for (const [operation, capability] of Object.entries(tool.operations)) {
        lines.push(
          `| ${escapeCell(operation)} | ${capability.supported ? 'yes' : 'no'} | ${capability.scopes.length === 0 ? '—' : escapeCell(capability.scopes.join(', '))} | ${capability.remediation === null ? '—' : escapeCell(capability.remediation)} |`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
};
