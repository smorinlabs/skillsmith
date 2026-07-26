import { describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type FileMetadataReadPort,
  type FileReadPort,
  defaultRuntimePorts,
} from '@skillsmith/core';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';
import type { CommandSpecInput, NormalizedCommandSpec } from '../../src/spec/types.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const ROOT = resolve(import.meta.dir, '../../../..');
const FAIL_CLOSED = ':5\n';
const TEST_BUN_CACHE = join(tmpdir(), 'skillsmith-test-bun-cache');

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type CompletionReadPorts = Pick<FileReadPort, 'pathKind'> &
  FileMetadataReadPort & {
    readonly listDirBounded: (path: string, maxEntries: number) => Promise<readonly string[]>;
    readonly readFileSnapshotNoFollow: (
      path: string,
      maxBytes: number,
    ) => Promise<{
      readonly bytes: Uint8Array;
      readonly metadata: {
        readonly kind: 'file';
        readonly mode: number | null;
        readonly identity: string;
        readonly sizeBytes: number;
      };
    }>;
  };

interface CompletionContext {
  readonly cwd?: string;
  readonly monotonicMilliseconds?: () => number;
  readonly ports?: CompletionReadPorts;
}

interface ResolvedCompletionContext {
  readonly cwd: string;
  readonly monotonicMilliseconds: () => number;
  readonly ports: CompletionReadPorts;
}

interface CompletionTransportModule {
  readonly resolveCompletionRequest?: (
    tokens: readonly string[],
    context: ResolvedCompletionContext,
  ) => string | Promise<string>;
  readonly validateCompletionProtocol?: (captured: string) => string;
}

interface CompletionAdapterModule {
  readonly hardenCompletionScript?: (shell: 'bash' | 'zsh' | 'fish', source: string) => string;
  readonly parseCompletionGraph?: (
    tokens: readonly string[],
    context: { readonly cwd: string; readonly monotonicMilliseconds: () => number },
    specs?: readonly CommandSpecInput[],
  ) => Promise<string>;
}

interface ProtocolCandidate {
  readonly value: string;
  readonly description: string;
}

