#!/usr/bin/env bash
set -euo pipefail

# staged scans the commit index; pre-push consumes Git ref updates on stdin.
# Manual current-file/history checks: just secrets / just secrets-history.
exec bun "$(dirname "$0")/secret-scan.ts" "${@:-staged}"
