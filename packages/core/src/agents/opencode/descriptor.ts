import { type ToolDescriptor, readOnlyOperations } from '../adapter-types.ts';

export const opencodeDescriptor: ToolDescriptor<'opencode'> = {
  id: 'opencode',
  order: 40,
  capabilityVersion: 1,
  operations: readOnlyOperations('opencode'),
};
