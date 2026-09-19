import type { StatusV1Dto } from '@skillsmith/core/contracts/v1';

type StatusEntry = StatusV1Dto['entries'][number];
type StatusPlacement = StatusEntry['placements'][number];
type StatusFact = StatusEntry['facts'][number];
type StatusJournal = StatusPlacement['journal'];
type StatusRetention = Extract<
  StatusJournal,
  { readonly state: 'pending' | 'committed' }
>['retention'][number];

/** Encode untrusted DTO scalars without allowing terminal or line control. */
const display = (value: string | null): string => {
  if (value === null) return 'null';
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          codePoint === 0x2028 ||
          codePoint === 0x2029)
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : character;
    })
    .join('');
};

const factLine = (fact: StatusFact, indent: string): string =>
  `${indent}${display(fact.code)} (${display(fact.impact)}): expected ${display(fact.expected)}; actual ${display(fact.actual)}`;

const desiredLine = (entry: StatusEntry): string => {
  if (entry.desired.state === 'absent') return '  desired: absent';
  const desired = entry.desired.value;
  const path = desired.source.path === null ? '' : `/${desired.source.path}`;
  const ref = desired.ref === null ? '' : `@${desired.ref}`;
  return `  desired: ${display(desired.source.host)}/${display(desired.source.repository)}${display(path)}${display(ref)}`;
};

const lockedLine = (entry: StatusEntry): string =>
  entry.locked.state === 'absent'
    ? '  locked: absent'
    : `  locked: ${display(entry.locked.value.resolvedSha)}`;

const shadowLabel = (shadow: StatusPlacement['shadow']): string => {
  if (shadow.state === 'none') return 'shadow: none';
  if (shadow.state === 'shadowed') return `shadowed by ${display(shadow.winner)}`;
  if (shadow.state === 'winner') return `shadows ${shadow.shadows.map(display).join(', ')}`;
  return 'shadow: duplicate';
};

const placementLine = (placement: StatusPlacement): string => {
  const path = placement.identity.path ?? '(default path)';
  const broken = placement.brokenReason === null ? '' : ` (${placement.brokenReason})`;
  return `  ${display(placement.identity.tool)}/${display(placement.identity.scope)} ${display(path)} — ${display(placement.classification)}${display(broken)}; verification: ${display(placement.verification)}; ${shadowLabel(placement.shadow)}`;
};

const quoteArg = (value: string): string => `'${display(value).replaceAll("'", "'\\''")}'`;
const argv = (value: readonly string[] | null): string =>
  value === null ? 'unavailable' : value.map(quoteArg).join(' ');

const retentionSummaryLine = (retention: StatusRetention): string => {
  const id = retention.resourceId ?? 'legacy';
  const source =
    retention.sourceRole === null ? retention.role : `${retention.role}/${retention.sourceRole}`;
  return `      ${display(id)} ${display(source)} ${display(retention.path)} — ${display(retention.state)}; retain until: ${display(retention.retainUntil ?? 'none')}`;
};

const revisionValue = (
  value:
    | Extract<
        StatusRetention['repositoryRevision'],
        { state: 'satisfied' | 'mismatch' }
      >['expected']
    | null,
): string => (value === null ? 'null' : `${display(value.kind)}:${display(value.digest)}`);

const repositoryRevisionLine = (retention: StatusRetention): string => {
  const check = retention.repositoryRevision;
  if (check.state === 'not-recorded') {
    return '        repository revision: not-recorded; expected null; observed null';
  }
  return `        repository revision: ${display(check.state)}; expected ${revisionValue(check.expected)}; observed ${revisionValue(check.observed)}`;
};

const contentHashLine = (retention: StatusRetention): string => {
  const check = retention.contentHash;
  if (check.state === 'not-recorded') {
    return '        content hash: not-recorded; domain null; expected null; observed null';
  }
  return `        content hash: ${display(check.state)}; domain ${display(check.domain)}; expected ${display(check.expected)}; observed ${display(check.observed)}`;
};

const quoteHumanText = (value: string): string =>
  `"${[...value]
    .map((character) => {
      if (character === '"') return '\\"';
      if (character === '\\') return '\\\\';
      return display(character);
    })
    .join('')}"`;

const legacyNode = (
  node:
    | Extract<StatusRetention, { readonly format: 'legacy-pair' }>['structural']['expected']
    | NonNullable<
        Extract<StatusRetention, { readonly format: 'legacy-pair' }>['structural']['observed']
      >
    | null,
): string => {
  if (node === null) return 'null';
  if (node.kind !== 'symlink') return node.kind;
  return node.linkTarget === null
    ? 'symlink -> unrecorded'
    : `symlink -> ${quoteHumanText(node.linkTarget)}`;
};

const retentionLines = (retention: StatusRetention): readonly string[] => {
  const lines = [retentionSummaryLine(retention)];
  if (retention.format === 'legacy-pair') {
    lines.push(
      `        structural: ${display(retention.structural.state)}; expected ${legacyNode(retention.structural.expected)}; observed ${legacyNode(retention.structural.observed)}`,
    );
  }
  lines.push(repositoryRevisionLine(retention), contentHashLine(retention));
  return lines;
};

const journalLines = (journal: StatusJournal): readonly string[] => {
  if (journal.state === 'none') return [];
  const action = journal.state === 'pending' ? 'abort' : 'reverse';
  const eligibility =
    journal.state === 'pending' ? journal.abortEligibility : journal.reverseEligibility;
  const lines = [
    `    journal ${display(journal.format)}/${display(journal.operation)} ${display(journal.transactionId)} — ${display(journal.state)} ${display(journal.phase)}; before: ${display(journal.before)}; ${display(action)}: ${display(eligibility)}`,
    ...journal.retention.flatMap(retentionLines),
  ];
  if (journal.state === 'pending') {
    lines.push(`      resume: ${display(journal.remediation.resume)}`);
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
    return `Artifacts — unselected (${display(artifacts.reason)})`;
  }
  return `Artifacts — ${display(artifacts.source)}; manifest: ${display(manifestLabel(artifacts.manifest))}; lock: ${display(lockLabel(artifacts.lock))}; relationship: ${display(artifacts.relationship.state)}`;
};

const ledgerLabel = (ledger: StatusV1Dto['ledger']): string => {
  if (ledger.state === 'absent') return 'absent';
  return ledger.sourceVersion === 1 ? 'v1 -> current v2' : 'current v2';
};

const entryLines = (entry: StatusEntry): readonly string[] => {
  const lines = [
    `${display(entry.name)} — ${display(entry.convergence)}`,
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
    `Status — targets: ${display(dto.selection.source)}; tools: ${display(dto.selection.toolSource)}; scopes: ${display(dto.selection.scopeSource)}; outcome: ${display(dto.selection.outcome)}${display(selectionReason)}`,
  );
  lines.push(
    dto.context.projectRoot === null
      ? `Context — cwd: ${display(dto.context.effectiveCwd)}; project: none`
      : `Context — cwd: ${display(dto.context.effectiveCwd)}; project: ${display(dto.context.projectRoot)} (${display(dto.context.projectSource)})`,
  );
  lines.push(artifactsLine(dto.artifacts));
  lines.push(
    `Ledger — ${ledgerLabel(dto.ledger)}; migration pending: ${dto.summary.migrationPending ? 'yes' : 'no'}`,
  );
  for (const fact of dto.facts) lines.push(factLine(fact, '  '));
  for (const journal of dto.journals) {
    lines.push(
      `Journal — ${display(journal.format)}/${display(journal.operation)} ${display(journal.transactionId)}; ${display(journal.phase)}; ${display(journal.reason)}`,
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
