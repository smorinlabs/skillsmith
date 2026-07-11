---
type: exploratory
status: chosen
created: 2026-07-11
updated: 2026-07-11
confidence: high
confidence_basis: official OpenAI product docs and cookbook cross-checked against the official app-server protocol, installed Codex CLI 0.144.1, and the current session goal-tool schemas
verified_example: false
assumptions: the user will start the goal manually in a fresh interactive Codex thread rooted at the Skillsmith repository; the preparation package will be committed before activation
sources:
  - https://learn.chatgpt.com/docs/reference/slash-commands#available-slash-commands
  - https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal
  - https://learn.chatgpt.com/docs/long-running-work#steer-a-running-goal
  - https://learn.chatgpt.com/use-cases/follow-goals#set-up-the-loop
  - https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex
  - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
origin_prompt: topics/codex-persistent-goal/prompts/00-landscape.prompt.md
---

# Landscape: Codex persistent goal for P17

## Question and constraints

P17 needs a fresh Codex thread to execute a large Phase 0-6 program from one canonical repository
file. The bootstrap must be one sentence; the detailed contract must remain versioned in the
repository; completion must be evidence-based; phase approvals remain human-controlled; and the
agent must be able to resume after ordinary turns or context compaction without relying on the
conversation as the only state store.

The user will activate the goal manually. No live goal was created during this research, so
`verified_example` is false by design.

## Primary-source survey

### Public product surface

OpenAI's slash-command reference describes `/goal` as setting a persistent goal and recommends
using `/plan` first. The Goals cookbook describes a Goal as a thread-scoped completion contract,
not global memory or project instructions. It documents set, view, pause, resume, and clear
operations, evidence-based completion, automatic continuation at safe idle boundaries, optional
budget accounting, and stopping on success, pause, interruption, a budget limit, or a blocker.

The long-running-work guide states that a running goal retains the same sandbox and approval policy
and pauses when a decision is needed. The follow-goals guide recommends one objective and stopping
condition, pointers to required files, explicit proof commands or artifacts, checkpoints, a short
progress log, and lifecycle control through `/goal`.

### Protocol surface

The official app-server reference says `/goal` and `thread/goal/*` operate on the same persisted goal
state. `thread/goal/set` accepts a thread ID, objective, status, and token budget;
`thread/goal/get` reads it; and `thread/goal/clear` removes it. Objectives must be non-empty and no
more than 4,000 characters. A new objective replaces the old goal and resets usage accounting;
updating the current non-terminal objective, or omitting the objective, preserves usage history.

The official OpenAI source README independently describes one persisted goal per materialized
thread and the same set/get/clear operations. It shows `active`, `blocked`, `budgetLimited`, and
`usageLimited` lifecycle uses. The public cookbook also describes `paused` and `complete` states.

### Installed and current-session surfaces

The locally installed binary reports `codex-cli 0.144.1`. `codex features list` reports `goals` as
`stable` and enabled. Top-level `codex --help` does not expose a non-interactive `goal` subcommand;
the verified user surface is the interactive slash command.

The official Codex manual helper was also attempted. It refused the response because the expected
`x-content-sha256` integrity header was absent, so the research used the official documentation
service, official source, and local capability output instead of treating an unverified manual body
as authoritative.

The current session exposes these callable contracts:

| Tool | Verified input and authority |
|---|---|
| `create_goal` | Required non-empty objective string in practice; optional positive `token_budget`, which must be omitted unless explicitly requested; fails while an unfinished goal exists. |
| `get_goal` | No input; returns current status, budgets, token and elapsed-time usage, and remaining budget. |
| `update_goal` | May mark only `complete` or `blocked`; cannot pause, resume, clear, or set budget/usage-limit states. Completion requires the whole objective and all required work to be done. The current runtime permits `blocked` only after the same blocker recurs for at least three consecutive goal turns and no meaningful progress remains. |

The callable tool is therefore a narrower agent authority layer over the broader user/system
lifecycle documented for `/goal` and app-server. A future session must obey its actual runtime tool
schema if it differs.

## Exact verified facts

