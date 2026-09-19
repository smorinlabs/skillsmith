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

GOAL_PROMPT='/goal Execute P17 completely by reading and following projects/P17-GOAL.md as the canonical objective and completion contract, applying the recorded standing human approval without additional review pauses and marking complete only after all referenced gates and final sign-off pass.'
REMOTE_TEST_PROMPT='Remote connectivity test only. Do not modify files. Use read-only shell commands to report the current directory, Git branch, Codex version, and Skillsmith version, then wait for my follow-up.'

usage() {
    cat <<'EOF'
Usage: scripts/p17-sandbox.sh COMMAND

Manage the isolated Lima environment for the P17 persistent Codex goal.

Run every scripts/p17-sandbox.sh command on the Mac from the Skillsmith checkout.
Only the authentication commands documented after `shell` run inside the guest.

Commands:
  setup          [MAC] Create/start the VM and provision tools and agent CLIs
                         This does not clone or install Skillsmith.
  manual         [MAC] Print the complete manual authentication and handoff steps
                         This command only prints instructions; it changes nothing.
  shell          [MAC] Open the guest for the documented manual authentication
                         commands [GUEST]; type `exit` when authentication is done
  install        [MAC] After GitHub authentication, clone/build/install Skillsmith
  check          [MAC] Validate isolation, auth, tools, repository, and P17 gates
  goal           [MAC] Launch the terminal Codex session and print the /goal prompt
  remote         [MAC] Print desktop-app SSH setup and the same /goal prompt
  remote-test    [MAC] Verify remote prerequisites and print an interactive test
                         This does not start the P17 goal or a separate Codex TUI.
  stop           [MAC] Stop the VM without deleting it
  destroy --yes  [MAC] Permanently delete the disposable VM
  help           [MAC] Show this help

Required order:
  1. setup    [MAC]   Installs the guest toolchain and all four agent CLIs
     manual   [MAC]   Optionally prints every remaining command without running it
  2. shell    [MAC]   Then authenticate inside the guest [GUEST] and exit
  3. install  [MAC]   Clones and installs Skillsmith using the guest GitHub login
  4. check    [MAC]   Runs the complete preflight
     remote-test [MAC]   Optionally tests desktop interactivity without P17
  5. goal OR remote [MAC]   Starts terminal mode or explains desktop mode

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

print_manual() {
    cat <<'EOF'
P17 MANUAL AUTHENTICATION AND HANDOFF

This command only prints instructions. It does not start the VM, open a shell,
authenticate an account, clone a repository, or change any files.

Prerequisite [MAC] - create and provision the VM if setup has not completed:

  ./scripts/p17-sandbox.sh setup

Step 1 [MAC] - open the guest:

  ./scripts/p17-sandbox.sh shell

Steps 2-6 [GUEST] - run these after the Ubuntu prompt appears:

  # Operator Codex using a ChatGPT subscription
  codex login --device-auth
  codex login status

  # GitHub account with access to smorinlabs/skillsmith
  gh auth login --hostname github.com --git-protocol https --web
  gh auth status
  gh auth setup-git

  # Test-user Codex using a ChatGPT subscription
  sudo -iu skillsmith-test codex login --device-auth
  sudo -iu skillsmith-test codex login status

  # Test-user Claude Code using Claude Pro or Max
  sudo -iu skillsmith-test claude auth login
  sudo -iu skillsmith-test claude auth status --text

  # Kilo Code and OpenCode remain installed but unauthenticated for this run.
  # Their binaries and Skillsmith agent detection are still checked later.

Step 7 [GUEST] - return to the Mac:

  exit

Steps 8-9 [MAC] - install Skillsmith and run the complete preflight:

  ./scripts/p17-sandbox.sh install
  ./scripts/p17-sandbox.sh check

Optional remote test [MAC] - verify desktop interactivity before P17:

  ./scripts/p17-sandbox.sh remote-test

Step 10 [MAC] - choose exactly one canonical P17 session:

  ./scripts/p17-sandbox.sh goal    # terminal Codex session
  # OR
  ./scripts/p17-sandbox.sh remote  # ChatGPT desktop SSH session

The detailed explanations and expected results are in docs/p17-sandbox.md.
EOF
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
        *)
            die "Lima VM $VM_NAME is not usable (status: ${status:-unknown}); run destroy --yes"
            ;;
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
        printf '+ limactl shell %q -- bash -s -- %q < %s\n' \
            "$VM_NAME" "$mode" "$GUEST_SCRIPT"
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

    run_guest_script provision
    run limactl protect "$VM_NAME"

    cat <<EOF

SETUP COMPLETE [MAC]
Installed inside the guest: OS packages, Node.js, Bun, GitHub CLI, Codex,
Claude Code, Kilo Code, OpenCode, and Actionlint.
Skillsmith is not installed yet. Authentication has not been performed.

NEXT [MAC] - open the guest:
  $ROOT_DIR/scripts/p17-sandbox.sh shell

To print every manual authentication and handoff command first:
  $ROOT_DIR/scripts/p17-sandbox.sh manual

NEXT [GUEST] - run the manual authentication commands in docs/p17-sandbox.md,
including GitHub authentication, then type: exit

NEXT [MAC] - clone and install Skillsmith:
  $ROOT_DIR/scripts/p17-sandbox.sh install
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

install_skillsmith() {
    if [[ "$DRY_RUN" == 1 ]]; then
        run_guest_script install
    else
        require_vm
        run_guest_script install
    fi

    cat <<EOF

Skillsmith installation complete [MAC].
The repository, dependencies, Gitleaks, and compiled Skillsmith binary now live
inside the VM. GitHub authentication remains stored only in the guest.

NEXT [MAC]:
  $ROOT_DIR/scripts/p17-sandbox.sh check
EOF
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

remote_desktop() {
    local ssh_config_display
    local ssh_alias="lima-$VM_NAME"
    # This is a literal OpenSSH Include value printed for the user, not a shell path.
    # shellcheck disable=SC2088
    printf -v ssh_config_display '~/.lima/%s/ssh.config' "$VM_NAME"

    if [[ "$DRY_RUN" == 1 ]]; then
        printf '+ limactl shell %q -- test -d /work/skillsmith/.git\n' "$VM_NAME"
    else
        require_vm
        limactl shell "$VM_NAME" -- test -d /work/skillsmith/.git ||
            die "Skillsmith is not installed; run install after guest GitHub authentication"
    fi

    cat <<EOF

CODEX DESKTOP SSH SETUP [MAC]

1. Add this line once to ~/.ssh/config on the Mac:

   Include $ssh_config_display

2. Confirm the Lima SSH alias from the Mac:

   ssh $ssh_alias 'bash -lc '\''command -v codex && printf "CODEX_HOME=%s\\n" "\$CODEX_HOME"'\''

3. In the ChatGPT desktop app, open Settings > Connections, add or enable:

   SSH host: $ssh_alias
   Project:  /work/skillsmith

4. Start the P17 task in that remote project and submit:

   $GOAL_PROMPT

No Codex TCP port or host filesystem mount is required. The desktop app starts
the guest Codex app server through Lima's loopback SSH connection. Do not also
run the goal subcommand for this task; that would create a separate terminal
session.
EOF
}

remote_test() {
    local guest_command
    local ssh_config_display
    local ssh_alias="lima-$VM_NAME"
    # This is a literal OpenSSH Include value printed for the user, not a shell path.
    # shellcheck disable=SC2088
    printf -v ssh_config_display '~/.lima/%s/ssh.config' "$VM_NAME"
    guest_command=$(cat <<'EOF'
export CODEX_HOME="$HOME/.codex-operator"
cd /work/skillsmith
test -d .git
command -v codex >/dev/null
codex login status 2>&1 | grep -qi ChatGPT
printf 'Remote test prerequisites passed: cwd=%s codex=%s\n' "$PWD" "$(codex --version)"
EOF
)

    if [[ "$DRY_RUN" == 1 ]]; then
        printf '+ limactl shell %q -- bash -lc %s\n' "$VM_NAME" "$guest_command"
    else
        require_vm
        limactl shell "$VM_NAME" -- bash -lc "$guest_command"
    fi

    cat <<EOF

CODEX DESKTOP INTERACTIVE TEST [MAC]

The guest repository, Codex executable, login-shell CODEX_HOME, and ChatGPT
subscription are ready.

1. Add this line once to ~/.ssh/config on the Mac if it is not already present:

   Include $ssh_config_display

2. In the ChatGPT desktop app, open Settings > Connections and add or enable:

   SSH host: $ssh_alias
   Project:  /work/skillsmith

3. Start a new task in that remote project and submit this read-only prompt:

   $REMOTE_TEST_PROMPT

4. After Codex responds, send this follow-up in the same task:

   Reply exactly REMOTE_INTERACTION_OK and do nothing else.

Success means the first response reports /work/skillsmith from the VM and the
second response is REMOTE_INTERACTION_OK. The task is fully interactive in the
desktop app and on paired remote devices.

This mode preflights the supported SSH task path and does not launch a separate terminal Codex TUI.
The desktop app cannot attach to that TUI;
the desktop app starts the guest Codex app server when you open the remote task.
EOF
}

stop_vm() {
    if [[ "$DRY_RUN" == 1 ]]; then
        run limactl stop "$VM_NAME"
        return
    fi
    require_command limactl
    if vm_exists; then
        case "$(vm_status)" in
            Running) run limactl stop "$VM_NAME" ;;
            Broken) run limactl stop --force "$VM_NAME" ;;
            *) ;;
        esac
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
    case "$(vm_status)" in
        Running) run limactl stop "$VM_NAME" ;;
        Stopped) ;;
        *) run limactl stop --force "$VM_NAME" ;;
    esac
    run limactl unprotect "$VM_NAME"
    run limactl delete "$VM_NAME"
}

command_name="${1:-help}"
shift || true

case "$command_name" in
    setup) setup ;;
    manual) print_manual ;;
    shell) open_shell ;;
    install) install_skillsmith ;;
    check) check_guest ;;
    goal) launch_goal ;;
    remote) remote_desktop ;;
    remote-test) remote_test ;;
    stop) stop_vm ;;
    destroy) destroy_vm "$@" ;;
    help|-h|--help) usage ;;
    *)
        echo "Unknown command: $command_name" >&2
        usage >&2
        exit 2
        ;;
esac
