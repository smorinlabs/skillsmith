#!/usr/bin/env bash
set -euo pipefail

TEST_USER="${P17_TEST_USER:-skillsmith-test}"
REPO_URL="${P17_REPO_URL:-https://github.com/smorinlabs/skillsmith.git}"
REPO_DIR="${P17_REPO_DIR:-/work/skillsmith}"
OPERATOR="$(id -un)"
OPERATOR_HOME="$HOME"
OPERATOR_CODEX_HOME="$OPERATOR_HOME/.codex-operator"
LOCAL_BIN="$OPERATOR_HOME/.local/bin"

usage() {
    cat <<'EOF'
Usage: scripts/p17-guest-bootstrap.sh MODE

Modes:
  install  Install the P17 toolchain and Skillsmith without authenticating
  check    Validate isolation, subscriptions, tools, Skillsmith, and P17 gates
EOF
}

die() {
    echo "error: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

ensure_linux_arm64() {
    [[ "$(uname -s)" == Linux ]] || die 'guest bootstrap requires Linux'
    case "$(uname -m)" in
        aarch64|arm64) ;;
        *) die "guest bootstrap requires ARM64, found $(uname -m)" ;;
    esac
}

assert_no_host_mounts() {
    local mounts
    mounts="$(findmnt -rn -t 9p,virtiofs,fuse.sshfs -o TARGET,FSTYPE 2>/dev/null || true)"
    [[ -z "$mounts" ]] || die "unexpected host filesystem mount detected: $mounts"
}

ensure_profile_line() {
    local file="$1"
    local line="$2"
    touch "$file"
    grep -qxF "$line" "$file" || printf '%s\n' "$line" >>"$file"
}

install_system_packages() {
    local installer
    installer="$(mktemp)"

    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
        build-essential ca-certificates curl git gh jq ripgrep unzip util-linux xz-utils

    curl -fsSL https://deb.nodesource.com/setup_22.x -o "$installer"
    sudo -E bash "$installer"
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

    curl -fsSL https://bun.sh/install -o "$installer"
    sudo env BUN_INSTALL=/usr/local bash "$installer"

    sudo npm install --global \
        @openai/codex \
        @anthropic-ai/claude-code \
        @kilocode/cli \
        opencode-ai
    rm -f "$installer"
}

create_test_user() {
    if ! id -u "$TEST_USER" >/dev/null 2>&1; then
        sudo useradd --create-home --shell /bin/bash "$TEST_USER"
    fi

    printf '%s ALL=(%s) NOPASSWD: ALL\n' "$OPERATOR" "$TEST_USER" |
        sudo tee "/etc/sudoers.d/$TEST_USER" >/dev/null
    sudo chmod 0440 "/etc/sudoers.d/$TEST_USER"
    sudo visudo --check --file="/etc/sudoers.d/$TEST_USER" >/dev/null
}

configure_operator_codex() {
    mkdir -p "$OPERATOR_CODEX_HOME" "$LOCAL_BIN"
    chmod 0700 "$OPERATOR_CODEX_HOME"
    ensure_profile_line "$OPERATOR_HOME/.profile" "export CODEX_HOME=\"\$HOME/.codex-operator\""
    ensure_profile_line "$OPERATOR_HOME/.profile" "export PATH=\"\$HOME/.local/bin:\$PATH\""
    ensure_profile_line "$OPERATOR_HOME/.bashrc" "export CODEX_HOME=\"\$HOME/.codex-operator\""
    ensure_profile_line "$OPERATOR_HOME/.bashrc" "export PATH=\"\$HOME/.local/bin:\$PATH\""

    if [[ ! -f "$OPERATOR_CODEX_HOME/config.toml" ]]; then
        cat >"$OPERATOR_CODEX_HOME/config.toml" <<'EOF'
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "live"

[features]
goals = true
multi_agent = true
EOF
        chmod 0600 "$OPERATOR_CODEX_HOME/config.toml"
    fi
}

install_actionlint() {
    local directory
    if command -v actionlint >/dev/null 2>&1; then
        return
    fi
    directory="$(mktemp -d)"
    curl -fsSL \
        https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash \
        -o "$directory/install-actionlint.sh"
    (
        cd "$directory"
        bash ./install-actionlint.sh
        install -m 0755 actionlint "$LOCAL_BIN/actionlint"
    )
    rm -rf "$directory"
}

install_skillsmith() {
    sudo install -d -o "$OPERATOR" -g "$(id -gn)" -m 0755 "$(dirname "$REPO_DIR")"
    if [[ ! -d "$REPO_DIR/.git" ]]; then
        git clone "$REPO_URL" "$REPO_DIR"
    elif [[ -z "$(git -C "$REPO_DIR" status --porcelain)" ]] &&
        [[ "$(git -C "$REPO_DIR" branch --show-current)" == main ]]; then
        git -C "$REPO_DIR" pull --ff-only origin main
    else
        echo "Preserving existing non-clean or non-main checkout at $REPO_DIR"
    fi

    (
        cd "$REPO_DIR"
        bun install --frozen-lockfile
        ./scripts/install-gitleaks.sh
        bun run build:linux-arm64
    )
    sudo install -m 0755 "$REPO_DIR/dist/skillsmith" /usr/local/bin/skillsmith
}

