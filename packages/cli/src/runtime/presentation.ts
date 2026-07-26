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

// eslint-disable-next-line skillsmith/capability-ownership -- This focused presentation adapter owns the read-only process color environment after the mutation adapter was removed.
const processColorEnvironment = (): Readonly<Record<string, string | undefined>> => process.env;

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

const styleLine = (line: string, reportKind: string): string => {
  const safe = stripVTControlCharacters(line);
  if (OBSERVATION_LINE.test(safe)) return safe;
  if (reportKind === 'version' && safe.length > 0) return chalk.cyan(safe);
  if (/^#{1,6}(?:\s|$)/u.test(safe) || HELP_HEADING.test(safe)) return chalk.bold.cyan(safe);
  if (safe.startsWith('error:')) return `${chalk.bold.red('error:')}${safe.slice('error:'.length)}`;
  if (safe.startsWith('warning:'))
    return `${chalk.bold.yellow('warning:')}${safe.slice('warning:'.length)}`;
  if (/^(?:success|passed|ok):/iu.test(safe)) {
    const delimiter = safe.indexOf(':') + 1;
    return `${chalk.bold.green(safe.slice(0, delimiter))}${safe.slice(delimiter)}`;
  }
  return safe;
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
          stdout:
            policy.stdoutColor === 'on' ? styleText(output.stdout, reportKind) : output.stdout,
        }),
    ...(output.stderr === undefined
      ? {}
      : {
          stderr:
            policy.stderrColor === 'on' ? styleText(output.stderr, reportKind) : output.stderr,
        }),
  });
