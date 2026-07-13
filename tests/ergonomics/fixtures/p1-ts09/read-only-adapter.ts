const readScopes = ['user', 'project', 'system', 'managed'] as const;

export const readOnlyFixtureAdapter = {
  descriptor: {
    id: 'fixture-read',
    order: 90,
    capabilityVersion: 1,
    operations: {
      detect: { supported: true, scopes: [], remediation: null },
      'inventory-skills': { supported: true, scopes: readScopes, remediation: null },
      'inventory-commands': { supported: true, scopes: readScopes, remediation: null },
      diagnostics: { supported: true, scopes: readScopes, remediation: null },
      install: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      uninstall: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      dev: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      promote: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      undo: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      'verify-static': { supported: false, scopes: [], remediation: 'no verifier registered' },
      'verify-deep': { supported: false, scopes: [], remediation: 'no verifier registered' },
      plan: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      apply: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      sync: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      update: { supported: false, scopes: [], remediation: 'fixture-read is read-only' },
      adapt: { supported: false, scopes: [], remediation: 'no adaptation registered' },
    },
  },
  inventory: {
    tool: 'fixture-read',
    installHint: 'install fixture-read',
    detect: async () => ({ ok: true as const, value: [] }),
    getSkillRoots: () => [],
    getCommandRoots: () => [],
    getPluginSkillDir: () => null,
    getPluginCommandDir: () => null,
  },
} as const;
