import { type ToolDescriptor, fullLifecycleOperations } from '../adapter-types.ts';

export const MUSE_VERIFIED_AGAINST = '1.3.0';

const USER_CUSTOM_FACT: ToolDescriptor['operations']['install'] = {
  supported: true,
  scopes: ['user', 'custom'],
  remediation: null,
};

// Muse lifecycle is user+custom scoped: project mutations are deferred (D-scope;
// same destination as Codex — see issue #99), so project stays
// inventory/diagnostics/verify while capability selection refuses mutations.
export const museDescriptor: ToolDescriptor<'muse'> = {
  id: 'muse',
  order: 50,
  capabilityVersion: 2,
  operations: {
    ...fullLifecycleOperations('muse'),
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
