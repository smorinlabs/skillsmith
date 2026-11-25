import { type ToolDescriptor, fullLifecycleOperations } from '../adapter-types.ts';

export const ANTIGRAVITY_VERIFIED_AGAINST = '1.5.16';

const USER_CUSTOM_FACT: ToolDescriptor['operations']['install'] = {
  supported: true,
  scopes: ['user', 'custom'],
  remediation: null,
};

// Antigravity lifecycle is user+custom scoped: project mutations are deferred
// (D-scope; `<project>/.agents/skills` collides with Codex — see issue #99), so
// project stays inventory/diagnostics/verify while capability selection refuses
// mutations.
export const antigravityDescriptor: ToolDescriptor<'antigravity'> = {
  id: 'antigravity',
  order: 60,
  capabilityVersion: 2,
  operations: {
    ...fullLifecycleOperations('antigravity'),
    install: USER_CUSTOM_FACT,
    uninstall: USER_CUSTOM_FACT,
    dev: USER_CUSTOM_FACT,
    promote: USER_CUSTOM_FACT,
    undo: USER_CUSTOM_FACT,
    plan: USER_CUSTOM_FACT,
    apply: USER_CUSTOM_FACT,
    sync: USER_CUSTOM_FACT,
    update: USER_CUSTOM_FACT,
  },
};
