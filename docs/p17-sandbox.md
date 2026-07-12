# P17 isolated execution environment

Use one disposable Lima VM as the outer filesystem boundary for the P17 persistent Codex goal.
The VM has no host filesystem mounts. Codex runs unrestricted inside it, while Skillsmith's live
user-level tests run against a separate guest user.

## Read this first: where every command runs

Run every `./scripts/p17-sandbox.sh ...` command on the **Mac**, from the Skillsmith checkout.
Only the commands explicitly labeled **GUEST** run after `shell` opens Ubuntu. Type `exit` to return
to the Mac before continuing with `install`, `check`, `goal`, or `remote`.

| Step | Run where | Action | What it accomplishes |
|------|-----------|--------|----------------------|
| 1 | Mac | `./scripts/p17-sandbox.sh setup` | Creates the VM and installs system tools plus all four agent CLIs. It does **not** clone or install Skillsmith. |
| Optional | Mac | `./scripts/p17-sandbox.sh manual` | Prints the complete remaining Mac/guest command sequence. It executes nothing and changes nothing. |
| 2 | Mac | `./scripts/p17-sandbox.sh shell` | Opens an interactive shell inside the guest. |
| 3 | Guest | Run the manual login commands below | Authenticates Codex, GitHub, and Claude inside the VM. Kilo and OpenCode remain unauthenticated. |
| 4 | Guest | `exit` | Returns to the Mac. |
| 5 | Mac | `./scripts/p17-sandbox.sh install` | Uses the guest GitHub login to clone the private repository, install dependencies and Gitleaks, build Skillsmith, and install its binary. |
| 6 | Mac | `./scripts/p17-sandbox.sh check` | Runs the complete isolation, authentication, installation, repository, and P17 preflight. |
| 7A | Mac | `./scripts/p17-sandbox.sh goal` | Starts the terminal Codex session. |
| 7B | Mac | `./scripts/p17-sandbox.sh remote` | Prints the SSH configuration and prompt for starting the task from the ChatGPT desktop app instead. |

Choose either 7A or 7B for the canonical P17 task. Do not start both: they create separate Codex
sessions.

At any point, print the complete manual authentication and handoff sequence without starting the VM
or changing files:

```bash
./scripts/p17-sandbox.sh manual
```

## What the two scripts own

- [`scripts/p17-sandbox.sh`](../scripts/p17-sandbox.sh) runs on macOS and owns the VM lifecycle and
  the clearly separated `setup`, read-only `manual`, `install`, `check`, terminal, and
  remote-desktop steps.
- [`scripts/p17-guest-bootstrap.sh`](../scripts/p17-guest-bootstrap.sh) is streamed into Ubuntu. Its
  `provision` mode installs tools without credentials or repository access; its `install` mode
  requires the manually authenticated guest GitHub account.
- Authentication is deliberately manual. Neither script accepts or stores API keys.

The default VM is ARM64 Ubuntu 24.04 on Lima VZ with 8 CPUs, 12 GiB RAM, a 20 GiB virtual disk,
no containerd, no host mounts, and host-to-guest TCP port 1455 forwarding for Kilo OAuth. Override
individual values with the environment variables shown by `scripts/p17-sandbox.sh help`.

VZ is the fast default on Apple Silicon. If the calling environment cannot access Apple's
Virtualization.framework, remove the incomplete VM and explicitly select QEMU:

**MAC — Skillsmith checkout**

```bash
./scripts/p17-sandbox.sh destroy --yes
P17_VM_TYPE=qemu ./scripts/p17-sandbox.sh setup
```

Do not silently fall back: an explicit override keeps the performance and isolation choice visible.

## 1. Create and provision the VM

**MAC — Skillsmith checkout**

```bash
./scripts/p17-sandbox.sh setup
```

`setup` creates or starts the VM and installs:

