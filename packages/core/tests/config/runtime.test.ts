import { describe, expect, test } from 'bun:test';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';

describe('resolveRuntimeConfiguration', () => {
  test('deep-freezes the exact decoded whitelist and discards unknown values', () => {
    const configuration = resolveRuntimeConfiguration({
      SKILLSMITH_TOOL: 'codex',
      SKILLSMITH_REGISTRY: 'stable',
      KILO_DISABLE_EXTERNAL_SKILLS: 'true',
      P17_SECRET: 'do-not-forward',
    });

    expect(Object.isFrozen(configuration)).toBeTrue();
    expect(Object.isFrozen(configuration.configLayer)).toBeTrue();
    expect(Object.isFrozen(configuration.configLayer.registry)).toBeTrue();
    expect(configuration.configLayer).toEqual({
      tool: 'codex',
      registry: { default: 'stable' },
    });
    expect(configuration.kiloExternalSkillsDisabled).toBeTrue();
    expect(JSON.stringify(configuration)).not.toContain('do-not-forward');
  });

  test('preserves current boolean and test-pause decoding semantics', () => {
    expect(
      resolveRuntimeConfiguration({
        CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
        KILO_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        SKILLSMITH_E2E: '1',
        SKILLSMITH_TEST_PAUSE_AT: 'live',
      }),
    ).toMatchObject({
      claudePolicySkillsDisabled: true,
      kiloExternalSkillsDisabled: false,
      opencodeClaudeSkillsDisabled: false,
      journalPause: 'live',
    });
    expect(
      resolveRuntimeConfiguration({
        SKILLSMITH_E2E: '0',
        SKILLSMITH_TEST_PAUSE_AT: 'live',
      }).journalPause,
    ).toBeUndefined();
  });
});
