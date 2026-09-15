# P18 — verify: validate against external consumer schemas (claude plugin validate parity)

`skillsmith verify --static` validates skillsmith's own model of a plugin/skill, but the schemas
that actually gate installation — Claude Code's marketplace/plugin schema, Codex's equivalent —
are owned externally and drift on their own schedule, independent of skillsmith's fixtures.
Motivating incident (2026-07-27): every generated `marketplace.json` in the fleet carried
`author` as a string; Claude Code's schema requires an object. `/plugin install` failed with
"plugin not found" while gen-check, unit tests, and `verify --static` all stayed green — only
`claude plugin validate` (wired into nothing in the fleet) caught it. Proposal: `verify` (and
thus the doctor) should invoke or replicate the real consumer validators — e.g. shell out to
`claude plugin validate` when the CLI is present — so external-schema drift surfaces at
verify/doctor time, not install time.

### Open questions
- Q: Shell out to `claude plugin validate` at verify time vs vendor/replicate its schema inside
  skillsmith — which keeps pace with upstream schema changes better, and which is more honest
  about being a snapshot?
- Q: Offline / CLI-not-present behavior — skip the check, fail closed, or warn?
- Q: What is the Codex-side equivalent validator (if one exists), and does the same
  shell-out-vs-vendor question apply there?

### Notes
P19 reconciliation (2026-09-15): remains an idea, not an implementation prerequisite.
The existing Claude static adapter already invokes `claude plugin validate <target>`;
the motivating fleet `marketplace.json` incident is not proof that this invocation is missing.
Refinement should identify the uncovered artifact/consumer boundary and reproduce it against
the current promised contract before proposing additional validation. P19's Codex local-loader
fix (#64) repairs existing deep verification; it does not deliver this broader idea.

Predecessor: P11 (`skillsmith verify` — cross-tool load verification) shipped the
`--static`/`--deep` check engine this project would extend. The incident showed all of
skillsmith's own gates (gen-check, unit tests, `verify --static`) green while the actual
consumer (`claude plugin install`) refused the plugin — the gap is between skillsmith's model
of validity and the external tool's, not a bug in either one considered alone.

<!-- Idea state. Minimal by convention.
     Promote with `project-refine P18` when ready. -->
