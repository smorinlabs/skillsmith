---
type: terminal
status: current
created: 2026-07-11
updated: 2026-07-11
library_version: Codex CLI 0.144.1; goals stable and enabled
confidence: high
confidence_basis: official OpenAI slash-command, long-running-work, app-server, and cookbook documentation cross-checked with the installed CLI and current session callable tool schemas
verified_example: false
assumptions: interactive Codex session at the Skillsmith repository root; user manually activates the goal; P17 package is committed before activation
sources:
  - https://learn.chatgpt.com/docs/reference/slash-commands#available-slash-commands
  - https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal
  - https://learn.chatgpt.com/docs/long-running-work#steer-a-running-goal
  - https://learn.chatgpt.com/use-cases/follow-goals#set-up-the-loop
  - https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex
  - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
origin_prompt: topics/codex-persistent-goal/prompts/00-landscape.prompt.md
---

# Codex persistent goals for a canonical repository execution contract

## The specific knowledge

Use a short interactive `/goal` objective that points to a committed repository file when the
operating contract is large. OpenAI documents `/goal` as a persistent Goal attached to the current
thread and explicitly recommends putting instructions longer than the 4,000-character objective
limit in a file and pointing the Goal at it.

The safe P17 bootstrap is:

```text
/goal Execute P17 completely by reading and following projects/P17-GOAL.md as the canonical objective and completion contract, pausing for every human approval it requires and marking complete only after all referenced gates and final sign-off pass.
```

This is an objective string containing a path, not a special file-ingestion syntax. Current public
documentation does not establish `/goal --file`, `/goal @file`, stdin ingestion, or automatic file
rereading.

The canonical `projects/P17-GOAL.md` should define the measurable outcome, evidence-based finish
line, constraints, boundaries, iteration/correction policy, blocker rule, authority hierarchy,
reference map, dependency groups, per-group TDD lifecycle, bounded sub-agent work, independent
adversarial review, phase approvals, resume protocol, and final closeout. It should link rather than
duplicate the plan, execution map, catalog, generated checklist, and evidence records.

## Verified interface

| Surface | Current verified contract |
|---|---|
| Interactive slash command | `/goal <objective>` sets; bare `/goal` views; `/goal edit`, `pause`, `resume`, and `clear` manage the lifecycle. |
| Objective | Non-empty, maximum 4,000 characters. A new objective replaces the old goal and resets usage accounting. |
| App server | `thread/goal/set`, `thread/goal/get`, and `thread/goal/clear` manage the same persisted thread goal state. |
| Current agent tool | `create_goal({objective, token_budget?})`; positive budget only when explicitly requested. |
| Current inspection tool | `get_goal({})` returns status, budgets, token/time usage, and remaining budget. |
| Current agent status tool | `update_goal({status: "complete" | "blocked"})`; agent cannot pause, resume, clear, or declare budget/usage limits. |

Goals persist as thread state across turns; they are not global memory or repository instructions.
Continuation occurs only at safe idle boundaries when the Goal is active and within budget. Plan-only
work does not trigger continuation. Interruptions pause progress, and a continuation that makes no
tool call suppresses the next automatic continuation. Existing sandbox and approval policy remain
in force.

Completion must be checked against concrete evidence. Budget exhaustion is not completion. Under
the current callable contract, mark complete only when all required work is done; mark blocked only
after the same blocking condition recurs for at least three consecutive goal turns and no meaningful
progress remains. If a future runtime exposes different lifecycle rules, its actual tool contract
governs.

## P17 goal-file checklist

`projects/P17-GOAL.md` should contain:

- one objective and terminal completion condition;
- repository-root/branch/instruction preflight;
- authority order and resolvable links to the project, consolidated plan, preparation checklist,
  execution map, catalog, generated checklist, evidence directory, architecture, instructions, and
  this research decision;
- mechanically checked inventory invariants;
- acyclic dependency-group order;
- the mapped -> ready -> red -> minimal implementation -> targeted green -> impacted green ->
  refactor -> adversarial review -> traceability closure -> signed-off lifecycle;
- bounded sub-agent briefs with non-overlapping ownership and root validation;
- independent Codex review for every group and phase, with stable finding IDs;
- correction and rerun rules after any failed gate or review;
- append-only evidence plus generated progress rollups;
- explicit user approval at phase boundaries and final completion;
- new-turn/context-compaction resumption by rereading committed state and checking Git;
- blocker and budget reporting that cannot be mistaken for completion;
- final structural, test, workflow, documentation, review, approval, and Git/PR verification.

## Resumption protocol

At bootstrap and after any uncertain continuation or context compaction:

1. Read `projects/P17-GOAL.md` and its authority/reference map.
2. Read the execution map, current catalog rollup, generated checklist, latest current-group
   evidence, and repository Git state.
3. Recompute or run the structural/traceability gate.
4. Resume the lowest dependency-ready unfinished group; never infer state from chat memory.

A new thread does not have an established inheritance guarantee. Create the Goal explicitly again.
Sub-agents likewise should be treated as bounded workers without inherited root-goal authority.

## Gotchas

- Pointing at a file is documented; direct file ingestion is not.
- The goal stores a thread objective, not a guaranteed immutable snapshot of linked files.
- Relative paths depend on starting in the intended repository.
- Plan mode is for shaping the work and does not automatically continue implementation.
- Human approval pauses do not expand permissions and should not be mislabeled as immediate
  blockers.
- No arbitrary token budget should be supplied for P17 unless the user explicitly chooses one.
- A reviewer or sub-agent report is evidence input, not sign-off, until the root validates it and the
  catalog/checklist close.

## Currency notes

Verified 2026-07-11 against Codex CLI 0.144.1, where `goals` is stable and enabled. The official
Codex manual helper refused its response because the expected `x-content-sha256` integrity header
was absent; current official OpenAI docs were instead searched and fetched through the OpenAI
documentation service, then cross-checked against official OpenAI source and local capability
output.
