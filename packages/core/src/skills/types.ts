import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';

export interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
}

export interface SkillEntry {
  name: string;
  path: string;
  realpath: string;
  tool: SupportedTool;
  scope: Scope;
  root: string;
  frontmatter: Frontmatter | null;
}
