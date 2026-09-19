import { type ToolDescriptor, fullLifecycleOperations } from '../adapter-types.ts';

export const CODEX_VERIFIED_AGAINST = '0.142.5';

export const codexDescriptor: ToolDescriptor<'codex'> = {
  id: 'codex',
  order: 20,
  capabilityVersion: 1,
  operations: fullLifecycleOperations('codex'),
};
