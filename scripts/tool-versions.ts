/**
 * True when `actual` is `minimum` or a newer release. Both must be dotted
 * numeric versions (e.g. `1.4.2`); anything else fails closed.
 */
export function isAtLeastVersion(actual: string, minimum: string): boolean {
  const parse = (version: string) =>
    /^\d+(\.\d+)*$/u.test(version) ? version.split('.').map(Number) : null;
  const have = parse(actual);
  const need = parse(minimum);
  if (have === null || need === null) return false;
  for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
