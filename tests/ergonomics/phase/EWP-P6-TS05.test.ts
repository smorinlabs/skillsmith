import { describe, expect, test } from 'bun:test';
import { CURRENT_COMMAND_SPECS } from '../../../packages/cli/src/spec/index.ts';

const EXPECTED = [
  [
    'discover',
    'agents',
    'Which coding tools are detected and what can Skillsmith do with them?',
    'skillsmith agents',
  ],
  ['discover', 'list', 'Which skills are installed?', 'skillsmith list'],
  ['discover', 'commands', 'Which slash commands are installed?', 'skillsmith commands'],
  [
    'discover',
    'status',
    'How do desired, locked, ledger, and live states relate?',
    'skillsmith status',
  ],
  [
    'manage',
    'install',
    'How do I acquire and persist a remote skill?',
    'skillsmith install <source>',
  ],
  [
    'manage',
    'uninstall',
    'How do I remove a skill and its desired-state declaration?',
    'skillsmith uninstall <skill>',
  ],
  [
    'manage',
    'update',
    'How do I check or apply source revision changes?',
    'skillsmith update --check',
  ],
  [
    'manage',
    'undo',
    'How do I abort or reverse a selected retained operation?',
    'skillsmith undo <skill>',
  ],
  [
    'develop',
    'dev',
    'How do I use a local checkout as the live development source?',
    'skillsmith dev <skill> --source <path>',
  ],
  [
    'develop',
    'verify',
    'Is this skill or plugin valid for the selected tools?',
    'skillsmith verify <path>',
  ],
  [
    'develop',
    'promote',
    'How do I snapshot a development placement into managed state?',
    'skillsmith promote <skill>',
  ],
  ['declarative', 'init', 'How do I create or migrate the desired-state file?', 'skillsmith init'],
  [
    'declarative',
    'export',
    'How do I capture the current fleet as portable desired state?',
    'skillsmith export',
  ],
  ['declarative', 'plan', 'What would convergence change?', 'skillsmith plan'],
  ['declarative', 'apply', 'How do I execute the reviewed convergence plan?', 'skillsmith apply'],
  [
    'declarative',
    'sync',
    'How do I reconcile one live location into another?',
    'skillsmith sync --from <A> --to <B>',
  ],
  [
    'maintain',
    'doctor',
    'What is unhealthy and what deterministic repair is available?',
    'skillsmith doctor',
  ],
  ['maintain', 'check', 'Are blocking machine/project health checks passing?', 'skillsmith check'],
  ['maintain', 'gc', 'Which unreachable local store objects can be reclaimed?', 'skillsmith gc'],
  [
    'maintain',
    'config',
    'What defaults are active and how do I change them?',
    'skillsmith config list',
  ],
  ['maintain', 'completion', 'How do I emit completion for a shell?', 'skillsmith completion zsh'],
  ['maintain', 'version', 'Which Skillsmith version is running?', 'skillsmith version'],
  [
    'maintain',
    'help',
    'How do I learn a command, topic, or workflow?',
    'skillsmith help workflows',
  ],
] as const;

interface PlannedSpec {
  readonly path: string;
  readonly group: string;
  readonly primaryQuestion: string;
  readonly minimalInvocations?: readonly string[];
  readonly commonWorkflows?: readonly unknown[];
}

describe('EWP-P6-TS05', () => {
  test('the exact 23-row complexity matrix is registry-owned', () => {
    const specs = (CURRENT_COMMAND_SPECS as readonly PlannedSpec[])
      .filter((spec) => spec.path.split(' ').length === 2)
      .toSorted(
        (left, right) =>
          (left as PlannedSpec & { readonly helpOrder: number }).helpOrder -
          (right as PlannedSpec & { readonly helpOrder: number }).helpOrder,
      );
    const actual = specs.map((spec) => [
      spec.group,
      spec.path.slice('skillsmith '.length),
      spec.primaryQuestion,
      spec.minimalInvocations?.[0],
    ]);
    expect(actual).toEqual(EXPECTED);
    expect(new Set(specs.map((spec) => spec.primaryQuestion)).size).toBe(23);
    expect(specs.every((spec) => (spec.commonWorkflows?.length ?? 0) >= 2)).toBeTrue();
  });
});
