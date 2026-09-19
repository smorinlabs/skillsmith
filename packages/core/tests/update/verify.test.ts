import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { claudeCodeAdapter } from '../../src/agents/claude-code/index.ts';
import { codexAdapter } from '../../src/agents/codex/index.ts';
import { createToolRegistry } from '../../src/agents/registry.ts';
import { genericError } from '../../src/errors.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import { err, ok } from '../../src/result.ts';
import { verifyUpdateCandidate } from '../../src/update/verify.ts';
import type { SummaryVerdict, ToolVerifier, VerifyMode } from '../../src/verify/types.ts';

const TARGET = join(import.meta.dir, '..', 'fixtures', 'verify', 'dummytest');

const verifier =
  <ToolId extends string>(
    tool: ToolId,
    verdict: SummaryVerdict,
    calls: VerifyMode[][],
  ): ToolVerifier<ToolId> =>
  async (_env, options) => {
    calls.push([...options.modes]);
    return ok({
      tool,
      available: verdict !== 'inconclusive',
      toolVersion: 'fixture',
      versionDrift: false,
      skipReason: verdict === 'inconclusive' ? ('not-installed' as const) : null,
      verdict,
      modes:
        verdict === 'inconclusive'
          ? []
          : options.modes.map((mode) => ({
              mode,
              status: 'ran' as const,
              skipReason: null,
              coverage: { manifest: true, skills: true },
              verdict,
              command: `${tool} fixture`,
              findings: [],
            })),
    });
  };

describe('verifyUpdateCandidate', () => {
  test('uses each adapter update policy to select static or static-plus-deep modes', async () => {
    const claudeCalls: VerifyMode[][] = [];
    const codexCalls: VerifyMode[][] = [];
    const registry = createToolRegistry([
      {
        ...claudeCodeAdapter,
        verification: {
          ...claudeCodeAdapter.verification,
          verify: verifier('claude-code', 'pass', claudeCalls),
        },
      },
      {
        ...codexAdapter,
        verification: {
          ...codexAdapter.verification,
          verify: verifier('codex', 'pass', codexCalls),
        },
      },
    ] as const);
    const env = await defaultRuntimePorts();

    const claude = await verifyUpdateCandidate(
      env,
      { tool: 'claude-code', path: TARGET, strict: false },
      registry,
    );
    const codex = await verifyUpdateCandidate(
      env,
      { tool: 'codex', path: TARGET, strict: false },
      registry,
    );

    expect(claude.ok && claude.value).toMatchObject({
      tool: 'claude-code',
      mode: 'static',
      gate: 'passed',
      blocked: false,
    });
    expect(codex.ok && codex.value).toMatchObject({
      tool: 'codex',
      mode: 'static+deep',
      gate: 'passed',
      blocked: false,
    });
    expect(claudeCalls).toEqual([['static']]);
    expect(codexCalls).toEqual([['static', 'deep']]);
  });

  test('is policy-driven rather than tool-name-driven and applies the shared strict gate', async () => {
    const claudeCalls: VerifyMode[][] = [];
    const codexCalls: VerifyMode[][] = [];
    const registry = createToolRegistry([
      {
        ...claudeCodeAdapter,
        verification: {
          ...claudeCodeAdapter.verification,
          verify: verifier('claude-code', 'warn', claudeCalls),
          gatePolicy: {
            ...claudeCodeAdapter.verification.gatePolicy,
            update: 'static+deep',
          },
        },
      },
      {
        ...codexAdapter,
        verification: {
          ...codexAdapter.verification,
          verify: verifier('codex', 'inconclusive', codexCalls),
          gatePolicy: {
            ...codexAdapter.verification.gatePolicy,
            update: 'static',
          },
        },
      },
    ] as const);
    const env = await defaultRuntimePorts();

    const warned = await verifyUpdateCandidate(
      env,
      { tool: 'claude-code', path: TARGET, strict: false },
      registry,
    );
    const strictWarning = await verifyUpdateCandidate(
      env,
      { tool: 'claude-code', path: TARGET, strict: true },
      registry,
    );
    const inconclusive = await verifyUpdateCandidate(
      env,
      { tool: 'codex', path: TARGET, strict: false },
      registry,
    );
    const strictInconclusive = await verifyUpdateCandidate(
      env,
      { tool: 'codex', path: TARGET, strict: true },
      registry,
    );

    expect(warned.ok && warned.value).toMatchObject({
      mode: 'static+deep',
      gate: 'warned',
      blocked: false,
    });
    expect(strictWarning.ok && strictWarning.value).toMatchObject({
      mode: 'static+deep',
      gate: 'failed',
      blocked: true,
    });
    expect(inconclusive.ok && inconclusive.value).toMatchObject({
      mode: 'static',
      gate: 'inconclusive',
      blocked: false,
    });
    expect(strictInconclusive.ok && strictInconclusive.value).toMatchObject({
      mode: 'static',
      gate: 'failed',
      blocked: true,
    });
    expect(claudeCalls).toEqual([
      ['static', 'deep'],
      ['static', 'deep'],
    ]);
    expect(codexCalls).toEqual([['static'], ['static']]);
  });

  test('returns verifier infrastructure failures without reducing them to a verdict', async () => {
    const registry = createToolRegistry([
      {
        ...claudeCodeAdapter,
        verification: {
          ...claudeCodeAdapter.verification,
          verify: (async () =>
            err(genericError('fixture verifier failed'))) satisfies ToolVerifier<'claude-code'>,
        },
      },
    ] as const);

    const result = await verifyUpdateCandidate(
      await defaultRuntimePorts(),
      { tool: 'claude-code', path: TARGET, strict: false },
      registry,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'generic', message: 'fixture verifier failed' },
    });
  });

  test('refuses capability before verification when a legacy adapter omits update policy', async () => {
    const calls: VerifyMode[][] = [];
    const { update: _update, ...legacyGatePolicy } = claudeCodeAdapter.verification.gatePolicy;
    const registry = createToolRegistry([
      {
        ...claudeCodeAdapter,
        verification: {
          ...claudeCodeAdapter.verification,
          verify: verifier('claude-code', 'pass', calls),
          gatePolicy: legacyGatePolicy,
        },
      },
    ]);

    const result = await verifyUpdateCandidate(
      await defaultRuntimePorts(),
      { tool: 'claude-code', path: TARGET, strict: false },
      registry,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'tool-unavailable',
        message: 'claude-code does not declare the update verification capability',
      },
    });
    expect(calls).toEqual([]);
  });
});
