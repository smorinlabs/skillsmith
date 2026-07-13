import { z } from 'zod';
import type { ToolAdapter, ToolOperationFact } from '../../agents/adapter-types.ts';
import { createJsonWireCodec } from '../codec.ts';

const CapabilityScopeV1Schema = z.enum([
  'user',
  'project',
  'system',
  'managed',
  'custom',
  'artifact',
]);

const CapabilityOperationV1Schema = z
  .object({
    supported: z.boolean(),
    scopes: z.array(CapabilityScopeV1Schema),
    remediation: z.string().nullable(),
  })
  .strict();

const CapabilityOperationsV1Schema = z
  .object({
    detect: CapabilityOperationV1Schema,
    'inventory-skills': CapabilityOperationV1Schema,
    'inventory-commands': CapabilityOperationV1Schema,
    diagnostics: CapabilityOperationV1Schema,
    install: CapabilityOperationV1Schema,
    uninstall: CapabilityOperationV1Schema,
    dev: CapabilityOperationV1Schema,
    promote: CapabilityOperationV1Schema,
    undo: CapabilityOperationV1Schema,
    'verify-static': CapabilityOperationV1Schema,
    'verify-deep': CapabilityOperationV1Schema,
    plan: CapabilityOperationV1Schema,
    apply: CapabilityOperationV1Schema,
    sync: CapabilityOperationV1Schema,
    update: CapabilityOperationV1Schema,
    adapt: CapabilityOperationV1Schema,
  })
  .strict();

const CapabilityToolV1Schema = z
  .object({
    id: z.string(),
    order: z.number().int(),
    capabilityVersion: z.number().int().positive(),
    operations: CapabilityOperationsV1Schema,
  })
  .strict();

const CapabilitySnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.capabilities'),
    tools: z.array(CapabilityToolV1Schema),
  })
  .strict();

export type CapabilitySnapshotV1Dto = z.infer<typeof CapabilitySnapshotV1Schema>;

interface CapabilitySnapshotSource {
  readonly adapters: readonly Pick<ToolAdapter, 'descriptor'>[];
}

const toCapabilityOperationV1Dto = (
  source: ToolOperationFact,
): z.infer<typeof CapabilityOperationV1Schema> => ({
  supported: source.supported,
  scopes: Array.from(source.scopes),
  remediation: source.remediation,
});

export const toCapabilitySnapshotV1Dto = (
  source: CapabilitySnapshotSource,
): CapabilitySnapshotV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.capabilities',
  tools: source.adapters.map((adapter) => ({
    id: adapter.descriptor.id,
    order: adapter.descriptor.order,
    capabilityVersion: adapter.descriptor.capabilityVersion,
    operations: {
      detect: toCapabilityOperationV1Dto(adapter.descriptor.operations.detect),
      'inventory-skills': toCapabilityOperationV1Dto(
        adapter.descriptor.operations['inventory-skills'],
      ),
      'inventory-commands': toCapabilityOperationV1Dto(
        adapter.descriptor.operations['inventory-commands'],
      ),
      diagnostics: toCapabilityOperationV1Dto(adapter.descriptor.operations.diagnostics),
      install: toCapabilityOperationV1Dto(adapter.descriptor.operations.install),
      uninstall: toCapabilityOperationV1Dto(adapter.descriptor.operations.uninstall),
      dev: toCapabilityOperationV1Dto(adapter.descriptor.operations.dev),
      promote: toCapabilityOperationV1Dto(adapter.descriptor.operations.promote),
      undo: toCapabilityOperationV1Dto(adapter.descriptor.operations.undo),
      'verify-static': toCapabilityOperationV1Dto(adapter.descriptor.operations['verify-static']),
      'verify-deep': toCapabilityOperationV1Dto(adapter.descriptor.operations['verify-deep']),
      plan: toCapabilityOperationV1Dto(adapter.descriptor.operations.plan),
      apply: toCapabilityOperationV1Dto(adapter.descriptor.operations.apply),
      sync: toCapabilityOperationV1Dto(adapter.descriptor.operations.sync),
      update: toCapabilityOperationV1Dto(adapter.descriptor.operations.update),
      adapt: toCapabilityOperationV1Dto(adapter.descriptor.operations.adapt),
    },
  })),
});

export const capabilitySnapshotV1Codec = createJsonWireCodec(
  {
    id: 'capability-snapshot',
    version: 1,
    wireKind: 'skillsmith.capabilities',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  CapabilitySnapshotV1Schema,
);
