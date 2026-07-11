import { join } from 'node:path';

export const CLI_ENTRYPOINT = join(import.meta.dir, '..', '..', 'src', 'index.ts');
