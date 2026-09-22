import { type SkillSmithError, invalidArgumentError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { parseSource } from './source.ts';

export interface InstallSkillSelection {
  readonly name: string;
  readonly mode: 'directory-first' | 'frontmatter';
}

export const isUsableSkillLookupName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.startsWith('-') &&
  value.trim() === value &&
  !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) &&
  [...value].length <= 256;

/** Pure validation shared by CLI dispatch, the application service, and embedders. */
export const validateInstallSelectorRequest = (request: {
  readonly sources: readonly string[];
  readonly skill?: unknown;
  readonly skillsMatchFrontmatter?: unknown;
  readonly ref?: unknown;
}): Result<InstallSkillSelection | undefined, SkillSmithError> => {
  const { skill, skillsMatchFrontmatter } = request;
  if (skillsMatchFrontmatter !== undefined && typeof skillsMatchFrontmatter !== 'boolean') {
    return err(
      invalidArgumentError('--skills-match-frontmatter is a boolean option without a value'),
    );
  }
  if (skill === undefined)
    return skillsMatchFrontmatter === true
      ? err(invalidArgumentError('--skills-match-frontmatter requires --skill'))
      : ok(undefined);
  if (!isUsableSkillLookupName(skill))
    return err(
      invalidArgumentError(
        '--skill requires a name of 1–256 Unicode characters without surrounding whitespace, control characters, or a leading dash',
      ),
    );
  if (request.sources.length !== 1)
    return err(invalidArgumentError('--skill requires exactly one repository source'));
  if (request.ref !== undefined && typeof request.ref !== 'string')
    return err(invalidArgumentError('--ref requires a string value'));
  const source = parseSource(
    request.sources[0] as string,
    request.ref === undefined ? {} : { overrideRef: request.ref },
  );
  if (!source.ok) return err(source.error);
  if (source.value.selector.kind !== 'whole-repo') {
    return err(
      invalidArgumentError(
        '--skill requires a whole-repository source without an embedded skill name or path',
      ),
    );
  }
  return ok(
    Object.freeze({
      name: skill,
      mode: skillsMatchFrontmatter ? 'frontmatter' : 'directory-first',
    }),
  );
};
