import { type Result, type Scope, err, ok } from '@skillsmith/core';

export interface ScopeFlagOpts {
  scope?: string;
  user?: boolean;
  system?: boolean;
  project?: boolean;
  managed?: boolean;
}

export const resolveScopeFlags = (
  opts: ScopeFlagOpts,
): Result<Scope | null, { code: 'scope-conflict'; message: string }> => {
  const shorthands: Scope[] = [];
  if (opts.user) shorthands.push('user');
  if (opts.system) shorthands.push('system');
  if (opts.project) shorthands.push('project');
  if (opts.managed) shorthands.push('managed');

  if (shorthands.length > 1) {
    return err({
      code: 'scope-conflict',
      message: `conflicting scope shorthand flags: ${shorthands.map((s) => `--${s}`).join(' ')}`,
    });
  }

  const shorthand = shorthands[0];
  const explicit = opts.scope as Scope | undefined;

  if (shorthand && explicit && shorthand !== explicit) {
    return err({
      code: 'scope-conflict',
      message: `--scope=${explicit} conflicts with --${shorthand}`,
    });
  }

  const value = explicit ?? shorthand ?? null;
  return ok(value);
};
