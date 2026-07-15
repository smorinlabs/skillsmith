import type { StatusV1Dto } from '@skillsmith/core/contracts/v1';

type StatusEntry = StatusV1Dto['entries'][number];
type StatusPlacement = StatusEntry['placements'][number];
type StatusFact = StatusEntry['facts'][number];
type StatusJournal = StatusPlacement['journal'];
type StatusRetention = Extract<
  StatusJournal,
  { readonly state: 'pending' | 'committed' }
>['retention'][number];

const scalar = (value: string | null): string => value ?? 'null';

const factLine = (fact: StatusFact, indent: string): string =>
  `${indent}${fact.code} (${fact.impact}): expected ${scalar(fact.expected)}; actual ${scalar(fact.actual)}`;

const desiredLine = (entry: StatusEntry): string => {
  if (entry.desired.state === 'absent') return '  desired: absent';
  const desired = entry.desired.value;
  const path = desired.source.path === null ? '' : `/${desired.source.path}`;
  const ref = desired.ref === null ? '' : `@${desired.ref}`;
  return `  desired: ${desired.source.host}/${desired.source.repository}${path}${ref}`;
};

const lockedLine = (entry: StatusEntry): string =>
  entry.locked.state === 'absent'
    ? '  locked: absent'
    : `  locked: ${entry.locked.value.resolvedSha}`;

const shadowLabel = (shadow: StatusPlacement['shadow']): string => {
  if (shadow.state === 'none') return 'shadow: none';
  if (shadow.state === 'shadowed') return `shadowed by ${shadow.winner}`;
  if (shadow.state === 'winner') return `shadows ${shadow.shadows.join(', ')}`;
  return 'shadow: duplicate';
};

const placementLine = (placement: StatusPlacement): string => {
  const path = placement.identity.path ?? '(default path)';
  const broken = placement.brokenReason === null ? '' : ` (${placement.brokenReason})`;
  return `  ${placement.identity.tool}/${placement.identity.scope} ${path} — ${placement.classification}${broken}; verification: ${placement.verification}; ${shadowLabel(placement.shadow)}`;
};

const quoteArg = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const argv = (value: readonly string[] | null): string =>
  value === null ? 'unavailable' : value.map(quoteArg).join(' ');

const retentionLine = (retention: StatusRetention): string => {
  const id = retention.resourceId ?? 'legacy';
  const source =
    retention.sourceRole === null ? retention.role : `${retention.role}/${retention.sourceRole}`;
  return `      ${id} ${source} ${retention.path} — ${retention.state}; retain until: ${retention.retainUntil ?? 'none'}`;
};

const journalLines = (journal: StatusJournal): readonly string[] => {
  if (journal.state === 'none') return [];
  const action = journal.state === 'pending' ? 'abort' : 'reverse';
  const eligibility =
    journal.state === 'pending' ? journal.abortEligibility : journal.reverseEligibility;
  const lines = [
    `    journal ${journal.format}/${journal.operation} ${journal.transactionId} — ${journal.state} ${journal.phase}; before: ${journal.before}; ${action}: ${eligibility}`,
    ...journal.retention.map(retentionLine),
  ];
  if (journal.state === 'pending') {
    lines.push(`      resume: ${journal.remediation.resume}`);
    lines.push(`      abort: ${argv(journal.remediation.abort)}`);
  } else {
    lines.push(`      reverse: ${argv(journal.remediation.reverse)}`);
  }
  return lines;
};

const manifestLabel = (
  manifest: Extract<StatusV1Dto['artifacts'], { readonly state: 'selected' }>['manifest'],
): string => {
  if (manifest.state === 'absent') return 'absent';
  return manifest.sourceVersion === 'legacy' ? 'legacy' : 'current v1';
};

const lockLabel = (
  lock: Extract<StatusV1Dto['artifacts'], { readonly state: 'selected' }>['lock'],
): string => (lock.state === 'absent' ? 'absent' : 'current v1');

const artifactsLine = (artifacts: StatusV1Dto['artifacts']): string => {
  if (artifacts.state === 'unselected') {
    return `Artifacts — unselected (${artifacts.reason})`;
  }
  return `Artifacts — ${artifacts.source}; manifest: ${manifestLabel(artifacts.manifest)}; lock: ${lockLabel(artifacts.lock)}; relationship: ${artifacts.relationship.state}`;
};

const ledgerLabel = (ledger: StatusV1Dto['ledger']): string => {
  if (ledger.state === 'absent') return 'absent';
  return ledger.sourceVersion === 1 ? 'v1 -> current v2' : 'current v2';
};

const entryLines = (entry: StatusEntry): readonly string[] => {
  const lines = [
    `${entry.name} — ${entry.convergence}`,
    desiredLine(entry),
    lockedLine(entry),
    ...entry.facts.map((fact: StatusFact) => factLine(fact, '  ')),
  ];
  for (const placement of entry.placements) {
    lines.push(placementLine(placement));
    lines.push(...placement.facts.map((fact: StatusFact) => factLine(fact, '    ')));
    lines.push(...journalLines(placement.journal));
  }
  return lines;
};

/** Render the same strict DTO used by JSON; verbosity is intentionally not an input. */
export const renderStatusHuman = (dto: StatusV1Dto): string => {
  const lines: string[] = [];
  const selectionReason = dto.selection.reason === null ? '' : `; reason: ${dto.selection.reason}`;
  lines.push(
    `Status — targets: ${dto.selection.source}; tools: ${dto.selection.toolSource}; scopes: ${dto.selection.scopeSource}; outcome: ${dto.selection.outcome}${selectionReason}`,
  );
  lines.push(
    dto.context.projectRoot === null
      ? `Context — cwd: ${dto.context.effectiveCwd}; project: none`
      : `Context — cwd: ${dto.context.effectiveCwd}; project: ${dto.context.projectRoot} (${dto.context.projectSource})`,
  );
  lines.push(artifactsLine(dto.artifacts));
  lines.push(
    `Ledger — ${ledgerLabel(dto.ledger)}; migration pending: ${dto.summary.migrationPending ? 'yes' : 'no'}`,
  );
  for (const fact of dto.facts) lines.push(factLine(fact, '  '));
  for (const journal of dto.journals) {
    lines.push(
      `Journal — ${journal.format}/${journal.operation} ${journal.transactionId}; ${journal.phase}; ${journal.reason}`,
    );
  }
  lines.push('');
  dto.entries.forEach((entry: StatusEntry, index: number) => {
    lines.push(...entryLines(entry));
    if (index < dto.entries.length - 1) lines.push('');
  });
  if (dto.entries.length > 0) lines.push('');
  lines.push(
    `Summary — ${dto.summary.entries} skills: ${dto.summary.converged} converged, ${dto.summary.drifting} drifting; migration pending: ${dto.summary.migrationPending ? 'yes' : 'no'}`,
  );
  return `${lines.join('\n')}\n`;
};
