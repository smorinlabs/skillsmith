# Run the canonical ordinary PR gate.
default: check

# Install workspace dependencies with bun
install:
    bun install

# Run the CLI in dev mode (forwards extra args to the CLI)
dev *args:
    bun run dev {{args}}

# Run the test suite (forwards extra args to `bun test`)
test *args:
    bun test {{args}}

# Typecheck the workspace with tsc --noEmit
typecheck:
    bun run typecheck

# Lint with Biome (no writes)
lint:
    bun run lint

# Enforce import-boundary rules via ESLint
lint-boundaries:
    bun run lint:boundaries

# Format and auto-fix with Biome
fmt:
    bun run fmt

# Lint GitHub Actions workflows with actionlint
actions-lint:
    bun run actions-lint

# Validate the P17 execution package and PR-openable checklist
p17-check:
    bun run check:p17

# Check generated command/capability/version references without writing.
generated-check:
    bun scripts/generate-command-reference.ts --check

# Run every tracked Bun test file exactly once in a fresh serial process.
test-terminal:
    bun scripts/run-test-files-serial.ts

# Run the ordered canonical ordinary PR gate exactly once.
check:
    just secrets
    bun run lint
    bun run lint:boundaries
    bun run typecheck
    bun scripts/generate-command-reference.ts --check
    bun run actions-lint
    just p17-check
    just test-terminal

# Run one closed release-validation lane against a transferred candidate.
release-check lane:
    bun scripts/release-check.ts --lane {{lane}}

# Build the CLI to dist/skillsmith (compiled bun binary)
build:
    bun run build

# Format, then run full check pipeline
all: fmt check

# Install gitleaks (used by the pre-commit and pre-push secret scan)
install-gitleaks:
    ./scripts/install-gitleaks.sh

# Install exact checksum-verified actionlint.
install-actionlint:
    ./scripts/install-actionlint.sh

# Scan current tracked contents with both credential scanners.
secrets:
    bun scripts/secret-scan.ts files

# Scan all fetched refs, or commits in an explicit base/head range.
secrets-history base="" head="":
    if [ -n {{quote(base)}} ] || [ -n {{quote(head)}} ]; then bun scripts/secret-scan.ts history {{quote(base)}} {{quote(head)}}; else bun scripts/secret-scan.ts history; fi

# Install exact checksum-verified TruffleHog.
install-trufflehog:
    ./scripts/install-trufflehog.sh

# Install fail-closed git hook wrappers (recovery: CONTRIBUTING "Hook recovery").
install-hooks:
    ./scripts/install-hooks.sh

# Verify installed git hooks, the lefthook binary, and lefthook.yml.
verify-hooks:
    ./scripts/verify-hooks.sh
