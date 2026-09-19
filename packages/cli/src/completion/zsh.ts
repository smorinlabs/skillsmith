import { createHash } from 'node:crypto';

const UPSTREAM_ZSH_SHA256 = 'e45bd3377bddad73eabee49a48eb0414d6e377d8e0b0dbe5ad6b6bf5742df88d';

const occurrences = (source: string, value: string): number => source.split(value).length - 1;

const replaceSection = (
  source: string,
  start: string,
  end: string,
  replacement: string,
): string => {
  if (occurrences(source, start) !== 1 || occurrences(source, end) !== 1) {
    throw new Error('pinned zsh completion template shape changed');
  }
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error('pinned zsh completion template anchors are out of order');
  }
  return `${source.slice(0, startIndex)}${replacement}${source.slice(endIndex)}`;
};

/** Harden the exact @bomb.sh/tab 0.0.21 zsh skeleton without owning its command inventory. */
export const hardenZshScript = (source: string): string => {
  if (
    createHash('sha256').update(source).digest('hex') !== UPSTREAM_ZSH_SHA256 ||
    occurrences(source, '#compdef skillsmith') !== 1 ||
    occurrences(source, 'requestComp="skillsmith complete -- ${quoted_args[*]}"') !== 1 ||
    occurrences(source, 'out=$(eval ${requestComp} 2>/dev/null)') !== 1 ||
    occurrences(
      source,
      'if eval _describe $keepOrder "completions" completions -Q ${flagPrefix} ${noSpace}; then',
    ) !== 1
  ) {
    throw new Error('pinned zsh completion template fingerprint changed');
  }

  const debugHandler = [
    '__skillsmith_debug() {',
    '    local file="$BASH_COMP_DEBUG_FILE"',
    '    if [[ -n ${file} ]]; then',
    '        echo "$*" >> "${file}"',
    '    fi',
    '}',
  ].join('\n');
  let hardened = source.replace(debugHandler, '__skillsmith_debug() { :; }');
  hardened = hardened.replace(
    '        flagPrefix="-P ${BASH_REMATCH}"',
    '        flagPrefix="${BASH_REMATCH}"',
  );
  hardened = hardened.replace(
    '    local lastParam lastChar flagPrefix requestComp out directive comp lastComp noSpace keepOrder',
    '    local lastParam lastChar flagPrefix out directive comp lastComp noSpace keepOrder',
  );
  const request = [
    '    # Preserve completion words as one argv element each.',
    '    local -a args_to_complete=("${(@)words[2,-1]}")',
    '    if [ "${lastChar}" = "" ] && [ "${args_to_complete[-1]}" != "" ]; then',
    '        __skillsmith_debug "Adding extra empty parameter"',
    '        args_to_complete+=("")',
    '    fi',
    '',
    '    __skillsmith_debug "Calling fixed completion transport"',
    '    out=$(skillsmith complete -- "${(@)args_to_complete}" 2>/dev/null)',
    '',
  ].join('\n');
  hardened = replaceSection(
    hardened,
    '    # Prepare the command to obtain completions, ensuring arguments are quoted for eval',
    '    __skillsmith_debug "completion output: ${out}"',
    request,
  );
  hardened = hardened.replace('        noSpace="-S \'\'"', '        noSpace=1');
  hardened = hardened.replace('        keepOrder="-V"', '        keepOrder=1');

  const describe = [
    '        local -a describeArgs',
    '        if [[ -n "$keepOrder" ]]; then describeArgs+=(-V); fi',
    '        describeArgs+=("completions" completions -Q)',
    '        if [[ -n "$flagPrefix" ]]; then describeArgs+=(-P "$flagPrefix"); fi',
    '        if [[ -n "$noSpace" ]]; then describeArgs+=(-S ""); fi',
    '        if _describe "${describeArgs[@]}"; then',
  ].join('\n');
  hardened = hardened.replace(
    '        if eval _describe $keepOrder "completions" completions -Q ${flagPrefix} ${noSpace}; then',
    describe,
  );
  hardened = hardened.replace(
    "# don't run the completion function when being sourced or eval-ed",
    "# don't run the completion function merely when being sourced",
  );

  if (/\beval\b/u.test(hardened) || hardened.includes('requestComp=')) {
    throw new Error('zsh completion hardening left a reparsed request path');
  }
  return hardened;
};
