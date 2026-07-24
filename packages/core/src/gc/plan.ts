import { resolve } from 'node:path';
import type { LedgerModel } from '../artifacts/ledger-types.ts';
import { deriveLedgerProjectRegistrations } from '../artifacts/registry.ts';
import { type Result, err, ok } from '../result.ts';
import type { GcDuration, GcRequestError } from './types.ts';

const DURATION = /^([1-9][0-9]*)(s|m|h|d|w)$/u;
const MULTIPLIER = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const);

const requestError = (
  code: GcRequestError['code'],
  message: string,
): Result<never, GcRequestError> => err(Object.freeze({ code, message }));

export const parseGcDuration = (value: string): Result<GcDuration, GcRequestError> => {
  const parsed = DURATION.exec(value);
  const unit = parsed?.[2] as keyof typeof MULTIPLIER | undefined;
  if (parsed?.[1] === undefined || unit === undefined) {
    return requestError('invalid-duration', 'duration must match [1-9][0-9]*(s|m|h|d|w)');
  }
  const count = Number(parsed[1]);
  const milliseconds = count * MULTIPLIER[unit];
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(milliseconds)) {
    return requestError('invalid-duration', 'duration milliseconds must be a safe integer');
  }
  return ok(Object.freeze({ input: value, milliseconds }));
};

export const normalizeGcForgetRoots = (
  cwd: string,
  roots: readonly string[],
): Result<readonly string[], GcRequestError> => {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (root.length === 0 || root.includes('\0')) {
      return requestError('invalid-forget', 'forget-project path is invalid');
    }
    const selected = resolve(cwd, root);
    if (!seen.has(selected)) {
      seen.add(selected);
      normalized.push(selected);
    }
  }
  return ok(Object.freeze(normalized));
};

export const withoutLedgerProjectAt = (
  model: LedgerModel,
  roots: readonly string[],
): Result<LedgerModel, GcRequestError> => {
  const projects = { ...model.projects };
  for (const root of roots) {
    if (!Object.hasOwn(projects, root)) {
      return requestError('invalid-forget', 'forget-project root is not registered');
    }
    delete projects[root];
  }
  const frozenProjects = Object.freeze(projects);
  return ok(
    Object.freeze({
      ...model,
      projects: frozenProjects,
      projectRegistrations: deriveLedgerProjectRegistrations(frozenProjects),
    }),
  );
};
