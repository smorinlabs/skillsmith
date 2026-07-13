import type { ToolAdapter } from '../../../../packages/core/src/agents/adapter-types.ts';
import { readOnlyFixtureAdapter } from './read-only-adapter.ts';

const writeScopes = ['user', 'project', 'custom'] as const;
const writable = { supported: true, scopes: writeScopes, remediation: null } as const;
const verifiable = { supported: true, scopes: ['artifact'], remediation: null } as const;
const operations = {
  ...readOnlyFixtureAdapter.descriptor.operations,
  install: writable,
  uninstall: writable,
  dev: writable,
  promote: writable,
  undo: writable,
  'verify-static': verifiable,
  'verify-deep': verifiable,
  plan: writable,
  apply: writable,
  sync: writable,
  update: writable,
};

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
    renderedFacts: { deepSkillCoverageSuffix: null, installStaticNotice: null },
  },
  placement: {
    roots: () => [],
    standardRoots: () => [],
    list: async () => ({
      placements: [],
      duplicates: [],
      currentRoot: null,
      legacyRoot: null,
    }),
    resolve: async (_env: unknown, _ctx: unknown, _storeRoot: string, skill: string) => ({
      placement: {
        skill,
        root: '/fixture/skills',
        path: `/fixture/skills/${skill}`,
        class: 'absent' as const,
        symlinkTarget: null,
        dangling: false,
      },
      notices: [],
      duplicateReason: null,
    }),
    noticeForRoot: () => null,
  },
} as const satisfies ToolAdapter<'fixture-write'>;
