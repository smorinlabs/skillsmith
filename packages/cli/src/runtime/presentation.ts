import { stripVTControlCharacters } from 'node:util';
import { Chalk } from 'chalk';
import { type ColorFlag, type ColorMode, resolveColorMode } from '../util/color.ts';
import type { CliRuntimeIo, RenderedCommandOutput } from './io.ts';

export interface PresentationPolicy {
  readonly stdoutColor: ColorMode;
  readonly stderrColor: ColorMode;
}

export interface PresentationPolicyInput {
  readonly format: 'human' | 'json';
  readonly color: ColorFlag;
  readonly noColor: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const OFF_POLICY: PresentationPolicy = Object.freeze({
  stdoutColor: 'off',
  stderrColor: 'off',
});

const COLOR_ENVIRONMENT_KEYS = [
  'NO_COLOR',
  'CLICOLOR',
  'TERM',
  'FORCE_COLOR',
  'CLICOLOR_FORCE',
] as const;

type ColorEnvironmentKey = (typeof COLOR_ENVIRONMENT_KEYS)[number];

/** Copy only color-policy inputs so invocation policy never retains ambient process authority. */
export const snapshotColorEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<ColorEnvironmentKey, string | undefined>> =>
  Object.freeze({
    NO_COLOR: env.NO_COLOR,
    CLICOLOR: env.CLICOLOR,
    TERM: env.TERM,
    FORCE_COLOR: env.FORCE_COLOR,
    CLICOLOR_FORCE: env.CLICOLOR_FORCE,
  });

const processColorEnvironment = (): Readonly<Record<ColorEnvironmentKey, string | undefined>> => {
  // eslint-disable-next-line skillsmith/capability-ownership -- This focused presentation adapter owns the read-only process color environment after the mutation adapter was removed.
  return snapshotColorEnvironment(process.env);
};

export const resolvePresentationPolicy = (input: PresentationPolicyInput): PresentationPolicy => {
  if (input.format === 'json') return OFF_POLICY;
  const resolve = (isTTY: boolean): ColorMode =>
    resolveColorMode({
      color: input.color,
      noColor: input.noColor,
      isTTY,
      env: input.env,
    });
  return Object.freeze({
    stdoutColor: resolve(input.stdoutIsTTY),
    stderrColor: resolve(input.stderrIsTTY),
  });
};

export const colorOptions = (
  options: Readonly<Record<string, unknown>>,
): Readonly<{ color: ColorFlag; noColor: boolean }> => {
  const raw = options.color;
  if (raw === false) return Object.freeze({ color: 'auto', noColor: true });
  return Object.freeze({
    color: raw === 'always' || raw === 'never' || raw === 'auto' ? raw : 'auto',
    noColor: false,
  });
};

export const colorOptionsFromArgv = (
  argv: readonly string[],
): Readonly<{ color: ColorFlag; noColor: boolean }> => {
  let color: ColorFlag = 'auto';
  let noColor = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') break;
    if (token === '--no-color') {
      noColor = true;
      continue;
    }
    const attached = token?.startsWith('--color=') ? token.slice('--color='.length) : undefined;
    const raw = token === '--color' ? argv[index + 1] : attached;
    if (raw === 'always' || raw === 'never' || raw === 'auto') color = raw;
  }
  return Object.freeze({ color, noColor });
};

export const presentationPolicyForIo = (
  options: Readonly<Record<string, unknown>>,
  format: 'human' | 'json',
  io: CliRuntimeIo,
  env: Readonly<Record<string, string | undefined>> = processColorEnvironment(),
): PresentationPolicy => {
  const selected = colorOptions(options);
  return resolvePresentationPolicy({
    format,
    ...selected,
    stdoutIsTTY: io.stdout.isTTY === true,
    stderrIsTTY: io.stderr.isTTY === true,
    env,
  });
};

export const presentationPolicyFromArgv = (
  argv: readonly string[],
  format: 'human' | 'json',
  io: CliRuntimeIo,
  env: Readonly<Record<string, string | undefined>> = processColorEnvironment(),
): PresentationPolicy =>
  resolvePresentationPolicy({
    format,
    ...colorOptionsFromArgv(argv),
    stdoutIsTTY: io.stdout.isTTY === true,
    stderrIsTTY: io.stderr.isTTY === true,
    env,
  });

const chalk = new Chalk({ level: 1 });
const OBSERVATION_LINE = /^(?:detail|trace|debug): /u;
const HELP_HEADING =
  /^(?:PRIMARY QUESTION|USAGE|INHERITED GLOBALS|DISCOVER|MANAGE|DEVELOP|DECLARATIVE|MAINTAIN|EXIT CODES)\b/u;

const isUnsafeHumanControl = (character: string): boolean => {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    (codePoint >= 11 && codePoint <= 31) ||
    (codePoint >= 127 && codePoint <= 159)
  );
};

const sanitizeHumanText = (value: string): string =>
  [...stripVTControlCharacters(value)]
    .filter((character) => !isUnsafeHumanControl(character))
    .join('');

const styleLine = (line: string, reportKind: string): string => {
  if (OBSERVATION_LINE.test(line)) return line;
  if (reportKind === 'version' && line.length > 0) return chalk.cyan(line);
  if (/^#{1,6}(?:\s|$)/u.test(line) || HELP_HEADING.test(line)) return chalk.bold.cyan(line);
  if (line.startsWith('error:')) return `${chalk.bold.red('error:')}${line.slice('error:'.length)}`;
  if (line.startsWith('warning:'))
    return `${chalk.bold.yellow('warning:')}${line.slice('warning:'.length)}`;
  if (/^(?:success|passed|ok):/iu.test(line)) {
    const delimiter = line.indexOf(':') + 1;
    return `${chalk.bold.green(line.slice(0, delimiter))}${line.slice(delimiter)}`;
  }
  return line;
};

const styleText = (value: string, reportKind: string): string =>
  value
    .split(/(?<=\n)/u)
    .map((segment) => {
      const terminalLf = segment.endsWith('\n');
      const line = terminalLf ? segment.slice(0, -1) : segment;
      return `${styleLine(line, reportKind)}${terminalLf ? '\n' : ''}`;
    })
    .join('');

export const presentHumanOutput = (
  output: RenderedCommandOutput,
  policy: PresentationPolicy,
  reportKind: string,
): RenderedCommandOutput =>
  Object.freeze({
    ...(output.stdout === undefined
      ? {}
      : {
          stdout: (() => {
            const safe = sanitizeHumanText(output.stdout);
            return policy.stdoutColor === 'on' ? styleText(safe, reportKind) : safe;
          })(),
        }),
    ...(output.stderr === undefined
      ? {}
      : {
          stderr: (() => {
            const safe = sanitizeHumanText(output.stderr);
            return policy.stderrColor === 'on' ? styleText(safe, reportKind) : safe;
          })(),
        }),
  });
