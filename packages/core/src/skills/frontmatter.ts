import matter from 'gray-matter';
import { DEFAULT_SAFE_SCHEMA, safeLoad } from 'js-yaml';
import { type SkillSmithError, skillParseError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type { Frontmatter } from './types.ts';

const metadataObject = (value: unknown): object =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

const rejectEngine = (): never => {
  throw new Error('unsupported frontmatter engine');
};

export const parseSkillFrontmatter = (
  text: string,
  file = '<inline>',
): Result<Frontmatter, SkillSmithError> => {
  try {
    let source = text.startsWith('\uFEFF') ? text.slice(1) : text;
    // Do not let gray-matter normalize a second BOM and discover a hidden engine tag.
    if (!source.startsWith('---') || source[3] === '-') return ok({});
    let language = 'yaml';
    if (source.startsWith('---') && source[3] !== '-') {
      const body = source.slice(3);
      const newline = body.search(/\r?\n/u);
      const tag = (newline < 0 ? body : body.slice(0, newline)).trim().toLowerCase();
      if (!['', 'yaml', 'yml', 'json'].includes(tag)) {
        return err(skillParseError('invalid skill frontmatter', file));
      }
      language = tag === 'json' ? 'json' : 'yaml';
      // Only an untagged header reaches gray-matter. Its default executable engines
      // cannot be selected by document text; explicit options also bypass its cache.
      source = `---${newline < 0 ? '' : body.slice(newline)}`;
    }
    const parsed = matter(source, {
      language,
      engines: {
        yaml: (input: string) => metadataObject(safeLoad(input, { schema: DEFAULT_SAFE_SCHEMA })),
        json: (input: string) => metadataObject(JSON.parse(input)),
        javascript: rejectEngine,
        js: rejectEngine,
      },
    });
    const data: unknown = parsed.data;
    const fm: Frontmatter = {};
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      for (const key of ['name', 'description', 'version'] as const) {
        const value = Object.getOwnPropertyDescriptor(data, key)?.value;
        if (typeof value === 'string') fm[key] = value;
      }
    }
    return ok(fm);
  } catch {
    return err(skillParseError('invalid skill frontmatter', file));
  }
};
