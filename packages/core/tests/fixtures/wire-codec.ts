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

const TransformInputSchema = z
  .object({ schemaVersion: z.literal(1), kind: z.literal('fixture.expected'), value: z.string() })
  .strict();

export const TransformedIdentityDriftSchema = TransformInputSchema.transform((input) => ({
  ...input,
  schemaVersion: 99 as const,
  kind: 'fixture.actual' as const,
}));

export const TransformedSecretSchema = TransformInputSchema.transform((input) => ({
  ...input,
  secret: 'injected',
}));

let getterReads = 0;

export const resetTransformedGetterReads = (): void => {
  getterReads = 0;
};

export const transformedGetterReads = (): number => getterReads;

export const TransformedGetterSchema = TransformInputSchema.transform((input) => {
  const output = { ...input } as typeof input & { derived?: string };
  Object.defineProperty(output, 'derived', {
    enumerable: true,
    get() {
      getterReads++;
      return `derived-${getterReads}`;
    },
  });
  return output;
});