| Claim | Result | Confidence |
|---|---|---|
| `/goal` is the official name | Yes; public slash-command reference and cookbook. | High |
| The goal is persistent | Yes, as thread-scoped persisted state across turns. It is not global or project-scoped state. | High |
| Goal input accepts arbitrary long Markdown directly | No. The objective is limited to 4,000 characters. | High |
| `/goal` has a documented file argument | No documented `--file`, `@file`, stdin, or direct ingestion form was found. | High for absence in current public docs; not a guarantee about future builds |
| A goal may point at a file | Yes. Official guidance says longer instructions belong in a file and the goal should point at it. | High |
| A pointed-to file is automatically reread | Not documented. The goal text stores the pointer; the canonical file must explicitly require rereads at bootstrap and checkpoints. | Medium |
| Goal state survives a resumed thread | The cookbook says resuming can restore the objective when appropriate, and app-server persists goal state by thread. | High |
| Goal state transfers to a new thread | Not established. Thread scope means a new thread should create its own goal explicitly. | High |
| Goal state survives context compaction | The architecture makes goal state separate persisted thread state, so it should remain attached; exact rereading of referenced files after compaction is not guaranteed. | Medium |
| Goal state propagates to sub-agents | Not documented. Treat the root thread as owner and give each sub-agent a bounded brief. | High for the recommendation; unknown product behavior |
| Plan mode automatically executes the goal | No. The cookbook says plan-only work does not trigger automatic continuation. Exit plan mode before execution. | High |
| A goal broadens permissions | No. Existing sandbox and approval policies remain in force. | High |
| A budget limit means success | No. It stops substantive work and requires a progress/blocker summary; it is not completion. | High |

## Candidate patterns

### A. Short `/goal` pointer to a canonical committed goal file — chosen

Use one short objective that identifies the outcome, canonical file, and evidence-based finish line.
The file holds the detailed operating contract and links all subordinate artifacts.

Strengths:

- follows OpenAI's explicit guidance for instructions longer than 4,000 characters;
- keeps the durable contract in Git and reviewable in the preparation PR;
- avoids copying hundreds of IDs into a runtime objective;
- permits deterministic bootstrap and resumption by rereading committed state;
- separates thread lifecycle state from the repository's normative work state.

Risk controls:

- verify the session is rooted at the Skillsmith repository before setting the goal;
- use a repository-relative path in the objective;
- require the agent to read the goal file and every normative reference before editing;
- require checkpoint rereads of the catalog/checklist/evidence, because automatic file rereading is
  not documented;
- do not change the goal file during execution without an explicit, reviewed contract amendment.

### B. Detailed inline `/goal` under 4,000 characters — ranked runner-up

This remains supported and could summarize the outcome, verification surface, constraints,
iteration policy, and blocker rule in the objective itself. It is useful when repository files are
unavailable or the task is compact. For P17 it is second best: it duplicates the committed
contract, risks divergence, leaves too little room for hundreds of tracked entities, and makes PR
review of the operational prompt harder.

### C. Ordinary prompt that asks Codex to infer or create the goal

An ordinary prompt can explicitly request goal creation, and the current callable tool supports
that when the user asks. It adds an avoidable interpretation step. Because the user intends to
activate the goal manually, a direct `/goal` pointer is clearer and easier to verify.

### D. Put the whole operating contract in `AGENTS.md`

`AGENTS.md` is appropriate for durable repository conventions, not one thread's completion
objective, budget, progress, and lifecycle. P17 should obey `AGENTS.md`, but its goal contract
belongs in `projects/P17-GOAL.md` and the thread goal state.

## Recommended bootstrap

Use this one sentence from the repository root in a fresh interactive Codex thread:

```text
/goal Execute P17 completely by reading and following projects/P17-GOAL.md as the canonical objective and completion contract, pausing for every human approval it requires and marking complete only after all referenced gates and final sign-off pass.
```

This does not claim a file-ingestion syntax. It supplies an ordinary objective string containing a
path, exactly matching the documented pointer pattern.

Do not set a token budget unless the user explicitly chooses one. An arbitrary cap would stop a
large program without making it complete. If a budget is later selected, the goal file must require
a checkpoint/evidence summary when it is reached.

## Required contents of `projects/P17-GOAL.md`

The canonical file should be an operational index and contract, not a duplicate of the hundreds of
plan records. It needs these sections:

1. **Objective and terminal completion condition** — implement accepted Phase 0-6 behavior; keep
   Phase 7 deferred and P14 blocked; complete only after every required entity, group, workflow,
   phase gate, final validation, and user sign-off passes.
2. **Bootstrap and scope check** — confirm repository root, branch/worktree, instructions, clean
   ownership boundaries, and current goal status before editing.
3. **Normative authority order** — goal file for operating process; P17 project for scope/status;
   consolidated plan for product contracts; execution map for dependency groups; machine-readable
   catalog for identity/ownership/status; generated checklist for the human view; append-only
   evidence for proof. Conversation summaries cannot override committed artifacts.
