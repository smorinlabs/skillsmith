# P19 review disposition

Independent read-only Codex reviews completed at main `7c8d865` and P17 `d786739` with changes
requested (F13-F16 below). Corrected-head sign-off is still pending. Codex and Claude Code
reviewers have standing user approval. Product issues remain open until their full acceptance
and affected-line integration are satisfied.

| ID | Origin / finding | Disposition |
| --- | --- | --- |
| P19-RV-F01 | [Copilot inline](https://github.com/smorinlabs/skillsmith/pull/66#discussion_r4013616457): all-error verification incorrectly says no tools ran | Corrected on main 9ead9ec and P17 d0ea2f4; explicit all-error regression passes. |
| P19-RV-F02 | Copilot review body: warned tools called passed beside a failure | Human summary now says verified; failure-plus-warning regression passes on both lines. |
| P19-RV-F03 | Copilot review body: inherited XDG directories escape local-loader isolation | Deep probe overrides home, configuration/data/cache/state/runtime and XDG search directories; assertions outside the fake process verify the full child environment on both lines. |
| P19-RV-F04 | Copilot review body: duplicate grouping precedes final scope/enablement filters | Reproduced and corrected on main's legacy inventory, with plugin scope and enabled/disabled controls. P17's canonical tool/scope-bounded collision metadata and post-collision display filters are preserved, not replaced by main's older contract. |
| P19-RV-F05 | [Copilot inline](https://github.com/smorinlabs/skillsmith/pull/66#discussion_r4013616507) and review body: stale command references | Main command docs now describe same-tool selected-inventory duplicates, initialized local loading, incomplete coverage and current human output. P17's historical research points explicitly to its corrected current implementation/reference. |
| P19-RV-F06 | Copilot review body: validation evidence lagged PR claims | Exact successive heads and gate outcomes are appended in EVIDENCE.md, including the successful final P17 receipt at d786739. Earlier failures and later corrections remain distinguishable. |
| P19-RV-F07 | P17 ordinary gate: update TS05 still simulates exec/401 and lacks static success replies | Shared hermetic app-server fixture and supported static responses added at d0ea2f4. Original expectations unchanged; targeted TS05 passes. Full terminal gate remains separately required. |
| P19-RV-F08 | P17 ordinary gate: inherited host tool installations change doctor findings | Baseline reproduction at 5a74185; fixture PATH and in-process filesystem facts isolated at be2297c. Exact doctor owner passes; tracked by #67. |
| P19-RV-F09 | Self-inspection: managed-marker probe under an ordinary file can raise ENOTDIR | Directory-kind guard and real-file/link regression at be2297c; part of #40. |
| P19-RV-F10 | P17 ordinary gate: verify TS04 inherits Codex under HOME despite empty PATH | Reproduced on untouched 5a74185; isolate HOME/XDG/tool configuration without changing assertions. Full verify owner passes 15 tests/80 assertions; part of #67. |
| P19-RV-F11 | P17 ordinary gate: help assertion still expects cross-scope-only duplicate wording | Corrected at 0871985 to the exact same-tool placement-conflict semantics, allowing line wrapping. All 10 help tests pass. |
| P19-RV-F12 | Remainder diagnosis: checker-output snapshot expects 23 local links instead of 25 | The two P19 backlinks legitimately change the count. Updated only the literal test expectation; all three output compatibility tests pass. Production checker, catalog and gates unchanged. |
| P19-RV-F13 | Main and P17 Codex reviewers: killing only the JSON-RPC launcher leaves descendant-held stdout/stderr pipes open, so the deadline does not bound completion | Open under #64 on both lines. A self-expiring child reproduced approximately 1.5 seconds of elapsed time for a 100 ms timeout. Require owned process-tree cleanup and bounded stream cleanup with a launcher/child regression. |
| P19-RV-F14 | Main and P17 Codex reviewers: nonzero shutdown discards a validated, exact-target skill-load failure | Open under #64/#61 on both lines. The same invalid-artifact response fails at exit 0 but becomes inconclusive at exit 1. Preserve proven artifact failure alongside transport diagnostics; never turn incomplete success into pass. |
| P19-RV-F15 | P17 Codex reviewer: deep-adapter catch converts cancellation into an ordinary successful application result with inconclusive coverage | Open under #64 on P17. Restore propagation through the existing cancellation boundary and add an in-flight Codex cancellation regression. |
| P19-RV-F16 | P17 Codex reviewer: doctor/verify subprocess fixtures can still discover host tools through global executable directories | Open under #67 on P17. Isolate fixture discovery without removing host installations, weakening assertions, or changing production discovery. |

The preserved P17 catalog records historical checkpoint sign-offs, not fresh approval of the P19 delta.

Local ordinary/security gates pass on both recorded heads; main Linux/macOS CI also passes.
Those prior green gates did not cover the newly reproduced findings. No P17 PR CI receipt
is claimed. Remaining sign-off conditions: correct F13-F16, obtain corrected-head review,
settle product-only P17 CI, validate exact integration heads, and integrate on affected lines.
The [Q1.A reporting decision](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5689778855)
preserves per-tool conflict semantics and keeps #41 open for a separate informational cross-tool
reporting PR; this addition is not a prerequisite for merging PR #66.
P17 PR creation also needs a scope decision because its
current PR workflow automatically invokes deferred Candidate-cask qualification. No release gate
has been waived, no deferred qualification has been counted passed, and no bug is auto-closed.