const runCli = async (
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<CliResult> => {
  const child = Bun.spawn(['bun', 'run', CLI_ENTRYPOINT, ...args], {
    cwd: options.cwd ?? ROOT,
    env: hermeticGitEnv({
      BUN_INSTALL_CACHE_DIR: TEST_BUN_CACHE,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      CI: '1',
      NO_COLOR: '1',
      ...options.env,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

let transportPromise: Promise<CompletionTransportModule> | undefined;
const completionTransport = async (): Promise<CompletionTransportModule> => {
  transportPromise ??= import(
    `${pathToFileURL(join(ROOT, 'packages/cli/src/completion/transport.ts')).href}?ewp-g6-02b`
  ) as Promise<CompletionTransportModule>;
  return transportPromise;
};

let completionPortsPromise: Promise<CompletionReadPorts> | undefined;
const completionPorts = (): Promise<CompletionReadPorts> => {
  completionPortsPromise ??= defaultRuntimePorts().then((ports) =>
    Object.freeze({
      listDirBounded: ports.listDirBounded,
      pathKind: ports.pathKind,
      readFileMetadata: ports.readFileMetadata,
      readFileSnapshotNoFollow: ports.readFileSnapshotNoFollow,
    }),
  );
  return completionPortsPromise;
};

let adapterPromise: Promise<CompletionAdapterModule> | undefined;
const completionAdapter = async (): Promise<CompletionAdapterModule> => {
  adapterPromise ??= import(
    `${pathToFileURL(join(ROOT, 'packages/cli/src/completion/adapter.ts')).href}?ewp-g6-02b`
  ) as Promise<CompletionAdapterModule>;
  return adapterPromise;
};

const resolveCompletion = async (
  tokens: readonly string[],
  context: CompletionContext = {},
): Promise<string> => {
  const module = await completionTransport();
  expect(
    typeof module.resolveCompletionRequest,
    'completion transport must export resolveCompletionRequest',
  ).toBe('function');
  if (typeof module.resolveCompletionRequest !== 'function') return FAIL_CLOSED;
  const ports = context.ports ?? (await completionPorts());
  return module.resolveCompletionRequest(Object.freeze([...tokens]), {
    cwd: context.cwd ?? ROOT,
    monotonicMilliseconds: context.monotonicMilliseconds ?? (() => performance.now()),
    ports,
  });
};

const parseProtocol = (
  source: string,
): {
  readonly candidates: readonly ProtocolCandidate[];
  readonly directive: number;
} => {
  expect(source.endsWith('\n'), 'completion protocol must end with LF').toBeTrue();
  const lines = source.slice(0, -1).split('\n');
  const directiveLine = lines.pop();
  expect(directiveLine).toMatch(/^:\d+$/);
  const candidates = lines.map((line) => {
    const fields = line.split('\t');
    expect(fields.length, `malformed candidate line ${JSON.stringify(line)}`).toBeLessThanOrEqual(
      2,
    );
    const value = fields[0] ?? '';
    expect(value.length).toBeGreaterThan(0);
    return { value, description: fields[1] ?? '' };
  });
  return { candidates, directive: Number(directiveLine?.slice(1) ?? Number.NaN) };
};

const valuesFor = async (
  tokens: readonly string[],
  context: CompletionContext = {},
): Promise<readonly string[]> =>
  parseProtocol(await resolveCompletion(tokens, context)).candidates.map(({ value }) => value);

const commandTokens = (spec: NormalizedCommandSpec): readonly string[] =>
  spec.path.split(' ').slice(1);

const topLevelSpecs = CURRENT_COMMAND_SPECS.filter(
  (spec) => spec.path.split(' ').length === 2,
).sort((left, right) => left.helpOrder - right.helpOrder);

const rootSpec = CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith');
if (rootSpec === undefined) throw new Error('missing root CommandSpec');

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const readNulValues = async (path: string): Promise<readonly string[]> => {
  const bytes = await readFile(path);
  const values: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) continue;
    values.push(bytes.subarray(start, index).toString('utf8'));
    start = index + 1;
  }
  return values;
};

const runSourcedBash = async (
  script: string,
  words: readonly string[],
  currentWord: number,
  stubOutput = FAIL_CLOSED,
): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly replies: readonly string[];
}> => {
  const fixture = await mkdtemp(join(tmpdir(), 'skillsmith-completion-bash-'));
  try {
    const scriptPath = join(fixture, 'completion.bash');
    const wordsPath = join(fixture, 'words.bin');
    const argvPath = join(fixture, 'argv.bin');
    const repliesPath = join(fixture, 'replies.bin');
    await writeFile(scriptPath, script);
    await writeFile(wordsPath, Buffer.from(`${words.join('\0')}\0`, 'utf8'));
    const harness = [
      'set -u',
      'mapfile -d "" -t COMP_WORDS < "$WORDS_PATH"',
      'COMP_CWORD="$CURRENT_WORD"',
      '_get_comp_words_by_ref() {',
      '  cur="${COMP_WORDS[COMP_CWORD]-}"',
      '  prev="${COMP_WORDS[COMP_CWORD-1]-}"',
      '  words=("${COMP_WORDS[@]}")',
      '  cword="$COMP_CWORD"',
      '}',
      'skillsmith() {',
      '  : > "$ARGV_PATH"',
      '  for argument in "$@"; do printf "%s\\0" "$argument" >> "$ARGV_PATH"; done',
      '  printf "%s" "$STUB_OUTPUT"',
      '}',
      'compopt() { :; }',
      'source "$SCRIPT_PATH"',
      '__skillsmith_complete',
      ': > "$REPLIES_PATH"',
      'for reply in "${COMPREPLY[@]-}"; do printf "%s\\0" "$reply" >> "$REPLIES_PATH"; done',
    ].join('\n');
    const child = Bun.spawn(['bash', '-c', harness], {
      cwd: fixture,
      env: hermeticGitEnv({
        ARGV_PATH: argvPath,
        CURRENT_WORD: String(currentWord),
        REPLIES_PATH: repliesPath,
        SCRIPT_PATH: scriptPath,
        STUB_OUTPUT: stubOutput,
        WORDS_PATH: wordsPath,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    return {
      exitCode,
      stderr: await new Response(child.stderr).text(),
      argv: await readNulValues(argvPath).catch(() => []),
      replies: await readNulValues(repliesPath).catch(() => []),
    };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
};

const snapshotTree = async (root: string): Promise<readonly string[]> => {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const key = relative(root, path);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        rows.push(`link:${key}:${await readlink(path)}`);
      } else if (stat.isDirectory()) {
        rows.push(`dir:${key}`);
        await walk(path);
      } else {
        rows.push(`file:${key}:${(await readFile(path)).toString('base64')}`);
      }
    }
  };
  await walk(root);
  return rows;
};

const manifest = (names: readonly string[]): string =>
  [
    'version = 1',
    '[defaults]',
    'tools = ["codex"]',
    'scope = "project"',
    ...names.flatMap((name) => [
      '[[skills]]',
      `name = ${JSON.stringify(name)}`,
      `source = ${JSON.stringify(`fixture.invalid/acme/skills//${name}`)}`,
      'tools = ["codex"]',
      'scope = "project"',
    ]),
    '',
  ].join('\n');

describe('P17-G6-02B completion contracts', () => {
  test('EWP-CMD-COMPLETION-TS01 root candidates close over 23 commands and adjacent aliases', async () => {
    const result = await runCli(['complete', '--', '']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = parseProtocol(result.stdout);
    expect(parsed.directive & 4).toBe(4);

    const expected = topLevelSpecs.flatMap((spec) => [
      spec.path.split(' ').at(-1) ?? spec.path,
      ...spec.aliases,
    ]);
    expect(topLevelSpecs).toHaveLength(23);
    expect(expected).toHaveLength(28);
    expect(parsed.candidates.map(({ value }) => value)).toEqual(expected);
    expect(parsed.candidates.map(({ value }) => value)).not.toContain('complete');

    const publicUnknown = await runCli(['complete']);
    expect(publicUnknown.exitCode).toBe(2);
    expect(publicUnknown.stdout).toBe('');
    expect(publicUnknown.stderr).toContain('complete');
    expect(publicUnknown.stderr).toMatch(/unknown command|too many arguments/);

    const adapter = await completionAdapter();
    expect(
      typeof adapter.parseCompletionGraph,
      'completion adapter must export its generic CommandSpec graph boundary',
    ).toBe('function');
    if (typeof adapter.parseCompletionGraph !== 'function') return;
    const extension: CommandSpecInput = {
      name: 'fixture-extension',
      path: 'skillsmith fixture-extension',
      aliases: ['fixture-alias'],
      group: 'develop',
      helpOrder: Number.MAX_SAFE_INTEGER,
      primaryQuestion: 'Can a downstream CommandSpec extend completion?',
      description: 'Generic downstream completion fixture.',
      arguments: [
        {
          name: 'target',
          required: false,
          variadic: false,
          choices: ['alpha', 'beta'],
          defaultValue: undefined,
          description: 'Fixture target.',
        },
      ],
      options: [],
      examples: ['skillsmith fixture-extension alpha'],
      capability: 'fixture',
      application: 'fixture',
    };
    const nestedExtension: CommandSpecInput = {
      ...extension,
      name: 'nested',
      path: 'skillsmith fixture-extension nested',
      aliases: [],
      arguments: [],
      examples: ['skillsmith fixture-extension nested'],
    };
    const deepExtension: CommandSpecInput = {
      ...extension,
      name: 'deep',
      path: 'skillsmith fixture-extension nested deep',
      aliases: [],
      arguments: [
        {
          name: 'leaf',
          required: false,
          variadic: false,
          choices: ['omega'],
          defaultValue: undefined,
          description: 'Deep fixture leaf.',
        },
      ],
      examples: ['skillsmith fixture-extension nested deep omega'],
    };
    const extensionSpecs = [...CURRENT_COMMAND_SPECS, extension, nestedExtension, deepExtension];
    const graphContext = { cwd: ROOT, monotonicMilliseconds: () => 0 };
    const extensionRoot = parseProtocol(
      await adapter.parseCompletionGraph([''], graphContext, extensionSpecs),
    ).candidates.map(({ value }) => value);
    expect(extensionRoot).toContain('fixture-extension');
    expect(extensionRoot).toContain('fixture-alias');
    const canonical = parseProtocol(
      await adapter.parseCompletionGraph(['fixture-extension', 'a'], graphContext, extensionSpecs),
    ).candidates.map(({ value }) => value);
    const aliased = parseProtocol(
      await adapter.parseCompletionGraph(['fixture-alias', 'a'], graphContext, extensionSpecs),
    ).candidates.map(({ value }) => value);
    expect(canonical).toEqual(['alpha']);
    expect(aliased).toEqual(canonical);
    expect(
      parseProtocol(
        await adapter.parseCompletionGraph(
          ['fixture-extension', 'nested', ''],
          graphContext,
          extensionSpecs,
        ),
      ).candidates.map(({ value }) => value),
    ).toContain('deep');
    expect(
      parseProtocol(
        await adapter.parseCompletionGraph(
          ['fixture-extension', 'nested', 'deep', ''],
          graphContext,
          extensionSpecs,
        ),
      ).candidates.map(({ value }) => value),
    ).toEqual(['omega']);

    const duplicateAlias: CommandSpecInput = {
      ...extension,
      name: 'duplicate-alias',
      path: 'skillsmith duplicate-alias',
      aliases: ['fixture-alias'],
    };
    await expect(
      adapter.parseCompletionGraph([''], graphContext, [...extensionSpecs, duplicateAlias]),
    ).rejects.toThrow(/duplicate completion alias/u);
  }, 30_000);

  test('EWP-CMD-COMPLETION-TS02 nested config paths resolve recursively without sibling leakage', async () => {
    const config = await valuesFor(['config', '']);
    expect([...config].sort()).toEqual(['get', 'list', 'set', 'unset']);

    for (const action of ['get', 'list', 'set', 'unset'] as const) {
      const nested = await valuesFor(['config', action, '--']);
      expect(nested.length).toBeGreaterThan(0);
      expect(nested.every((value) => value.startsWith('--'))).toBeTrue();
      expect(nested).not.toContain('get');
      expect(nested).not.toContain('list');
      expect(nested).not.toContain('set');
      expect(nested).not.toContain('unset');
    }

    const adapter = await completionAdapter();
    expect(typeof adapter.parseCompletionGraph).toBe('function');
    if (typeof adapter.parseCompletionGraph !== 'function') return;
    const nestedOrder = new Map([
      ['unset', 0],
      ['list', 1],
      ['set', 2],
      ['get', 3],
    ]);
    const reorderedSpecs = CURRENT_COMMAND_SPECS.map((spec) => {
      const action = spec.path.match(/^skillsmith config (get|set|list|unset)$/u)?.[1];
      return action === undefined ? spec : { ...spec, helpOrder: nestedOrder.get(action) ?? 0 };
    });
    expect(
      parseProtocol(
        await adapter.parseCompletionGraph(
          ['config', ''],
          { cwd: ROOT, monotonicMilliseconds: () => 0 },
          reorderedSpecs,
        ),
      ).candidates.map(({ value }) => value),
    ).toEqual(['unset', 'list', 'set', 'get']);
  });

  test('EWP-CMD-COMPLETION-TS03 every canonical and alias path has exact local plus inherited flags', async () => {
    for (const spec of CURRENT_COMMAND_SPECS) {
      const expectedLong = unique(
        [...rootSpec.options, ...spec.options].map((option) => option.long),
      );
      const expectedShort = unique(
        [...rootSpec.options, ...spec.options].flatMap((option) =>
          option.short === null ? [] : [option.short],
        ),
      );
      expect([...(await valuesFor([...commandTokens(spec), '--']))].sort(), spec.path).toEqual(
        [...expectedLong].sort(),
      );
      expect([...(await valuesFor([...commandTokens(spec), '-']))].sort(), spec.path).toEqual(
        [...expectedShort].sort(),
      );
    }

    for (const spec of topLevelSpecs) {
      for (const alias of spec.aliases) {
        const canonical = await valuesFor([...commandTokens(spec), '--']);
        const aliased = await valuesFor([alias, '--']);
        expect(aliased, `${alias} must resolve exactly as ${spec.path}`).toEqual(canonical);
      }
    }
  }, 60_000);

  test('EWP-CMD-COMPLETION-TS04 values come from exact allowed sets in separated and attached forms', async () => {
    for (const spec of CURRENT_COMMAND_SPECS) {
      for (const option of spec.options.filter((candidate) => candidate.allowedValues.length > 0)) {
        const tokens = commandTokens(spec);
        const separated = await valuesFor([...tokens, option.long, '']);
        expect([...separated].sort(), `${spec.path} ${option.long} separated`).toEqual(
          [...option.allowedValues].sort(),
        );
        const prefix = option.allowedValues[0]?.slice(0, 1) ?? '';
        const attached = await valuesFor([...tokens, `${option.long}=${prefix}`]);
        expect([...attached].sort(), `${spec.path} ${option.long}= attached`).toEqual(
          option.allowedValues.filter((value) => value.startsWith(prefix)).sort(),
        );
        for (const parserOnly of (option.parserValues ?? []).filter(
          (value) => !option.allowedValues.includes(value),
        )) {
          expect(separated).not.toContain(parserOnly);
        }
      }

      for (const argument of spec.arguments.filter((candidate) => candidate.choices.length > 0)) {
        expect([...(await valuesFor([...commandTokens(spec), '']))].sort()).toEqual(
          [...argument.choices].sort(),
        );
      }
    }

    expect(await valuesFor(['install', '--scope', 'x'])).toEqual([]);
    expect(await valuesFor(['install', '--pin='])).toEqual([]);
    expect(await valuesFor(['install', '--scope', ''])).toEqual(['user', 'project']);
    expect(await valuesFor(['config', 'get', '--color', ''])).toEqual(['always', 'auto', 'never']);
  }, 60_000);

  test('EWP-CMD-COMPLETION-TS05 local providers are read-only, symlink-safe, deterministic, and bounded', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'skillsmith-completion-providers-'));
    const outside = await mkdtemp(join(tmpdir(), 'skillsmith-completion-outside-'));
    try {
      await mkdir(join(fixture, 'space dir'));
      await mkdir(join(fixture, 'local-one'));
      await writeFile(join(fixture, 'local-one', 'SKILL.md'), '# Local one\n');
      await mkdir(join(outside, 'linked-skill'));
      await mkdir(join(outside, 'linked-skill', 'nested'));
      await writeFile(join(outside, 'linked-skill', 'SKILL.md'), '# Must not traverse\n');
      await writeFile(join(outside, 'linked-skill', 'nested', 'outside.txt'), 'must not read\n');
      await symlink(join(outside, 'linked-skill'), join(fixture, 'linked'));
      await writeFile(join(fixture, 'skillsmith.toml'), manifest(['alpha', 'beta']));

      const before = await snapshotTree(fixture);
      expect(await valuesFor(['plan', '--file', 'sk'], { cwd: fixture })).toContain(
        'skillsmith.toml',
      );
      expect(await valuesFor(['verify', './sp'], { cwd: fixture })).toContain('./space dir/');
      expect(await valuesFor(['update', 'a'], { cwd: fixture })).toEqual(['alpha']);
      const skills = await valuesFor(['update', ''], { cwd: fixture });
      expect(skills).toEqual([...new Set(skills)].sort());
      expect(skills).toContain('alpha');
      expect(skills).toContain('beta');
      expect(skills).toContain('local-one');
      expect(skills).not.toContain('linked');
      expect(skills).not.toContain('--all');
      expect(skills).not.toContain('*');
      expect(skills).not.toContain('undeclared');
      expect(await resolveCompletion(['verify', 'linked/'], { cwd: fixture })).toBe(FAIL_CLOSED);
      expect(await resolveCompletion(['verify', 'linked/nested/'], { cwd: fixture })).toBe(
        FAIL_CLOSED,
      );
      expect(await resolveCompletion(['update', ''], { cwd: join(fixture, 'linked') })).toBe(
        FAIL_CLOSED,
      );
      expect(await snapshotTree(fixture)).toEqual(before);

      expect(
        await resolveCompletion(
          Array.from({ length: 65 }, () => 'x'),
          { cwd: fixture },
        ),
      ).toBe(FAIL_CLOSED);
      expect(await resolveCompletion(['x'.repeat(4097)], { cwd: fixture })).toBe(FAIL_CLOSED);
      expect(
        await resolveCompletion(
          Array.from({ length: 5 }, () => 'x'.repeat(4096)),
          {
            cwd: fixture,
          },
        ),
      ).toBe(FAIL_CLOSED);

      const candidateOverflow = join(fixture, 'candidate-overflow');
      await mkdir(candidateOverflow);
      await writeFile(
        join(candidateOverflow, 'skillsmith.toml'),
        manifest(
          Array.from({ length: 257 }, (_, index) => `skill-${String(index).padStart(3, '0')}`),
        ),
      );
      expect(await resolveCompletion(['update', ''], { cwd: candidateOverflow })).toBe(FAIL_CLOSED);

      const directoryOverflow = join(fixture, 'directory-overflow');
      await mkdir(directoryOverflow);
      await Promise.all(
        Array.from({ length: 513 }, (_, index) =>
          mkdir(join(directoryOverflow, `entry-${String(index).padStart(3, '0')}`)),
        ),
      );
      expect(await resolveCompletion(['verify', ''], { cwd: directoryOverflow })).toBe(FAIL_CLOSED);

      const oversized = join(fixture, 'oversized');
      await mkdir(oversized);
      await writeFile(join(oversized, 'skillsmith.toml'), `#${'x'.repeat(256 * 1024)}\n`);
      expect(await resolveCompletion(['update', ''], { cwd: oversized })).toBe(FAIL_CLOSED);

      for (const sizeBytes of [undefined, -1, Number.NaN, 256 * 1024 + 1]) {
        let contentReads = 0;
        const unsafeMetadataPorts: CompletionReadPorts = {
          listDirBounded: async () => [],
          pathKind: async () => 'dir',
          readFileSnapshotNoFollow: async () => {
            contentReads += 1;
            return {
              bytes: new Uint8Array(),
              metadata: { kind: 'file', mode: 0o600, identity: 'unsafe', sizeBytes: 0 },
            };
          },
          readFileMetadata: async () => ({
            kind: 'file',
            mode: 0o600,
            identity: 'unsafe-metadata',
            ...(sizeBytes === undefined ? {} : { sizeBytes }),
          }),
        };
        expect(
          await resolveCompletion(['update', ''], {
            cwd: '/completion-metadata-fixture',
            ports: unsafeMetadataPorts,
          }),
        ).toBe(FAIL_CLOSED);
        expect(contentReads).toBe(0);
      }

      let racedContentReads = 0;
      const changedDuringReadPorts: CompletionReadPorts = {
        listDirBounded: async () => [],
        pathKind: async () => 'dir',
        readFileSnapshotNoFollow: async () => {
          racedContentReads += 1;
          return {
            bytes: new Uint8Array([1, 2]),
            metadata: {
              kind: 'file',
              mode: 0o600,
              identity: 'changed-during-read',
              sizeBytes: 2,
            },
          };
        },
        readFileMetadata: async () => ({
          kind: 'file',
          mode: 0o600,
          identity: 'changed-during-read',
          sizeBytes: 1,
        }),
      };
      expect(
        await resolveCompletion(['update', ''], {
          cwd: '/completion-metadata-fixture',
          ports: changedDuringReadPorts,
        }),
      ).toBe(FAIL_CLOSED);
      expect(racedContentReads).toBe(1);

      const originalManifest = new TextEncoder().encode(manifest(['alpha']));
      const substitutedManifest = new TextEncoder().encode(manifest(['omega']));
      expect(substitutedManifest.byteLength).toBe(originalManifest.byteLength);
      let unboundedDirectoryReads = 0;
      const atomicBoundaryPorts = {
        listDir: async () => {
          unboundedDirectoryReads += 1;
          return [];
        },
        listDirBounded: async () => [],
        pathKind: async () => 'dir' as const,
        readBytes: async () => substitutedManifest,
        readFileMetadata: async (path: string) => ({
          kind: path.endsWith('skillsmith.toml') ? ('file' as const) : ('absent' as const),
          mode: 0o600,
          identity: path.endsWith('skillsmith.toml') ? 'same-metadata' : null,
          sizeBytes: path.endsWith('skillsmith.toml') ? originalManifest.byteLength : null,
        }),
        readFileSnapshotNoFollow: async () => ({
          bytes: originalManifest,
          metadata: {
            kind: 'file' as const,
            mode: 0o600,
            identity: 'same-metadata',
            sizeBytes: originalManifest.byteLength,
          },
        }),
      } as CompletionReadPorts & {
        readonly listDirBounded: (path: string, maxEntries: number) => Promise<readonly string[]>;
        readonly readFileSnapshotNoFollow: (
          path: string,
          maxBytes: number,
        ) => Promise<{
          readonly bytes: Uint8Array;
          readonly metadata: {
            readonly kind: 'file';
            readonly mode: number;
            readonly identity: string;
            readonly sizeBytes: number;
          };
        }>;
      };
      expect(
        await valuesFor(['update', ''], { cwd: '/atomic-boundary', ports: atomicBoundaryPorts }),
      ).toContain('alpha');
      expect(
        await valuesFor(['update', ''], { cwd: '/atomic-boundary', ports: atomicBoundaryPorts }),
      ).not.toContain('omega');
      expect(unboundedDirectoryReads).toBe(0);

      const productionReadPorts = (await defaultRuntimePorts()) as Awaited<
        ReturnType<typeof defaultRuntimePorts>
      > & {
        readonly listDirBounded?: unknown;
        readonly readFileSnapshotNoFollow?: unknown;
      };
      expect(typeof productionReadPorts.listDirBounded).toBe('function');
      expect(typeof productionReadPorts.readFileSnapshotNoFollow).toBe('function');

      const unreadable = join(fixture, 'unreadable');
      await mkdir(unreadable);
      const unreadableManifest = join(unreadable, 'skillsmith.toml');
      await writeFile(unreadableManifest, manifest(['hidden']));
      await chmod(unreadableManifest, 0o000);
      expect(await resolveCompletion(['update', ''], { cwd: unreadable })).toBe(FAIL_CLOSED);
      await chmod(unreadableManifest, 0o600);

      let monotonic = 0;
      expect(
        await resolveCompletion(['verify', ''], {
          cwd: fixture,
          monotonicMilliseconds: () => {
            monotonic += 501;
            return monotonic;
          },
        }),
      ).toBe(FAIL_CLOSED);

      const providerSource = await readFile(
        join(ROOT, 'packages/cli/src/completion/providers.ts'),
        'utf8',
      );
      expect(providerSource).not.toMatch(
        /(?:node:)?(?:child_process|http|https|net|tls)|\b(?:fetch|spawn|exec|writeFile|appendFile|rm|unlink|rename|prompt)\s*\(/,
      );
    } finally {
      await chmod(join(fixture, 'unreadable', 'skillsmith.toml'), 0o600).catch(() => undefined);
      await rm(fixture, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 60_000);

  test('EWP-CMD-COMPLETION-TS06 scripts and protocol hardening preserve argv and fail closed', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'skillsmith-completion-scripts-'));
    try {
      const home = join(fixture, 'home');
      const xdg = join(fixture, 'xdg');
      await mkdir(join(home, '.config', 'fish'), { recursive: true });
      await mkdir(xdg, { recursive: true });
      for (const path of [
        join(home, '.bashrc'),
        join(home, '.zshrc'),
        join(home, '.config', 'fish', 'config.fish'),
      ]) {
        await writeFile(path, `canary:${basename(path)}\n`);
      }
      const before = await snapshotTree(fixture);
      const scripts = new Map<'bash' | 'zsh' | 'fish', string>();
      for (const shell of ['bash', 'zsh', 'fish'] as const) {
        const first = await runCli(['completion', shell], {
          cwd: fixture,
          env: { HOME: home, XDG_CONFIG_HOME: xdg },
        });
        const second = await runCli(['completion', shell], {
          cwd: fixture,
          env: { HOME: home, XDG_CONFIG_HOME: xdg },
        });
        expect(first).toEqual(second);
        expect(first.exitCode, first.stderr).toBe(0);
        expect(first.stderr).toBe('');
        expect(first.stdout.length).toBeGreaterThan(0);
        expect(first.stdout).toContain('skillsmith complete --');
        expect(first.stdout).not.toMatch(/\beval\b|requestComp="[^"]*\$\{/);
        expect(first.stdout).not.toContain('BASH_COMP_DEBUG_FILE');
        expect(first.stdout).not.toMatch(/>>/u);
        scripts.set(shell, first.stdout);
      }
      expect(scripts.get('fish')).not.toContain('complete --do-complete');
      expect(await snapshotTree(fixture)).toEqual(before);

      const bashScript = scripts.get('bash') ?? '';
      const syntax = Bun.spawnSync(['bash', '-n'], {
        env: hermeticGitEnv(),
        stdin: Buffer.from(bashScript),
      });
      expect(syntax.exitCode, syntax.stderr.toString()).toBe(0);
      expect(scripts.get('zsh')).toMatch(/^#compdef skillsmith/m);
      expect(scripts.get('fish')).toContain('function __skillsmith_perform_completion');

      const canary = join(fixture, 'shell-eval-canary');
      const hostile = [
        `$(printf marker > ${canary})`,
        `\`printf marker > ${canary}\``,
        `; printf marker > ${canary}`,
        "single'quote",
        'double"quote',
        'space value',
        'tab\tvalue',
        'line\nvalue',
        '*?[abc]',
        '\\backslash',
        '-leading',
      ];
      const hostileRun = await runSourcedBash(
        bashScript,
        ['skillsmith', ...hostile],
        hostile.length,
      );
      expect(hostileRun.exitCode, hostileRun.stderr).toBe(0);
      expect(hostileRun.argv).toEqual(['complete', '--', ...hostile]);
      expect(
        await lstat(canary)
          .then(() => true)
          .catch(() => false),
      ).toBeFalse();

      const trailing = await runSourcedBash(bashScript, ['skillsmith', 'list'], 2);
      expect(trailing.exitCode, trailing.stderr).toBe(0);
      expect(trailing.argv).toEqual(['complete', '--', 'list', '']);

      const attached = await runSourcedBash(
        bashScript,
        ['skillsmith', 'install', '--scope=pr'],
        2,
        'project\tProject scope\n:4\n',
      );
      expect(attached.exitCode, attached.stderr).toBe(0);
      expect(attached.argv).toEqual(['complete', '--', 'install', '--scope=pr']);
      expect(attached.replies).toEqual(['--scope=project']);

      const adapter = await completionAdapter();
      expect(typeof adapter.hardenCompletionScript).toBe('function');
      if (typeof adapter.hardenCompletionScript !== 'function') return;
      const packageName = '@bomb.sh/tab';
      const tab = (await import(packageName)) as {
        readonly RootCommand: new () => {
          setup(name: string, executable: string, shell: string): void;
        };
      };
      const capture = (shell: 'bash' | 'zsh' | 'fish'): string => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (...values: unknown[]) => lines.push(values.map(String).join(' '));
        try {
          new tab.RootCommand().setup('skillsmith', 'skillsmith', shell);
        } finally {
          console.log = original;
        }
        return `${lines.join('\n')}\n`;
      };
      const rawBash = capture('bash');
      const rawZsh = capture('zsh');
      const rawFish = capture('fish');
      expect(rawBash).toContain('eval "$requestComp"');
      expect(rawZsh).toContain('out=$(eval ${requestComp}');
      expect(adapter.hardenCompletionScript('bash', rawBash)).toBe(bashScript);
      expect(adapter.hardenCompletionScript('zsh', rawZsh)).toBe(scripts.get('zsh') ?? '');
      expect(adapter.hardenCompletionScript('fish', rawFish)).toBe(scripts.get('fish') ?? '');

      const nonAnchorDrift = new Map([
        [
          'bash',
          rawBash.replace(
            '# Function to debug completion',
            '# Function to debug completion\nprintf marker',
          ),
        ],
        ['zsh', rawZsh.replace('#compdef skillsmith', '#compdef skillsmith\nprintf marker')],
        [
          'fish',
          rawFish.replace(
            '# fish completion for skillsmith',
            '# fish completion for skillsmith\nprintf marker',
          ),
        ],
      ] as const);
      for (const [shell, source] of nonAnchorDrift) {
        expect(() => adapter.hardenCompletionScript?.(shell, source)).toThrow();
      }

      const evalLine = '    out=$(eval "$requestComp" 2>/dev/null)';
      const drifted = [
        rawBash.replace(evalLine, ''),
        rawBash.replace(evalLine, `${evalLine}\n${evalLine}`),
        rawBash.replace(
          / {4}requestComp="skillsmith complete --[^\n]+\n([\s\S]*?) {4}out=\$\(eval "\$requestComp" 2>\/dev\/null\)/,
          `${evalLine}\n$&`,
        ),
      ];
      for (const source of drifted) {
        expect(() => adapter.hardenCompletionScript?.('bash', source)).toThrow();
      }

      const transport = await completionTransport();
      expect(typeof transport.validateCompletionProtocol).toBe('function');
      if (typeof transport.validateCompletionProtocol !== 'function') return;
      expect(transport.validateCompletionProtocol('alpha\tAlpha\n:4\n')).toBe('alpha\tAlpha\n:4\n');
      for (const malformed of [
        'alpha\tone\ttwo\n:4\n',
        'alpha\0value\tAlpha\n:4\n',
        'alpha\rvalue\tAlpha\n:4\n',
        'alpha\u0085value\tAlpha\n:4\n',
        `alpha${String.fromCharCode(0xd800)}\tAlpha\n:4\n`,
        'alpha\tAlpha\n:8\n',
        'alpha\tAlpha\n:16\n',
        'alpha\tAlpha\n:64\n',
        'alpha\tAlpha\n:4\npost\tdata\n',
        ':2\n:4\n',
        ':999\n:4\n',
        ':5\n:4\n',
        'alpha\tAlpha\n',
        `${'x'.repeat(64 * 1024)}\tAlpha\n:4\n`,
      ]) {
        expect(transport.validateCompletionProtocol(malformed)).toBe(FAIL_CLOSED);
      }

      const help = await runCli(['completion', '--help']);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toMatch(/source|save|package/i);
      expect((await runCli(['completion', 'powershell'])).exitCode).toBe(2);
      expect((await runCli(['completion', 'install'])).exitCode).toBe(2);
      expect((await runCli(['completion', 'uninstall'])).exitCode).toBe(2);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 60_000);
});
