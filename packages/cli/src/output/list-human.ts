import {
  type InventoryCollisionGroupReport,
  type Origin,
  SUPPORTED_TOOLS,
  type SkillEntry,
  redactSensitiveString,
} from '@skillsmith/core';

export interface ListHumanOpts {
  long: boolean;
  outcome?: 'selected' | 'filter-noop';
  duplicates?: boolean;
  collisionGroups?: readonly InventoryCollisionGroupReport[];
}

type Visibility = Readonly<{
  readonly state: string;
  readonly winner?: unknown;
  readonly members?: readonly unknown[];
}>;

type PresentedSkillEntry = SkillEntry & {
  readonly mode?: string;
  readonly placement?: string;
  readonly source?: string | null;
  readonly revision?: string | null;
  readonly store?: string | null;
  readonly verification?: string;
  readonly description?: string | null;
  readonly visibility?: Visibility;
};

const SCOPE_ORDER = Object.freeze(['system', 'user', 'project', 'managed']);
const TOOL_ORDER = new Map(SUPPORTED_TOOLS.map((tool, index) => [tool, index]));
const scopeOrder = new Map(SCOPE_ORDER.map((scope, index) => [scope, index]));
const COMPACT_ROW_LIMIT = 100;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareEntries = (left: PresentedSkillEntry, right: PresentedSkillEntry): number =>
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

const valueCell = (value: string | null | undefined, empty = ''): string =>
  escapeCell(redactSensitiveString(value ?? empty));

const safeLine = (value: string): string => redactSensitiveString(value).replace(/[\r\n]+/g, ' ');

const emptyOutput = (outcome: ListHumanOpts['outcome']): string =>
  outcome === 'filter-noop' ? 'No skills matched the active filters.\n' : 'No skills installed.\n';

const formatOrigin = (origin: Origin): string => {
  if (origin.kind === 'standalone') return 'standalone';
  if (origin.kind === 'plugin')
    return `plugin:${origin.pluginId}@${origin.pluginVersion}(${origin.pluginScope})`;
  return 'policy';
};

const stateCell = (entry: PresentedSkillEntry): string =>
  entry.enabled === 'on' ? '' : entry.enabled === 'off' ? 'disabled' : 'unconfigured';

const visibilityCell = (entry: PresentedSkillEntry): string => {
  const visibility = entry.visibility;
  if (visibility === undefined || visibility.state === 'unique') return 'unique';
  if (visibility.state === 'duplicate') return 'ambiguous';
  return visibility.winner === null || visibility.winner === undefined
    ? visibility.state
    : `${visibility.state}:${String(visibility.winner)}`;
};

export const renderListHuman = (
  entries: readonly PresentedSkillEntry[],
  opts: ListHumanOpts,
): string => {
  if (entries.length === 0)
    return opts.duplicates
      ? 'No duplicate skills matched the selected inventory.\n'
      : emptyOutput(opts.outcome);

  const columns = opts.long
    ? [
        'Tool',
        'Scope',
        'Mode',
        'Name',
        'State',
        'Placement',
        'Path',
        'Real path',
        'Root',
        'Origin',
        'Source',
        'Revision',
        'Store',
        'Verification',
        'Description',
        'Visibility',
      ]
    : ['Tool', 'Scope', 'Mode', 'Name', 'State'];
  const lines = [
    'Installed skills',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  const ordered = [...entries].sort(compareEntries);
  const displayed = opts.long ? ordered : ordered.slice(0, COMPACT_ROW_LIMIT);
  let previousTool: string | undefined;
  for (const entry of displayed) {
    if (previousTool !== undefined && entry.tool !== previousTool) lines.push('');
    previousTool = entry.tool;
    const compact = [
      entry.tool,
      entry.scope,
      entry.mode ?? 'unmanaged',
      entry.name,
      stateCell(entry),
    ];
    const row = opts.long
      ? [
          ...compact,
          entry.placement ?? 'copy',
          entry.path,
          entry.realpath,
          entry.root,
          formatOrigin(entry.origin),
          entry.source,
          entry.revision,
          entry.store,
          entry.verification ?? 'unrecorded',
          entry.description ?? entry.frontmatter?.description,
          visibilityCell(entry),
        ]
      : compact;
    lines.push(`| ${row.map((value) => valueCell(value, opts.long ? '—' : '')).join(' | ')} |`);
  }
  if (!opts.long && ordered.length > COMPACT_ROW_LIMIT) {
    lines.push(
      `... ${ordered.length - COMPACT_ROW_LIMIT} more entries; narrow with filters or use --long or --json.`,
    );
  }
  if (opts.duplicates) {
    for (const group of opts.collisionGroups ?? []) {
      const members = group.members.map((member) => `${member.scope}:${member.path}`).join(', ');
      const resolution = group.winner === null ? 'ambiguous' : `winner ${group.winner}`;
      lines.push(safeLine(`Duplicate ${group.tool}/${group.name}: ${members}; ${resolution}.`));
    }
  }
  return `${lines.join('\n')}\n`;
};
