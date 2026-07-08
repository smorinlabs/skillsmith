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
