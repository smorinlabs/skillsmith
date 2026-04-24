# SkillSmith MVP-2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship SkillSmith `v0.2.0` (internal milestone): `skillsmith config <get|set|list|unset>` with a layered TOML config, `skillsmith completion <bash|zsh|fish>` via runtime commander introspection, plus the library-side `loadConfig`/`saveConfig` surface and the new `config-error` exit code 3.

**Architecture:** Config lives in `packages/core/src/config/`, exposing `loadConfig` (gathers all layers, merges per-key) and `saveConfig` (atomic write via `proper-lockfile` + write-temp-then-rename). Completion lives in `packages/cli/src/completion/`: a walker converts commander's `Command` tree to an internal `CompletionNode[]`, and three renderers (bash/zsh/fish) produce shell scripts. Enum flags must use `.addOption(new Option().choices([...]))` so `argChoices` is populated; a gate test enforces this.

**Tech Stack:** adds `smol-toml` and `proper-lockfile` as runtime deps to `@skillsmith/core`. CLI gains the `completion` and `config` commands. No change to tsconfig, biome, or lefthook.

**Spec:** `docs/superpowers/specs/2026-04-24-mvp-2a-design.md`
**Prerequisite:** MVP-1 at `v0.1.0` + round-1 bug audit landed (currently at HEAD).

---

## Conventions

- All paths are repo-relative.
- Every task ends with a commit using Conventional Commits.
- TDD applies to behavior code. Scaffolding verified by running the tool.
- `bun test` discovers `*.test.ts` anywhere in the workspace.
- `InstallRecord`/`SupportedTool`/`ScanEnv` types from MVP-1 are re-used.

---

## Phase A — Retrofit commander for completion (prerequisite)

### Task 1: Migrate existing enum options to `addOption(...choices())`

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write a failing gate test**

Create `packages/cli/tests/completion/declaration-gate.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { Command, Option } from 'commander';
import { buildProgram } from '../../src/program.ts';

// Heuristic: an option whose short description lists a pipe-separated enum
// must carry argChoices. Catches `.option('--fmt <x>', 'a | b')` regressions.
const ENUM_DESCRIPTION = /\b\w+\s*\|\s*\w+\b/;

const walk = (cmd: Command): { cmd: Command; opts: Option[] }[] => [
  { cmd, opts: cmd.options },
  ...cmd.commands.flatMap(walk),
];

describe('commander declaration gate', () => {
  const program = buildProgram();

  test('every subcommand has a description', () => {
    for (const { cmd } of walk(program)) {
      if (cmd === program) continue;
      expect(cmd.description()).not.toBe('');
    }
  });

  test('every enum-looking option has argChoices', () => {
    for (const { cmd, opts } of walk(program)) {
      for (const opt of opts) {
        const desc = opt.description ?? '';
        if (!ENUM_DESCRIPTION.test(desc)) continue;
        expect(
          opt.argChoices,
          `${cmd.name()} ${opt.long} — description looks enum-shaped but no .choices() declared`,
        ).toBeDefined();
      }
    }
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/cli/tests/completion/declaration-gate.test.ts`
Expected: FAIL — `buildProgram` doesn't exist yet, and the existing `--color`/`--format` options look enum-shaped without `choices`.

- [ ] **Step 3: Extract the commander setup into `buildProgram`**

Create `packages/cli/src/program.ts`:

```ts
import { defaultScanEnv, VERSION } from '@skillsmith/core';
import { Argument, Command, Option } from 'commander';
import { runAgents } from './commands/agents.ts';
import { HELP_TOPIC_NAMES, renderTopic } from './help/topics.ts';
import { exitCodeForError } from './util/exit-codes.ts';

export const buildProgram = (): Command => {
  const program = new Command()
    .name('skillsmith')
    .description('SkillSmith installs and manages agent skills for AI coding tools.')
    .version(VERSION, '-V, --version')
    .helpOption('-h, --help', 'Show help')
    .option(
      '-v, --verbose',
      'Verbose output; repeatable',
      (_: string, prev: number) => prev + 1,
      0,
    )
    .option('-q, --quiet', 'Suppress non-error output', false)
    .addOption(new Option('--color <mode>', 'Colorize output').choices(['auto', 'always', 'never']).default('auto'))
    .option('-C, --cd <dir>', 'Change directory before running', '.')
    .option('--debug', 'Print debug traces', false);

  program
    .command('agents')
    .description('List every supported tool SkillSmith detects on this system')
    .option(
      '-t, --tool <name>',
      'Narrow scan to specific tool (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option('--detected-only', 'Omit the "Not detected" section', false)
    .addOption(new Option('--format <fmt>', 'Output format').choices(['markdown', 'json']).default('markdown'))
    .action(async (opts: { tool: string[]; detectedOnly: boolean; format: 'markdown' | 'json' }) => {
      const env = await defaultScanEnv();
      const r = await runAgents({
        env,
        tools: opts.tool.length > 0 ? opts.tool : undefined,
        format: opts.format,
        detectedOnly: opts.detectedOnly,
      });
      if (!r.ok) {
        process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
        process.exit(exitCodeForError(r.error));
      }
      process.stdout.write(`${r.output}\n`);
    });

  program
    .command('version')
    .description('Print SkillSmith version')
    .action(() => {
      process.stdout.write(`${VERSION}\n`);
    });

  program
    .command('help [topic]')
    .description('Help about a command or cross-cutting topic')
    .action((topic?: string) => {
      if (!topic) {
        program.outputHelp();
        return;
      }
      if ((HELP_TOPIC_NAMES as readonly string[]).includes(topic)) {
        const r = renderTopic(topic);
        if (r.ok) {
          process.stdout.write(`${r.value}\n`);
          return;
        }
      }
      const cmd = program.commands.find((c) => c.name() === topic);
      if (cmd) {
        cmd.outputHelp();
        return;
      }
      process.stderr.write(
        `error: '${topic}' is not a known command or topic.\nKnown topics: ${HELP_TOPIC_NAMES.join(', ')}\n`,
      );
      process.exit(2);
    });

  return program;
};
```

Note the `.addOption(new Option('--color ...').choices(['auto','always','never']))` and `.addOption(new Option('--format ...').choices(['markdown','json']))` replacements.

- [ ] **Step 4: Rewrite `packages/cli/src/index.ts` to delegate**

```ts
#!/usr/bin/env bun
import { buildProgram } from './program.ts';
import { installSigintHandler } from './util/signals.ts';

const main = async (): Promise<number> => {
  const controller = new AbortController();
  const handle = installSigintHandler(controller);

  try {
    const args = process.argv.slice(2);
    const program = buildProgram();
    if (args.length === 0) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(process.argv);
    return handle.wasInterrupted() ? 130 : 0;
  } finally {
    handle.uninstall();
  }
};

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
```

- [ ] **Step 5: Run the gate test**

Run: `bun test packages/cli/tests/completion/declaration-gate.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Verify existing help + integration tests still pass**

Run: `bun test packages/cli`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/program.ts packages/cli/tests/completion/declaration-gate.test.ts
git commit -m "refactor(cli): extract buildProgram and migrate enum options to .choices()"
```

---

## Phase B — Completion walker and renderers

### Task 2: `CompletionNode` types + commander walker

**Files:**
- Create: `packages/cli/src/completion/types.ts`
- Create: `packages/cli/src/completion/walk.ts`
- Create: `packages/cli/tests/completion/walk.test.ts`

- [ ] **Step 1: Write failing test `packages/cli/tests/completion/walk.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { walk } from '../../src/completion/walk.ts';

const buildFixture = (): Command => {
  const program = new Command()
    .name('sk')
    .description('root')
    .addOption(new Option('--color <m>', 'colorize').choices(['auto', 'off']));
  program
    .command('agents')
    .description('list tools')
    .option('-t, --tool <name>', 'repeatable')
    .addOption(new Option('--format <fmt>', 'output').choices(['md', 'json']));
  program
    .command('completion')
    .description('emit completion script')
    .addArgument(new Argument('<shell>', 'target shell').choices(['bash', 'zsh', 'fish']));
  return program;
};

describe('walk', () => {
  test('captures subcommands with descriptions', () => {
    const [root] = walk(buildFixture());
    expect(root?.name).toBe('sk');
    const sub = root?.subcommands.map((s) => s.name).sort();
    expect(sub).toEqual(['agents', 'completion']);
  });

  test('captures enum choices on options', () => {
    const root = walk(buildFixture())[0]!;
    const color = root.options.find((o) => o.long === '--color');
    expect(color?.choices).toEqual(['auto', 'off']);
    const agents = root.subcommands.find((s) => s.name === 'agents')!;
    const fmt = agents.options.find((o) => o.long === '--format');
    expect(fmt?.choices).toEqual(['md', 'json']);
  });

  test('captures enum choices on positional arguments', () => {
    const root = walk(buildFixture())[0]!;
    const completion = root.subcommands.find((s) => s.name === 'completion')!;
    expect(completion.args[0]?.choices).toEqual(['bash', 'zsh', 'fish']);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/cli/tests/completion/walk.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `packages/cli/src/completion/types.ts`**

```ts
export interface CompletionOption {
  long: string | null;
  short: string | null;
  description: string;
  takesValue: boolean;
  choices: readonly string[] | null;
}

export interface CompletionArg {
  name: string;
  required: boolean;
  variadic: boolean;
  choices: readonly string[] | null;
}

