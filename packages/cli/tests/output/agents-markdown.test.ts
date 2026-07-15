import { describe, expect, test } from 'bun:test';
import type { InstallRecord, SupportedTool } from '@skillsmith/core';
import { renderAgentsMarkdown } from '../../src/output/agents-markdown.ts';

const empty: Map<SupportedTool, InstallRecord[]> = new Map([
  ['claude-code', []],
  ['codex', []],
  ['kilo-code', []],
  ['opencode', []],
]);

describe('renderAgentsMarkdown', () => {
  test('labels every empty tool as not detected', () => {
    const md = renderAgentsMarkdown(empty, { detectedOnly: false });
    expect(md).toContain('# Tools detected');
    expect(md).toContain('## claude-code — not detected');
    expect(md).toContain('## codex — not detected');
  });

  test('omits not-detected tools when detectedOnly', () => {
    const md = renderAgentsMarkdown(empty, { detectedOnly: true });
    expect(md).not.toContain('not detected');
  });

  test('renders table rows for detected installs', () => {
    const results = new Map<SupportedTool, InstallRecord[]>([
      [
        'claude-code',
        [
          { path: '/opt/homebrew/bin/claude', version: '1.2.3', installMethod: 'brew' },
          { path: '/Users/u/.npm/bin/claude', version: '1.1.0', installMethod: 'npm-global' },
        ],
      ],
      ['codex', []],
      ['kilo-code', []],
      ['opencode', []],
    ]);
    const md = renderAgentsMarkdown(results, { detectedOnly: false });
    expect(md).toContain('## claude-code — multiple installations (2)');
    expect(md).toContain('| Path | Version | Install method |');
    expect(md).toContain('| /opt/homebrew/bin/claude | 1.2.3 | brew |');
    expect(md).toContain('| /Users/u/.npm/bin/claude | 1.1.0 | npm-global |');
  });

  test('escapes pipes and newlines in cell values', () => {
    const results = new Map<SupportedTool, InstallRecord[]>([
      [
        'claude-code',
        [
          {
            path: '/weird|path/claude',
            version: 'v1.0\nINJECTED | row',
            installMethod: 'brew',
          },
        ],
      ],
      ['codex', []],
      ['kilo-code', []],
      ['opencode', []],
    ]);
    const md = renderAgentsMarkdown(results, { detectedOnly: true });
    expect(md).toContain('/weird\\|path/claude');
    expect(md).not.toMatch(/\nINJECTED/);
    expect(md).toContain('v1.0 INJECTED \\| row');
  });
});
