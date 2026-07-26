import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VERSION, runHelpApplication } from '@skillsmith/core';
import rootPackage from '../../../../package.json' with { type: 'json' };
import corePackage from '../../../core/package.json' with { type: 'json' };
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import cliPackage from '../../package.json' with { type: 'json' };
import { HELP_TOPIC_NAMES, renderTopic } from '../../src/help/topics.ts';
import { buildProgram } from '../../src/program.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const readRepo = (path: string): Promise<string> => readFile(resolve(ROOT, path), 'utf8');

interface PlannedWorkflow {
  readonly label: string;
  readonly invocation: string;
}

interface PlannedHelpSpec {
  readonly path: string;
  readonly primaryQuestion: string;
  readonly minimalInvocations?: readonly string[];
  readonly commonWorkflows?: readonly PlannedWorkflow[];
}

const plannedSpecs = CURRENT_COMMAND_SPECS as readonly PlannedHelpSpec[];
const publicSpecs = (): readonly PlannedHelpSpec[] =>
  plannedSpecs.filter((spec) => spec.path.split(' ').length === 2);

const runCli = async (args: readonly string[]) => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    env: hermeticGitEnv({ CI: '1', NO_COLOR: '1' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

describe('EWP-CMD-HELP-TS01', () => {
  test('root help and workflows use the exact five groups and one canonical command row', () => {
    const rootHelp = buildProgram().helpInformation();
    const workflows = renderTopic('workflows');
    expect(workflows.ok).toBeTrue();
    if (!workflows.ok) throw new Error('workflows topic is missing');

    for (const output of [rootHelp, workflows.value]) {
      const indexes = ['DISCOVER', 'MANAGE', 'DEVELOP', 'DECLARATIVE', 'MAINTAIN'].map((heading) =>
        output.indexOf(heading),
      );
      expect(
        indexes.every((index) => index >= 0),
        output,
      ).toBeTrue();
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
      for (const spec of publicSpecs()) {
        const name = spec.path.slice('skillsmith '.length);
        expect(output.match(new RegExp(`\\b${name}\\b`, 'gu'))?.length ?? 0, name).toBe(1);
      }
    }
    expect(rootHelp).toMatch(/dev[^\n]*demote/u);
    expect(rootHelp).toMatch(/uninstall[^\n]*(?:rm|remove)/u);
  });
});

describe('EWP-CMD-HELP-TS02', () => {
  test('significant command help is progressive, complete, and truthful', () => {
    const program = buildProgram();
    for (const name of ['install', 'undo', 'sync', 'apply']) {
      const help = program.commands.find((command) => command.name() === name)?.helpInformation();
      expect(help, name).toBeDefined();
      if (help === undefined) continue;
      const headings = [
        'PRIMARY QUESTION',
        'USAGE',
        'COMMON WORKFLOWS',
        'TARGETS AND SCOPE',
        'SOURCE, DESTINATION, AND ARTIFACTS',
        'BEHAVIOR AND VERIFICATION',
        'SAFETY AND APPROVAL',
        'AUTOMATION AND OUTPUT',
        'INHERITED GLOBALS',
        'EXIT CODES',
      ];
      const present = headings
        .map((heading) => help.indexOf(heading))
        .filter((index) => index >= 0);
      expect(present.length, name).toBeGreaterThanOrEqual(7);
      expect(present, name).toEqual([...present].sort((left, right) => left - right));
    }
  });
});

describe('EWP-CMD-HELP-TS03', () => {
  test('canonical and compatibility help topics are current and reachable', () => {
    const canonical = [
      'workflows',
      'manifest',
      'lock',
      'plan',
      'source',
      'environment',
      'scope',
      'exit-codes',
      'formatting',
    ] as const;
    expect(HELP_TOPIC_NAMES as readonly string[]).toEqual(canonical);
    for (const name of [...canonical, 'sources', 'scopes']) {
      const result = renderTopic(name);
      expect(result.ok, name).toBeTrue();
      if (result.ok) expect(result.value.length, name).toBeGreaterThan(40);
    }
    const manifest = renderTopic('manifest');
    if (manifest.ok) {
      expect(manifest.value).not.toContain('No current command writes or applies');
      expect(manifest.value).toContain('skillsmith.lock');
    }
  });
});

describe('EWP-CMD-HELP-TS04', () => {
  test('near misses suggest a known name but never autocorrect or execute it', async () => {
    const outcome = await runHelpApplication(
      {
        arguments: ['instlal'],
        options: { knownHelpNames: ['install', 'manifest', 'source'] },
      },
      {} as never,
    );
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.mutation.changed).toBe(0);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(
      "Did you mean 'install'?",
    );
    expect(outcome.report.request.arguments).toEqual(['instlal']);
  });
});

describe('EWP-CMD-HELP-TS05', () => {
  test('all 23 commands declare bounded minimal invocations and runnable workflows', () => {
    expect(publicSpecs()).toHaveLength(23);
    for (const spec of publicSpecs()) {
      expect(spec.minimalInvocations?.length ?? 0, spec.path).toBeGreaterThanOrEqual(1);
      expect(spec.commonWorkflows?.length ?? 0, spec.path).toBeGreaterThanOrEqual(2);
      expect(spec.commonWorkflows?.length ?? 0, spec.path).toBeLessThanOrEqual(3);
      for (const invocation of spec.minimalInvocations ?? []) {
        expect(invocation.startsWith(`${spec.path}`), invocation).toBeTrue();
      }
    }
  });
});

describe('EWP-CMD-HELP-TS06', () => {
  test('active help/docs contain no stale or expanded public surface', async () => {
    const [reference, readme] = await Promise.all([
      readRepo('docs/commands.md'),
      readRepo('README.md'),
    ]);
    const active = `${buildProgram().helpInformation()}\n${reference}\n${readme}`;
    expect(active).not.toMatch(/mapping placeholder|Phase [0-5] will|four groups|help-all/iu);
    expect(active).not.toMatch(/docs\/superpowers|projects\/p17|research\/commands/iu);
    for (const invented of ['add', 'link', 'show', 'outdated', 'diff', 'recover', 'search']) {
      expect(buildProgram().commands.some((command) => command.name() === invented)).toBeFalse();
    }
  });
});

describe('EWP-CMD-HELP-TS07', () => {
  test('version command, global flag, and package metadata agree', async () => {
    expect(rootPackage.version).toBe(cliPackage.version);
    expect(rootPackage.version).toBe(corePackage.version);
    expect(rootPackage.version).toBe(VERSION);
    const [command, flag] = await Promise.all([runCli(['version']), runCli(['-V'])]);
    expect(command).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
    expect(flag).toEqual(command);
    expect(await readRepo('docs/commands.md')).toContain(`Current version: \`${VERSION}\``);
  });
});