export interface CompletionNode {
  name: string;
  description: string;
  options: readonly CompletionOption[];
  args: readonly CompletionArg[];
  subcommands: readonly CompletionNode[];
}
```

- [ ] **Step 4: Implement `packages/cli/src/completion/walk.ts`**

```ts
import type { Argument, Command, Option } from 'commander';
import type { CompletionArg, CompletionNode, CompletionOption } from './types.ts';

const describeOption = (o: Option): CompletionOption => ({
  long: o.long ?? null,
  short: o.short ?? null,
  description: o.description ?? '',
  takesValue: o.required || o.optional,
  choices: o.argChoices && o.argChoices.length > 0 ? [...o.argChoices] : null,
});

const describeArg = (a: Argument): CompletionArg => ({
  name: a.name(),
  required: a.required,
  variadic: a.variadic,
  choices: a.argChoices && a.argChoices.length > 0 ? [...a.argChoices] : null,
});

const describeCommand = (cmd: Command): CompletionNode => ({
  name: cmd.name(),
  description: cmd.description(),
  options: cmd.options.map(describeOption),
  args: (cmd.registeredArguments ?? []).map(describeArg),
  subcommands: cmd.commands.map(describeCommand),
});

export const walk = (program: Command): CompletionNode[] => [describeCommand(program)];
```

- [ ] **Step 5: Verify**

Run: `bun test packages/cli/tests/completion/walk.test.ts`
Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/completion/types.ts packages/cli/src/completion/walk.ts packages/cli/tests/completion/walk.test.ts
git commit -m "feat(cli): add commander-tree walker producing CompletionNode AST"
```

---

### Task 3: Bash renderer

**Files:**
- Create: `packages/cli/src/completion/bash.ts`
- Create: `packages/cli/tests/completion/bash.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { renderBash } from '../../src/completion/bash.ts';
import { walk } from '../../src/completion/walk.ts';

const fixture = () => {
  const p = new Command().name('sk').description('root');
  p.command('agents').description('list').addOption(new Option('--format <f>', '').choices(['md', 'json']));
  p.command('completion')
    .description('scripts')
    .addArgument(new Argument('<shell>').choices(['bash', 'zsh']));
  return walk(p);
};

describe('renderBash', () => {
  const out = renderBash(fixture());

  test('starts with a shebang-ish comment and install hint', () => {
    expect(out.split('\n')[0]).toMatch(/^#/);
    expect(out).toMatch(/To install:/);
  });

  test('defines a _sk completion function and registers it', () => {
    expect(out).toMatch(/_sk\s*\(\s*\)/);
    expect(out).toMatch(/complete\s+-F\s+_sk\s+sk\b/);
  });

  test('includes subcommand names', () => {
    expect(out).toContain('agents');
    expect(out).toContain('completion');
  });

  test('includes enum values for options', () => {
    expect(out).toContain('md');
    expect(out).toContain('json');
  });

  test('includes enum values for positional args', () => {
    expect(out).toContain('bash');
    expect(out).toContain('zsh');
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/cli/tests/completion/bash.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/cli/src/completion/bash.ts`**

```ts
import type { CompletionNode } from './types.ts';

const flagTokens = (n: CompletionNode): string[] => {
  const tokens: string[] = [];
  for (const o of n.options) {
    if (o.long) tokens.push(o.long);
    if (o.short) tokens.push(o.short);
  }
  return tokens;
};

export const renderBash = (nodes: readonly CompletionNode[]): string => {
  const root = nodes[0];
  if (!root) return '';
  const bin = root.name;
  const subs = root.subcommands.map((s) => s.name);

  const caseArms: string[] = [];
  for (const sub of root.subcommands) {
    const subFlags = flagTokens(sub);
    const subArgChoices = sub.args.flatMap((a) => a.choices ?? []);
    const enumValues = new Set<string>(subArgChoices);
    for (const o of sub.options) for (const c of o.choices ?? []) enumValues.add(c);
    const words = [...subFlags, ...enumValues];
    caseArms.push(
      `      ${sub.name})\n        COMPREPLY=( $(compgen -W "${words.join(' ')}" -- "$cur") )\n        return 0;;`,
    );
  }

  const rootFlags = flagTokens(root);
  const rootWords = [...subs, ...rootFlags];

  return [
    `# skillsmith bash completion (autogenerated)`,
    `# To install: ${bin} completion bash | sudo tee /etc/bash_completion.d/${bin}`,
    ``,
    `_${bin}() {`,
    `  local cur prev`,
    `  COMPREPLY=()`,
    `  cur="\${COMP_WORDS[COMP_CWORD]}"`,
    `  prev="\${COMP_WORDS[COMP_CWORD-1]}"`,
    `  case "\${COMP_WORDS[1]:-}" in`,
    ...caseArms,
    `    *)`,
    `      COMPREPLY=( $(compgen -W "${rootWords.join(' ')}" -- "$cur") )`,
    `      return 0;;`,
    `  esac`,
    `}`,
    `complete -F _${bin} ${bin}`,
    ``,
  ].join('\n');
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/completion/bash.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/completion/bash.ts packages/cli/tests/completion/bash.test.ts
git commit -m "feat(cli): render bash completion from CompletionNode tree"
```

---

### Task 4: Zsh renderer

**Files:**
- Create: `packages/cli/src/completion/zsh.ts`
- Create: `packages/cli/tests/completion/zsh.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { walk } from '../../src/completion/walk.ts';
import { renderZsh } from '../../src/completion/zsh.ts';

const fixture = () => {
  const p = new Command().name('sk').description('root');
  p.command('agents').description('list').addOption(new Option('--format <f>', '').choices(['md', 'json']));
  p.command('completion').description('scripts').addArgument(new Argument('<shell>').choices(['bash', 'zsh']));
  return walk(p);
};

