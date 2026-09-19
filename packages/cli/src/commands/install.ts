import { type InstallDeps, defaultInstallDeps } from '@skillsmith/core';

export interface TtyState {
  readonly stderr: boolean;
  readonly stdin: boolean;
}

export const shouldEnablePicker = (
  options: { readonly json: boolean; readonly noPrompt: boolean },
  tty: TtyState,
): boolean => tty.stderr && tty.stdin && !options.json && !options.noPrompt;

/** Compatibility-only helper; production interaction is owned by runtime/interaction.ts. */
export const buildInstallDeps = (
  options: { readonly json: boolean; readonly noPrompt: boolean },
  tty: TtyState,
): InstallDeps => ({
  ...defaultInstallDeps,
  ...(shouldEnablePicker(options, tty) ? { pick: async () => null } : {}),
});
