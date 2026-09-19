import { type Complete, RootCommand, type Command as TabCommand } from '@bomb.sh/tab';
import { normalizeCommandSpec } from '../runtime/command-spec.ts';
import { CURRENT_COMMAND_SPECS } from '../spec/index.ts';
import type {
  CommandArgumentSpec,
  CommandOptionSpec,
  CommandSpecInput,
  CompletionProviderKind,
  NormalizedCommandSpec,
} from '../spec/types.ts';
import { hardenBashScript } from './bash.ts';
import { hardenFishScript } from './fish.ts';
import {
  type CompletionCandidate,
  type CompletionProviderContext,
  completeLocalProvider,
} from './providers.ts';
import type { Shell } from './run.ts';
import { hardenZshScript } from './zsh.ts';

const encoder = new TextEncoder();
const SCRIPT_CAPTURE_BYTES = 128 * 1024;
const PROTOCOL_CAPTURE_BYTES = 64 * 1024;

let captureActive = false;

export const captureTabOutput = (operation: () => void, byteLimit: number): string => {
  if (captureActive) throw new Error('tab output capture is already active');
  captureActive = true;
  const original = console.log;
  const lines: string[] = [];
  let bytes = 0;
  console.log = (...values: unknown[]) => {
    if (!values.every((value) => typeof value === 'string' || typeof value === 'number')) {
      throw new Error('tab emitted an unsupported console value');
    }
    const line = values.map(String).join(' ');
    bytes += encoder.encode(line).byteLength + 1;
    if (bytes > byteLimit) throw new Error('tab output capture byte bound exceeded');
    lines.push(line);
  };
  try {
    operation();
    return `${lines.join('\n')}\n`;
  } finally {
    console.log = original;
    captureActive = false;
  }
};

interface ProviderState {
  requested?: CompletionProviderKind;
  resolved?: Readonly<{
    kind: CompletionProviderKind;
    candidates: readonly CompletionCandidate[];
  }>;
}

export type CompletionGraphContext = Omit<CompletionProviderContext, 'ports'> &
  Partial<Pick<CompletionProviderContext, 'ports'>>;

interface GraphContext extends CompletionGraphContext {
  readonly prefix: string;
  readonly providerState: ProviderState;
}

const completeValues = (
  complete: Complete,
  values: readonly string[],
  description: string,
): void => {
  for (const value of values) complete(value, description);
};

const providerHandler =
  (kind: CompletionProviderKind, context: GraphContext): ((complete: Complete) => void) =>
  (complete) => {
    const requested = context.providerState.requested;
    if (requested !== undefined && requested !== kind) {
      throw new Error('completion parse selected more than one dynamic provider');
    }
    context.providerState.requested = kind;
    if (context.providerState.resolved?.kind !== kind) return;
    for (const candidate of context.providerState.resolved.candidates) {
      complete(candidate.value, candidate.description);
    }
  };

const optionHandler = (
  option: CommandOptionSpec,
  context: GraphContext,
): ((complete: Complete) => void) | undefined => {
  if (option.allowedValues.length > 0) {
    return (complete) => completeValues(complete, option.allowedValues, option.description ?? '');
  }
  if (option.completionProvider !== undefined) {
    return providerHandler(option.completionProvider, context);
  }
  return option.valueShape === 'boolean' ? undefined : () => undefined;
};

const argumentHandler = (
  argument: CommandArgumentSpec,
  context: GraphContext,
): ((complete: Complete) => void) | undefined => {
  if (argument.choices.length > 0) {
    return (complete) => completeValues(complete, argument.choices, argument.description ?? '');
  }
  if (argument.completionProvider === undefined) return undefined;
  return providerHandler(argument.completionProvider, context);
};

const optionsForCommand = (
  root: NormalizedCommandSpec,
  active: NormalizedCommandSpec,
): readonly CommandOptionSpec[] => {
  const options = new Map<string, CommandOptionSpec>();
  for (const option of [...root.options, ...active.options]) options.set(option.long, option);
  return [...options.values()];
};

const attachSpec = (
  command: TabCommand,
  root: NormalizedCommandSpec,
  spec: NormalizedCommandSpec,
  context: GraphContext,
): void => {
  for (const option of optionsForCommand(root, spec)) {
    const name = option.long.replace(/^--/u, '');
    const alias = option.short?.replace(/^-/, '');
    const handler = optionHandler(option, context);
    if (handler !== undefined) {
      command.option(name, option.description ?? '', handler, alias ?? undefined);
    } else if (alias !== undefined) {
      command.option(name, option.description ?? '', alias);
    } else {
      command.option(name, option.description ?? '');
    }
  }
  for (const argument of spec.arguments) {
    command.argument(argument.name, argumentHandler(argument, context), argument.variadic);
  }
};

