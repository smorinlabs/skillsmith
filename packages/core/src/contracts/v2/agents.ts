import { z } from 'zod';
import { toolRegistry } from '../../agents/registry.ts';
import type { AgentsReport } from '../../application/read-services.ts';
import { redactSensitiveString } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';
import { toCapabilitySnapshotV1Dto } from '../v1/capability-snapshot.ts';

const InstallRecordV2Schema = z
  .object({
    path: z.string(),
    version: z.string(),
    installMethod: z.enum([
      'brew',
      'npm-global',
      'bun-global',
      'native-installer',
      'app-bundle',
      'unknown',
    ]),
  })
  .strict();

const CapabilityScopeSchema = z.enum([
  'user',
  'project',
  'system',
  'managed',
  'custom',
  'artifact',
]);
const CapabilityOperationSchema = z
  .object({
    supported: z.boolean(),
    scopes: z.array(CapabilityScopeSchema),
    remediation: z.string().nullable(),
  })
  .strict();
const CapabilityOperationsSchema = z
  .object({
    detect: CapabilityOperationSchema,
    'inventory-skills': CapabilityOperationSchema,
    'inventory-commands': CapabilityOperationSchema,
    diagnostics: CapabilityOperationSchema,
    install: CapabilityOperationSchema,
    uninstall: CapabilityOperationSchema,
    dev: CapabilityOperationSchema,
    promote: CapabilityOperationSchema,
    undo: CapabilityOperationSchema,
    'verify-static': CapabilityOperationSchema,
    'verify-deep': CapabilityOperationSchema,
    plan: CapabilityOperationSchema,
    apply: CapabilityOperationSchema,
    sync: CapabilityOperationSchema,
    update: CapabilityOperationSchema,
    adapt: CapabilityOperationSchema,
  })
  .strict();
const CapabilitySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.capabilities'),
    tools: z.array(
      z
        .object({
          id: z.string(),
          order: z.number().int(),
          capabilityVersion: z.number().int().positive(),
          operations: CapabilityOperationsSchema,
        })
        .strict(),
    ),
  })
  .strict();

const AgentsV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('skillsmith.agents'),
    detections: z.array(
      z
        .object({
          tool: z.string(),
          installations: z.array(InstallRecordV2Schema),
        })
        .strict(),
    ),
    capabilities: CapabilitySnapshotSchema,
  })
  .strict();

export type AgentsV2Dto = z.infer<typeof AgentsV2Schema>;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const toAgentsV2Dto = (report: AgentsReport): AgentsV2Dto => ({
  schemaVersion: 2,
  kind: 'skillsmith.agents',
  detections: toolRegistry.ids
    .filter((tool) => report.detections.has(tool))
    .map((tool) => {
      const records = report.detections.get(tool) ?? [];
      return {
        tool: redactSensitiveString(tool),
        installations: [...records]
          .sort(
            (left, right) =>
              compareText(left.path, right.path) ||
              compareText(left.version, right.version) ||
              compareText(left.installMethod, right.installMethod),
          )
          .map((record) => ({
            path: redactSensitiveString(record.path),
            version: redactSensitiveString(record.version),
            installMethod: record.installMethod,
          })),
      };
    }),
  capabilities:
    report.capabilities ?? toCapabilitySnapshotV1Dto({ adapters: toolRegistry.adapters }),
});

export const agentsV2Codec = createJsonWireCodec(
  {
    id: 'agents',
    version: 2,
    wireKind: 'skillsmith.agents',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  AgentsV2Schema,
);
