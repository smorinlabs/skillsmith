import { type ToolDescriptor, fullLifecycleOperations } from '../adapter-types.ts';

export const CLAUDE_CODE_VERIFIED_AGAINST = '2.1.278';

export const claudeCodeDescriptor: ToolDescriptor<'claude-code'> = {
  id: 'claude-code',
  order: 10,
  capabilityVersion: 1,
  operations: fullLifecycleOperations('claude-code'),
};
