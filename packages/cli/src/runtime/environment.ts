import { type ColorFlag, resolveColorMode } from '../util/color.ts';

export const applyRuntimeColorMode = (flag: ColorFlag): void => {
  const mode = resolveColorMode({
    color: flag,
    noColor: Boolean(process.env.NO_COLOR),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (mode === 'off') {
    process.env.NO_COLOR = '1';
    Reflect.deleteProperty(process.env, 'FORCE_COLOR');
  } else {
    process.env.FORCE_COLOR = '1';
    Reflect.deleteProperty(process.env, 'NO_COLOR');
  }
};
