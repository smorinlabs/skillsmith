import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { EnabledState, Frontmatter, Origin } from '../skills/types.ts';

export interface CommandEntry {
  name: string;
  path: string;
  realpath: string;
  tool: SupportedTool;
  scope: Scope;
  root: string;
  frontmatter: Frontmatter | null;
  origin: Origin;
  enabled: EnabledState;
}
