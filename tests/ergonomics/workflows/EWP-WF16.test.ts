import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type HelpFixture,
  createHelpFixture,
  destroyHelpFixture,
  runHelpFixtureCli,
} from '../fixtures/p6-help/fleet.ts';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
let fixture: HelpFixture | undefined;

afterEach(async () => {
  if (fixture !== undefined) await destroyHelpFixture(fixture);
  fixture = undefined;
});

describe('EWP-WF16', () => {
  test('documentation-driven help is hermetic, current, and cleanup-safe', async () => {
    fixture = await createHelpFixture();
    const [rootHelp, workflows, version, reference, architecture, adr] = await Promise.all([
      runHelpFixtureCli(fixture, ['--help']),
      runHelpFixtureCli(fixture, ['help', 'workflows']),
      runHelpFixtureCli(fixture, ['version']),
      readFile(resolve(ROOT, 'docs/commands.md'), 'utf8'),
      readFile(resolve(ROOT, 'docs/architecture.md'), 'utf8'),
      readFile(resolve(ROOT, 'docs/adr/0004-command-runtime-application-boundary.md'), 'utf8'),
    ]);

    expect(rootHelp).toMatchObject({ code: 0, stderr: '' });
    expect(workflows).toMatchObject({ code: 0, stderr: '' });
    expect(version).toMatchObject({ code: 0, stderr: '' });
    expect(rootHelp.stdout).toContain('DEVELOP');
    expect(workflows.stdout).toContain('skillsmith dev');
    expect(reference).not.toContain('mapping placeholder');
    expect(reference).toContain('SkillSmith command reference');
    expect(`${architecture}\n${adr}`).not.toMatch(/G6[^\n]*(?:defer|future)/iu);
    expect(await Bun.file(fixture.root).exists()).toBeTrue();
  });
});
