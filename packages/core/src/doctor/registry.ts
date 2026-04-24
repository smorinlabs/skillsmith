import { configParse } from './checks/config-parse.ts';
import { crossScopeDuplicate } from './checks/cross-scope-duplicate.ts';
import { legacyInstall } from './checks/legacy-install.ts';
import { multiInstall } from './checks/multi-install.ts';
import { networkReach } from './checks/network-reach.ts';
import { scopeWritable } from './checks/scope-writable.ts';
import { toolDetected } from './checks/tool-detected.ts';
import { xdgPaths } from './checks/xdg-paths.ts';
import type { Check } from './types.ts';

export const builtInChecks: readonly Check[] = [
  xdgPaths,
  configParse,
  toolDetected,
  scopeWritable,
  crossScopeDuplicate,
  multiInstall,
  legacyInstall,
  networkReach,
];
