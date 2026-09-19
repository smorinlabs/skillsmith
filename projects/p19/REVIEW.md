# P19 review disposition

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
| P19-RV-F06 | Copilot review body: validation evidence lagged PR claims | Exact successive heads and gate outcomes are appended in EVIDENCE.md. Earlier failures and later corrections remain distinguishable; final receipt must be recorded before closeout. |
| P19-RV-F07 | P17 ordinary gate: update TS05 still simulates exec/401 and lacks static success replies | Shared hermetic app-server fixture and supported static responses added at d0ea2f4. Original expectations unchanged; targeted TS05 passes. Full terminal gate remains separately required. |
| P19-RV-F08 | P17 ordinary gate: inherited host tool installations change doctor findings | Baseline reproduction at 5a74185; fixture PATH and in-process filesystem facts isolated at be2297c. Exact doctor owner passes; tracked by #67. |
| P19-RV-F09 | Self-inspection: managed-marker probe under an ordinary file can raise ENOTDIR | Directory-kind guard and real-file/link regression at be2297c; part of #40. |
| P19-RV-F10 | P17 ordinary gate: verify TS04 inherits Codex under HOME despite empty PATH | Reproduced on untouched 5a74185; isolate HOME/XDG/tool configuration without changing assertions. Full verify owner passes 15 tests/80 assertions; part of #67. |
| P19-RV-F11 | P17 ordinary gate: help assertion still expects cross-scope-only duplicate wording | Corrected at 0871985 to the exact same-tool placement-conflict semantics, allowing line wrapping. All 10 help tests pass. |
| P19-RV-F12 | Remainder diagnosis: checker-output snapshot expects 23 local links instead of 25 | The two P19 backlinks legitimately change the count. Updated only the literal test expectation; all three output compatibility tests pass. Production checker, catalog and gates unchanged. |
| P19-RV-F13 | Independent review: descendant-held pipes defeat launcher-only termination | Corrected at b33c224 with owned POSIX process-group termination, reader cancellation and bounded cleanup. Linux controls pass; no Windows process-tree parity claim. |
| P19-RV-F14 | Independent review: abnormal shutdown drops proven exact-target artifact errors | Corrected at b33c224. Validated failures survive transport diagnostics; successful-looking or invalid transcripts cannot establish success. |
| P19-RV-F15 | Independent review: cancellation becomes an inconclusive successful application result | Corrected at b33c224; cancellation reaches runVerify's existing boundary and staging cleanup is verified. |
| P19-RV-F16 | Independent review: HOME/PATH isolation still discovers global tools | Corrected at b33c224 with the shared test-only detection preload, synthetic global-tool controls and original CLI assertions. Production discovery and host tools unchanged. |
| P19-RV-F17 | Main review: new descendant fixture races child startup, including after setup-window enlargement | Corrected and independently approved at 01d09a9: atomic heartbeat, bounded readiness, controlled deadline with immediate spy restoration, exited-launcher proof and retained real-clock timer regression. Main equivalent replay: 41 pass/0 fail/721 assertions; P17 transport owner: 12 pass/0 fail/32 assertions. |

The preserved P17 catalog records historical checkpoint sign-offs, not fresh approval of the P19 delta.

Remaining sign-off conditions: exact-head ordinary gates/CI and integration.
[Q1.A](https://github.com/smorinlabs/skillsmith/issues/41#issuecomment-5689778855) keeps per-tool
conflicts and assigns informational cross-tool reporting to a separate PR; #41 remains open.
[Q2.A](https://github.com/smorinlabs/skillsmith/issues/51#issuecomment-5689864463) authorizes
the narrow CI separation and maintenance PR into agent/p17-execution, retaining #44's draft hold.
CI-only ffd1cba preserves ordinary/native checks and moves qualification behind a guarded manual
trigger. No release qualification was executed, waived or counted passed; #52/#58 remain deferred.
