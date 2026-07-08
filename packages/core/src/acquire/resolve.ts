import type { CandidateSkill, Selection, SourceSpec } from './types.ts';

/** Filter scanned candidates by the parsed source selector.
 *  whole-repo → all; name → candidates whose `name` equals it (case-sensitive);
 *  path → the candidate whose `path` equals it exactly ([] when absent). */
export const matchCandidates = (
  all: readonly CandidateSkill[],
  selector: SourceSpec['selector'],
): CandidateSkill[] => {
  if (selector.kind === 'whole-repo') return [...all];
  if (selector.kind === 'name') return all.filter((c) => c.name === selector.name);
  return all.filter((c) => c.path === selector.path);
};

/** Resolve a set of matches into a single Selection.
 *  0 → none; 1 → chosen; >1 → the picker decides (non-null = chosen, null/absent = ambiguous).
 *  A non-interactive caller passes no picker so it never guesses (R2). */
export const selectSkill = async (
  matches: readonly CandidateSkill[],
  scanned: number,
  pick?: (cands: readonly CandidateSkill[]) => Promise<CandidateSkill | null>,
): Promise<Selection> => {
  if (matches.length === 0) return { kind: 'none', searched: scanned };
  const [first] = matches;
  if (matches.length === 1 && first) return { kind: 'chosen', skill: first };
  if (pick) {
    const chosen = await pick(matches);
    if (chosen) return { kind: 'chosen', skill: chosen };
  }
  return { kind: 'ambiguous', candidates: [...matches] };
};
