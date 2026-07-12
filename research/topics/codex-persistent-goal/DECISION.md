---
decided: 2026-07-11
status: decided
---

# Decision: How P17 starts and sustains a Codex persistent goal

## Choice

Use a short direct `/goal` objective that points to the committed canonical
`projects/P17-GOAL.md`. The goal file is the operating contract and reference map; linked artifacts
own product design, execution grouping, machine-readable identity/status, generated checkboxes, and
evidence. The root Goal owns progression and validation. Sub-agents receive bounded work or review
briefs and do not receive assumed goal inheritance.

Use this bootstrap sentence:

```text
/goal Execute P17 completely by reading and following projects/P17-GOAL.md as the canonical objective and completion contract, applying the recorded standing human approval without additional review pauses and marking complete only after all referenced gates and final sign-off pass.
```

Do not set a token budget unless the user explicitly requests one.

## Why

OpenAI documents a 4,000-character goal-objective limit and recommends putting longer instructions
in a file and pointing the Goal at it. P17 contains hundreds of tracked entities and must be
reviewable, mechanically validated, and resumable from committed state. A short pointer avoids
runtime duplication while the repository artifacts preserve exhaustive truth.

This split also respects Codex's architecture: the Goal is persistent thread state, not global
memory or project instructions. The Git-tracked goal file and linked catalog/checklist/evidence make
the execution reconstructable after compaction, interruption, or a new turn without claiming that
Codex automatically reloads files.

## Runner-up (ranked)

A fully self-contained inline `/goal` objective under 4,000 characters is the next-best option. Use
it only if the repository contract file cannot be made available. Switch to it if path resolution or
repository access is repeatedly impossible after the working directory and permissions are fixed.
For P17 it is inferior because it duplicates a reviewed contract, cannot carry the exhaustive
reference structure comfortably, and can drift outside Git review.

## Why not the others

- **Ordinary prompt asking Codex to create the goal:** supported when explicitly requested, but adds
  a model-interpretation step that manual direct `/goal` activation avoids.
- **Special `/goal --file` or `@file` syntax:** not documented in current official sources.
- **Put the goal contract in `AGENTS.md`:** conflates repository-wide conventions with one thread's
  completion/lifecycle state.
- **Paste the consolidated plan into `/goal`:** exceeds or crowds the 4,000-character objective
  limit and creates an unreviewed duplicate.
- **Assume conversation persistence is enough:** chat summaries are not an exhaustive status,
  ownership, or evidence ledger.

## Operating conditions

- Start from the Skillsmith repository root in a fresh interactive thread.
- Commit and merge the complete P17 preparation package before activation.
- Read the goal file and all normative references before edits.
- Exit Plan mode before expecting automatic execution continuation.
- Reread committed execution state after compaction or uncertainty; automatic file rereading is not
  documented.
- Keep phase and final approvals human-controlled.
- Follow the actual current-session tool schema for completion and blocker transitions.
- Treat budget/usage limits, interruption, and approval pauses as non-completion terminal or waiting
  conditions.

## Chain

- Prompt: prompts/00-landscape.prompt.md
- Framing: prompts/00-landscape.framing.md
- Output: 00-landscape.md
- Leaf: ../../reference/codex-persistent-goal-2026-07-11.md
