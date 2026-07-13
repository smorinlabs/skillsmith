import { readOnlyFixtureAdapter } from './read-only-adapter.ts';

const writeScopes = ['user', 'project', 'custom'] as const;
const operations = Object.fromEntries(
  Object.entries(readOnlyFixtureAdapter.descriptor.operations).map(([id, value]) => [
    id,
    ['detect', 'inventory-skills', 'inventory-commands', 'diagnostics'].includes(id)
      ? value
      : id === 'verify-static' || id === 'verify-deep'
        ? { supported: true, scopes: ['artifact'] as const, remediation: null }
        : id === 'adapt'
          ? value
          : { supported: true, scopes: writeScopes, remediation: null },
  ]),
);

export const writeFixtureAdapter = {
  descriptor: {
    ...readOnlyFixtureAdapter.descriptor,
    id: 'fixture-write',
    order: 91,
    operations,
  },
  inventory: { ...readOnlyFixtureAdapter.inventory, tool: 'fixture-write' },
  verification: {
    verifiedAgainst: '1.0.0',
    modes: ['static', 'deep'],
    verify: async (_ports?: unknown, options: { modes?: readonly ('static' | 'deep')[] } = {}) => ({
      ok: true as const,
      value: {
        tool: 'fixture-write',
        available: true,
        toolVersion: '1.0.0',
        versionDrift: false,
        skipReason: null,
        verdict: 'pass',
        modes: (options.modes ?? ['static']).map((mode) => ({
          mode,
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict: 'pass',
          command: 'fixture verify',
          findings: [],
        })),
      },
    }),
    gatePolicy: { installDeep: true, promote: 'static+deep' },
    targetManifests: ['.fixture-plugin/plugin.json'],
  },
  placement: {
    roots: () => [],
    list: async () => [],
    legacyNotice: () => null,
  },
} as const;