- Ubuntu build and repository utilities;
- Node.js 22 and Bun;
- Codex, Claude Code, Kilo Code, and OpenCode;
- GitHub CLI and Actionlint;
- the isolated `skillsmith-test` guest user; and
- the operator's unrestricted guest-only Codex configuration.

It does **not** authenticate any account, clone the private Skillsmith repository, install repository
dependencies, install Gitleaks, build Skillsmith, or install the Skillsmith binary. Those actions
happen only after the manual authentication boundary.

The operator uses `$HOME/.codex-operator`. Live Skillsmith tests use `skillsmith-test` and its real
user-level agent directories. This prevents ordinary install/apply/uninstall tests from rewriting
the Codex configuration orchestrating P17.

## 2. Open the guest and authenticate manually

**MAC — Skillsmith checkout**

```bash
./scripts/p17-sandbox.sh shell
```

The prompt now belongs to the Ubuntu **guest**. Run every command in the remainder of this section
inside that guest.

### 2.1 Authenticate the operator Codex subscription

**GUEST — operator user**

```bash
codex login --device-auth
codex login status
```

The status must report ChatGPT authentication rather than an API key.

### 2.2 Authenticate GitHub manually

This step is required before the private Skillsmith repository can be cloned. It is not performed
by `setup`.

**GUEST — operator user**

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth status
gh auth setup-git
```

Complete the browser/device flow using a GitHub account with access to
`smorinlabs/skillsmith`. `gh auth status` must pass. The later host-side `install` command checks
this again and refuses to clone if the guest is not authenticated.

### 2.3 Authenticate the test user's Codex subscription

**GUEST — operator user invoking the test user**

```bash
sudo -iu skillsmith-test codex login --device-auth
sudo -iu skillsmith-test codex login status
```

### 2.4 Authenticate Claude Code

**GUEST — operator user invoking the test user**

```bash
sudo -iu skillsmith-test claude auth login
sudo -iu skillsmith-test claude auth status --text
```

Use Claude Pro or Max rather than an API key.

### 2.5 Leave Kilo Code and OpenCode unauthenticated

Do not authenticate Kilo Code or OpenCode for this run. Both CLIs remain installed so Skillsmith can
detect them and exercise their filesystem contracts, but subscription-backed live provider calls are
outside this sandbox gate.

### 2.6 Return to the Mac

**GUEST**

```bash
exit
```

Do not run `./scripts/p17-sandbox.sh install`, `check`, `goal`, or `remote` until the prompt has
returned to the Mac.

## 3. Clone, build, and install Skillsmith

**MAC — Skillsmith checkout**

```bash
./scripts/p17-sandbox.sh install
```

This separate step runs inside the VM but is launched from the Mac. It:

1. verifies the guest GitHub login;
2. configures Git to use that login;
3. clones or safely fast-forwards `/work/skillsmith`;
4. runs `bun install --frozen-lockfile`;
5. installs Gitleaks;
6. builds the Linux ARM64 Skillsmith binary; and
7. installs the binary at `/usr/local/bin/skillsmith` inside the VM.

No host repository or host agent configuration is mounted or modified.

## 4. Validate before starting P17

**MAC — Skillsmith checkout**

```bash
./scripts/p17-sandbox.sh check
```

The check fails unless all of the following are true:

- the guest has no 9p, VirtioFS, or SSHFS host mounts;
- every required CLI is installed;
- the guest checkout is clean `main` at the current `origin/main` commit;
- operator and test-user Codex logins report ChatGPT authentication;
- Claude is authenticated;
- Kilo Code and OpenCode are installed and detected; authentication is not required;
- GitHub is authenticated inside the guest;
- Skillsmith detects Claude Code, Codex, Kilo Code, and OpenCode for `skillsmith-test`;
- `bun run check` passes;
- the P17 preparation package's live final gate passes; and
- the root filesystem still has adequate space.

The final gate uses GitHub and can fail temporarily if the authenticated account's GraphQL quota is
exhausted. Rerun `check` after the quota resets; do not treat a rate-limit failure as a passing gate.

## 5A. Start P17 in the terminal

**MAC — Skillsmith checkout**

```bash
./scripts/p17-sandbox.sh goal
```

The command launches Codex inside the VM with `--dangerously-bypass-approvals-and-sandbox` and live
search from `/work/skillsmith`. Paste the one-sentence `/goal` command printed in the terminal.
Unrestricted execution removes Codex command-approval prompts; it does not remove P17's required
human phase approvals, adversarial reviews, or final sign-off.

## 5B. Start P17 from the ChatGPT desktop app

Use this instead of terminal step 5A when the task should remain accessible through Codex Remote.

**MAC — Skillsmith checkout**

```bash
./scripts/p17-sandbox.sh remote
```

The command does not expose an app-server port and does not launch another Codex session. It prints
the exact Lima SSH include, host alias, desktop-app project path, and canonical `/goal` prompt.

Add the printed line once to the Mac's `~/.ssh/config`. With the default VM name it is:

```sshconfig
Include ~/.lima/skillsmith-p17/ssh.config
```

Then confirm the connection from the Mac:

```bash
ssh lima-skillsmith-p17 'bash -lc '\''command -v codex && printf "CODEX_HOME=%s\n" "$CODEX_HOME"'\''
```

In the ChatGPT desktop app:

1. Open **Settings > Connections**.
2. Add or enable the SSH host `lima-skillsmith-p17`.
3. Choose `/work/skillsmith` as the remote project.
4. Start a task in that project.
5. Submit the `/goal` prompt printed by `remote`.

The desktop app starts the remote Codex app server through Lima's loopback SSH connection. Keep the
Mac and VM running. Pair a phone or another supported desktop with the Mac desktop app when access
from another device is needed. Files and commands still come from the VM; no host filesystem mount
is added.

## 6. Recover from the earlier unauthenticated clone failure

If an earlier `setup` ended with:

```text
fatal: could not read Username for 'https://github.com': No such device or address
```

the VM and most or all tool provisioning succeeded; only the private repository clone failed. After
updating to this version of the scripts, continue safely as follows:

**MAC — Skillsmith checkout**

```bash
./scripts/p17-sandbox.sh setup
./scripts/p17-sandbox.sh shell
```

Rerunning `setup` is idempotent and now stops before repository access. Inside the guest, complete
all manual authentication steps above, including `gh auth login`, then `exit`. Back on the Mac:

```bash
./scripts/p17-sandbox.sh install
./scripts/p17-sandbox.sh check
./scripts/p17-sandbox.sh goal   # terminal mode
# OR
./scripts/p17-sandbox.sh remote # desktop-app mode
```

## 7. Stop, resume, or discard

**MAC — Skillsmith checkout**

Stop without deleting:

```bash
./scripts/p17-sandbox.sh stop
```

Resume by running `setup`, `shell`, `install`, `check`, `goal`, or `remote`; each starts an existing
stopped VM when necessary. Permanently discard the guest and all guest credentials only with
explicit confirmation:

```bash
./scripts/p17-sandbox.sh destroy --yes
```

The VM protects host files and host agent settings. It does not prevent unrestricted Codex from
reading guest subscription credentials or performing authenticated remote GitHub operations. Use
this environment only with the trusted Skillsmith repository and preserve completed work through
normal commits and pushes.

## Current upstream references

- [Codex remote connections and SSH hosts](https://learn.chatgpt.com/docs/remote-connections)
- [Codex sandbox defaults and full-access configuration](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)
- [Codex external-sandbox security guidance](https://learn.chatgpt.com/docs/agent-approvals-security#run-codex-in-dev-containers)
- [Lima VZ driver](https://lima-vm.io/docs/config/vmtype/vz/)
- [Lima disk resizing](https://lima-vm.io/docs/config/disk/)
