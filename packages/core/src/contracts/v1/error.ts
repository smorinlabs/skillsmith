import { z } from 'zod';
import { createJsonWireCodec } from '../codec.ts';

const ErrorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('error'),
    code: z.string(),
    message: z.string(),
    exitCode: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(130),
    ]),
  })
  .strict();

export type ErrorV1Dto = z.infer<typeof ErrorV1Schema>;

export interface ErrorV1Input {
  readonly code: string;
  readonly message: string;
  readonly exitCode: ErrorV1Dto['exitCode'];
}

export const toErrorV1Dto = (source: ErrorV1Input): ErrorV1Dto => ({
  schemaVersion: 1,
  kind: 'error',
  code: source.code,
  message: source.message,
  exitCode: source.exitCode,
});

export const errorV1Codec = createJsonWireCodec(
  {
    id: 'error',
    version: 1,
    wireKind: 'error',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 0, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  ErrorV1Schema,
);