describe('renderZsh', () => {
  const out = renderZsh(fixture());

  test('starts with #compdef skillsmith-bin name', () => {
    expect(out).toMatch(/^#compdef sk\b/m);
  });

  test('uses _describe for subcommand completion', () => {
    expect(out).toContain('_describe');
    expect(out).toContain('agents');
    expect(out).toContain('completion');
  });

  test('contains enum option and positional choices', () => {
    expect(out).toContain('md');
    expect(out).toContain('json');
    expect(out).toContain('bash');
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/cli/tests/completion/zsh.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/cli/src/completion/zsh.ts`**

```ts
import type { CompletionNode } from './types.ts';

const zshEscape = (s: string): string => s.replace(/'/g, "'\\''");

export const renderZsh = (nodes: readonly CompletionNode[]): string => {
  const root = nodes[0];
  if (!root) return '';
  const bin = root.name;

  const subLines = root.subcommands
    .map((s) => `    '${s.name}:${zshEscape(s.description || s.name)}'`)
    .join('\n');

  const caseArms = root.subcommands
    .map((s) => {
      const flags = s.options.flatMap((o) => {
        const names = [o.short, o.long].filter((n): n is string => Boolean(n));
        return names.map((n) => `'${n}[${zshEscape(o.description || n)}]'`);
      });
      const positionals = s.args
        .filter((a) => a.choices)
        .map((a) => `':${a.name}:(${(a.choices ?? []).join(' ')})'`);
      const enumPairs = s.options
        .filter((o) => o.choices)
        .map((o) => `'${o.long}=(${(o.choices ?? []).join(' ')})'`);
      const body = [...flags, ...positionals, ...enumPairs].join(' \\\n          ');
      return `    ${s.name})\n        _arguments \\\n          ${body || "':no-args:'"}\n        ;;`;
    })
    .join('\n');

  return [
    `#compdef ${bin}`,
    `# skillsmith zsh completion (autogenerated)`,
    `# To install: ${bin} completion zsh > "\${fpath[1]}/_${bin}"`,
    ``,
    `_${bin}() {`,
    `  local -a commands`,
    `  commands=(`,
    subLines,
    `  )`,
    `  local context state state_descr line`,
    `  _arguments -C \\`,
    `    '1: :->cmd' \\`,
    `    '*::arg:->args'`,
    `  case "$state" in`,
    `    cmd) _describe 'command' commands ;;`,
    `    args) case "$line[1]" in`,
    caseArms,
    `    esac ;;`,
    `  esac`,
    `}`,
    `_${bin} "$@"`,
    ``,
  ].join('\n');
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/completion/zsh.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/completion/zsh.ts packages/cli/tests/completion/zsh.test.ts
git commit -m "feat(cli): render zsh completion from CompletionNode tree"
```

---

### Task 5: Fish renderer

**Files:**
- Create: `packages/cli/src/completion/fish.ts`
- Create: `packages/cli/tests/completion/fish.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { Argument, Command, Option } from 'commander';
import { renderFish } from '../../src/completion/fish.ts';
import { walk } from '../../src/completion/walk.ts';

const fixture = () => {
  const p = new Command().name('sk').description('root');
  p.command('agents').description('list').addOption(new Option('--format <f>', 'out').choices(['md', 'json']));
  p.command('completion').description('scripts').addArgument(new Argument('<shell>').choices(['bash', 'zsh']));
  return walk(p);
};

describe('renderFish', () => {
  const out = renderFish(fixture());

  test('emits per-command complete lines', () => {
    expect(out).toMatch(/complete -c sk -f -n '__fish_use_subcommand' -a agents/);
    expect(out).toMatch(/complete -c sk -f -n '__fish_use_subcommand' -a completion/);
  });

  test('emits enum values for options', () => {
    expect(out).toContain('md');
    expect(out).toContain('json');
  });

  test('emits positional choices for subcommands', () => {
    expect(out).toContain('bash');
    expect(out).toContain('zsh');
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/cli/tests/completion/fish.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/cli/src/completion/fish.ts`**

```ts
import type { CompletionNode } from './types.ts';

const fishEscape = (s: string): string => s.replace(/'/g, "\\'");

export const renderFish = (nodes: readonly CompletionNode[]): string => {
  const root = nodes[0];
  if (!root) return '';
  const bin = root.name;
  const lines: string[] = [
    `# skillsmith fish completion (autogenerated)`,
    `# To install: ${bin} completion fish > ~/.config/fish/completions/${bin}.fish`,
    ``,
  ];

  for (const sub of root.subcommands) {
    lines.push(
      `complete -c ${bin} -f -n '__fish_use_subcommand' -a ${sub.name} -d '${fishEscape(sub.description || sub.name)}'`,
    );
    for (const opt of sub.options) {
      const flag = [opt.short && `-s ${opt.short.replace(/^-/, '')}`, opt.long && `-l ${opt.long.replace(/^--/, '')}`]
        .filter(Boolean)
        .join(' ');
      if (!flag) continue;
      const choices = opt.choices ? ` -xa '${opt.choices.join(' ')}'` : '';
      const desc = opt.description ? ` -d '${fishEscape(opt.description)}'` : '';
      lines.push(
        `complete -c ${bin} -f -n '__fish_seen_subcommand_from ${sub.name}' ${flag}${choices}${desc}`,
      );
    }
    for (const arg of sub.args) {
      if (!arg.choices) continue;
      lines.push(
        `complete -c ${bin} -f -n '__fish_seen_subcommand_from ${sub.name}' -xa '${arg.choices.join(' ')}'`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/cli/tests/completion/fish.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/completion/fish.ts packages/cli/tests/completion/fish.test.ts
git commit -m "feat(cli): render fish completion from CompletionNode tree"
```

---

### Task 6: `completion` command wiring

**Files:**
- Create: `packages/cli/src/commands/completion.ts`
- Modify: `packages/cli/src/program.ts`
- Create: `packages/cli/tests/completion/integration.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from 'bun:test';

const BIN = 'packages/cli/src/index.ts';
const run = async (args: string[]) => {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    code,
  };
};

describe('skillsmith completion', () => {
  test('bash: exit 0, contains _skillsmith and agents', async () => {
    const r = await run(['completion', 'bash']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/_skillsmith/);
    expect(r.stdout).toContain('agents');
  });

  test('zsh: exit 0, has #compdef header', async () => {
    const r = await run(['completion', 'zsh']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^#compdef skillsmith/m);
  });

  test('fish: exit 0, has complete -c skillsmith lines', async () => {
    const r = await run(['completion', 'fish']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/complete -c skillsmith/);
  });

  test('unknown shell: exit 2', async () => {
    const r = await run(['completion', 'pwsh']);
    expect(r.code).toBe(2);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test packages/cli/tests/completion/integration.test.ts`
Expected: FAIL — `completion` subcommand not yet registered.

- [ ] **Step 3: Implement `packages/cli/src/commands/completion.ts`**

```ts
import type { Command } from 'commander';
import { renderBash } from '../completion/bash.ts';
import { renderFish } from '../completion/fish.ts';
import { walk } from '../completion/walk.ts';
import { renderZsh } from '../completion/zsh.ts';

export type Shell = 'bash' | 'zsh' | 'fish';

export const runCompletion = (program: Command, shell: Shell): string => {
  const nodes = walk(program);
  switch (shell) {
    case 'bash':
      return renderBash(nodes);
    case 'zsh':
      return renderZsh(nodes);
    case 'fish':
      return renderFish(nodes);
  }
};
```

- [ ] **Step 4: Register the command in `buildProgram`**

Add to `packages/cli/src/program.ts`, just before the `help` command block:

```ts
import { Argument } from 'commander';
import { runCompletion, type Shell } from './commands/completion.ts';

// inside buildProgram, after `version` subcommand:
program
  .command('completion')
  .description('Emit a shell completion script')
  .addArgument(new Argument('<shell>', 'Target shell').choices(['bash', 'zsh', 'fish']))
  .action((shell: Shell) => {
    process.stdout.write(runCompletion(program, shell));
  });
```

- [ ] **Step 5: Verify**

Run: `bun test packages/cli/tests/completion/integration.test.ts`
Expected: 4 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/completion.ts packages/cli/src/program.ts packages/cli/tests/completion/integration.test.ts
git commit -m "feat(cli): add completion command wiring walk+render into the commander tree"
```

---

### Task 7: Preview script

**Files:**
- Create: `scripts/preview-completions.ts`

- [ ] **Step 1: Implement `scripts/preview-completions.ts`**

```ts
#!/usr/bin/env bun
import { buildProgram } from '../packages/cli/src/program.ts';
import { runCompletion, type Shell } from '../packages/cli/src/commands/completion.ts';

const shells: Shell[] = ['bash', 'zsh', 'fish'];
const program = buildProgram();
for (const shell of shells) {
  process.stdout.write(`=== ${shell} ===\n`);
  process.stdout.write(runCompletion(program, shell));
  process.stdout.write('\n');
}
```

- [ ] **Step 2: Run it**

Run: `bun run scripts/preview-completions.ts | head -40`
Expected: shows `=== bash ===` header and the start of the bash script.

- [ ] **Step 3: Commit**

```bash
git add scripts/preview-completions.ts
git commit -m "chore: add preview-completions dev script to dump all shell outputs"
```

---

## Phase C — Core config layer

### Task 8: Config types and TOML schema

**Files:**
- Create: `packages/core/src/config/types.ts`
- Create: `packages/core/src/config/schema.ts`
- Create: `packages/core/tests/config/schema.test.ts`

- [ ] **Step 1: Add `smol-toml` to core deps**

Run:
```bash
cd packages/core && bun add smol-toml@^1.3.0 && cd ../..
```

- [ ] **Step 2: Write failing test `packages/core/tests/config/schema.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { parseConfig } from '../../src/config/schema.ts';

describe('parseConfig', () => {
  test('accepts empty TOML', () => {
    const r = parseConfig('');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  test('accepts a valid config with tool, scope, path, registry.default', () => {
    const toml = `
tool = "claude-code"
scope = "user"
path = "/custom"

[registry]
default = "github.com/acme"
`;
    const r = parseConfig(toml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tool).toBe('claude-code');
      expect(r.value.scope).toBe('user');
      expect(r.value.path).toBe('/custom');
      expect(r.value.registry?.default).toBe('github.com/acme');
    }
  });

  test('rejects unknown top-level key as config-error', () => {
    const r = parseConfig('garbage = 1\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });

  test('rejects unknown nested key', () => {
    const r = parseConfig('[registry]\nbogus = "x"\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });

  test('rejects invalid tool value', () => {
    const r = parseConfig('tool = "not-a-tool"\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });

  test('rejects malformed TOML syntax', () => {
    const r = parseConfig('this is not = valid toml\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });
});
```

- [ ] **Step 3: Verify it fails**

Run: `bun test packages/core/tests/config/schema.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `packages/core/src/config/types.ts`**

```ts
import type { SupportedTool } from '../agents/types.ts';

export type Scope = 'system' | 'user' | 'project';

export type ConfigLayer = 'defaults' | 'system' | 'user' | 'project' | 'explicit-file' | 'env';

export interface Config {
  tool?: SupportedTool;
  scope?: Scope;
  path?: string;
  registry?: { default?: string };
}

export type ConfigKey = 'tool' | 'scope' | 'path' | 'registry.default';

export const CONFIG_KEYS: readonly ConfigKey[] = ['tool', 'scope', 'path', 'registry.default'];

export interface EffectiveConfig {
  value: Config;
  sources: Partial<Record<ConfigKey, ConfigLayer>>;
  layers: Record<ConfigLayer, Config>;
}
```

- [ ] **Step 5: Implement `packages/core/src/config/schema.ts`**

```ts
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { SUPPORTED_TOOLS } from '../agents/types.ts';
import { type SkillSmithError, configError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Config } from './types.ts';

const RegistrySchema = z
  .object({ default: z.string().optional() })
  .strict('registry: unknown key');

const ConfigSchema = z
  .object({
    tool: z.enum(SUPPORTED_TOOLS as readonly [string, ...string[]]).optional(),
    scope: z.enum(['system', 'user', 'project']).optional(),
    path: z.string().optional(),
    registry: RegistrySchema.optional(),
  })
  .strict('unknown top-level key');

export const parseConfig = (text: string): Result<Config, SkillSmithError> => {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    return err(configError(`TOML parse error: ${e instanceof Error ? e.message : String(e)}`));
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') || '<root>';
    return err(configError(`config schema: ${path}: ${first?.message ?? 'invalid'}`));
  }
  return ok(parsed.data as Config);
};
```

- [ ] **Step 6: Extend `SkillSmithError` with `config-error`**

In `packages/core/src/errors.ts`:

```ts
export type SkillSmithError =
  | { code: 'generic'; message: string; cause?: unknown }
  | { code: 'unknown-tool'; tool: string }
  | { code: 'config-error'; message: string; file?: string; line?: number };

// existing factories unchanged; add:
export const configError = (
  message: string,
  opts: { file?: string; line?: number } = {},
): SkillSmithError => ({
  code: 'config-error',
  message,
  ...(opts.file !== undefined ? { file: opts.file } : {}),
  ...(opts.line !== undefined ? { line: opts.line } : {}),
});
```

- [ ] **Step 7: Verify schema tests pass**

Run: `bun test packages/core/tests/config/schema.test.ts`
Expected: 6 pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/config packages/core/src/errors.ts packages/core/tests/config packages/core/package.json bun.lock
git commit -m "feat(core): add Config types, zod schema, and config-error variant"
```

---

### Task 9: Config file paths

**Files:**
- Create: `packages/core/src/config/paths.ts`
- Create: `packages/core/tests/config/paths.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import {
  getConfigPath,
  findProjectConfig,
  resolveExplicitFile,
} from '../../src/config/paths.ts';

const env = (overrides: Partial<ScanEnv> = {}): ScanEnv => ({
  homeDir: '/home/u',
  path: [],
  platform: 'linux',
  xdg: { config: '/home/u/.config', data: '/home/u/.local/share', cache: '/home/u/.cache' },
  fileExists: async () => false,
  realpath: async (p) => p,
  runVersion: async () => 'unknown',
  ...overrides,
});

describe('getConfigPath', () => {
  test('user scope uses XDG config dir', () => {
    expect(getConfigPath(env(), 'user')).toBe('/home/u/.config/skillsmith/config.toml');
  });
  test('system scope uses /etc', () => {
    expect(getConfigPath(env(), 'system')).toBe('/etc/skillsmith/config.toml');
  });
  test('project scope uses given cwd', () => {
    expect(getConfigPath(env(), 'project', '/tmp/proj')).toBe('/tmp/proj/skillsmith.toml');
  });
});

describe('findProjectConfig', () => {
  test('returns null when no skillsmith.toml is found', async () => {
    const r = await findProjectConfig(env(), '/a/b/c');
    expect(r).toBeNull();
  });
  test('returns the nearest skillsmith.toml walking up', async () => {
    const existing = new Set(['/a/skillsmith.toml']);
    const e = env({ fileExists: async (p) => existing.has(p) });
    const r = await findProjectConfig(e, '/a/b/c');
    expect(r).toBe('/a/skillsmith.toml');
  });
  test('stops walk at .git boundary', async () => {
    const existing = new Set(['/top/skillsmith.toml', '/top/sub/.git']);
    const e = env({ fileExists: async (p) => existing.has(p) });
    const r = await findProjectConfig(e, '/top/sub/nested');
    expect(r).toBeNull();
  });
});

describe('resolveExplicitFile', () => {
  test('prefers flag over env', () => {
    expect(resolveExplicitFile({ flag: '/f', env: '/e' })).toBe('/f');
  });
  test('falls back to env when no flag', () => {
    expect(resolveExplicitFile({ flag: undefined, env: '/e' })).toBe('/e');
  });
  test('returns null when neither is set', () => {
    expect(resolveExplicitFile({ flag: undefined, env: undefined })).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/config/paths.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/config/paths.ts`**

```ts
import { dirname, join } from 'node:path';
import type { ScanEnv } from '../env/types.ts';
import type { Scope } from './types.ts';

export const getConfigPath = (env: ScanEnv, scope: Scope, cwd?: string): string => {
  switch (scope) {
    case 'system':
      return '/etc/skillsmith/config.toml';
    case 'user':
      return join(env.xdg.config, 'skillsmith', 'config.toml');
    case 'project':
      return join(cwd ?? process.cwd(), 'skillsmith.toml');
  }
};

export const findProjectConfig = async (
  env: ScanEnv,
  cwd: string,
): Promise<string | null> => {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, 'skillsmith.toml');
    if (await env.fileExists(candidate)) return candidate;
    const gitDir = join(dir, '.git');
    if (await env.fileExists(gitDir)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export const resolveExplicitFile = (input: {
  flag: string | undefined;
  env: string | undefined;
}): string | null => input.flag ?? input.env ?? null;
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/config/paths.test.ts`
Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/paths.ts packages/core/tests/config/paths.test.ts
git commit -m "feat(core): add config path resolution (XDG + walk-up + explicit)"
```

---

### Task 10: Env-var layer

**Files:**
- Create: `packages/core/src/config/env.ts`
- Create: `packages/core/tests/config/env.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { configFromEnv } from '../../src/config/env.ts';

describe('configFromEnv', () => {
  test('empty env → empty config', () => {
    expect(configFromEnv({})).toEqual({});
  });
  test('SKILLSMITH_TOOL, SKILLSMITH_SCOPE populate top-level', () => {
    expect(configFromEnv({ SKILLSMITH_TOOL: 'codex', SKILLSMITH_SCOPE: 'user' })).toEqual({
      tool: 'codex',
      scope: 'user',
    });
  });
  test('SKILLSMITH_PATH populates path', () => {
    expect(configFromEnv({ SKILLSMITH_PATH: '/x' })).toEqual({ path: '/x' });
  });
  test('SKILLSMITH_REGISTRY populates registry.default', () => {
    expect(configFromEnv({ SKILLSMITH_REGISTRY: 'gh/acme' })).toEqual({
      registry: { default: 'gh/acme' },
    });
  });
  test('ignores unknown SKILLSMITH_* vars', () => {
    expect(configFromEnv({ SKILLSMITH_EXTRA: 'x', SKILLSMITH_TOOL: 'codex' })).toEqual({
      tool: 'codex',
    });
  });
  test('ignores invalid tool values (validation happens downstream)', () => {
    // env.ts is a raw extractor; schema validation covers invalid values
    expect(configFromEnv({ SKILLSMITH_TOOL: 'nope' })).toEqual({ tool: 'nope' as never });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/config/env.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/config/env.ts`**

```ts
import type { Config } from './types.ts';

export const configFromEnv = (env: Record<string, string | undefined>): Config => {
  const c: Config = {};
  if (env.SKILLSMITH_TOOL) c.tool = env.SKILLSMITH_TOOL as Config['tool'];
  if (env.SKILLSMITH_SCOPE) c.scope = env.SKILLSMITH_SCOPE as Config['scope'];
  if (env.SKILLSMITH_PATH) c.path = env.SKILLSMITH_PATH;
  if (env.SKILLSMITH_REGISTRY) c.registry = { default: env.SKILLSMITH_REGISTRY };
  return c;
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/config/env.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/env.ts packages/core/tests/config/env.test.ts
git commit -m "feat(core): read partial Config from SKILLSMITH_* env vars"
```

---

### Task 11: `loadConfig` with layer merge

**Files:**
- Create: `packages/core/src/config/load.ts`
- Create: `packages/core/tests/config/load.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import type { ScanEnv } from '../../src/env/types.ts';
import { loadConfig } from '../../src/config/load.ts';

const makeEnv = (overrides: Partial<ScanEnv> & { files?: Record<string, string> } = {}): ScanEnv => {
  const files = overrides.files ?? {};
  return {
    homeDir: '/home/u',
    path: [],
    platform: 'linux',
    xdg: { config: '/home/u/.config', data: '/home/u/.local/share', cache: '/home/u/.cache' },
    fileExists: async (p) => p in files,
    realpath: async (p) => p,
    runVersion: async () => 'unknown',
    ...overrides,
  };
};

describe('loadConfig', () => {
  test('empty system → returns defaults', async () => {
    const r = await loadConfig(makeEnv(), { envVars: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value).toEqual({});
      expect(Object.keys(r.value.sources)).toHaveLength(0);
    }
  });

  test('user file wins over system', async () => {
    const e = makeEnv({
      files: {
        '/etc/skillsmith/config.toml': 'tool = "codex"\n',
        '/home/u/.config/skillsmith/config.toml': 'tool = "claude-code"\n',
      },
    });
    const r = await loadConfig(e, { envVars: {}, readFile: async (p) => (e as unknown as { files: Record<string, string> }).files[p]! });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value.tool).toBe('claude-code');
      expect(r.value.sources.tool).toBe('user');
    }
  });

  test('env wins over user', async () => {
    const e = makeEnv({
      files: { '/home/u/.config/skillsmith/config.toml': 'tool = "claude-code"\n' },
    });
    const r = await loadConfig(e, {
      envVars: { SKILLSMITH_TOOL: 'codex' },
      readFile: async (p) => (e as unknown as { files: Record<string, string> }).files[p]!,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value.tool).toBe('codex');
      expect(r.value.sources.tool).toBe('env');
    }
  });

  test('explicit-file wins over env? — no, env wins per spec', async () => {
    // env > explicit-file per §2.2 precedence
    const e = makeEnv({ files: { '/tmp/explicit.toml': 'tool = "claude-code"\n' } });
    const r = await loadConfig(e, {
      envVars: { SKILLSMITH_TOOL: 'codex' },
      explicitFile: '/tmp/explicit.toml',
      readFile: async (p) => (e as unknown as { files: Record<string, string> }).files[p]!,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sources.tool).toBe('env');
  });

  test('malformed user config → config-error', async () => {
    const e = makeEnv({
      files: { '/home/u/.config/skillsmith/config.toml': 'garbage = nope bar\n' },
    });
    const r = await loadConfig(e, {
      envVars: {},
      readFile: async (p) => (e as unknown as { files: Record<string, string> }).files[p]!,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test packages/core/tests/config/load.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/config/load.ts`**

```ts
import { readFile as fsReadFile } from 'node:fs/promises';
import type { ScanEnv } from '../env/types.ts';
import { type SkillSmithError, configError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { configFromEnv } from './env.ts';
import { findProjectConfig, getConfigPath, resolveExplicitFile } from './paths.ts';
import { parseConfig } from './schema.ts';
import type { Config, ConfigKey, ConfigLayer, EffectiveConfig } from './types.ts';

export interface LoadConfigOpts {
  explicitFile?: string;
  explicitFileEnv?: string;
  envVars?: Record<string, string | undefined>;
  cwd?: string;
  readFile?: (p: string) => Promise<string>;
}

const DEFAULT_READ = async (p: string) => fsReadFile(p, 'utf8');

const tryLoadFile = async (
  read: (p: string) => Promise<string>,
  exists: (p: string) => Promise<boolean>,
  p: string,
): Promise<Result<Config | null, SkillSmithError>> => {
  if (!(await exists(p))) return ok(null);
  let text: string;
  try {
    text = await read(p);
  } catch (e) {
    return err(configError(`failed to read ${p}: ${e instanceof Error ? e.message : String(e)}`, { file: p }));
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) return err({ ...parsed.error, file: p });
  return ok(parsed.value);
};

const ORDER: ConfigLayer[] = ['defaults', 'system', 'user', 'project', 'explicit-file', 'env'];

const KEY_PATHS: Record<ConfigKey, (c: Config) => unknown> = {
  tool: (c) => c.tool,
  scope: (c) => c.scope,
  path: (c) => c.path,
  'registry.default': (c) => c.registry?.default,
};

const assign = (target: Config, key: ConfigKey, value: unknown): void => {
  switch (key) {
    case 'tool':
      target.tool = value as Config['tool'];
      return;
    case 'scope':
      target.scope = value as Config['scope'];
      return;
    case 'path':
      target.path = value as string;
      return;
    case 'registry.default':
      target.registry = { ...(target.registry ?? {}), default: value as string };
      return;
  }
};

export const loadConfig = async (
  env: ScanEnv,
  opts: LoadConfigOpts = {},
): Promise<Result<EffectiveConfig, SkillSmithError>> => {
  const read = opts.readFile ?? DEFAULT_READ;
  const envVars = opts.envVars ?? (process.env as Record<string, string | undefined>);
  const cwd = opts.cwd ?? process.cwd();
  const explicitPath = resolveExplicitFile({
    flag: opts.explicitFile,
    env: opts.explicitFileEnv,
  });
  const projectPath = await findProjectConfig(env, cwd);

  const layers: Record<ConfigLayer, Config> = {
    defaults: {},
    system: {},
    user: {},
    project: {},
    'explicit-file': {},
    env: configFromEnv(envVars),
  };

  const systemR = await tryLoadFile(read, env.fileExists, getConfigPath(env, 'system'));
  if (!systemR.ok) return systemR;
  if (systemR.value) layers.system = systemR.value;

  const userR = await tryLoadFile(read, env.fileExists, getConfigPath(env, 'user'));
  if (!userR.ok) return userR;
  if (userR.value) layers.user = userR.value;

  if (projectPath) {
    const projectR = await tryLoadFile(read, env.fileExists, projectPath);
    if (!projectR.ok) return projectR;
    if (projectR.value) layers.project = projectR.value;
  }
  if (explicitPath) {
    const explicitR = await tryLoadFile(read, env.fileExists, explicitPath);
    if (!explicitR.ok) return explicitR;
    if (explicitR.value) layers['explicit-file'] = explicitR.value;
  }

  const value: Config = {};
  const sources: Partial<Record<ConfigKey, ConfigLayer>> = {};
  const keys: ConfigKey[] = ['tool', 'scope', 'path', 'registry.default'];
  for (const key of keys) {
    for (let i = ORDER.length - 1; i >= 0; i--) {
      const layer = ORDER[i] as ConfigLayer;
      const v = KEY_PATHS[key](layers[layer]);
      if (v !== undefined) {
        assign(value, key, v);
        sources[key] = layer;
        break;
      }
    }
  }

  return ok({ value, sources, layers });
};
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/config/load.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/load.ts packages/core/tests/config/load.test.ts
git commit -m "feat(core): layered loadConfig with per-key source tracking"
```

---

### Task 12: `saveConfig` atomic write with proper-lockfile

**Files:**
- Create: `packages/core/src/config/save.ts`
- Create: `packages/core/tests/config/save.test.ts`

- [ ] **Step 1: Add `proper-lockfile` to core deps**

Run:
```bash
cd packages/core && bun add proper-lockfile@^4.1.2 && cd ../..
```

- [ ] **Step 2: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultScanEnv } from '../../src/env/default.ts';
import { saveConfig } from '../../src/config/save.ts';

const tmpDir = async (name: string): Promise<string> => {
  const d = join('/tmp', `sk-save-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(d, { recursive: true });
  return d;
};

describe('saveConfig', () => {
  test('writes a new user config file', async () => {
    const env = await defaultScanEnv();
    const d = await tmpDir('new');
    const xdgEnv = { ...env, xdg: { ...env.xdg, config: d } };
    const r = await saveConfig(xdgEnv, {
      scope: 'user',
      patch: { tool: 'codex' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const content = await readFile(r.value.file, 'utf8');
      expect(content).toContain('tool');
      expect(content).toContain('codex');
    }
    await rm(d, { recursive: true, force: true });
  });

  test('merges into existing file, preserving other keys', async () => {
    const env = await defaultScanEnv();
    const d = await tmpDir('merge');
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'scope = "user"\n');
    const xdgEnv = { ...env, xdg: { ...env.xdg, config: d } };
    const r = await saveConfig(xdgEnv, { scope: 'user', patch: { tool: 'codex' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const content = await readFile(r.value.file, 'utf8');
      expect(content).toContain('scope');
      expect(content).toContain('tool');
    }
    await rm(d, { recursive: true, force: true });
  });

  test('deletes a key when requested', async () => {
    const env = await defaultScanEnv();
    const d = await tmpDir('delete');
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'tool = "codex"\nscope = "user"\n');
    const xdgEnv = { ...env, xdg: { ...env.xdg, config: d } };
    const r = await saveConfig(xdgEnv, { scope: 'user', patch: {}, delete: ['tool'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const content = await readFile(r.value.file, 'utf8');
      expect(content).not.toContain('tool');
      expect(content).toContain('scope');
    }
    await rm(d, { recursive: true, force: true });
  });

  test('concurrent writes to same file both succeed with coherent final state', async () => {
    const env = await defaultScanEnv();
    const d = await tmpDir('concurrent');
    const xdgEnv = { ...env, xdg: { ...env.xdg, config: d } };
    const [r1, r2] = await Promise.all([
      saveConfig(xdgEnv, { scope: 'user', patch: { tool: 'codex' } }),
      saveConfig(xdgEnv, { scope: 'user', patch: { scope: 'user' } }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const content = await readFile(join(d, 'skillsmith/config.toml'), 'utf8');
    // at least one of the two updates is present; no corruption
    expect(content.includes('tool') || content.includes('scope')).toBe(true);
    await rm(d, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Verify failure**

Run: `bun test packages/core/tests/config/save.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `packages/core/src/config/save.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { stringify as stringifyToml } from 'smol-toml';
import type { ScanEnv } from '../env/types.ts';
import { type SkillSmithError, configError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { getConfigPath } from './paths.ts';
import { parseConfig } from './schema.ts';
import type { Config, ConfigKey, Scope } from './types.ts';

export interface SaveConfigOpts {
  scope: Scope;
  patch?: Partial<Config>;
  delete?: readonly ConfigKey[];
  cwd?: string;
}

const deleteKey = (c: Config, key: ConfigKey): void => {
  switch (key) {
    case 'tool':
      c.tool = undefined;
      return;
    case 'scope':
      c.scope = undefined;
      return;
    case 'path':
      c.path = undefined;
      return;
    case 'registry.default':
      if (c.registry) c.registry.default = undefined;
      return;
  }
};

const stripUndefined = (c: Config): Config => {
  const out: Config = {};
  if (c.tool !== undefined) out.tool = c.tool;
  if (c.scope !== undefined) out.scope = c.scope;
  if (c.path !== undefined) out.path = c.path;
  if (c.registry) {
    const r: Record<string, unknown> = {};
    if (c.registry.default !== undefined) r.default = c.registry.default;
    if (Object.keys(r).length > 0) out.registry = r as Config['registry'];
  }
  return out;
};

export const saveConfig = async (
  env: ScanEnv,
  opts: SaveConfigOpts,
): Promise<Result<{ file: string }, SkillSmithError>> => {
  const file = getConfigPath(env, opts.scope, opts.cwd);
  try {
    await mkdir(dirname(file), { recursive: true });
  } catch (e) {
    return err(configError(`cannot create directory for ${file}: ${e instanceof Error ? e.message : String(e)}`, { file }));
  }

  // Ensure the file exists so proper-lockfile has something to lock
  try {
    await writeFile(file, '', { flag: 'ax' });
  } catch {
    // already exists — fine
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(file, { stale: 10_000, retries: { retries: 5, factor: 1, minTimeout: 10, maxTimeout: 100 } });
  } catch (e) {
    return err(configError(`lock failed: ${e instanceof Error ? e.message : String(e)}`, { file }));
  }

  try {
    let existing: Config = {};
    const text = await readFile(file, 'utf8');
    if (text.trim().length > 0) {
      const parsed = parseConfig(text);
      if (!parsed.ok) return err({ ...parsed.error, file });
      existing = parsed.value;
    }

    const merged: Config = { ...existing, ...(opts.patch ?? {}) };
    if (opts.patch?.registry) {
      merged.registry = { ...(existing.registry ?? {}), ...opts.patch.registry };
    }
    for (const key of opts.delete ?? []) deleteKey(merged, key);

    const serialized = stringifyToml(stripUndefined(merged) as Record<string, unknown>);
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, serialized);
    await rename(tmp, file);
    return ok({ file });
  } catch (e) {
    return err(configError(`save failed: ${e instanceof Error ? e.message : String(e)}`, { file }));
  } finally {
    if (release) await release().catch(() => {});
  }
};
```

- [ ] **Step 5: Verify**

Run: `bun test packages/core/tests/config/save.test.ts`
Expected: 4 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/save.ts packages/core/tests/config/save.test.ts packages/core/package.json bun.lock
git commit -m "feat(core): saveConfig with proper-lockfile + atomic write-temp+rename"
```

---

### Task 13: Expose config API from `@skillsmith/core`

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/public-types.ts`
- Modify: `packages/core/tests/public-api.test.ts`

- [ ] **Step 1: Extend `packages/core/src/public-types.ts`**

Add these re-exports:

```ts
export type { Config, ConfigKey, ConfigLayer, EffectiveConfig, Scope } from './config/types.ts';
export { CONFIG_KEYS } from './config/types.ts';
export type { LoadConfigOpts } from './config/load.ts';
export type { SaveConfigOpts } from './config/save.ts';
```

- [ ] **Step 2: Extend `packages/core/src/index.ts`**

Add:

```ts
export { loadConfig } from './config/load.ts';
export { saveConfig } from './config/save.ts';
export { getConfigPath, findProjectConfig } from './config/paths.ts';
export { configError } from './errors.ts';
export { CONFIG_KEYS } from './config/types.ts';
```

- [ ] **Step 3: Update `packages/core/tests/public-api.test.ts`** to include the new symbols in the `expected` set:

```ts
    const expected = new Set([
      'VERSION',
      'defaultScanEnv',
      'noopLogger',
      'registry',
      'listSupportedTools',
      'getAgent',
      'detectAll',
      'detectTool',
      'ok',
      'err',
      'isOk',
      'isErr',
      'map',
      'mapErr',
      'genericError',
      'unknownToolError',
      'configError',
      'loadConfig',
      'saveConfig',
      'getConfigPath',
      'findProjectConfig',
      'CONFIG_KEYS',
    ]);
```

- [ ] **Step 4: Verify**

Run: `bun test packages/core/tests/public-api.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/public-types.ts packages/core/tests/public-api.test.ts
git commit -m "feat(core): export loadConfig, saveConfig, and config types publicly"
```

---

## Phase D — CLI `config` command

### Task 14: Exit-code mapping for `config-error`

**Files:**
- Modify: `packages/cli/src/util/exit-codes.ts`
- Modify: `packages/cli/tests/util/exit-codes.test.ts`

- [ ] **Step 1: Extend test**

Add a test in `packages/cli/tests/util/exit-codes.test.ts`:

```ts
  test("'config-error' → 3", () => {
    const e: SkillSmithError = { code: 'config-error', message: 'boom' };
    expect(exitCodeForError(e)).toBe(3);
  });
```

- [ ] **Step 2: Extend impl**

In `packages/cli/src/util/exit-codes.ts`:

```ts
    case 'config-error':
      return 3;
```

- [ ] **Step 3: Verify**

Run: `bun test packages/cli/tests/util/exit-codes.test.ts`
Expected: 3 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/util/exit-codes.ts packages/cli/tests/util/exit-codes.test.ts
git commit -m "feat(cli): map config-error to exit code 3"
```

---

### Task 15: `config get` subcommand

**Files:**
- Create: `packages/cli/src/commands/config/get.ts`
- Create: `packages/cli/tests/commands/config-get.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import type { ScanEnv, EffectiveConfig } from '@skillsmith/core';
import { runConfigGet } from '../../src/commands/config/get.ts';

const env: ScanEnv = {
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async () => false,
  realpath: async (p) => p,
  runVersion: async () => 'unknown',
};

const stub = (effective: EffectiveConfig) =>
  async () => ({ ok: true as const, value: effective });

describe('runConfigGet', () => {
  test('returns the effective value with source when no --scope', async () => {
    const eff: EffectiveConfig = {
      value: { tool: 'codex' },
      sources: { tool: 'user' },
      layers: { defaults: {}, system: {}, user: { tool: 'codex' }, project: {}, 'explicit-file': {}, env: {} },
    };
    const r = await runConfigGet({ env, key: 'tool', loadConfig: stub(eff) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.value).toBe('codex');
  });

  test('unknown key → exit code 2 signal', async () => {
    const r = await runConfigGet({ env, key: 'nonsense', loadConfig: stub({ value: {}, sources: {}, layers: { defaults: {}, system: {}, user: {}, project: {}, 'explicit-file': {}, env: {} } }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-key');
  });

  test('scope-specific read returns only that layer', async () => {
    const eff: EffectiveConfig = {
      value: { tool: 'codex' },
      sources: { tool: 'env' },
      layers: {
        defaults: {},
        system: {},
        user: { tool: 'claude-code' },
        project: {},
        'explicit-file': {},
        env: { tool: 'codex' },
      },
    };
    const r = await runConfigGet({ env, key: 'tool', scope: 'user', loadConfig: stub(eff) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.value).toBe('claude-code');
  });
});
```

- [ ] **Step 2: Implement `packages/cli/src/commands/config/get.ts`**

```ts
import {
  CONFIG_KEYS,
  type ConfigKey,
  type EffectiveConfig,
  loadConfig,
  type Result,
  type ScanEnv,
  type Scope,
  type SkillSmithError,
} from '@skillsmith/core';

export interface RunConfigGetInput {
  env: ScanEnv;
  key: string;
  scope?: Scope;
  json?: boolean;
  loadConfig?: (env: ScanEnv) => Promise<Result<EffectiveConfig, SkillSmithError>>;
}

export type RunConfigGetResult =
  | { ok: true; value: string; source?: string }
  | { ok: false; error: SkillSmithError | { code: 'unknown-key'; key: string } | { code: 'unset'; key: string; scope?: Scope } };

const getByKey = (layer: EffectiveConfig['layers'][keyof EffectiveConfig['layers']], key: ConfigKey): string | undefined => {
  switch (key) {
    case 'tool':
      return layer.tool;
    case 'scope':
      return layer.scope;
    case 'path':
      return layer.path;
    case 'registry.default':
      return layer.registry?.default;
  }
};

export const runConfigGet = async (input: RunConfigGetInput): Promise<RunConfigGetResult> => {
  if (!(CONFIG_KEYS as readonly string[]).includes(input.key)) {
    return { ok: false, error: { code: 'unknown-key', key: input.key } };
  }
  const key = input.key as ConfigKey;
  const loader = input.loadConfig ?? ((env: ScanEnv) => loadConfig(env));
  const r = await loader(input.env);
  if (!r.ok) return { ok: false, error: r.error };
  const eff = r.value;

  if (input.scope) {
    const v = getByKey(eff.layers[input.scope], key);
    if (v === undefined) return { ok: false, error: { code: 'unset', key: input.key, scope: input.scope } };
    return { ok: true, value: v };
  }
  const v = getByKey(eff.layers[eff.sources[key] ?? 'defaults'], key);
  if (v === undefined) return { ok: false, error: { code: 'unset', key: input.key } };
  return { ok: true, value: v, source: eff.sources[key] };
};
```

- [ ] **Step 3: Verify**

Run: `bun test packages/cli/tests/commands/config-get.test.ts`
Expected: 3 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/config/get.ts packages/cli/tests/commands/config-get.test.ts
git commit -m "feat(cli): add config get subcommand handler"
```

---

### Task 16: `config set` subcommand

**Files:**
- Create: `packages/cli/src/commands/config/set.ts`
- Create: `packages/cli/tests/commands/config-set.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultScanEnv } from '@skillsmith/core';
import { runConfigSet } from '../../src/commands/config/set.ts';

const tmp = async (name: string) => {
  const d = join('/tmp', `sk-cli-set-${name}-${Date.now()}`);
  await mkdir(d, { recursive: true });
  return d;
};

describe('runConfigSet', () => {
  test('writes tool=codex to user config', async () => {
    const baseEnv = await defaultScanEnv();
    const d = await tmp('tool');
    const env = { ...baseEnv, xdg: { ...baseEnv.xdg, config: d } };
    const r = await runConfigSet({ env, key: 'tool', value: 'codex' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const c = await readFile(r.file, 'utf8');
      expect(c).toContain('codex');
    }
    await rm(d, { recursive: true, force: true });
  });

  test('rejects unknown key', async () => {
    const baseEnv = await defaultScanEnv();
    const r = await runConfigSet({ env: baseEnv, key: 'nope', value: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-key');
  });

  test('rejects invalid value per schema', async () => {
    const baseEnv = await defaultScanEnv();
    const d = await tmp('invalid');
    const env = { ...baseEnv, xdg: { ...baseEnv.xdg, config: d } };
    const r = await runConfigSet({ env, key: 'tool', value: 'not-a-tool' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
    await rm(d, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Implement `packages/cli/src/commands/config/set.ts`**

```ts
import {
  CONFIG_KEYS,
  type ConfigKey,
  type Result,
  type ScanEnv,
  type Scope,
  saveConfig,
  type SkillSmithError,
} from '@skillsmith/core';

export interface RunConfigSetInput {
  env: ScanEnv;
  key: string;
  value: string;
  scope?: Scope;
  cwd?: string;
}

export type RunConfigSetResult =
  | { ok: true; file: string }
  | { ok: false; error: SkillSmithError | { code: 'unknown-key'; key: string } };

const patchFor = (key: ConfigKey, value: string): Parameters<typeof saveConfig>[1]['patch'] => {
  switch (key) {
    case 'tool':
      return { tool: value as never };
    case 'scope':
      return { scope: value as Scope };
    case 'path':
      return { path: value };
    case 'registry.default':
      return { registry: { default: value } };
  }
};

export const runConfigSet = async (input: RunConfigSetInput): Promise<RunConfigSetResult> => {
  if (!(CONFIG_KEYS as readonly string[]).includes(input.key)) {
    return { ok: false, error: { code: 'unknown-key', key: input.key } };
  }
  const key = input.key as ConfigKey;
  const scope = input.scope ?? 'user';
  const r: Result<{ file: string }, SkillSmithError> = await saveConfig(input.env, {
    scope,
    patch: patchFor(key, input.value),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, file: r.value.file };
};
```

- [ ] **Step 3: Verify**

Run: `bun test packages/cli/tests/commands/config-set.test.ts`
Expected: 3 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/config packages/cli/tests/commands/config-set.test.ts
git commit -m "feat(cli): add config set subcommand handler"
```

---

### Task 17: `config list` and `config unset` subcommands

**Files:**
- Create: `packages/cli/src/commands/config/list.ts`
- Create: `packages/cli/src/commands/config/unset.ts`
- Create: `packages/cli/tests/commands/config-list.test.ts`
- Create: `packages/cli/tests/commands/config-unset.test.ts`

- [ ] **Step 1: Failing tests**

`packages/cli/tests/commands/config-list.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { EffectiveConfig, ScanEnv } from '@skillsmith/core';
import { runConfigList } from '../../src/commands/config/list.ts';

const env: ScanEnv = {
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async () => false,
  realpath: async (p) => p,
  runVersion: async () => 'unknown',
};

const stub = (effective: EffectiveConfig) =>
  async () => ({ ok: true as const, value: effective });

describe('runConfigList', () => {
  test('text output: key = value lines with source comments', async () => {
    const eff: EffectiveConfig = {
      value: { tool: 'codex', scope: 'user' },
      sources: { tool: 'user', scope: 'env' },
      layers: {
        defaults: {},
        system: {},
        user: { tool: 'codex' },
        project: {},
        'explicit-file': {},
        env: { scope: 'user' },
      },
    };
    const r = await runConfigList({ env, loadConfig: stub(eff) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain('tool = "codex"');
      expect(r.output).toContain('# source: user');
      expect(r.output).toContain('scope = "user"');
      expect(r.output).toContain('# source: env');
    }
  });

  test('json output: effective + sources + layers', async () => {
    const eff: EffectiveConfig = {
      value: { tool: 'codex' },
      sources: { tool: 'user' },
      layers: { defaults: {}, system: {}, user: { tool: 'codex' }, project: {}, 'explicit-file': {}, env: {} },
    };
    const r = await runConfigList({ env, json: true, loadConfig: stub(eff) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = JSON.parse(r.output);
      expect(parsed.effective.tool).toBe('codex');
      expect(parsed.sources.tool).toBe('user');
    }
  });
});
```

`packages/cli/tests/commands/config-unset.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultScanEnv } from '@skillsmith/core';
import { runConfigUnset } from '../../src/commands/config/unset.ts';

describe('runConfigUnset', () => {
  test('removes a key from user config', async () => {
    const baseEnv = await defaultScanEnv();
    const d = join('/tmp', `sk-unset-${Date.now()}`);
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'tool = "codex"\nscope = "user"\n');
    const env = { ...baseEnv, xdg: { ...baseEnv.xdg, config: d } };
    const r = await runConfigUnset({ env, key: 'tool' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const c = await readFile(r.file, 'utf8');
      expect(c).not.toContain('tool');
      expect(c).toContain('scope');
    }
    await rm(d, { recursive: true, force: true });
  });

  test('idempotent: unset when not present still ok', async () => {
    const baseEnv = await defaultScanEnv();
    const d = join('/tmp', `sk-unset-idem-${Date.now()}`);
    const env = { ...baseEnv, xdg: { ...baseEnv.xdg, config: d } };
    const r = await runConfigUnset({ env, key: 'tool' });
    expect(r.ok).toBe(true);
    await rm(d, { recursive: true, force: true });
  });

  test('rejects unknown key', async () => {
    const baseEnv = await defaultScanEnv();
    const r = await runConfigUnset({ env: baseEnv, key: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown-key');
  });
});
```

- [ ] **Step 2: Implement `packages/cli/src/commands/config/list.ts`**

```ts
import {
  CONFIG_KEYS,
  type ConfigKey,
  type EffectiveConfig,
  loadConfig,
  type Result,
  type ScanEnv,
  type Scope,
  type SkillSmithError,
} from '@skillsmith/core';

export interface RunConfigListInput {
  env: ScanEnv;
  scope?: Scope;
  json?: boolean;
  loadConfig?: (env: ScanEnv) => Promise<Result<EffectiveConfig, SkillSmithError>>;
}

export type RunConfigListResult =
  | { ok: true; output: string }
  | { ok: false; error: SkillSmithError };

const getByKey = (
  layer: EffectiveConfig['layers'][keyof EffectiveConfig['layers']],
  key: ConfigKey,
): string | undefined => {
  switch (key) {
    case 'tool':
      return layer.tool;
    case 'scope':
      return layer.scope;
    case 'path':
      return layer.path;
    case 'registry.default':
      return layer.registry?.default;
  }
};

export const runConfigList = async (input: RunConfigListInput): Promise<RunConfigListResult> => {
  const loader = input.loadConfig ?? ((env: ScanEnv) => loadConfig(env));
  const r = await loader(input.env);
  if (!r.ok) return { ok: false, error: r.error };
  const eff = r.value;

  if (input.json) {
    if (input.scope) {
      return { ok: true, output: JSON.stringify(eff.layers[input.scope], null, 2) };
    }
    return {
      ok: true,
      output: JSON.stringify(
        { effective: eff.value, sources: eff.sources, layers: eff.layers },
        null,
        2,
      ),
    };
  }

  const lines: string[] = [];
  if (input.scope) {
    const layer = eff.layers[input.scope];
    for (const key of CONFIG_KEYS) {
      const v = getByKey(layer, key);
      if (v !== undefined) lines.push(`${key} = ${JSON.stringify(v)}`);
    }
  } else {
    for (const key of CONFIG_KEYS) {
      const source = eff.sources[key];
      if (!source) continue;
      const v = getByKey(eff.layers[source], key);
      if (v !== undefined) lines.push(`${key} = ${JSON.stringify(v)}    # source: ${source}`);
    }
  }
  return { ok: true, output: `${lines.join('\n')}\n` };
};
```

- [ ] **Step 3: Implement `packages/cli/src/commands/config/unset.ts`**

```ts
import {
  CONFIG_KEYS,
  type ConfigKey,
  type ScanEnv,
  type Scope,
  saveConfig,
  type SkillSmithError,
} from '@skillsmith/core';

export interface RunConfigUnsetInput {
  env: ScanEnv;
  key: string;
  scope?: Scope;
  cwd?: string;
}

export type RunConfigUnsetResult =
  | { ok: true; file: string }
  | { ok: false; error: SkillSmithError | { code: 'unknown-key'; key: string } };

export const runConfigUnset = async (input: RunConfigUnsetInput): Promise<RunConfigUnsetResult> => {
  if (!(CONFIG_KEYS as readonly string[]).includes(input.key)) {
    return { ok: false, error: { code: 'unknown-key', key: input.key } };
  }
  const scope = input.scope ?? 'user';
  const r = await saveConfig(input.env, {
    scope,
    delete: [input.key as ConfigKey],
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, file: r.value.file };
};
```

- [ ] **Step 4: Verify both test files pass**

Run: `bun test packages/cli/tests/commands/config-list.test.ts packages/cli/tests/commands/config-unset.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/config/list.ts packages/cli/src/commands/config/unset.ts packages/cli/tests/commands/config-list.test.ts packages/cli/tests/commands/config-unset.test.ts
git commit -m "feat(cli): add config list and config unset subcommand handlers"
```

---

### Task 18: `config` dispatcher + commander wiring

**Files:**
- Create: `packages/cli/src/commands/config.ts`
- Modify: `packages/cli/src/program.ts`
- Create: `packages/cli/tests/commands/config-integration.test.ts`

- [ ] **Step 1: Failing integration test**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BIN = 'packages/cli/src/index.ts';
const run = async (args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const code = await proc.exited;
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    code,
  };
};

describe('skillsmith config', () => {
  test('get/set round-trip at user scope', async () => {
    const d = join('/tmp', `sk-rt-${Date.now()}`);
    await mkdir(d, { recursive: true });
    try {
      const setR = await run(['config', 'set', 'tool', 'codex'], { XDG_CONFIG_HOME: d });
      expect(setR.code).toBe(0);
      const getR = await run(['config', 'get', 'tool'], { XDG_CONFIG_HOME: d });
      expect(getR.code).toBe(0);
      expect(getR.stdout.trim()).toBe('codex');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('list --json emits structured output', async () => {
    const d = join('/tmp', `sk-list-${Date.now()}`);
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'tool = "codex"\n');
    try {
      const r = await run(['config', 'list', '--json'], { XDG_CONFIG_HOME: d });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.effective.tool).toBe('codex');
      expect(parsed.sources.tool).toBe('user');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('unset removes a key', async () => {
    const d = join('/tmp', `sk-unset-${Date.now()}`);
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'tool = "codex"\nscope = "user"\n');
    try {
      const r = await run(['config', 'unset', 'tool'], { XDG_CONFIG_HOME: d });
      expect(r.code).toBe(0);
      const getR = await run(['config', 'get', 'tool'], { XDG_CONFIG_HOME: d });
      expect(getR.code).toBe(1);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('unknown key exits 2', async () => {
    const r = await run(['config', 'get', 'nope']);
    expect(r.code).toBe(2);
  });

  test('malformed config exits 3', async () => {
    const d = join('/tmp', `sk-bad-${Date.now()}`);
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'garbage = nope bar\n');
    try {
      const r = await run(['config', 'list'], { XDG_CONFIG_HOME: d });
      expect(r.code).toBe(3);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Implement `packages/cli/src/commands/config.ts`**

```ts
import { defaultScanEnv, type Scope } from '@skillsmith/core';
import { Command, Option } from 'commander';
import { exitCodeForError } from '../util/exit-codes.ts';
import { runConfigGet } from './config/get.ts';
import { runConfigList } from './config/list.ts';
import { runConfigSet } from './config/set.ts';
import { runConfigUnset } from './config/unset.ts';

const scopeOption = () =>
  new Option('--scope <s>', 'user | project | system').choices(['user', 'project', 'system']);

export const configCommand = (): Command => {
  const cmd = new Command('config').description('Manage SkillSmith configuration');

  cmd
    .command('get <key>')
    .description('Print a config value')
    .addOption(scopeOption())
    .option('--json', 'Emit JSON', false)
    .action(async (key: string, opts: { scope?: Scope; json: boolean }) => {
      const env = await defaultScanEnv();
      const r = await runConfigGet({ env, key, ...(opts.scope ? { scope: opts.scope } : {}), json: opts.json });
      if (!r.ok) {
        if (r.error.code === 'unknown-key') {
          process.stderr.write(`error: unknown config key '${r.error.key}'\n`);
          process.exit(2);
        }
        if (r.error.code === 'unset') {
          process.stderr.write(`error: '${r.error.key}' is not set${r.error.scope ? ` at ${r.error.scope} scope` : ''}\n`);
          process.exit(1);
        }
        process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
        process.exit(exitCodeForError(r.error));
      }
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ key, value: r.value, ...(r.source ? { source: r.source } : {}) }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`${r.value}\n`);
      }
    });

  cmd
    .command('set <key> <value>')
    .description('Set a config value (default scope: user)')
    .addOption(scopeOption())
    .action(async (key: string, value: string, opts: { scope?: Scope }) => {
      const env = await defaultScanEnv();
      const r = await runConfigSet({ env, key, value, ...(opts.scope ? { scope: opts.scope } : {}) });
      if (!r.ok) {
        if (r.error.code === 'unknown-key') {
          process.stderr.write(`error: unknown config key '${r.error.key}'\n`);
          process.exit(2);
        }
        process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
        process.exit(exitCodeForError(r.error));
      }
      process.stderr.write(`wrote ${r.file}\n`);
    });

  cmd
    .command('list')
    .description('List effective config (or a single scope)')
    .addOption(scopeOption())
    .option('--json', 'Emit JSON', false)
    .action(async (opts: { scope?: Scope; json: boolean }) => {
      const env = await defaultScanEnv();
      const r = await runConfigList({ env, ...(opts.scope ? { scope: opts.scope } : {}), json: opts.json });
      if (!r.ok) {
        process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
        process.exit(exitCodeForError(r.error));
      }
      process.stdout.write(r.output);
    });

  cmd
    .command('unset <key>')
    .description('Remove a config value (default scope: user)')
    .addOption(scopeOption())
    .action(async (key: string, opts: { scope?: Scope }) => {
      const env = await defaultScanEnv();
      const r = await runConfigUnset({ env, key, ...(opts.scope ? { scope: opts.scope } : {}) });
      if (!r.ok) {
        if (r.error.code === 'unknown-key') {
          process.stderr.write(`error: unknown config key '${r.error.key}'\n`);
          process.exit(2);
        }
        process.stderr.write(`error: ${JSON.stringify(r.error)}\n`);
        process.exit(exitCodeForError(r.error));
      }
      process.stderr.write(`updated ${r.file}\n`);
    });

  return cmd;
};
```

- [ ] **Step 3: Register in `buildProgram`**

Add to `packages/cli/src/program.ts`, between the `agents` and `completion` subcommands:

```ts
import { configCommand } from './commands/config.ts';

// inside buildProgram, after agents:
program.addCommand(configCommand());
```

- [ ] **Step 4: Verify integration**

Run: `bun test packages/cli/tests/commands/config-integration.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/config.ts packages/cli/src/program.ts packages/cli/tests/commands/config-integration.test.ts
git commit -m "feat(cli): wire config get/set/list/unset into commander"
```

---

## Phase E — Finalize + release

### Task 19: Update ESLint zones for new directories

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Add zones to the `import/no-restricted-paths` array**

Extend the `zones` list with:

```js
// config is a sibling leaf, not a consumer of domain modules
{ target: './packages/core/src/config', from: './packages/core/src/agents' },
{ target: './packages/core/src/config', from: './packages/core/src/detect' },
{ target: './packages/core/src/config', from: './packages/core/src/scan' },

// completion renderers receive a Command from the caller; no cli-internal imports
{ target: './packages/cli/src/completion', from: './packages/cli/src/commands' },
{ target: './packages/cli/src/completion', from: './packages/cli/src/output' },
{ target: './packages/cli/src/completion', from: './packages/cli/src/help' },
```

- [ ] **Step 2: Verify boundaries hold**

Run: `bun run lint:boundaries`
Expected: clean.

- [ ] **Step 3: Verify a deliberate violation is flagged**

Temporarily add `import { runAgents } from '../commands/agents.ts';` to `packages/cli/src/completion/walk.ts`, run `bun run lint:boundaries`, confirm ESLint flags `import/no-restricted-paths`, then revert.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "ci(lint): add ESLint zones for config and completion modules"
```

---

### Task 20: Final verification + `v0.2.0` tag

- [ ] **Step 1: Full check**

Run: `bun run check`
Expected: all green.

- [ ] **Step 2: Build + smoke**

Run:
```bash
bun run build
./dist/skillsmith completion bash | head -5
./dist/skillsmith config set tool claude-code && ./dist/skillsmith config get tool
./dist/skillsmith config list --json | bunx jq '.sources.tool'
./dist/skillsmith config unset tool
```
Expected: bash completion script printed, set/get round-trip returns `claude-code`, `jq` returns `"user"`, unset leaves file without the `tool` key.

- [ ] **Step 3: Preview script smoke**

Run: `bun run scripts/preview-completions.ts | head -10`
Expected: shows `=== bash ===` header and start of the bash script.

- [ ] **Step 4: Update package versions**

Bump `package.json`, `packages/core/package.json`, `packages/cli/package.json` from `0.1.0` → `0.2.0`.

```bash
git add package.json packages/core/package.json packages/cli/package.json
git commit -m "chore: bump workspace to v0.2.0"
```

- [ ] **Step 5: Tag**

```bash
git tag -a v0.2.0 -m "MVP-2a: config + completion — internal milestone"
```

- [ ] **Step 6: Sanity check**

Run: `git status && git log --oneline -15 && git tag`
Expected: clean tree; `v0.1.0` and `v0.2.0` both present; commits tell the MVP-2a story.

---

## Post-plan notes

- Public release is still deferred to MVP-2b.
- PowerShell completion is tracked in `research/skillsmith-phases.md` §3.2 (MVP-2b).
- The `completion` walker expects `.addOption(new Option(...).choices([...]))` for every enum flag — the declaration-gate test (Task 1) will fail CI if this discipline slips. New commands in MVP-2b (`list`, `doctor`) must follow suit.
- `saveConfig` uses `proper-lockfile` with short retry windows. If a `config set` is interrupted (SIGINT), the lock is released via `proper-lockfile`'s process-exit handlers; verify during MVP-2b if any complaints surface.
- `smol-toml`'s `stringify` does not preserve comments from the input. Intentional: config is small and the list output annotates sources. Revisit if users ask.
