# Framing: Codex persistent goal for P17

## Question

How should a fresh Codex session initialize and safely execute a large, multi-phase repository goal
from one canonical Markdown prompt, using the current built-in persistent-goal interface?

## Current evidence

- The current session exposes a goal-creation capability accepting a required text `objective` and
  an optional positive `token_budget`; status is managed separately from the goal prompt.
- The user refers to this product surface as the Codex slash Goal command and will invoke it
  manually in a new thread.
- The official Codex manual helper was attempted on 2026-07-11 and refused its response because the
  expected `x-content-sha256` header was absent.
- Two narrow searches of official OpenAI documentation returned no page documenting `/goal` or a
  file-ingestion form.

## Project constraints

- Repository: Skillsmith, a Bun 1.3.14+ and TypeScript 5.9 workspace.
- P17 covers an approved Phase 0-6 implementation program with hundreds of named tracked entities.
- `projects/P17-GOAL.md` must be the single canonical goal prompt and reference all supporting
  project, plan, checklist, catalog, evidence, and verification artifacts.
- The new-session bootstrap must be one sentence. The user will create the persistent goal manually.
- Execution must use dependency-aware groups, test-driven development, sub-agents where useful,
  independent Codex adversarial review, mechanical traceability, evidence, and phase approvals.
- Research must prioritize official OpenAI documentation, current locally installed Codex help or
  callable capability metadata, and official OpenAI source/release material. Any undocumented
  behavior must be labeled as such rather than inferred.

## Decision required

Name the safest supported bootstrap pattern, the exact documented/verified goal input contract, how
file references should be handled, what persistence/resumption guarantees are established, and
which execution instructions belong in the canonical goal file versus the one-sentence bootstrap.
