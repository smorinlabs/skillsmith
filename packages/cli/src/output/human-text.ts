/** Encode untrusted human-readable scalars without terminal or line control. */
export const displayHumanText = (value: string | null): string => {
  if (value === null) return 'null';
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          codePoint === 0x2028 ||
          codePoint === 0x2029)
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : character;
    })
    .join('');
};

/** Quote informational text losslessly; this is display text, not shell syntax. */
export const quoteHumanText = (value: string): string =>
  `"${[...value]
    .map((character) => {
      if (character === '"') return '\\"';
      if (character === '\\') return '\\\\';
      const codePoint = character.codePointAt(0);
      // Preserve lone UTF-16 surrogates instead of emitting invalid Unicode.
      if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) {
        return `\\u${codePoint.toString(16).padStart(4, '0')}`;
      }
      return displayHumanText(character);
    })
    .join('')}"`;