4. **Resolvable reference map** — link the P17 project record, consolidated plan,
   `projects/p17/PREP.md`, `projects/p17/EXECUTION.md`, the final catalog and generated-checklist
   paths, `projects/p17/evidence/`, architecture, repository instructions, and this research
   decision/leaf.
5. **Inventory invariants** — record the accepted counts and require the structural validator to
   recompute them; never use prose counts as proof.
6. **Dependency-aware execution order** — execute only ready groups; prohibit dependent work until
   prerequisite group and phase gates are signed off.
7. **Per-group TDD state machine** — mapped -> ready -> test-first/red (or characterized refactor
   boundary) -> minimal implementation -> targeted green -> impacted green -> refactor ->
   independent adversarial review -> traceability closure -> signed off.
8. **Sub-agent protocol** — root thread owns the goal; delegate only bounded groups or independent
   review; name owned files and expected artifacts; prevent simultaneous writes to overlapping
   files; require evidence-bearing handoff; independently verify sub-agent claims.
9. **Adversarial review contract** — use a fresh Codex reviewer for every group and whole phase;
   test contract mismatch, negative paths, atomicity/data loss, interruption/concurrency,
   output/exit semantics, cross-command consistency, artifact compatibility, skipped tests, and
   tests that pass the wrong implementation. Stable finding IDs must close before sign-off.
10. **Verification/correction loop** — failed test, gate, traceability check, or review finding
    reopens the group; fix minimally; rerun targeted and impacted suites; repeat independent review;
    update evidence; sign off only when clean.
11. **Evidence and progress protocol** — update canonical catalog state, regenerate the checklist,
    write append-only group evidence, record commands/results/commits/CI/reviews, and give concise
    progress updates. Never infer commit, push, PR, merge, or clean state.
12. **Human-controlled boundaries** — request explicit approval at every phase boundary and final
    completion; do not release, merge, broaden scope, alter accepted design, or advance while
    approval is pending. Waiting for scheduled approval is not immediate proof of a blocker.
13. **Resume/compaction protocol** — on every new turn, automatic continuation after uncertainty,
    or context compaction, reread the goal file, execution map, catalog rollup, current checklist,
    latest group evidence, and Git state; then select the lowest ready unfinished group. Do not rely
    on recalled chat summaries.
14. **Blocked and budget rules** — exhaust safe in-scope alternatives; follow the current runtime's
    exact blocked threshold; report attempted paths, evidence, blocker, and unlocking input. A
    budget or usage limit is not completion.
15. **Final closeout** — recompute all inventory/traceability checks, run the complete validation
    matrix, close phase/final adversarial review, obtain explicit final user approval, verify final
    Git/PR state, and only then mark the goal complete.

## Persistence and resumption caveats

- The goal is attached to one thread. Resuming that thread is the supported continuity path. A new
  thread needs a new explicit `/goal` invocation.
- The stored goal contains the objective string, not a guaranteed snapshot of every referenced
  file. Git provides the durable contract; explicit rereads provide freshness.
- A repository path in the objective assumes the intended working directory. Verify the repo root
  before activation and use links relative to each containing Markdown file inside the package.
- Context compaction preserves the thread's usable continuity, but exact retained conversational
  detail is intentionally summarized. The catalog, checklist, and evidence must be sufficient to
  reconstruct execution without old chat text.
- User input, another active turn, queued work, plan-only activity, interruption, approvals, budget,
  or a tool-less continuation can stop automatic progress. The goal file must make the next action
  recoverable rather than assume an uninterrupted loop.
- Sub-agent goal inheritance is not established. Sub-agent work is complete only when the root
  validates and records its evidence.

## Pitfalls

1. Pasting the entire plan into `/goal` and exceeding 4,000 characters.
2. Treating `/goal projects/P17-GOAL.md` as a documented file loader rather than an objective that
   points to a path.
3. Assuming a new thread, fork, sub-agent, or compaction automatically rereads the canonical file.
4. Leaving Plan mode active and expecting automatic implementation continuation.
5. Giving independent agents overlapping write ownership or accepting their summaries as proof.
6. Marking the goal complete after one green suite while catalog entries, workflows, reviews,
   documentation drift, human approvals, or final Git state remain open.
7. Calling a goal blocked at the first uncertainty or approval pause instead of following the
   runtime's blocker policy and exhausting safe progress.
8. Treating budget exhaustion as success.
9. Editing generated checklists manually and creating drift from the catalog.
10. Letting conversation summaries override the committed authority hierarchy.

## Outcome

The P17 use case should use a short direct `/goal` objective pointing to a committed canonical goal
file. The runtime goal supplies thread-scoped persistence and continuation; the repository package
supplies exhaustive, reviewable, restartable truth.
