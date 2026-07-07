import { describe, expect, test } from 'bun:test';
import * as core from '@skillsmith/core';
import pkg from '../package.json' with { type: 'json' };

describe('@skillsmith/core public API', () => {
  test('exports the documented runtime symbols', () => {
    const expected = new Set([
      'VERSION',
      'defaultScanEnv',
      'noopLogger',
      'registry',
      'listSupportedTools',
      'getAgent',
      'detectAll',
      'detectTool',
      'ok',
      'err',
      'isOk',
      'isErr',
      'map',
      'mapErr',
      'genericError',
      'unknownToolError',
      'configError',
      'loadConfig',
      'saveConfig',
      'getConfigPath',
      'findProjectConfig',
      'resolveExplicitFile',
      'CONFIG_KEYS',
      'SCOPES',
      'SUPPORTED_TOOLS',
      'parseSkillFrontmatter',
      'listSkills',
      'runChecks',
      'builtInChecks',
      'skillParseError',
      'runVerify',
      'VERIFY_TOOLS',
      'VERIFIED_AGAINST',
    ]);
    const actual = new Set(Object.keys(core));
    for (const k of expected) expect(actual.has(k)).toBe(true);
  });

  test('VERSION matches packages/core/package.json', () => {
    expect(core.VERSION).toBe(pkg.version);
  });

  test('detectAll is callable with defaultScanEnv and returns a Result', async () => {
    const env = await core.defaultScanEnv();
    const r = await core.detectAll(env);
    expect(typeof r.ok).toBe('boolean');
  });
});
