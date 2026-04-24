import type { InstallRecord, SupportedTool } from '@skillsmith/core';
import { z } from 'zod';

const InstallRecordSchema = z.object({
  path: z.string(),
  version: z.string(),
  installMethod: z.enum(['brew', 'npm-global', 'native-installer', 'app-bundle', 'unknown']),
});

export const AgentsJsonSchema = z.object({
  schemaVersion: z.literal(1),
  experimental: z.literal(true),
  tools: z.record(z.array(InstallRecordSchema)),
});

export const renderAgentsJson = (results: Map<SupportedTool, InstallRecord[]>): string => {
  const tools: Record<string, InstallRecord[]> = {};
  for (const [k, v] of results) tools[k] = v;
  return JSON.stringify({ schemaVersion: 1, experimental: true, tools }, null, 2);
};
