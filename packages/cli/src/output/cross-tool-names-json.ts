import type { CrossToolNameGroup } from '@skillsmith/core';
import { z } from 'zod';

const MemberSchema = z.object({
  tool: z.string(),
  scope: z.string(),
  path: z.string(),
});

const GroupSchema = z.object({
  name: z.string(),
  members: z.array(MemberSchema),
});

export const CrossToolNamesJsonSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('skillsmith.cross-tool-names'),
  groups: z.array(GroupSchema),
});

export const renderCrossToolNamesJson = (groups: readonly CrossToolNameGroup[]): string =>
  JSON.stringify({ schemaVersion: 1, kind: 'skillsmith.cross-tool-names', groups }, null, 2);
