#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUEST_SCRIPT="$ROOT_DIR/scripts/p17-guest-bootstrap.sh"

VM_NAME="${P17_VM_NAME:-skillsmith-p17}"
VM_TYPE="${P17_VM_TYPE:-vz}"
VM_CPUS="${P17_VM_CPUS:-8}"
VM_MEMORY_GIB="${P17_VM_MEMORY_GIB:-12}"
VM_DISK_GIB="${P17_VM_DISK_GIB:-20}"
VM_TEMPLATE="${P17_VM_TEMPLATE:-template:ubuntu-24.04}"
OAUTH_PORT="${P17_OAUTH_PORT:-1455}"
DRY_RUN="${P17_DRY_RUN:-0}"

GOAL_PROMPT='/goal Execute P17 completely by reading and following projects/P17-GOAL.md as the canonical objective and completion contract, pausing for every human approval it requires and marking complete only after all referenced gates and final sign-off pass.'

usage() {
    cat <<'EOF'
Usage: scripts/p17-sandbox.sh COMMAND

Manage the isolated Lima environment for the P17 persistent Codex goal.

Commands:
  setup          Create/start the VM and install the guest toolchain
  shell          Open an interactive shell in the VM
  check          Run guest isolation, auth, install, and repository checks
  goal           Launch unrestricted Codex and print the canonical /goal prompt
  stop           Stop the VM without deleting it
  destroy --yes  Permanently delete the disposable VM
  help           Show this help

Environment overrides:
  P17_VM_NAME, P17_VM_TYPE, P17_VM_CPUS, P17_VM_MEMORY_GIB, P17_VM_DISK_GIB,
  P17_VM_TEMPLATE, P17_OAUTH_PORT, P17_DRY_RUN
EOF
}

die() {
    echo "error: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

print_command() {
    printf '+ '
    local argument
    for argument in "$@"; do
        if [[ "$argument" =~ ^[A-Za-z0-9_./:=,+-]+$ ]]; then
            printf '%s ' "$argument"
        else
            printf '%q ' "$argument"
        fi
    done
    printf '\n'
}

run() {
    if [[ "$DRY_RUN" == 1 ]]; then
        print_command "$@"
        return
    fi
    "$@"
}

vm_exists() {
    limactl list --json 2>/dev/null |
        jq -e --arg name "$VM_NAME" 'select(.name == $name)' >/dev/null
}

vm_status() {
    limactl list --json 2>/dev/null |
        jq -r --arg name "$VM_NAME" 'select(.name == $name) | .status'
}

start_existing_vm() {
    local status
    status="$(vm_status)"
    case "$status" in
        Running) ;;
        Stopped) run limactl start "$VM_NAME" ;;
        *) die "Lima VM $VM_NAME is not usable (status: ${status:-unknown})" ;;
    esac
}

require_vm() {
    require_command limactl
    require_command jq
    vm_exists || die "Lima VM $VM_NAME does not exist; run setup first"
    start_existing_vm
}

run_guest_script() {
    local mode="$1"
    if [[ "$DRY_RUN" == 1 ]]; then
        printf '+ limactl shell %q -- bash -s -- %q < %s %s\n' \
            "$VM_NAME" "$mode" "$GUEST_SCRIPT" "$mode"
        return
    fi
    limactl shell "$VM_NAME" -- bash -s -- "$mode" <"$GUEST_SCRIPT"
}

setup() {
    [[ -f "$GUEST_SCRIPT" ]] || die "guest bootstrap script not found: $GUEST_SCRIPT"

    if [[ "$DRY_RUN" == 1 ]]; then
        run limactl start \
            --name="$VM_NAME" \
            --vm-type="$VM_TYPE" \
            --arch=aarch64 \
            --cpus="$VM_CPUS" \
            --memory="$VM_MEMORY_GIB" \
            --disk="$VM_DISK_GIB" \
            --mount-none \
            --containerd=none \
            --port-forward="$OAUTH_PORT:$OAUTH_PORT,static=true" \
            "$VM_TEMPLATE"
    else
        require_command limactl
        require_command jq
    fi

    if [[ "$DRY_RUN" == 1 ]]; then
        :
    elif vm_exists; then
        start_existing_vm
    else
        if command -v lsof >/dev/null 2>&1 &&
            lsof -nP -iTCP:"$OAUTH_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
            die "host TCP port $OAUTH_PORT is already in use"
        fi
        run limactl start \
            --name="$VM_NAME" \
            --vm-type="$VM_TYPE" \
            --arch=aarch64 \
            --cpus="$VM_CPUS" \
            --memory="$VM_MEMORY_GIB" \
            --disk="$VM_DISK_GIB" \
            --mount-none \
            --containerd=none \
            --port-forward="$OAUTH_PORT:$OAUTH_PORT,static=true" \
            "$VM_TEMPLATE"
    fi

    run_guest_script install
    run limactl protect "$VM_NAME"

    cat <<EOF

Guest installation complete. Authentication remains manual:
  $ROOT_DIR/scripts/p17-sandbox.sh shell

Follow docs/p17-sandbox.md, then run:
  $ROOT_DIR/scripts/p17-sandbox.sh check
  $ROOT_DIR/scripts/p17-sandbox.sh goal
EOF
}

open_shell() {
    if [[ "$DRY_RUN" == 1 ]]; then
        run limactl shell "$VM_NAME"
        return
    fi
    require_vm
    exec limactl shell "$VM_NAME"
}

check_guest() {
    if [[ "$DRY_RUN" == 1 ]]; then
        run_guest_script check
        return
    fi
    require_vm
    run_guest_script check
}

launch_goal() {
    local guest_command
    guest_command=$(cat <<EOF
export CODEX_HOME="\$HOME/.codex-operator"
cd /work/skillsmith
printf '%s\n\n' 'Paste this command into Codex:' '$GOAL_PROMPT'
exec codex --dangerously-bypass-approvals-and-sandbox --search -C /work/skillsmith
EOF
)

    if [[ "$DRY_RUN" == 1 ]]; then
        printf '+ limactl shell %q -- bash -lc %s\n' "$VM_NAME" "$guest_command"
        return
    fi
    require_vm
    exec limactl shell "$VM_NAME" -- bash -lc "$guest_command"
}

stop_vm() {
    if [[ "$DRY_RUN" == 1 ]]; then
        run limactl stop "$VM_NAME"
        return
    fi
    require_command limactl
    if vm_exists && [[ "$(vm_status)" == Running ]]; then
        run limactl stop "$VM_NAME"
    fi
}

destroy_vm() {
    [[ "${1:-}" == --yes ]] || die "destroy requires --yes"
    if [[ "$DRY_RUN" == 1 ]]; then
        run limactl stop "$VM_NAME"
        run limactl unprotect "$VM_NAME"
        run limactl delete "$VM_NAME"
        return
    fi
    require_command limactl
    vm_exists || die "Lima VM $VM_NAME does not exist"
    if [[ "$(vm_status)" == Running ]]; then
        run limactl stop "$VM_NAME"
    fi
    run limactl unprotect "$VM_NAME"
    run limactl delete "$VM_NAME"
}

command_name="${1:-help}"
shift || true

case "$command_name" in
    setup) setup ;;
    shell) open_shell ;;
    check) check_guest ;;
    goal) launch_goal ;;
    stop) stop_vm ;;
    destroy) destroy_vm "$@" ;;
    help|-h|--help) usage ;;
    *)
        echo "Unknown command: $command_name" >&2
        usage >&2
        exit 2
        ;;
esac
