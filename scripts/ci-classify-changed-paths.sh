#!/usr/bin/env bash
# Classify a pull request's changed paths so CI can skip heavy jobs for
# changes confined to audited prose files.
#
# Usage: scripts/ci-classify-changed-paths.sh <base-sha> <head-sha>
#
# Run from a full-history checkout of the tested tree (the PR merge commit).
# Prints exactly one line, `code-changed=true` or `code-changed=false`, and
# always exits 0. Every error or ambiguity prints `code-changed=true`, so a
# classifier failure can only run more CI, never less.
set -euo pipefail

decide() {
  printf 'code-changed=%s\n' "$1"
  exit 0
}
trap 'decide true' ERR

# Audited prose: existing Markdown files whose consumers were inspected
# (literal path references, directory walkers, check-p17-package.ts link
# checks, generated references, Biome, tsc, and the tracked-file secret scan,
# whose PR coverage secret-scan.yml's history scan keeps). Exact paths only:
# new or unlisted files, and every other extension, are code. Extend only
# after auditing the file's consumers again.
audited_prose=(
  CATEGORIES.md
  SKILLSMITH_NPM_PYPI_OWNERS.md
  docs/superpowers/plans/2026-04-24-mvp-1-implementation.md
  docs/superpowers/plans/2026-04-24-mvp-2a-implementation.md
  docs/superpowers/plans/2026-04-24-mvp-2b1-implementation.md
  docs/superpowers/plans/2026-04-24-mvp-2b11-implementation.md
  docs/superpowers/plans/2026-04-24-split-command-docs.md
  docs/superpowers/plans/2026-07-07-verify-implementation.md
  docs/superpowers/plans/2026-07-10-p16-hermetic-git-fixtures.md
  docs/superpowers/plans/2026-09-20-skillsmith-search-implementation.md
  docs/superpowers/specs/2026-04-24-mvp-1-design.md
  docs/superpowers/specs/2026-04-24-mvp-2a-design.md
  docs/superpowers/specs/2026-04-24-mvp-2b1-design.md
  docs/superpowers/specs/2026-04-24-mvp-2b11-design.md
  research/archive/skillsmith-cli-design-critical-inconsistencies.md
  research/archive/skillsmith-cli-design-inconsistencies.md
  research/archive/skillsmith-cli-design-proposal.md
  research/archive/skillsmith-competitive-landscape.md
  research/archive/skillsmith-feature-copy.md
  research/archive/skillsmith-features.md
  research/archive/skillsmith-prd.md
  research/archive/skillsmith-v1-stack-summary-v0.md
  research/archive/skillsmith-v1-tech-stack.md
)

is_prose() {
  local entry
  for entry in "${audited_prose[@]}"; do
    if [ "$1" = "$entry" ]; then return 0; fi
  done
  return 1
}

# Every tracked file outside the audited set may read prose.
non_prose=(.)
for entry in "${audited_prose[@]}"; do non_prose+=(":(exclude,literal)$entry"); done

# Succeeds when <pattern> occurs literally in the tested tree under the
# pathspecs; any git failure decides true. This is an extra fail-closed
# layer over the audited list, not a dependency analysis.
mentioned_in() {
  local pattern=$1 rc=0
  shift
  git grep -q -F -e "$pattern" HEAD -- "$@" || rc=$?
  case $rc in
    0) return 0 ;;
    1) return 1 ;;
    *) decide true ;;
  esac
}

base=${1:-}
head=${2:-}
sha='^[0-9a-f]{40}$'
[[ $base =~ $sha && $head =~ $sha ]] || decide true
git rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null || decide true

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# Merge-base diff of the PR. --no-renames lists both sides of a rename,
# deletions are listed, and -z keeps unusual filenames intact.
git diff --no-renames --name-only -z "$base...$head" >"$workdir/changed" || decide true
[ -s "$workdir/changed" ] || decide true

changed=()
while IFS= read -r -d '' path; do
  if ! is_prose "$path"; then decide true; fi
  if mentioned_in "$path" "${non_prose[@]}"; then decide true; fi
  changed+=("$path")
done <"$workdir/changed"

# One level of transitivity: audited prose that a check names is itself a reader.
git ls-files -z >"$workdir/tracked" || decide true
readers=()
while IFS= read -r -d '' path; do
  if is_prose "$path" && mentioned_in "$path" "${non_prose[@]}"; then readers+=("$path"); fi
done <"$workdir/tracked"
if [ "${#readers[@]}" -gt 0 ]; then
  for path in "${changed[@]}"; do
    if mentioned_in "$path" "${readers[@]}"; then decide true; fi
  done
fi

decide false
