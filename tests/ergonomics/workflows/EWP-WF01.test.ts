import { describe, expect, test } from 'bun:test';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const ALL_COMMANDS = [
  'agents',
  'doctor',
  'completion',
  'install',
  'update',
  'uninstall',
  'sync',
  'list',
  'find',
  'init',
  'plan',
  'apply',
  'dev',
  'check',
  'lock',
  'verify',
  'status',
  'outdated',
  'diff',
  'flip',
  'migrate',
  'version',
  'help',
] as const;

const loadGates = async (): Promise<Record<string, unknown>> =>
  (await import('../../../scripts/release-gates.ts')) as Record<string, unknown>;
const requirePublicValidator = async (): Promise<(input: unknown) => unknown> => {
  const gate = (await loadGates()).validatePublicWorkflowReceipts;
  expect(typeof gate, 'public WF01 receipt validator must exist').toBe('function');
  if (typeof gate !== 'function') throw new Error('validatePublicWorkflowReceipts is absent');
  return gate as (input: unknown) => unknown;
};

const publicReceipt = (runner: string, includeHomebrew: boolean) => ({
  candidateBundleSha256: DIGEST,
  channels: [...['direct', 'npm', 'bun'], ...(includeHomebrew ? ['homebrew'] : [])],
  cleanOwnedPrefix: true,
  commands: ALL_COMMANDS,
  completionZshValid: true,
  noSourceCheckoutOnPath: true,
  requiredSkips: 0,
  runner,
  sha: SHA,
  tag: 'v1.0.0',
  version: '1.0.0',
});

const validReceipts = () => [
  publicReceipt('ubuntu-24.04', false),
  publicReceipt('ubuntu-24.04-arm', false),
  publicReceipt('macos-15', true),
  publicReceipt('macos-15-intel', true),
];

describe('EWP-WF01', () => {
  test('requires exact v1.0.0 public direct, npm, and Bun installs on all four native runners', async () => {
    const validate = await requirePublicValidator();
    expect(validate({ receipts: validReceipts() })).toEqual({ receiptCount: 4, version: '1.0.0' });
    expect(() => validate({ receipts: validReceipts().slice(1) })).toThrow();
    expect(() =>
      validate({
        receipts: validReceipts().map((receipt, index) =>
          index === 0 ? { ...receipt, channels: ['direct', 'npm'] } : receipt,
        ),
      }),
    ).toThrow();
  });

  test('requires the public smorinlabs tap cask on both macOS architectures only', async () => {
    const validate = await requirePublicValidator();
    const receipts = validReceipts();
    expect(validate({ receipts })).toMatchObject({ receiptCount: 4 });
    expect(() =>
      validate({
        receipts: receipts.map((receipt) =>
          receipt.runner === 'macos-15-intel'
            ? { ...receipt, channels: receipt.channels.filter((channel) => channel !== 'homebrew') }
            : receipt,
        ),
      }),
    ).toThrow();
  });

  test('proves all 23 commands, capability orientation, aliases, and clean no-source lifecycle', async () => {
    const validate = await requirePublicValidator();
    expect(validate({ receipts: validReceipts() })).toMatchObject({ version: '1.0.0' });
    expect(() =>
      validate({
        receipts: validReceipts().map((receipt, index) =>
          index === 0 ? { ...receipt, commands: receipt.commands.slice(1) } : receipt,
        ),
      }),
    ).toThrow();
    expect(() =>
      validate({
        receipts: validReceipts().map((receipt, index) =>
          index === 0 ? { ...receipt, noSourceCheckoutOnPath: false } : receipt,
        ),
      }),
    ).toThrow();
  });

  test('rejects a skip, version/SHA drift, invalid completion, or dirty uninstall prefix', async () => {
    const validate = await requirePublicValidator();
    const mutations = [
      { requiredSkips: 1 },
      { version: '0.7.0' },
      { sha: 'c'.repeat(40) },
      { completionZshValid: false },
      { cleanOwnedPrefix: false },
    ];
    for (const mutation of mutations) {
      expect(() =>
        validate({
          receipts: validReceipts().map((receipt, index) =>
            index === 0 ? { ...receipt, ...mutation } : receipt,
          ),
        }),
      ).toThrow();
    }
  });
});
