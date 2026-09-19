import { InvalidArgumentError } from 'commander';

/** Commander parser for options whose contract permits exactly one occurrence. */
export const singularOption =
  (flag: string) =>
  (value: string, previous: string | undefined): string => {
    if (previous !== undefined) {
      throw new InvalidArgumentError(`${flag} may only be specified once`);
    }
    return value;
  };
