import type { EnabledState, PluginProvenanceScope } from '../skills/types.ts';

export interface PluginInstallation {
  id: string; // "plugin-name@marketplace"
  scope: PluginProvenanceScope;
  installPath: string;
  version: string;
  projectPath?: string;
}

export interface PluginEnablement {
  enabled: EnabledState;
  source: 'managed' | 'user' | 'project' | 'local' | 'none';
}

export interface DiscoveredPlugin {
  installation: PluginInstallation;
  enablement: PluginEnablement;
}
