import {
  type SkillSmithError,
  cancelledError,
  permissionDeniedError,
  safeErrorCode,
  sourceUnresolvableError,
} from '../errors.ts';
import type { GitPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { parseSkillFrontmatter } from '../skills/frontmatter.ts';
import { isUsableSkillLookupName } from './selector-request.ts';
import type { CandidateSkill } from './types.ts';

const MAX_CANDIDATES = 1_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 16_777_216;

/** A unique result is meaningful only after every eligible document has been inspected. */
export const matchDeclaredNames = async (input: {
  readonly git: GitPort;
  readonly repositoryRoot: string;
  readonly sha: string;
  readonly candidates: readonly CandidateSkill[];
  readonly name: string;
  readonly signal?: AbortSignal;
}): Promise<Result<CandidateSkill[], SkillSmithError>> => {
  const { git, repositoryRoot, sha, candidates, name, signal } = input;
  const incomplete = (reason: string) =>
    err(
      sourceUnresolvableError(
        `declared-name scan incomplete: ${reason}; use a known exact repository path`,
      ),
    );
  if (signal?.aborted) return err(cancelledError('skill selection cancelled'));
  if (candidates.length === 0) return ok([]);
  if (candidates.length > MAX_CANDIDATES) return incomplete('more than 1,000 eligible skills');
  const read = git.readBlobBounded;
  if (read === undefined) return incomplete('bounded Git metadata reads are unavailable');
  let remaining = MAX_TOTAL_BYTES;
  const matches: CandidateSkill[] = [];
  for (const candidate of candidates) {
    if (signal?.aborted) return err(cancelledError('skill selection cancelled'));
    const path = candidate.path === '' ? 'SKILL.md' : `${candidate.path}/SKILL.md`;
    const maxBytes = Math.min(MAX_FILE_BYTES, remaining);
    let bytes: Uint8Array;
    try {
      bytes = await read.call(git, {
        repositoryRoot,
        ref: sha,
        path,
        maxBytes,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const code = safeErrorCode(error);
      if (signal?.aborted || code === 'cancelled' || code === 'ABORT_ERR')
        return err(cancelledError('skill selection cancelled'));
      if (['permission', 'permission-denied', 'EACCES', 'EPERM'].includes(code ?? ''))
        return err(permissionDeniedError(`cannot read skill metadata at ${path}`));
      return incomplete(
        `cannot read regular-file metadata at ${path} within 1 MiB per file and 16 MiB per scan`,
      );
    }
    if (signal?.aborted) return err(cancelledError('skill selection cancelled'));
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
      return incomplete(`invalid bounded metadata result at ${path}`);
    remaining -= bytes.byteLength;
    let text: string;
    try {
      // Preserve the BOM so the shared parser alone owns frontmatter normalization.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return incomplete(`invalid UTF-8 at ${path}`);
    }
    const metadata = parseSkillFrontmatter(text, path);
    if (!metadata.ok) return incomplete(`invalid frontmatter at ${path}`);
    if (
      isUsableSkillLookupName(metadata.value.name) &&
      metadata.value.name.toLowerCase() === name.toLowerCase()
    )
      matches.push(candidate);
  }
  return ok(matches);
};