const validateCompletionSpecs = (specs: readonly NormalizedCommandSpec[]): void => {
  const canonical = new Set<string>();
  for (const spec of specs) {
    if (canonical.has(spec.path)) throw new Error(`duplicate completion path: ${spec.path}`);
    canonical.add(spec.path);
  }
  const rootCount = specs.filter((spec) => spec.path === 'skillsmith').length;
  if (rootCount !== 1) throw new Error('completion registry must contain exactly one root spec');

  const registered = new Set(
    specs
      .filter((spec) => spec.path !== 'skillsmith')
      .map((spec) => spec.path.slice('skillsmith '.length)),
  );
  for (const spec of specs) {
    const name = spec.path.slice('skillsmith '.length);
    const parent = name.split(' ').slice(0, -1).join(' ');
    for (const alias of spec.aliases) {
      if (alias.length === 0 || alias.includes(' ')) {
        throw new Error(`invalid completion alias: ${alias}`);
      }
      const aliasPath = parent.length === 0 ? alias : `${parent} ${alias}`;
      if (registered.has(aliasPath)) throw new Error(`duplicate completion alias: ${aliasPath}`);
      registered.add(aliasPath);
    }
  }
};

const createCompletionRoot = (
  context: GraphContext,
  inputs: readonly CommandSpecInput[] = CURRENT_COMMAND_SPECS,
): RootCommand => {
  const specs = inputs.map(normalizeCommandSpec);
  validateCompletionSpecs(specs);
  const rootSpec = specs.find((spec) => spec.path === 'skillsmith');
  if (rootSpec === undefined) throw new Error('completion registry has no root CommandSpec');
  const root = new RootCommand();
  attachSpec(root, rootSpec, rootSpec, context);

  const topLevelOrder = new Map(
    specs
      .filter((spec) => spec.path.split(' ').length === 2)
      .map((spec) => [spec.path.split(' ')[1] ?? '', spec.helpOrder]),
  );
  const commands = specs
    .filter((spec) => spec.path !== 'skillsmith')
    .toSorted((left, right) => {
      const leftParts = left.path.split(' ');
      const rightParts = right.path.split(' ');
      const topOrder =
        (topLevelOrder.get(leftParts[1] ?? '') ?? left.helpOrder) -
        (topLevelOrder.get(rightParts[1] ?? '') ?? right.helpOrder);
      if (topOrder !== 0) return topOrder;
      if (leftParts.length !== rightParts.length) return leftParts.length - rightParts.length;
      const nestedOrder = left.helpOrder - right.helpOrder;
      return nestedOrder !== 0 ? nestedOrder : left.path.localeCompare(right.path);
    });
  for (const spec of commands) {
    const name = spec.path.slice('skillsmith '.length);
    attachSpec(root.command(name, spec.description), rootSpec, spec, context);
    for (const alias of spec.aliases) {
      const parent = name.split(' ').slice(0, -1).join(' ');
      const aliasPath = parent.length === 0 ? alias : `${parent} ${alias}`;
      attachSpec(root.command(aliasPath, spec.description), rootSpec, spec, context);
    }
  }
  return root;
};

export const parseCompletionGraph = async (
  tokens: readonly string[],
  context: CompletionGraphContext,
  specs: readonly CommandSpecInput[] = CURRENT_COMMAND_SPECS,
): Promise<string> => {
  const current = tokens.at(-1) ?? '';
  const equals = current.startsWith('-') ? current.indexOf('=') : -1;
  const prefix = equals < 0 ? current : current.slice(equals + 1);
  const probeState: ProviderState = {};
  const probe = createCompletionRoot({ ...context, prefix, providerState: probeState }, specs);
  const probeOutput = captureTabOutput(() => probe.parse([...tokens]), PROTOCOL_CAPTURE_BYTES);
  if (probeState.requested === undefined) return probeOutput;
  if (context.ports === undefined) throw new Error('completion provider ports are unavailable');

  const candidates = Object.freeze(
    (
      await completeLocalProvider(probeState.requested, prefix, {
        cwd: context.cwd,
        monotonicMilliseconds: context.monotonicMilliseconds,
        ports: context.ports,
      })
    ).map((candidate) => Object.freeze({ ...candidate })),
  );
  const finalState: ProviderState = {
    resolved: Object.freeze({ kind: probeState.requested, candidates }),
  };
  const root = createCompletionRoot({ ...context, prefix, providerState: finalState }, specs);
  return captureTabOutput(() => root.parse([...tokens]), PROTOCOL_CAPTURE_BYTES);
};

export const hardenCompletionScript = (shell: Shell, source: string): string => {
  if (shell === 'bash') return hardenBashScript(source);
  if (shell === 'zsh') return hardenZshScript(source);
  return hardenFishScript(source);
};

export const generateCompletionScript = (shell: Shell): string => {
  const root = new RootCommand();
  const captured = captureTabOutput(
    () => root.setup('skillsmith', 'skillsmith', shell),
    SCRIPT_CAPTURE_BYTES,
  );
  return hardenCompletionScript(shell, captured);
};
