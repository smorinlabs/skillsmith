/**
 * Closed legacy result vocabulary retained at the compatibility edge.
 *
 * Foundational planning owns these literals so compatibility projection does not import the
 * acquisition or placement runners that already consume planning products.
 */
export type InstallAction =
  | 'installed'
  | 'updated'
  | 'repaired'
  | 'noop'
  | 'skipped'
  | 'refused'
  | 'failed';

export type UninstallAction = 'removed' | 'noop' | 'refused' | 'failed';

export type FlipAction =
  | 'flipped'
  | 'updated'
  | 'noop'
  | 'skipped'
  | 'refused'
  | 'failed'
  | 'rolled-back'
  | 'created'
  | 'adopted';

export type CurrentCompatibilityAction = InstallAction | UninstallAction | FlipAction;
