import { type ToolDescriptor, readOnlyOperations } from '../adapter-types.ts';

export const museDescriptor: ToolDescriptor<'muse'> = {
  id: 'muse',
  order: 50,
  capabilityVersion: 1,
  operations: readOnlyOperations('muse'),
};
