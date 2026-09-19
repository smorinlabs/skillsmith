import { describe, expect, test } from 'bun:test';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../../src/place/paths.ts';

const paths = () => ({
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
});

describe('resolveDataDir', () => {
  test('prefers SKILLSMITH_HOME when set', () => {
    expect(resolveDataDir(paths(), { skillsmithHome: '/custom/data' })).toBe('/custom/data');
  });

  test('falls back to env.xdg.data/skillsmith when unset', () => {
    expect(resolveDataDir(paths(), { skillsmithHome: undefined })).toBe(
      '/h/.local/share/skillsmith',
    );
  });
});

describe('storeRootOf', () => {
  test('joins "store" onto the data dir', () => {
    expect(storeRootOf('/data')).toBe('/data/store');
  });
});

describe('ledgerPathOf', () => {
  test('joins "placements.json" onto the data dir', () => {
    expect(ledgerPathOf('/data')).toBe('/data/placements.json');
  });
});
