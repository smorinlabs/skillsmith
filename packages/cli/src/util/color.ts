export type ColorFlag = 'auto' | 'always' | 'never';
export type ColorMode = 'on' | 'off';

export interface ColorInputs {
  color: ColorFlag;
  noColor: boolean;
  isTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export const resolveColorMode = (inputs: ColorInputs): ColorMode => {
  const { color, noColor, isTTY, env } = inputs;
  // P0-01 is absolute: explicit force controls never put ANSI on a pipe.
  if (!isTTY) return 'off';
  if (noColor) return 'off';
  if (color === 'never') return 'off';
  if (env.NO_COLOR && env.NO_COLOR.length > 0) return 'off';
  if (env.CLICOLOR === '0') return 'off';
  if (color === 'always') return 'on';
  if (env.TERM === 'dumb') return 'off';
  if (env.FORCE_COLOR && env.FORCE_COLOR.length > 0) return 'on';
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE.length > 0) return 'on';
  return 'on';
};
