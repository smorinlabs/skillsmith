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
    const identity = `${notice.code}:${notice.path}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    lines.push(
      `warning: legacy project config at ${notice.path} remains readable and unchanged; migrate it when Phase ${notice.migrationPhase} tooling becomes available`,
    );
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
};
