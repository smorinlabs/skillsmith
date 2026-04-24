import matter from 'gray-matter';
import { type SkillSmithError, skillParseError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type { Frontmatter } from './types.ts';

export const parseSkillFrontmatter = (
  text: string,
  file = '<inline>',
): Result<Frontmatter, SkillSmithError> => {
  try {
    const parsed = matter(text);
    const data = parsed.data as Record<string, unknown>;
    const fm: Frontmatter = {};
    if (typeof data.name === 'string') fm.name = data.name;
    if (typeof data.description === 'string') fm.description = data.description;
    if (typeof data.version === 'string') fm.version = data.version;
    return ok(fm);
  } catch (e) {
    return err(skillParseError(e instanceof Error ? e.message : String(e), file));
  }
};
