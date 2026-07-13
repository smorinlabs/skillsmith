import { z } from 'zod';

export const FixtureVersion2Schema = z.object({ schemaVersion: z.literal(2) }).strict();

export const MigratingVersion2Schema = z
  .object({ schemaVersion: z.literal(2), value: z.string() })
  .strict();

export const DriftedVersionAndKindSchema = z
  .object({
    requiredFirst: z.string(),
    schemaVersion: z.literal(1),
    kind: z.literal('fixture.actual'),
  })
  .strict();

export const BroadKindSchema = z
  .object({ schemaVersion: z.literal(2), kind: z.string() })
  .strict();

export const NestedPassthroughSchema = z
  .object({
    schemaVersion: z.literal(2),
    nested: z.object({ value: z.string() }).passthrough(),
  })
  .strict();

export const OptionalVersionSchema = z
  .object({ schemaVersion: z.number().optional(), value: z.string() })
  .strict();

export const NestedDefaultPassthroughSchema = z
  .object({
    schemaVersion: z.literal(2),
    nested: z.object({ value: z.string() }).passthrough().default({ value: 'default' }),
  })
  .strict();

export const CatchallSchema = z
  .object({ schemaVersion: z.literal(2) })
  .strict()
  .catchall(z.unknown());

export const MixedObjectUnionSchema = z.union([
  z.string(),
  z.union([
    z.object({ schemaVersion: z.literal(2), left: z.string() }).strict(),
    z.object({ schemaVersion: z.literal(2), right: z.string() }).strict(),
  ]),
]);

export const AlternativeVersion1Schema = z
  .object({ schemaVersion: z.literal(1), alternate: z.string() })
  .strict();
