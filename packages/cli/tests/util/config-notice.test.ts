import { describe, expect, test } from 'bun:test';
import { renderConfigNotices } from '../../src/util/config-notice.ts';

describe('config compatibility notices', () => {
  test('renders one human Phase-2 warning and no JSON output', () => {
    const config = {
      notices: [
        {
          code: 'legacy-project-config' as const,
          path: '/repo/skillsmith.toml',
          migrationPending: true as const,
          migrationPhase: 2 as const,
        },
        {
          code: 'legacy-project-config' as const,
          path: '/repo/skillsmith.toml',
          migrationPending: true as const,
          migrationPhase: 2 as const,
        },
      ],
    };

    const human = renderConfigNotices(config, 'human');
    expect(human).toContain('/repo/skillsmith.toml');
    expect(human).toContain('migrate it');
    expect(human).toContain('Phase 2');
    expect(human.trim().split('\n')).toHaveLength(1);
    expect(renderConfigNotices(config, 'json')).toBe('');
    expect(renderConfigNotices({}, 'human')).toBe('');
  });
});
