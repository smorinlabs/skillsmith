import type { SkillEntry } from '@skillsmith/core';
import { z } from 'zod';

const FrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .nullable();

const SkillEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  realpath: z.string(),
  tool: z.string(),
  scope: z.string(),
  root: z.string(),
  frontmatter: FrontmatterSchema,
});

export const ListJsonSchema = z.object({
  schemaVersion: z.literal(1),
  experimental: z.literal(true),
  skills: z.array(SkillEntrySchema),
});

export const renderListJson = (entries: readonly SkillEntry[]): string =>
  JSON.stringify({ schemaVersion: 1, experimental: true, skills: entries }, null, 2);
