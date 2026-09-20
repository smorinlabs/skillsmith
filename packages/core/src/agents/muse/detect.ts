import { createBinaryDetect } from '../detect-factory.ts';

// Suppress the launcher's hourly self-update check during version probes so
// detection stays offline, fast, and side-effect free.
export const detect = createBinaryDetect('muse', 'muse', { MUSE_NO_AUTO_UPDATE: '1' });
