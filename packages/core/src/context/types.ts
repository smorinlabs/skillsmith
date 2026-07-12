export type ProjectKind = 'git' | 'non-git';

/** Stable, invocation-scoped path bases shared by every project-aware operation. */
export interface ProjectContext {
  readonly invocationCwd: string;
  readonly effectiveCwd: string;
  readonly projectRoot: string | null;
  readonly projectIdentity: string | null;
  readonly projectKind: ProjectKind;
  readonly discoveredConfigPath: string | null;
  readonly explicitConfigPath: string | null;
}

export interface ResolveProjectContextOptions {
  readonly invocationCwd: string;
  readonly cd?: string;
  readonly explicitConfigPath?: string;
}
