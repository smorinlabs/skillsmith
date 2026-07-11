import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getAgent } from '../../agents/registry.ts';
import type { ScanEnv } from '../../env/types.ts';
import { errorMessage } from '../../errors.ts';
import type { Check, Finding } from '../types.ts';

type AccessPath = (path: string, mode: number) => Promise<void>;

const nearestExistingAncestor = async (env: ScanEnv, root: string): Promise<string> => {
  let candidate = dirname(root);
  while ((await env.pathKind(candidate)) === 'absent') {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
};

const effectivePathKind = async (env: ScanEnv, path: string): Promise<string> => {
  const kind = await env.pathKind(path);
  if (kind !== 'symlink') return kind;
  try {
    return await env.pathKind(await env.realpath(path));
  } catch {
    return 'broken symlink';
  }
};

const quoted = (value: string): string => JSON.stringify(value);

export const createScopeWritableCheck = (
  accessPath: AccessPath = access,
  getUid: () => number | undefined = () => process.getuid?.(),
): Check => ({
  id: 'scope-writable',
  severity: 'error',
  runsIn: ['doctor', 'check'],
  run: async (ctx) => {
    const findings: Finding[] = [];
    for (const tool of ctx.tools) {
      const a = getAgent(tool);
      if (!a.ok) continue;
      for (const scope of ctx.scopes) {
        const roots = a.value.getSkillRoots(ctx.env, scope, {
          cwd: ctx.cwd,
          envVars: ctx.envVars,
        });
        for (const root of roots) {
          const rootKind = await ctx.env.pathKind(root);
          const scopeInUse = rootKind !== 'absent';
          const probePath = scopeInUse ? root : await nearestExistingAncestor(ctx.env, root);
          const uid = getUid();
          let operation = `inspect ${quoted(probePath)} as a directory`;
          try {
            const probeKind = await effectivePathKind(ctx.env, probePath);
            if (probeKind !== 'dir') {
              throw new Error(`expected a directory, found ${probeKind}`);
            }
            operation = `access(${quoted(probePath)}, W_OK | X_OK) as uid ${uid ?? 'unknown'}`;
            await accessPath(probePath, constants.W_OK | constants.X_OK);
          } catch (e) {
            const expectedPrivilegedScope =
              (scope === 'system' || scope === 'managed') && ctx.scopeExplicit === false;
            findings.push({
              checkId: 'scope-writable',
              severity: expectedPrivilegedScope ? 'info' : 'error',
              title: 'skill root not writable',
              message: `${tool}/${scope} root ${root}: ${errorMessage(e)}`,
              remediation: expectedPrivilegedScope
                ? `select --scope=${scope} only when intentionally managing this privileged scope`
                : `ensure ${root} is writable, or select a writable scope`,
              tool,
              scope,
              path: root,
              operation,
              reason: 'checks whether SkillSmith can install or update skills in this scope',
              scopeInUse,
            });
          }
        }
      }
    }
    return findings;
  },
});

export const scopeWritable: Check = createScopeWritableCheck();
