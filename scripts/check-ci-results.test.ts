import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Step = { env?: Record<string, string>; run?: string };
type Job = {
  name?: string;
  if?: string;
  needs?: string[];
  'continue-on-error'?: boolean;
  steps: Step[];
};
const workflow = Bun.YAML.parse(
  readFileSync(resolve(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8'),
) as { jobs: Record<string, Job> };
const overall = workflow.jobs['ci-result'];
const step = overall.steps[0];
const required = step.env?.REQUIRED_JOBS.split(',') ?? [];
const successful = (): Record<string, { result?: string }> =>
  Object.fromEntries(required.map((job) => [job, { result: 'success' }]));

// Execute the actual workflow command, so changes to its fail-closed behavior
// are tested without a second implementation of the result validator.
function check(needs: unknown, event = 'pull_request') {
  return spawnSync('bash', ['-e', '-c', step.run ?? 'exit 99'], {
    env: {
      ...process.env,
      ...step.env,
      NEEDS_JSON: JSON.stringify(needs),
      EVENT_NAME: event,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('overall CI result', () => {
  test('always waits for every other CI job without hiding job failures', () => {
    const jobs = Object.keys(workflow.jobs).filter((job) => job !== 'ci-result');
    expect(overall.name).toBe('CI result');
    expect(overall.if).toBe('${{ always() }}');
    expect(overall.needs?.toSorted()).toEqual(jobs.toSorted());
    expect(required.toSorted()).toEqual(jobs.toSorted());
    expect(step.env?.NEEDS_JSON).toBe('${{ toJSON(needs) }}');
    expect(step.env?.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(overall.steps).toHaveLength(1);
    for (const job of Object.values(workflow.jobs)) {
      expect(job['continue-on-error']).toBeUndefined();
    }
    expect(workflow.jobs['lint-pr-title'].if).toBe("github.event_name == 'pull_request'");
  });

  test('accepts a complete successful PR run', () => {
    const result = check(successful());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('All required CI jobs passed');
  });

  test('accepts the deliberate PR-title skip on a main push', () => {
    const needs = successful();
    needs['lint-pr-title'].result = 'skipped';
    const result = check(needs, 'push');
    expect(result.status, result.stderr).toBe(0);
  });

  for (const job of required) {
    for (const result of ['failure', 'cancelled', 'skipped', 'unknown', '']) {
      test(`rejects ${job} with result ${JSON.stringify(result)} on a PR`, () => {
        const needs = successful();
        needs[job].result = result;
        const checked = check(needs);
        expect(checked.status).toBe(1);
        expect(checked.stderr).toContain(`${job}: expected success`);
      });
    }
    test(`rejects a missing result for ${job}`, () => {
      const needs = successful();
      needs[job] = {};
      expect(check(needs).status).toBe(1);
      delete needs[job];
      expect(check(needs).status).toBe(1);
    });
    if (job !== 'lint-pr-title') {
      test(`rejects an unexpected ${job} skip on a main push`, () => {
        const needs = successful();
        needs['lint-pr-title'].result = 'skipped';
        needs[job].result = 'skipped';
        expect(check(needs, 'push').status).toBe(1);
      });
    }
  }

  test('rejects absent, malformed, extra, or unsupported-event evidence', () => {
    for (const value of [
      null,
      [],
      {},
      'success',
      { ...successful(), foreign: { result: 'success' } },
    ]) {
      expect(check(value).status).toBe(1);
    }
    expect(check(successful(), 'workflow_dispatch').status).toBe(1);
  });
});
