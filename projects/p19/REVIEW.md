# P19 review disposition

Fresh independent Codex sign-off is still pending. This ledger records findings and implementation
evidence, not approval. Product issues remain open until affected-line review and integration.

| ID | Origin / finding | Disposition |
| --- | --- | --- |
| P19-RV-F01 | [Copilot inline](https://github.com/smorinlabs/skillsmith/pull/66#discussion_r4013616457): all-error verification incorrectly says no tools ran | Corrected on main 9ead9ec and P17 d0ea2f4; explicit all-error regression passes. |
| P19-RV-F02 | Copilot review body: warned tools called passed beside a failure | Human summary now says verified; failure-plus-warning regression passes on both lines. |
| P19-RV-F03 | Copilot review body: inherited XDG directories escape local-loader isolation | Deep probe overrides home, configuration/data/cache/state/runtime and XDG search directories; assertions outside the fake process verify the full child environment on both lines. |
| P19-RV-F04 | Copilot review body: duplicate grouping precedes final scope/enablement filters | Reproduced and corrected on main's legacy inventory, with plugin scope and enabled/disabled controls. P17's canonical tool/scope-bounded collision metadata and post-collision display filters are preserved, not replaced by main's older contract. |
| P19-RV-F05 | [Copilot inline](https://github.com/smorinlabs/skillsmith/pull/66#discussion_r4013616507) and review body: stale command references | Main command docs now describe same-tool selected-inventory duplicates, initialized local loading, incomplete coverage and current human output. P17's historical research points explicitly to its corrected current implementation/reference. |
| P19-RV-F06 | Copilot review body: validation evidence lagged PR claims | Exact successive heads and gate outcomes are appended in EVIDENCE.md. Earlier failures and later corrections remain distinguishable; final receipt must be recorded before closeout. |
| P19-RV-F07 | P17 ordinary gate: update TS05 still simulates exec/401 and lacks static success replies | Shared hermetic app-server fixture and supported static responses added at d0ea2f4. Original expectations unchanged; targeted TS05 passes. Full terminal gate remains separately required. |
| P19-RV-F08 | P17 ordinary gate: inherited host tool installations change doctor findings | Baseline reproduction at 5a74185; fixture PATH and in-process filesystem facts isolated at be2297c. Exact doctor owner passes; tracked by #67. |
| P19-RV-F09 | Self-inspection: managed-marker probe under an ordinary file can raise ENOTDIR | Directory-kind guard and real-file/link regression at be2297c; part of #40. |
| P19-RV-F10 | P17 ordinary gate: verify TS04 inherits Codex under HOME despite empty PATH | Reproduced on untouched 5a74185; isolate HOME/XDG/tool configuration without changing assertions. Full verify owner passes 15 tests/80 assertions; part of #67. |

The preserved P17 catalog records historical checkpoint sign-offs, not fresh approval of the P19 delta.

Remaining sign-off conditions: fresh Codex review, exact-head ordinary gates/CI, accepted duplicate
semantics, and affected-line integration. P17 PR creation also needs a scope decision because its
current PR workflow automatically invokes deferred Candidate-cask qualification. No release gate
has been waived, no deferred qualification has been counted passed, and no bug is auto-closed.
