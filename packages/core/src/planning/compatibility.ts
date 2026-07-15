import type { InstallAction, UninstallAction } from '../acquire/types.ts';
import type { FlipAction } from '../place/types.ts';
import type {
  CurrentCompatibilityProjection,
  ExecutableOperation,
  OperationImage,
} from './types.ts';

export type CurrentCompatibilityAction = InstallAction | UninstallAction | FlipAction;

const fail = (message: string): never => {
  throw new TypeError(`operation compatibility: ${message}`);
};

const classification = (image: OperationImage): string | null =>
  image.kind === 'placement' ? image.classification : null;

const operationAction = (
  family: CurrentCompatibilityProjection['family'],
  operation: ExecutableOperation,
): CurrentCompatibilityAction => {
  if (family === 'install') {
    if (operation.kind === 'install') return 'installed';
    if (operation.kind === 'update') return 'updated';
    if (operation.kind === 'repair') return 'repaired';
    return fail(`install cannot project operation kind ${operation.kind}`);
  }
  if (family === 'uninstall') {
    if (operation.kind === 'remove') return 'removed';
    return fail(`uninstall cannot project operation kind ${operation.kind}`);
  }
  if (operation.kind === 'update') return 'updated';
  if (operation.kind === 'promote') return 'flipped';
  if (operation.kind === 'link-dev') {
    if (operation.before.kind === 'absent') return 'created';
    if (classification(operation.before) === 'unmanaged') return 'adopted';
    if (classification(operation.before) === 'dev' && classification(operation.after) === 'dev') {
      return 'updated';
    }
    return 'flipped';
  }
  return fail(`flip cannot project operation kind ${operation.kind}`);
};

export const toCurrentCompatibilityAction = (
  input: CurrentCompatibilityProjection,
): CurrentCompatibilityAction => {
  const { family, operation, diagnostic, result } = input;
  if (family !== 'install' && family !== 'uninstall' && family !== 'flip') {
    fail('family is unsupported');
  }
  if (diagnostic !== null && diagnostic.kind !== 'warning') {
    if (diagnostic.kind === 'noop') return 'noop';
    if (diagnostic.kind === 'skip') {
      if (family === 'uninstall') fail('uninstall has no skipped compatibility action');
      return 'skipped';
    }
    return 'refused';
  }
  if (result !== null) {
    if (operation === null) return fail('an execution result requires its operation');
    if (result.operationId !== operation.operationId)
      return fail('result/operation identity mismatch');
    if (result.outcome === 'failed' || result.outcome === 'cancelled') return 'failed';
    if (result.outcome === 'rolled-back') {
      if (family !== 'flip') fail(`${family} has no rolled-back compatibility action`);
      return 'rolled-back';
    }
  }
  if (operation !== null) return operationAction(family, operation);
  if (diagnostic?.kind === 'warning') fail('a warning alone has no compatibility action');
  return fail('projection contains no operation, diagnostic, or result');
};
