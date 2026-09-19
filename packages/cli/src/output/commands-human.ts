import {
  type CommandEntry,
  type Origin,
  SUPPORTED_TOOLS,
  redactSensitiveString,
} from '@skillsmith/core';

export interface CommandsHumanOpts {
  long: boolean;
  outcome?: 'selected' | 'filter-noop';
}

type PresentedCommandEntry = CommandEntry & {
  readonly description?: string | null;
};

const SCOPE_ORDER = Object.freeze(['user', 'project']);
const TOOL_ORDER = new Map(SUPPORTED_TOOLS.map((tool, index) => [tool, index]));
const scopeOrder = new Map(SCOPE_ORDER.map((scope, index) => [scope, index]));
const COMPACT_ROW_LIMIT = 100;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareEntries = (left: PresentedCommandEntry, right: PresentedCommandEntry): number =>
  (TOOL_ORDER.get(left.tool) ?? Number.MAX_SAFE_INTEGER) -
    (TOOL_ORDER.get(right.tool) ?? Number.MAX_SAFE_INTEGER) ||
  (scopeOrder.get(left.scope) ?? Number.MAX_SAFE_INTEGER) -
    (scopeOrder.get(right.scope) ?? Number.MAX_SAFE_INTEGER) ||
  compareText(left.name, right.name) ||
  compareText(left.path, right.path);

const escapeCell = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');

const valueCell = (value: string | null | undefined): string =>
  escapeCell(redactSensitiveString(value ?? ''));

const emptyOutput = (outcome: CommandsHumanOpts['outcome']): string =>
  outcome === 'filter-noop'
    ? 'No slash commands installed.\nActive filters reduced the selected inventory to zero.\n'
    : 'No slash commands installed.\n';

const formatOrigin = (origin: Origin): string => {
  if (origin.kind === 'standalone') return 'standalone';
  if (origin.kind === 'plugin')
    return `plugin:${origin.pluginId}@${origin.pluginVersion}:${origin.pluginScope}`;
  return 'policy';
};

const formatFrontmatter = (entry: PresentedCommandEntry): string => {
  if (entry.frontmatter === null) return 'null';
  const values = [
    ['name', entry.frontmatter.name],
    ['description', entry.frontmatter.description],
    ['version', entry.frontmatter.version],
  ] as const;
  return `{${values
    .flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${value}`]))
    .join(';')}}`;
};

const stateCell = (entry: PresentedCommandEntry): string =>
  entry.enabled === 'on' ? '' : entry.enabled === 'off' ? 'disabled' : 'unconfigured';

export const renderCommandsHuman = (
  entries: readonly PresentedCommandEntry[],
  opts: CommandsHumanOpts,
): string => {
  if (entries.length === 0) return emptyOutput(opts.outcome);

  const columns = opts.long
    ? [
        'Tool',
        'Scope',
        'Name',
        'State',
        'Logical path',
        'Real path',
        'Root',
        'Origin',
        'Version',
        'Frontmatter',
        'Description',
      ]
    : ['Tool', 'Scope', 'Name', 'State'];
  const lines = [
    'Installed slash commands',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  const ordered = [...entries].sort(compareEntries);
  const displayed = opts.long ? ordered : ordered.slice(0, COMPACT_ROW_LIMIT);
  let previousTool: string | undefined;
  for (const entry of displayed) {
    if (previousTool !== undefined && entry.tool !== previousTool) lines.push('');
    previousTool = entry.tool;
    const compact = [entry.tool, entry.scope, entry.name, stateCell(entry)];
    const row = opts.long
      ? [
          ...compact,
          entry.path,
          entry.realpath,
          entry.root,
          formatOrigin(entry.origin),
          entry.frontmatter?.version ?? '',
          formatFrontmatter(entry),
          entry.description ?? entry.frontmatter?.description ?? '',
        ]
      : compact;
    lines.push(`| ${row.map(valueCell).join(' | ')} |`);
  }
  if (!opts.long && ordered.length > COMPACT_ROW_LIMIT) {
    lines.push(
      `... ${ordered.length - COMPACT_ROW_LIMIT} more entries; narrow with filters or use --long or --json.`,
    );
  }
  return `${lines.join('\n')}\n`;
};
