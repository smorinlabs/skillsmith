export interface SourceSpec {
  raw: string; // the literal user argument, ref suffix included
  host: string; // 'github.com' for sugar; the host segment (may carry ':port') or URL/scp authority host
  repoPath: string; // UNCLAMPED '/'-joined repo path ('acme/platform/tools'); trailing '.git' stripped
  cloneUrl: string; // sugar/host-explicit: `https://<host>/<repoPath>.git`; URL/scp forms: verbatim minus `//path` and `@ref`
  selector:
    | { kind: 'whole-repo' }
    | { kind: 'name'; name: string }
    | { kind: 'path'; path: string }; // normalized: no leading/trailing '/', no empty/'.'/'..' segments
  ref: string | null; // the `@ref` as given; null = HEAD (remote default branch)
}

export interface CandidateSkill {
  path: string; // repo-relative git tree path of the skill dir; '' = repo root
  name: string; // basename(path); for path '' the caller substitutes the repo's final segment
}

export type Selection =
  | { kind: 'chosen'; skill: CandidateSkill }
  | { kind: 'ambiguous'; candidates: CandidateSkill[] } // caller: exit-2 refusal + JSON candidates
  | { kind: 'none'; searched: number }; // caller: exit-5 source-unresolvable
