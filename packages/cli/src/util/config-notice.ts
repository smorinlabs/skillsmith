import type { EffectiveConfig } from '@skillsmith/core';

export type ConfigNoticeFormat = 'human' | 'json';

/** Render compatibility metadata without changing any command's structured JSON contract. */
export const renderConfigNotices = (
  config: Pick<EffectiveConfig, 'notices'>,
  format: ConfigNoticeFormat,
): string => {
  if (format === 'json') return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const notice of config.notices ?? []) {
    const identity = `${notice.code}:${'path' in notice ? notice.path : notice.source}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (notice.code === 'legacy-project-config') {
      lines.push(
        `warning: legacy project config at ${notice.path} remains readable and unchanged; migrate it in Phase 2 with config set or config unset`,
      );
      continue;
    }
    lines.push(
      `warning: ${notice.disposition} plural tool selection from ${notice.source}: ${notice.tools.join(', ')}`,
    );
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
};
