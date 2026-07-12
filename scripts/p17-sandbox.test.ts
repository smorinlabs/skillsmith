import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const hostScript = resolve(root, 'scripts/p17-sandbox.sh');
const guestScript = resolve(root, 'scripts/p17-guest-bootstrap.sh');

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
    for (const command of ['setup', 'shell', 'check', 'goal', 'stop', 'destroy']) {
      expect(output).toContain(command);
    }
  });

  test('setup dry-run creates one minimal isolated VM and streams guest installation', () => {
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
    expect(output).toContain('p17-guest-bootstrap.sh install');
    expect(output).not.toContain('limactl clone');
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

  test('guest bootstrap installs the four agents and Skillsmith without embedding auth', () => {
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
    expect(source).toContain('bun install --frozen-lockfile');
    expect(source).toContain('bun run build:linux-arm64');
    expect(source).toContain("grep -qi 'ChatGPT'");
    expect(source).toContain('.value.type == "oauth"');
    expect(source).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|KILO_API_KEY/);
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
