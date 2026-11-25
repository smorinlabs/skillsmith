import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

// release-please creates refs/tags/v1.0.0 at the release-PR merge commit and then the draft
// release, so the tag push starts release.yml. Without force-tag-creation a draft release has
// no tag until it is published, and release.yml (which publishes it) never starts.
test('release-please creates the tag for its draft release', async () => {
  const config = JSON.parse(
    await readFile(resolve(ROOT, 'release-please-config.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(config.draft).toBe(true);
  expect(config['force-tag-creation']).toBe(true);
});

test('CHANGELOG.md has at most one section per version', async () => {
  const changelog = await readFile(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
  const versions = [...changelog.matchAll(/^## \[([^\]]+)\]/gmu)].map((match) => match[1]);
  expect(versions.length).toBeGreaterThan(0);
  expect(versions.filter((version, index) => versions.indexOf(version) !== index)).toEqual([]);
});
