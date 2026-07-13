import { describe, expect, test } from 'bun:test';
import * as core from '@skillsmith/core';
import pkg from '../package.json' with { type: 'json' };
import { runtimePorts } from './fixtures/runtime-ports.ts';

describe('@skillsmith/core public API', () => {
  test('exports the documented runtime symbols', () => {
    const expected = new Set([
      'VERSION',
      'defaultScanEnv',
      'noopLogger',
      'registry',
      'toolRegistry',
      'createToolRegistry',
      'TOOL_OPERATIONS',
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
      'verifyPlugin',
      'VERIFY_TOOLS',
      'VERIFIED_AGAINST',
      'runPromote',
      'runDev',
      'runRollback',
      'defaultFlipDeps',
      'FLIP_TOOLS',
      'runInstall',
      'runUninstall',
      'defaultInstallDeps',
      'defaultUninstallDeps',
      'parseSource',
    ]);
    const actual = new Set(Object.keys(core));
    for (const k of expected) expect(actual.has(k)).toBe(true);
  });

  test('exports the validated registry without breaking the 1.x inventory projection', () => {
    expect(core.toolRegistry.ids).toEqual(core.SUPPORTED_TOOLS);
    expect(core.toolRegistry.toolsFor('verify-static')).toEqual(core.VERIFY_TOOLS);
    expect(core.toolRegistry.toolsFor('install')).toEqual(core.FLIP_TOOLS);
    expect(core.TOOL_OPERATIONS).toContain('diagnostics');
    const codex = core.toolRegistry.get('codex');
    expect(codex).toBeDefined();
    if (codex === undefined) throw new Error('built-in codex adapter is missing');
    expect(codex.inventory).toBe(core.registry.codex);
    expect(core.createToolRegistry(core.toolRegistry.adapters).ids).toEqual(core.toolRegistry.ids);
  });

  test('VERSION matches packages/core/package.json', () => {
    expect(core.VERSION).toBe(pkg.version);
  });

  test('detectAll is callable with defaultScanEnv and returns a Result', async () => {
    const env = await core.defaultScanEnv();
    const r = await core.detectAll(runtimePorts(env));
    expect(typeof r.ok).toBe('boolean');
  });
});
