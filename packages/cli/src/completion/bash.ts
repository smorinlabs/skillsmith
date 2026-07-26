const occurrences = (source: string, value: string): number => source.split(value).length - 1;

const replaceSection = (
  source: string,
  start: string,
  end: string,
  replacement: string,
): string => {
  if (occurrences(source, start) !== 1 || occurrences(source, end) !== 1) {
    throw new Error('pinned Bash completion template shape changed');
  }
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error('pinned Bash completion template anchors are out of order');
  }
  return `${source.slice(0, startIndex)}${replacement}${source.slice(endIndex)}`;
};

/** Harden the exact @bomb.sh/tab 0.0.21 Bash skeleton without owning its command inventory. */
export const hardenBashScript = (source: string): string => {
  if (
    occurrences(source, '# bash completion for skillsmith') !== 1 ||
    occurrences(source, 'requestComp="skillsmith complete -- ${words[@]:1}"') !== 1 ||
    occurrences(source, 'eval "$requestComp"') !== 1 ||
    occurrences(source, 'complete -F __skillsmith_complete skillsmith') !== 1
  ) {
    throw new Error('pinned Bash completion template fingerprint changed');
  }

  const request = [
    '    local out directive',
    '    local -a requestComp=(skillsmith complete -- "${words[@]:1}")',
    '',
    '    # Preserve a completed word as one final empty argv element.',
    '    if [[ -z "$cur" ]]; then',
    '        requestComp+=("")',
    '    fi',
    '',
    '    out=$("${requestComp[@]}" 2>/dev/null)',
    '',
  ].join('\n');
  let hardened = replaceSection(
    source,
    '    local requestComp out directive',
    '    # Extract directive if present',
    request,
  );

  const candidates = [
    '    # Preserve each candidate as data; never feed candidate text back to the shell parser.',
    '    local tab value completionPrefix="" filterCur="$cur"',
    "    tab=$(printf '\\t')",
    '    if [[ "$cur" == --*=* ]]; then',
    '        completionPrefix="${cur%%=*}="',
    '        filterCur="${cur#*=}"',
    '    fi',
    '    COMPREPLY=()',
    '    while IFS= read -r comp; do',
    '        [[ -z "$comp" ]] && continue',
    '        value=${comp%%$tab*}',
    '        if [[ "$value" == "$filterCur"* ]]; then',
    '            COMPREPLY+=("${completionPrefix}${value}")',
    '        fi',
    '    done <<< "$out"',
    '',
  ].join('\n');
  hardened = replaceSection(
    hardened,
    "    # Process completions\n    local IFS=$'\\n'",
    '}\n\n# Register completion function',
    candidates,
  );

  if (/\beval\b/u.test(hardened) || hardened.includes('requestComp="skillsmith complete --')) {
    throw new Error('Bash completion hardening left a reparsed request path');
  }
  return hardened;
};
