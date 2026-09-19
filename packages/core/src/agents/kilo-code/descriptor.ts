import { type ToolDescriptor, readOnlyOperations } from '../adapter-types.ts';

export const kiloCodeDescriptor: ToolDescriptor<'kilo-code'> = {
  id: 'kilo-code',
  order: 30,
  capabilityVersion: 1,
  operations: readOnlyOperations('kilo-code'),
};
