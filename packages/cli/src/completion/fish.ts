import { createHash } from 'node:crypto';

const UPSTREAM_FISH_SHA256 = '251f84ff41359a6f058ad62d0aa2e452792b19ae8d0c731e366bfa414b04f218';

/** Validate the pinned Fish argv dispatch and remove only the upstream reparsing comparison word. */
export const hardenFishScript = (source: string): string => {
  const invocation = 'skillsmith complete -- $args[2..-1] "$lastArg"';
  if (
    createHash('sha256').update(source).digest('hex') !== UPSTREAM_FISH_SHA256 ||
    source.split('# fish completion for skillsmith').length - 1 !== 1 ||
    source.split('function __skillsmith_perform_completion\n').length - 1 !== 1 ||
    source.split(invocation).length - 1 !== 1 ||
    /\beval\s/u.test(source)
  ) {
    throw new Error('pinned Fish completion template fingerprint changed');
  }
  const debugHandler = [
    'function __skillsmith_debug',
    '    set -l file "$BASH_COMP_DEBUG_FILE"',
    '    if test -n "$file"',
    '        echo "$argv" >> $file',
    '    end',
    'end',
  ].join('\n');
  const sourceTimeProbe = [
    '# Since Fish completions are only loaded once the user triggers them, we trigger them ourselves',
    '# so we can properly delete any completions provided by another script.',
    '# Only do this if the program can be found, or else fish may print some errors; besides,',
    '# the existing completions will only be loaded if the program can be found.',
    'if type -q "skillsmith"',
    '    # The space after the program name is essential to trigger completion for the program',
    '    # and not completion of the program name itself.',
    "    # Also, we use '> /dev/null 2>&1' since '&>' is not supported in older versions of fish.",
    '    complete --do-complete "skillsmith " > /dev/null 2>&1',
    'end',
    '',
  ].join('\n');
  let hardened = source.replace(debugHandler, 'function __skillsmith_debug\nend');
  hardened = hardened.replace(sourceTimeProbe, '');
  hardened = hardened.replace(
    'no string join/eval, which would collapse multi-segment paths',
    'direct argv preserves multi-segment paths',
  );
  if (
    /\beval\b/u.test(hardened) ||
    hardened.includes('BASH_COMP_DEBUG_FILE') ||
    hardened.includes('complete --do-complete')
  ) {
    throw new Error('Fish completion contains unsafe runtime authority');
  }
  return hardened;
};
