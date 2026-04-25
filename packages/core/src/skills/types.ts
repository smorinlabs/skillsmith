import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';

export interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
}

export type PluginProvenanceScope = 'user' | 'project' | 'managed' | 'local';

/**
 * Three-state enablement model:
 * - 'on'    — explicit `true` in the relevant settings file (or implicit for standalone/policy entries).
 * - 'off'   — explicit `false` in the relevant settings file.
 * - 'unset' — no key present / no file present. Runtime-equivalent to 'off' for Claude Code,
 *             but distinguishes "user never configured" from "user explicitly disabled."
 */
export type EnabledState = 'on' | 'off' | 'unset';

export type Origin =
  | { kind: 'standalone' }
  | {
      kind: 'plugin';
      pluginId: string;
      pluginVersion: string;
      pluginScope: PluginProvenanceScope;
    }
  | { kind: 'policy' };

export interface SkillEntry {
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
