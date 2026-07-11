# Run the default check pipeline (lint, typecheck, actions-lint, test)
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

# Run all verification: lint, boundaries, typecheck, actions-lint, P17, test
check: lint lint-boundaries typecheck actions-lint p17-check test

# Build the CLI to dist/skillsmith (compiled bun binary)
build:
    bun run build

# Format, then run full check pipeline
all: fmt check

# Install gitleaks (used by the pre-commit and pre-push secret scan)
install-gitleaks:
    ./scripts/install-gitleaks.sh
