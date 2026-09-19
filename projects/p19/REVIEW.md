# P19 review disposition

Independent read-only Codex reviews at main `7c8d865` and P17 `d786739` requested F13-F16.
Runtime corrections at main `5adb299` and P17 `b33c224` have source approval; the final
descendant-fixture correction at main `27c67e9` / P17 `01d09a9` is independently approved.
Codex and Claude Code reviewers have standing user approval. Product issues remain open until
their full acceptance and affected-line integration are satisfied.

Independent Codex review approved runtime corrections at `b33c224` and separately approved
CI-only `ffd1cba`. The subsequent descendant-fixture correction at `01d09a9` is independently
approved. Reviewers have standing approval. Issues remain open until acceptance and integration.

| ID | Origin / finding | Disposition |
| --- | --- | --- |
| P19-RV-F01 | [Copilot inline](https://github.com/smorinlabs/skillsmith/pull/66#discussion_r4013616457): all-error verification incorrectly says no tools ran | Corrected on main 9ead9ec and P17 d0ea2f4; explicit all-error regression passes. |
| P19-RV-F02 | Copilot review body: warned tools called passed beside a failure | Human summary now says verified; failure-plus-warning regression passes on both lines. |
| P19-RV-F03 | Copilot review body: inherited XDG directories escape local-loader isolation | Deep probe overrides home, configuration/data/cache/state/runtime and XDG search directories; assertions outside the fake process verify the full child environment on both lines. |
| P19-RV-F04 | Copilot review body: duplicate grouping precedes final scope/enablement filters | Reproduced and corrected on main's legacy inventory, with plugin scope and enabled/disabled controls. P17's canonical tool/scope-bounded collision metadata and post-collision display filters are preserved, not replaced by main's older contract. |
| P19-RV-F05 | [Copilot inline](https://github.com/smorinlabs/skillsmith/pull/66#discussion_r4013616507) and review body: stale command references | Main command docs now describe same-tool selected-inventory duplicates, initialized local loading, incomplete coverage and current human output. P17's historical research points explicitly to its corrected current implementation/reference. |
| P19-RV-F06 | Copilot review body: validation evidence lagged PR claims | Exact successive heads and gate outcomes are appended in EVIDENCE.md, including the successful final P17 receipt at d786739. Earlier failures and later corrections remain distinguishable; final receipt must be recorded before closeout. |
| P19-RV-F07 | P17 ordinary gate: update TS05 still simulates exec/401 and lacks static success replies | Shared hermetic app-server fixture and supported static responses added at d0ea2f4. Original expectations unchanged; targeted TS05 passes. Full terminal gate remains separately required. |
| P19-RV-F08 | P17 ordinary gate: inherited host tool installations change doctor findings | Baseline reproduction at 5a74185; fixture PATH and in-process filesystem facts isolated at be2297c. Exact doctor owner passes; tracked by #67. |
| P19-RV-F09 | Self-inspection: managed-marker probe under an ordinary file can raise ENOTDIR | Directory-kind guard and real-file/link regression at be2297c; part of #40. |
| P19-RV-F10 | P17 ordinary gate: verify TS04 inherits Codex under HOME despite empty PATH | Reproduced on untouched 5a74185; isolate HOME/XDG/tool configuration without changing assertions. Full verify owner passes 15 tests/80 assertions; part of #67. |
| P19-RV-F11 | P17 ordinary gate: help assertion still expects cross-scope-only duplicate wording | Corrected at 0871985 to the exact same-tool placement-conflict semantics, allowing line wrapping. All 10 help tests pass. |
| P19-RV-F12 | Remainder diagnosis: checker-output snapshot expects 23 local links instead of 25 | The two P19 backlinks legitimately change the count. Updated only the literal test expectation; all three output compatibility tests pass. Production checker, catalog and gates unchanged. |
| P19-RV-F13 | Main and P17 Codex reviewers: killing only the JSON-RPC launcher leaves descendant-held stdout/stderr pipes open, so the deadline does not bound completion | Corrected at main 5adb299 / P17 b33c224: owned POSIX process group, cancelled readers and bounded cleanup grace. Independent Linux reproduction now returns 110 ms for a 100 ms deadline. macOS CI remains required; no Windows process-tree parity claim. |
| P19-RV-F14 | Main and P17 Codex reviewers: nonzero shutdown discards a validated, exact-target skill-load failure | Corrected at main 5adb299 / P17 b33c224. Validated exact-target failure survives exit, timeout and protocol errors alongside sanitized diagnostics. Incomplete success or invalid transcripts never become pass or proven artifact failure. |
| P19-RV-F15 | P17 Codex reviewer: deep-adapter catch converts cancellation into an ordinary successful application result with inconclusive coverage | Corrected at P17 b33c224: rethrow cancellation to the existing runVerify boundary; in-flight cancellation and temporary-directory cleanup regression passes. Main's different cancellation boundary is not changed. |
| P19-RV-F16 | P17 Codex reviewer: doctor/verify subprocess fixtures can still discover host tools through global executable directories | Corrected at P17 b33c224: shared test-only preload isolates external tool stat probes. Synthetic global-tool controls and unchanged real CLI assertions pass. No host installation or production discovery changed. |
| P19-RV-F17 | Main reviewer: new descendant regression cancels before its child starts; enlarged setup windows still fail under concurrent scheduling | Corrected and independently approved at main 27c67e9 / P17 01d09a9: atomic heartbeat, bounded readiness, controlled transport deadline with synchronous timer-spy restoration, proof the exited launcher is gone, and separate unchanged real-clock timeout coverage. Reviewer replay: 41 pass/0 fail/721 assertions; P17 transport owner: 12 pass/0 fail/32 assertions. |

The preserved P17 catalog records historical checkpoint sign-offs, not fresh approval of the P19 delta.

Local ordinary/security gates pass on both recorded heads; main Linux/macOS CI also passes.
Those prior green gates did not cover the newly reproduced findings. No P17 PR CI receipt
is claimed. Remaining sign-off conditions: exact integration-head gates, current CI and
affected-line integration. Independent source/fixture review has no remaining blockers.
The [Q1.A reporting decision](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5689778855)
preserves per-tool conflict semantics and keeps #41 open for a separate informational cross-tool
reporting PR; this addition is not a prerequisite for merging PR #66.
[Q2.A](https://github.com/smorinlabs/skillsmith/issues/51#issuecomment-5689864463) approved the
product-only P17 path, retaining #44's draft hold. CI-only `ffd1cba` is independently approved: ordinary checks and all
native smoke lanes remain automatic; Candidate-cask qualification is guarded and manual.
Its outstanding release work remains #52/#58. No release gate is waived, no deferred
qualification is counted passed, and no bug is auto-closed.
