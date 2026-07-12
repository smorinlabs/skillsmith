import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const hostScript = resolve(root, 'scripts/p17-sandbox.sh');
const guestScript = resolve(root, 'scripts/p17-guest-bootstrap.sh');
const guide = resolve(root, 'docs/p17-sandbox.md');
const packageCheck = resolve(root, 'scripts/check-p17-package.ts');

function runHost(...args: string[]) {
  return Bun.spawnSync(['bash', hostScript, ...args], {
    cwd: root,
    env: { ...process.env, PATH: '/usr/bin:/bin', P17_DRY_RUN: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('P17 Lima sandbox scripts', () => {
  test('host help exposes the compact lifecycle', () => {
    const result = runHost('help');
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    for (const command of [
      'setup',
      'manual',
      'shell',
      'install',
      'check',
      'goal',
      'remote',
      'remote-test',
      'stop',
      'destroy',
    ]) {
      expect(output).toContain(command);
    }
    expect(output).toContain('[MAC]');
    expect(output).toContain('[GUEST]');
    expect(output).toContain('does not clone or install Skillsmith');
  });

  test('manual prints every manual boundary and performs no action', () => {
    const result = runHost('manual');
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    const output = result.stdout.toString();
    for (const marker of [
      '[MAC]',
      '[GUEST]',
      './scripts/p17-sandbox.sh shell',
      'codex login --device-auth',
      'gh auth login --hostname github.com --git-protocol https --web',
      'sudo -iu skillsmith-test claude auth login',
      'Kilo Code and OpenCode remain installed but unauthenticated',
      'exit',
      './scripts/p17-sandbox.sh install',
      './scripts/p17-sandbox.sh check',
      './scripts/p17-sandbox.sh goal',
      './scripts/p17-sandbox.sh remote',
    ]) {
      expect(output).toContain(marker);
    }
    expect(output).toContain('This command only prints instructions');
    expect(output).not.toContain('+ limactl');
  });

  test('setup dry-run creates one minimal isolated VM and provisions only the guest toolchain', () => {
    const result = runHost('setup');
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('--vm-type=vz');
    expect(output).toContain('--arch=aarch64');
    expect(output).toContain('--cpus=8');
    expect(output).toContain('--memory=12');
    expect(output).toContain('--disk=20');
    expect(output).toContain('--mount-none');
    expect(output).toContain('--containerd=none');
    expect(output).toContain('--port-forward=1455:1455,static=true');
    expect(output).toContain('bash -s -- provision <');
    expect(output).toContain('Skillsmith is not installed yet');
    expect(output).not.toContain('limactl clone');
  });

  test('install dry-run is a separate authenticated repository step', () => {
    const result = runHost('install');
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('bash -s -- install <');
    expect(output).toContain('GitHub authentication');
    expect(output).toContain('Skillsmith installation complete');
  });

  test('goal dry-run uses the operator Codex home and explicit unrestricted mode', () => {
    const result = runHost('goal');
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('CODEX_HOME="$HOME/.codex-operator"');
    expect(output).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(output).toContain('--search');
    expect(output).toContain('projects/P17-GOAL.md');
  });

  test('remote dry-run prints desktop SSH setup without exposing an app-server port', () => {
    const result = runHost('remote');
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    const output = result.stdout.toString();
    expect(output).toContain('Include ~/.lima/skillsmith-p17/ssh.config');
    expect(output).toContain('lima-skillsmith-p17');
    expect(output).toContain('/work/skillsmith');
    expect(output).toContain('projects/P17-GOAL.md');
    expect(output).toContain('goal subcommand for this task');
    expect(output).not.toContain('--listen');
  });

  test('remote-test preflights the guest and prints an interactive read-only desktop test', () => {
    const result = runHost('remote-test');
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    const output = result.stdout.toString();
    expect(output).toContain('bash -lc');
    expect(output).toContain('codex login status');
    expect(output).toContain('Include ~/.lima/skillsmith-p17/ssh.config');
    expect(output).toContain('SSH host: lima-skillsmith-p17');
    expect(output).toContain('Project:  /work/skillsmith');
    expect(output).toContain('Do not modify files');
    expect(output).toContain('REMOTE_INTERACTION_OK');
    expect(output).toContain('fully interactive');
    expect(output).toContain('does not launch a separate terminal Codex TUI');
    expect(output).not.toContain('remote-control start');
    expect(output).not.toContain('app-server --listen');
  });

  test('VM driver fallback is explicit and overrideable', () => {
    const result = Bun.spawnSync(['bash', hostScript, 'setup'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        P17_DRY_RUN: '1',
        P17_VM_TYPE: 'qemu',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('--vm-type=qemu');
  });

  test('guest bootstrap separates provisioning from the authenticated Skillsmith install', () => {
    const hostSource = readFileSync(hostScript, 'utf8');
    const source = readFileSync(guestScript, 'utf8');
    for (const packageName of [
      '@openai/codex',
      '@anthropic-ai/claude-code',
      '@kilocode/cli',
      'opencode-ai',
    ]) {
      expect(source).toContain(packageName);
    }
    expect(source).toContain('skillsmith-test');
    expect(source).toContain('git clone');
    expect(source).toContain('gh auth status');
    expect(source).toContain('gh auth setup-git');
    expect(source).toContain('bun install --frozen-lockfile');
    expect(source).toContain('bun run build:linux-arm64');
    expect(source).toContain('$OPERATOR_HOME/.bashrc');
    expect(source).toContain('fetch origin main');
    expect(source).toContain("grep -qi 'ChatGPT'");
    expect(source).not.toContain("check_item 'test Kilo subscription'");
    expect(hostSource).toContain('limactl stop --force');
    expect(source).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|KILO_API_KEY/);
  });

  test('P17 live package checks support the Ubuntu GitHub CLI without --slurp', () => {
    const source = readFileSync(packageCheck, 'utf8');
    expect(source).toContain('function jsonItems');
    expect(source).toContain("'--jq'");
    expect(source).toContain("'.[]'");
    expect(source).not.toContain("'--slurp'");
  });

  test('guest provision dry-run display is an exact streamed-script command', () => {
    const result = runHost('setup');
    const guestLine = result.stdout
      .toString()
      .split('\n')
      .find((line) => line.includes('bash -s -- provision'));
    expect(guestLine).toBe(
      `+ limactl shell skillsmith-p17 -- bash -s -- provision < ${guestScript}`,
    );
  });

  test('guide records the ordered host and guest workflow including manual GitHub auth', () => {
    const source = readFileSync(guide, 'utf8');
    const orderedMarkers = [
      './scripts/p17-sandbox.sh setup',
      './scripts/p17-sandbox.sh shell',
      'gh auth login --hostname github.com --git-protocol https --web',
      './scripts/p17-sandbox.sh install',
      './scripts/p17-sandbox.sh check',
      './scripts/p17-sandbox.sh goal',
      './scripts/p17-sandbox.sh remote',
    ];
    let previous = -1;
    for (const marker of orderedMarkers) {
      const current = source.indexOf(marker, previous + 1);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    expect(source).toContain('Run every `./scripts/p17-sandbox.sh ...` command on the **Mac**');
    expect(source).toContain('It does **not** authenticate any account');
    expect(source).toContain('It does **not** clone or install Skillsmith');
    expect(source).toContain('**GUEST — operator user**');
  });

  test('both scripts are valid Bash', () => {
    for (const script of [hostScript, guestScript]) {
      const result = Bun.spawnSync(['bash', '-n', script], { cwd: root, stderr: 'pipe' });
      expect(result.exitCode).toBe(0);
    }
  });

  test('unknown lifecycle commands fail with usage status', () => {
    const result = runHost('not-a-command');
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('Unknown command');
  });
});
