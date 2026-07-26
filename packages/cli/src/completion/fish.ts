/** Validate the pinned Fish argv dispatch and remove only the upstream reparsing comparison word. */
export const hardenFishScript = (source: string): string => {
  const invocation = 'skillsmith complete -- $args[2..-1] "$lastArg"';
  if (
    source.split('# fish completion for skillsmith').length - 1 !== 1 ||
    source.split('function __skillsmith_perform_completion\n').length - 1 !== 1 ||
    source.split(invocation).length - 1 !== 1 ||
    /\beval\s/u.test(source)
  ) {
    throw new Error('pinned Fish completion template fingerprint changed');
  }
  const hardened = source.replace(
    'no string join/eval, which would collapse multi-segment paths',
    'direct argv preserves multi-segment paths',
  );
  if (/\beval\b/u.test(hardened)) throw new Error('Fish completion contains reparsing text');
  return hardened;
};
