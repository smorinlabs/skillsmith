import type { Check } from './types.ts';

// Checks are appended by Phase F. Keep the export stable so the
// public API surface doesn't churn as individual checks land.
export const builtInChecks: readonly Check[] = [];
