# P17 isolated execution environment

Use one disposable Lima VM as the outer security boundary for the P17 persistent Codex goal. The
VM has no host filesystem mounts. Codex runs unrestricted inside it, while Skillsmith's live
user-level tests run against a separate guest user.

## What the two scripts own

- [`scripts/p17-sandbox.sh`](../scripts/p17-sandbox.sh) runs on macOS and owns the VM lifecycle.
- [`scripts/p17-guest-bootstrap.sh`](../scripts/p17-guest-bootstrap.sh) runs inside Ubuntu and owns
  idempotent installation and validation.
- Authentication is deliberately manual. Neither script accepts or stores API keys.

The default VM is ARM64 Ubuntu 24.04 on Lima VZ with 8 CPUs, 12 GiB RAM, a 20 GiB virtual disk,
no containerd, no host mounts, and host-to-guest TCP port 1455 forwarding for Kilo OAuth. Override
individual values with the environment variables shown by `scripts/p17-sandbox.sh help`.

VZ is the fast default on Apple Silicon. If the calling environment cannot access Apple's
Virtualization.framework, remove the incomplete VM and explicitly select QEMU:

```bash
./scripts/p17-sandbox.sh destroy --yes
P17_VM_TYPE=qemu ./scripts/p17-sandbox.sh setup
```

Do not silently fall back: an explicit override keeps the performance and isolation choice visible.

## 1. Install the VM and toolchain

From a clean, synchronized Skillsmith checkout on the Mac:

```bash
./scripts/p17-sandbox.sh setup
./scripts/p17-sandbox.sh shell
```

`setup` installs Node 22, Bun, Codex, Claude Code, Kilo Code, OpenCode, GitHub CLI, Actionlint,
Gitleaks, the Skillsmith dependencies, and a compiled Linux ARM64 Skillsmith binary. The agent
binaries are shared inside the guest; authentication and configuration remain per-user.

The operator uses `$HOME/.codex-operator`. Live Skillsmith tests use `skillsmith-test` and its real
user-level agent directories. This prevents ordinary install/apply/uninstall tests from rewriting
the Codex configuration that is orchestrating P17.

## 2. Authenticate manually

Inside the guest, authenticate the operator Codex with a ChatGPT subscription:

```bash
codex login --device-auth
codex login status
```

Authenticate the test user's Codex with a ChatGPT subscription:

```bash
sudo -iu skillsmith-test codex login --device-auth
sudo -iu skillsmith-test codex login status
```

Authenticate Claude Code interactively with Claude Pro or Max:

```bash
sudo -iu skillsmith-test claude auth login
sudo -iu skillsmith-test claude auth status --text
```

Authenticate Kilo Code with a subscription, not an API key:

```bash
sudo -iu skillsmith-test kilo
```

In Kilo, use either the Kilo account/Kilo Pass sign-in or `/connect` with OpenAI ChatGPT OAuth.
The host browser callback reaches the guest through TCP port 1455. Confirm the resulting account or
OAuth credential:

```bash
sudo -iu skillsmith-test kilo profile --json
sudo -iu skillsmith-test kilo auth list
```

OpenCode login is optional unless an applicable subscription is available:

```bash
sudo -iu skillsmith-test opencode auth login
sudo -iu skillsmith-test opencode auth list
```

Authenticate GitHub for clone refreshes, final P17 verification, commits, pushes, and PR work:

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
gh auth status
```

Exit the guest after authentication:

```bash
exit
```

## 3. Validate before starting P17

```bash
./scripts/p17-sandbox.sh check
```

The check fails unless all of the following are true:

- the guest has no 9p, VirtioFS, or SSHFS host mounts;
- every required CLI is installed;
- operator and test-user Codex logins report ChatGPT authentication;
- Claude is authenticated;
- Kilo has either a Kilo account or an OpenAI/ChatGPT OAuth credential;
- Skillsmith detects Claude Code, Codex, Kilo Code, and OpenCode for `skillsmith-test`;
- `bun run check` passes;
- the P17 preparation package's live final gate passes; and
- the root filesystem still has adequate space.

The final gate uses GitHub and can fail temporarily if the authenticated account's GraphQL quota is
exhausted. Rerun `check` after the quota resets; do not treat a rate-limit failure as a passing gate.

## 4. Start the persistent Codex goal

```bash
./scripts/p17-sandbox.sh goal
```

The command launches Codex with `--dangerously-bypass-approvals-and-sandbox` and live search from
`/work/skillsmith`. Paste the one-sentence `/goal` command printed in the terminal. Unrestricted
execution removes Codex command-approval prompts; it does not remove P17's required human phase
approvals, adversarial reviews, or final sign-off.

## 5. Stop, resume, or discard

Stop without deleting:

```bash
./scripts/p17-sandbox.sh stop
```

Resume by running `setup`, `shell`, `check`, or `goal`; each starts an existing stopped VM when
needed. Permanently discard the guest and all guest credentials only with explicit confirmation:

```bash
./scripts/p17-sandbox.sh destroy --yes
```

The VM protects host files and host agent settings. It does not prevent unrestricted Codex from
reading guest subscription credentials or performing authenticated remote GitHub operations. Use
this environment only with the trusted Skillsmith repository and preserve completed work through
normal commits and pushes.

## Current upstream references

- [Codex sandbox defaults and full-access configuration](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)
- [Codex external-sandbox security guidance](https://learn.chatgpt.com/docs/agent-approvals-security#run-codex-in-dev-containers)
- [Lima VZ driver](https://lima-vm.io/docs/config/vmtype/vz/)
- [Lima disk resizing](https://lima-vm.io/docs/config/disk/)
