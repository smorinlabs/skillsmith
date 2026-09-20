import { z } from 'zod';
import type { SearchReport } from '../../search/types.ts';
import { createJsonWireCodec } from '../codec.ts';

const SearchHitSchema = z
  .object({
    kind: z.literal('skill'),
    catalogId: z.string().min(1),
    providerSkillId: z.string().nullable(),
    name: z.string().min(1),
    source: z.string().nullable(),
    installs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    url: z.string().url().startsWith('https://skills.sh/'),
    verification: z.literal('not-checked'),
  })
  .strict();

const SearchV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.search'),
    provider: z.literal('skills.sh'),
    query: z.string().refine((value) => [...value].length >= 2),
    owner: z.string().nullable(),
    limit: z.number().int().min(1).max(20),
    returned: z.number().int().min(0).max(20),
    searchType: z.enum(['fuzzy', 'semantic', 'unknown']),
    results: z.array(SearchHitSchema).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.returned !== value.results.length || value.returned > value.limit)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['returned'],
        message: 'returned must match results within the requested limit',
      });
    if (new Set(value.results.map((hit) => hit.catalogId)).size !== value.results.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'catalog IDs must be unique',
      });
  });

export type SearchV1Dto = z.infer<typeof SearchV1Schema>;
export const toSearchV1Dto = (report: SearchReport): SearchV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.search',
  provider: report.provider,
  query: report.query,
  owner: report.owner,
  limit: report.limit,
  returned: report.returned,
  searchType: report.searchType,
  results: report.results.map((hit) => ({
    kind: hit.kind,
    catalogId: hit.catalogId,
    providerSkillId: hit.providerSkillId,
    name: hit.name,
    source: hit.source,
    installs: hit.installs,
    url: hit.url,
    verification: hit.verification,
  })),
});

export const searchV1Codec = createJsonWireCodec(
  {
    id: 'search',
    version: 1,
    wireKind: 'skillsmith.search',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  },
  SearchV1Schema,
);