install_all() {
    ensure_linux_arm64
    assert_no_host_mounts
    install_system_packages
    create_test_user
    configure_operator_codex
    export PATH="$LOCAL_BIN:/usr/local/bin:$PATH"
    install_actionlint
    install_skillsmith
    sudo apt-get clean
    sudo npm cache clean --force >/dev/null 2>&1 || true

    cat <<EOF

P17 guest installation completed without authentication.
Repository: $REPO_DIR
Operator Codex home: $OPERATOR_CODEX_HOME
Test user: $TEST_USER

Return to the host instructions in docs/p17-sandbox.md for manual subscription login.
EOF
}

failures=0

check_item() {
    local name="$1"
    shift
    printf 'CHECK %-34s ' "$name"
    if "$@" >/tmp/p17-check.out 2>/tmp/p17-check.err; then
        echo PASS
    else
        echo FAIL
        sed 's/^/  /' /tmp/p17-check.out >&2
        sed 's/^/  /' /tmp/p17-check.err >&2
        failures=$((failures + 1))
    fi
}

check_detected_agents() {
    local output
    output="$(sudo -iu "$TEST_USER" env PATH="/usr/local/bin:/usr/bin:/bin" \
        skillsmith agents --format json)"
    jq -e '
      [.tools | to_entries[] | select((.value | length) > 0) | .key] as $found
      | (["claude-code", "codex", "kilo-code", "opencode"] - $found | length) == 0
    ' <<<"$output" >/dev/null
}

check_repository_baseline() {
    [[ -z "$(git -C "$REPO_DIR" status --porcelain)" ]] || return 1
    [[ "$(git -C "$REPO_DIR" branch --show-current)" == main ]] || return 1
    git -C "$REPO_DIR" fetch origin main
    [[ "$(git -C "$REPO_DIR" rev-parse HEAD)" == \
        "$(git -C "$REPO_DIR" rev-parse origin/main)" ]]
}

check_operator_codex_subscription() {
    local output
    output="$(env CODEX_HOME="$OPERATOR_CODEX_HOME" codex login status 2>&1)"
    grep -qi 'ChatGPT' <<<"$output"
}

check_test_codex_subscription() {
    local output
    output="$(sudo -iu "$TEST_USER" codex login status 2>&1)"
    grep -qi 'ChatGPT' <<<"$output"
}

check_kilo_subscription() {
    local test_home
    test_home="$(getent passwd "$TEST_USER" | cut -d: -f6)"

    if sudo -iu "$TEST_USER" kilo profile --json >/dev/null 2>&1; then
        return
    fi

    sudo test -f "$test_home/.local/share/kilo/auth.json" || return 1
    sudo jq -e '
      to_entries
      | any(
          (.key | ascii_downcase | test("openai|chatgpt"))
          and (.value.type == "oauth")
        )
    ' "$test_home/.local/share/kilo/auth.json" >/dev/null
}

check_all() {
    ensure_linux_arm64
    export PATH="$LOCAL_BIN:/usr/local/bin:$PATH"

    check_item 'no host filesystem mounts' assert_no_host_mounts
    for tool in bun node npm git gh jq rg actionlint gitleaks codex claude kilo opencode skillsmith; do
        check_item "tool: $tool" command -v "$tool"
    done
    check_item 'Skillsmith checkout' test -d "$REPO_DIR/.git"
    check_item 'clean synchronized main' check_repository_baseline
    check_item 'operator Codex config' \
        env CODEX_HOME="$OPERATOR_CODEX_HOME" codex --strict-config --version
    check_item 'operator Codex subscription' check_operator_codex_subscription
    check_item 'test Codex subscription' check_test_codex_subscription
    check_item 'test Claude subscription' sudo -iu "$TEST_USER" claude auth status --text
    check_item 'test Kilo subscription' check_kilo_subscription
    check_item 'operator GitHub login' gh auth status
    check_item 'all four agents detected' check_detected_agents
    check_item 'repository full gate' bash -lc "cd '$REPO_DIR' && bun run check"
    check_item 'P17 final merged-package gate' \
        bash -lc "cd '$REPO_DIR' && bun scripts/check-p17-package.ts --final"

    echo
    df -h /
    if ((failures > 0)); then
        die "$failures P17 guest checks failed"
    fi
    echo 'All required P17 guest checks passed.'
}

mode="${1:-}"
case "$mode" in
    install) install_all ;;
    check) check_all ;;
    help|-h|--help) usage ;;
    *)
        echo "Unknown or missing mode: ${mode:-<none>}" >&2
        usage >&2
        exit 2
        ;;
esac
