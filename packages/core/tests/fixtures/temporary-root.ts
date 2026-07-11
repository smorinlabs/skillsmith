import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const buildInTemporaryRoot = async <T>(
  prefix: string,
  build: (base: string) => Promise<T>,
): Promise<T> => {
  const base = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await build(base);
  } catch (buildError) {
    try {
      await rm(base, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [buildError, cleanupError],
        `fixture construction and cleanup both failed for ${base}`,
      );
    }
    throw buildError;
  }
};
