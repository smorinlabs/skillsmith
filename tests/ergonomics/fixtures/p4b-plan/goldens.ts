export const PLAN_REPORT_KIND = 'skillsmith.plan-report' as const;

export const SYNTHETIC_OPERATION_ROWS = Object.freeze([
  { kind: 'install', before: 'absent', after: 'placement', drift: true },
  { kind: 'update', before: 'placement', after: 'placement', drift: true },
  { kind: 'remove', before: 'placement', after: 'absent', drift: true },
  { kind: 'move-scope', before: 'placement', after: 'placement', drift: true },
  { kind: 'adapt', before: 'placement', after: 'placement', drift: true },
  { kind: 'migrate-project-config', before: 'manifest', after: 'manifest', drift: true },
  { kind: 'migrate-ledger', before: 'ledger', after: 'ledger', drift: true },
] as const);

export const EMPTY_SUMMARY = Object.freeze({
  operations: 0,
  checks: 0,
  diagnostics: 1,
  drift: 0,
});

export const INSTALL_SUMMARY = Object.freeze({
  operations: 1,
  drift: 1,
});

export const REDACTION_CANARIES = Object.freeze([
  'Bearer p4b-plan-secret',
  'https://user:password@fixture.invalid/acme/skills.git',
  'P4B_PRIVATE_TOKEN',
] as const);
