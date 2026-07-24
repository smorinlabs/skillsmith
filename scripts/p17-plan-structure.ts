#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type P17PlanValidation = 'EWP-P0A-TS01' | 'EWP-P0A-TS06' | 'EWP-P0A-TS07';

const expectedCounts = {
  recommendation: 34,
  'phase-task': 65,
  'phase-test': 61,
  'command-test': 157,
  'option-gate': 10,
  workflow: 16,
  command: 23,
  finding: 44,
  decision: 16,
} as const;

type Kind = keyof typeof expectedCounts;
type Definition = { id: string; kind: Kind };

const sequence = (prefix: string, count: number): string[] => numbered(prefix, count, 2);

const expectedIds: Record<Kind, string[]> = {
  recommendation: [
    ...sequence('P0-', 8),
    ...sequence('P1-', 12),
    ...sequence('P2-', 8),
    ...sequence('P3-', 6),
  ],
  'phase-task': Object.entries({
    'EWP-P0A-T': 12,
    'EWP-P1-T': 13,
    'EWP-P2-T': 6,
    'EWP-P3A-T': 5,
    'EWP-P3B-T': 7,
    'EWP-P4A-T': 4,
    'EWP-P4B-T': 5,
    'EWP-P5-T': 6,
    'EWP-P6-T': 7,
  }).flatMap(([prefix, count]) => sequence(prefix, count)),
  'phase-test': Object.entries({
    'EWP-P0A-TS': 9,
    'EWP-P1-TS': 11,
    'EWP-P2-TS': 8,
    'EWP-P3A-TS': 4,
    'EWP-P3B-TS': 7,
    'EWP-P4A-TS': 4,
    'EWP-P4B-TS': 7,
    'EWP-P5-TS': 5,
    'EWP-P6-TS': 6,
  }).flatMap(([prefix, count]) => sequence(prefix, count)),
  'command-test': Object.entries({
    'EWP-CMD-AGENTS-TS': 3,
    'EWP-CMD-APPLY-TS': 14,
    'EWP-CMD-CHECK-TS': 5,
    'EWP-CMD-COMMANDS-TS': 4,
    'EWP-CMD-COMPLETION-TS': 6,
    'EWP-CMD-CONFIG-TS': 5,
    'EWP-CMD-DEV-TS': 6,
    'EWP-CMD-DOCTOR-TS': 6,
    'EWP-CMD-EXPORT-TS': 9,
    'EWP-CMD-GC-TS': 8,
    'EWP-CMD-HELP-TS': 7,
    'EWP-CMD-INIT-TS': 5,
    'EWP-CMD-INSTALL-TS': 8,
    'EWP-CMD-LIST-TS': 7,
    'EWP-CMD-PLAN-TS': 12,
    'EWP-CMD-PROMOTE-TS': 6,
    'EWP-CMD-STATUS-TS': 6,
    'EWP-CMD-SYNC-TS': 10,
    'EWP-CMD-UNDO-TS': 9,
    'EWP-CMD-UNINSTALL-TS': 7,
    'EWP-CMD-UPDATE-TS': 10,
    'EWP-CMD-VERIFY-TS': 4,
  }).flatMap(([prefix, count]) => sequence(prefix, count)),
  'option-gate': sequence('EWP-OPT-TS', 10),
  workflow: sequence('EWP-WF', 16),
  command: [
    'agents',
    'list',
    'commands',
    'status',
    'install',
    'uninstall',
    'update',
    'undo',
    'dev',
    'verify',
    'promote',
    'init',
    'export',
    'plan',
    'apply',
    'sync',
    'doctor',
    'check',
    'gc',
    'config',
    'completion',
    'version',
    'help',
  ].map((command) => `COMMAND:${command}`),
  finding: numbered('EWP-CF-', 44, 3),
  decision: numbered('D-', 16, 3),
};

const validationId =
  /EWP-(?:P(?:0A|1|2|3A|3B|4A|4B|5|6)-TS|CMD-[A-Z]+-TS|OPT-TS)\d{2}|EWP-WF\d{2}/g;

const requiredFindingFields = [
  ['accepted resolution', /^- \*\*Accepted resolution:\*\*/m, /^- \*\*Accepted resolution:\*\*/gm],
  [
    'saved example',
    /^- \*\*Saved (?:before\/after scenario|example|edge-case fixture):\*\*/m,
    /^- \*\*Saved (?:before\/after scenario|example|edge-case fixture):\*\*/gm,
  ],
  [
    'affected contracts',
    /^- \*\*Affected (?:sections and validation|contracts):\*\*/m,
    /^- \*\*Affected (?:sections and validation|contracts):\*\*/gm,
  ],
  ['recorded date', /^- \*\*Recorded:\*\* \d{4}-\d{2}-\d{2}/m, /^- \*\*Recorded:\*\*/gm],
] as const;

const requiredDecisionFields = [
  ['answer', /^- \*\*Answer:\*\*/m, /^- \*\*Answer:\*\*/gm],
  ['rationale', /^- \*\*Rationale:\*\*/m, /^- \*\*Rationale:\*\*/gm],
  [
    'rejected alternatives',
    /^- \*\*Rejected alternatives:\*\*/m,
    /^- \*\*Rejected alternatives:\*\*/gm,
  ],
  ['affected sections', /^- \*\*Affected sections:\*\*/m, /^- \*\*Affected sections:\*\*/gm],
  ['recorded date', /^- \*\*Recorded:\*\* \d{4}-\d{2}-\d{2}/m, /^- \*\*Recorded:\*\*/gm],
] as const;

const expectedDecisionAmendments = new Map<string, string[]>([
  ['D-003', ['2026-07-11:EWP-CF-029']],
  ['D-006', ['2026-07-11:EWP-CF-021', '2026-07-11:EWP-CF-022']],
  ['D-010', ['2026-07-11:EWP-CF-031']],
  ['D-011', ['2026-07-11:EWP-CF-031']],
  ['D-012', ['2026-07-11:EWP-CF-016']],
  ['D-016', ['2026-07-11:EWP-CF-032']],
]);

const expectedDecisionAmendmentBodies = new Map<string, string[]>([
  [
    'D-003',
    [
      '2026-07-11 by EWP-CF-029 (structural discriminator, lossless visible migration, exact-legacy read support through 1.x, and no separate migrate command)',
    ],
  ],
  [
    'D-006',
    [
      '2026-07-11 by EWP-CF-021',
      '2026-07-11 by EWP-CF-022 (defines the shared effective project root without changing ownership-first destination precedence)',
    ],
  ],
  ['D-010', ['2026-07-11 by EWP-CF-031 (target-or-all required; no implicit latest selection)']],
  ['D-011', ['2026-07-11 by EWP-CF-031 (targetless check only; mutation requires target or all)']],
  ['D-012', ['2026-07-11 by EWP-CF-016']],
  ['D-016', ['2026-07-11 by EWP-CF-032 (adds Develop and progressive per-command help)']],
]);

const canonicalDecisionFieldLabels = new Set([
  'Status:',
  'Answer:',
  'Rationale:',
  'Rejected alternatives:',
  'Affected sections:',
  'Recorded:',
  'Amended:',
]);

const canonicalDecisionDetailSha256 =
  '10b330175f5f8880c65c78c749ba73e4eb12ff19ac3ab03831a4ce049819014a';

const expectedFindingRecordedDates = new Map(
  numbered('EWP-CF-', 44, 3).map((id, index) => [
    id,
    index < 15 ? '2026-07-10' : index < 43 ? '2026-07-11' : '2026-07-23',
  ]),
);

function definitions(plan: string): Definition[] {
  const result: Definition[] = [];
  const add = (kind: Kind, pattern: RegExp): void => {
    for (const match of plan.matchAll(pattern)) {
      const id = match[1];
      if (id) result.push({ id, kind });
    }
  };
  add('recommendation', /^### (P[0-3]-\d{2}) .+$/gm);
  add('phase-task', /^- \*\*(EWP-P(?:0A|1|2|3A|3B|4A|4B|5|6)-T\d{2}):\*\* .+$/gm);
  add('phase-test', /^- \*\*(EWP-P(?:0A|1|2|3A|3B|4A|4B|5|6)-TS\d{2}):\*\* .+$/gm);
  add('command-test', /^- \*\*(EWP-CMD-[A-Z]+-TS\d{2}):\*\* .+$/gm);
  add('option-gate', /^- \*\*(EWP-OPT-TS\d{2}):\*\* .+$/gm);
  add('workflow', /^### (EWP-WF\d{2}) .+$/gm);
  add('finding', /^#### (EWP-CF-\d{3}) — .+$/gm);
  add('decision', /^#### (D-\d{3}) — .+$/gm);
  for (const match of plan.matchAll(
    /^\| (?:Discover|Manage|Develop|Declarative|Maintain) \| `([a-z]+)` \| .+? \|/gm,
  )) {
    if (match[1]) result.push({ id: `COMMAND:${match[1]}`, kind: 'command' });
  }
  return result;
}

function counts(items: Definition[]): Record<Kind, number> {
  const result = Object.fromEntries(Object.keys(expectedCounts).map((kind) => [kind, 0])) as Record<
    Kind,
    number
  >;
  for (const item of items) result[item.kind] += 1;
  return result;
}

function occurrences(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function numbered(prefix: string, count: number, width: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index + 1).padStart(width, '0')}`,
  );
}

function sections(plan: string, pattern: RegExp): Map<string, string[]> {
  const headings = [...plan.matchAll(pattern)].map((match) => ({
    id: match[1] ?? '',
    start: match.index ?? 0,
  }));
  const result = new Map<string, string[]>();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading?.id) continue;
    const headingLineEnd = plan.indexOf('\n', heading.start);
    const followingStart = headingLineEnd < 0 ? plan.length : headingLineEnd + 1;
    const followingHeading = plan.slice(followingStart).search(/^#{1,4} /m);
    const end = followingHeading < 0 ? plan.length : followingStart + followingHeading;
    const bodies = result.get(heading.id) ?? [];
    bodies.push(plan.slice(heading.start, end));
    result.set(heading.id, bodies);
  }
  return result;
}

function expandValidationReferences(text: string): string[] {
  const result = new Set(text.match(validationId) ?? []);
  const prefix = 'EWP-(?:P(?:0A|1|2|3A|3B|4A|4B|5|6)-TS|CMD-[A-Z]+-TS|OPT-TS)';
  for (const match of text.matchAll(new RegExp(`(${prefix})(\\d{2})\\.\\.(\\d{2})`, 'g'))) {
    const base = match[1];
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (!base || end < start) continue;
    for (let value = start; value <= end; value += 1) {
      result.add(`${base}${String(value).padStart(2, '0')}`);
    }
  }
  for (const match of text.matchAll(new RegExp(`(${prefix})(\\d{2})((?:/\\d{2})+)`, 'g'))) {
    const base = match[1];
    if (!base) continue;
    for (const suffix of match[3]?.split('/').filter(Boolean) ?? []) result.add(`${base}${suffix}`);
  }
  return [...result];
}

function referenceGrammarDiagnostics(text: string): string[] {
  const diagnostics: string[] = [];
  const startId =
    '(?:EWP-(?:P(?:0A|1|2|3A|3B|4A|4B|5|6)-(?:T|TS)|CMD-[A-Z]+-TS|OPT-TS|CF-)\\d{2,3}|EWP-WF\\d{2}|D-\\d{3})';
  const allExpected = new Map<string, Kind>();
  for (const [kind, ids] of Object.entries(expectedIds) as [Kind, string[]][]) {
    for (const id of ids) allExpected.set(id, kind);
  }
  const endpoint = (start: string, token: string): string => {
    if (/^\d+$/.test(token)) return `${start.replace(/\d+$/, '')}${token}`;
    if (/^(?:EWP-|D-)/.test(token)) return token;
    if (/^WF\d+$/.test(token)) return `EWP-${token}`;
    if (/^(?:TS|T)\d+$/.test(token)) return `${start.replace(/(?:TS|T)\d+$/, '')}${token}`;
    return token;
  };
  for (const match of text.matchAll(
    new RegExp(`(${startId})\\.\\.((?:EWP-[A-Z0-9-]+|D-)?[A-Z]*\\d{2,3})`, 'g'),
  )) {
    const start = match[1] ?? '';
    const end = endpoint(start, match[2] ?? '');
    const kind = allExpected.get(start);
    if (!kind || !allExpected.has(end)) {
      diagnostics.push(`undefined range endpoint ${end} in ${match[0]}`);
      continue;
    }
    if (allExpected.get(end) !== kind) {
      diagnostics.push(`cross-family range ${match[0]}`);
      continue;
    }
    if (expectedIds[kind].indexOf(end) < expectedIds[kind].indexOf(start)) {
      diagnostics.push(`malformed descending range ${match[0]}`);
    }
  }
  for (const match of text.matchAll(new RegExp(`(${startId})((?:/\\d{2,3})+)`, 'g'))) {
    const start = match[1] ?? '';
    for (const suffix of match[2]?.split('/').filter(Boolean) ?? []) {
      const id = endpoint(start, suffix);
      if (!allExpected.has(id) || allExpected.get(id) !== allExpected.get(start)) {
        diagnostics.push(`undefined slash reference ${id} in ${match[0]}`);
      }
    }
  }
  return diagnostics;
}

function definitionSetDiagnostics(items: Definition[]): string[] {
  const diagnostics: string[] = [];
  for (const kind of Object.keys(expectedIds) as Kind[]) {
    const actual = new Set(items.filter((item) => item.kind === kind).map((item) => item.id));
    const expected = new Set(expectedIds[kind]);
    for (const id of expected)
      if (!actual.has(id)) diagnostics.push(`missing ${kind} definition ${id}`);
    for (const id of actual)
      if (!expected.has(id)) diagnostics.push(`unexpected ${kind} definition ${id}`);
  }
  return diagnostics;
}

const linkageStopWords = new Set([
  'accepted',
  'after',
  'and',
  'before',
  'contract',
  'current',
  'define',
  'defined',
  'for',
  'from',
  'into',
  'only',
  'phase',
  'resolution',
  'section',
  'sections',
  'the',
  'this',
  'through',
  'with',
]);

function linkageWords(text: string): Set<string> {
  const words = new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9.-]{3,}/g) ?? []).filter(
      (word) => !linkageStopWords.has(word),
    ),
  );
  for (const token of text.toLowerCase().match(/(?:sections?|phase)\s+\d+(?:\.\d+)*/g) ?? []) {
    words.add(token.replace(/^sections?/, 'section').replace(/\s+/g, '-'));
  }
  for (const word of [...words]) {
    for (const part of word.split(/[./-]/)) {
      if (part.length >= 4 && !linkageStopWords.has(part)) words.add(part);
    }
  }
  return words;
}

function overlapCount(left: string, right: string): number {
  const rightWords = linkageWords(right);
  return [...linkageWords(left)].filter((word) => rightWords.has(word)).length;
}

function matchedFieldContent(body: string, marker: RegExp): string {
  const match = marker.exec(body);
  if (match?.index === undefined) return '';
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const end = rest.search(/\n(?:(?:[ \t]*>[ \t]?)*[ \t]*[-+*][ \t]+|#{1,4} )/);
  return rest.slice(0, end < 0 ? undefined : end).trim();
}

function matchedFieldContents(body: string, marker: RegExp): string[] {
  return [...body.matchAll(marker)].map((match) => {
    const start = (match.index ?? 0) + match[0].length;
    const rest = body.slice(start);
    const end = rest.search(/\n(?:(?:[ \t]*>[ \t]?)*[ \t]*[-+*][ \t]+|#{1,4} )/);
    return visibleText(rest.slice(0, end < 0 ? undefined : end));
  });
}

function visibleText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[`*_~#[\]()<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningful(value: string): boolean {
  const visible = visibleText(value);
  return (
    visible.length >= 8 &&
    /[a-z0-9]{3}/i.test(visible) &&
    !/^(?:wrong|tbd|none|null|n\/a)$/i.test(visible)
  );
}

function identifierDiagnostics(text: string): string[] {
  const expected = new Set(
    (Object.entries(expectedIds) as [Kind, string[]][])
      .filter(([kind]) => kind !== 'recommendation' && kind !== 'command')
      .flatMap(([, ids]) => ids),
  );
  const diagnostics: string[] = [];
  for (const token of text.match(/\b(?:EWP|D)-[A-Z0-9-]*\d+\b/g) ?? []) {
    if (!expected.has(token)) diagnostics.push(`malformed or undefined identifier ${token}`);
  }
  return [...new Set(diagnostics)];
}

function linkageTokens(text: string): Set<string> {
  return new Set(
    (
      text.match(/EWP-[A-Z0-9-]+|D-\d{3}|P[0-3]-\d{2}|(?:Sections?|Phase)\s+\d+(?:\.\d+)*/gi) ?? []
    ).map((token) =>
      token
        .toLowerCase()
        .replace(/^sections?/, 'section')
        .replace(/\s+/g, '-'),
    ),
  );
}

function isLinked(left: string, right: string): boolean {
  const visibleLeft = visibleText(left);
  const visibleRight = visibleText(right);
  if (overlapCount(visibleLeft, visibleRight) >= 2) return true;
  const rightTokens = linkageTokens(visibleRight);
  return [...linkageTokens(visibleLeft)].some((token) => rightTokens.has(token));
}

function validateTs01(plan: string, items: Definition[]): string[] {
  const diagnostics: string[] = [];
  const decisionStart = plan.indexOf('#### D-001 —');
  const decisionEnd = plan.indexOf('### Decision record template', decisionStart);
  const decisionBlock =
    decisionStart >= 0 && decisionEnd > decisionStart ? plan.slice(decisionStart, decisionEnd) : '';
  const decisionDigest = createHash('sha256').update(decisionBlock).digest('hex');
  if (decisionDigest !== canonicalDecisionDetailSha256) {
    diagnostics.push('decision detail block does not match canonical accepted record');
  }
  const decisionSections = sections(plan, /^#### (D-\d{3}) — .+$/gm);
  const findingSections = sections(plan, /^#### (EWP-CF-\d{3}) — .+$/gm);
  const register = new Map<string, string[]>();
  for (const match of plan.matchAll(/^\| (D-\d{3}) \| [^\n]+ \| (accepted|modified) \|$/gm)) {
    const id = match[1] ?? '';
    register.set(id, [...(register.get(id) ?? []), match[2] ?? '']);
  }
  for (const id of numbered('D-', 16, 3)) {
    const bodies = decisionSections.get(id) ?? [];
    if (bodies.length === 0) diagnostics.push(`missing detailed decision heading ${id}`);
    if (bodies.length > 1) diagnostics.push(`duplicate detailed decision heading ${id}`);
    const body = bodies[0] ?? '';
    for (const match of body.matchAll(/^(?:[ \t]*>[ \t]?)*[ \t]*[-+*][ \t]+(.+)$/gm)) {
      const item = match[0];
      const canonical = [...canonicalDecisionFieldLabels].some((label) =>
        item.startsWith(`- **${label}**`),
      );
      if (!canonical) {
        const label = match[1]?.match(/[*_]+([^*_]+)[*_]+/)?.[1] ?? match[1] ?? '';
        diagnostics.push(`${id} has malformed decision field marker - **${label}**`);
      }
    }
    const statusMarkers = [...body.matchAll(/^- \*\*Status:\*\*/gm)];
    if (statusMarkers.length > 1) diagnostics.push(`${id} has duplicate decision status fields`);
    const status = visibleText(matchedFieldContent(body, /^- \*\*Status:\*\*/m));
    if (status && status !== 'accepted' && status !== 'modified') {
      diagnostics.push(`${id} decision status must be accepted, found ${status}`);
    }
    if (bodies.length > 0 && !status) diagnostics.push(`${id} missing decision status`);
    for (const [field, pattern, markerPattern] of requiredDecisionFields) {
      if (body && !pattern.test(body)) diagnostics.push(`${id} missing decision ${field}`);
      if ([...body.matchAll(markerPattern)].length > 1) {
        diagnostics.push(`${id} has duplicate decision ${field} fields`);
      }
      const content =
        field === 'recorded date'
          ? matchedFieldContent(body, /^- \*\*Recorded:\*\*/m)
          : matchedFieldContent(body, pattern);
      if (body && !isMeaningful(content)) {
        diagnostics.push(`${id} decision ${field} is empty or not meaningful`);
      }
      if (field === 'recorded date' && visibleText(content) !== '2026-07-10') {
        diagnostics.push(`${id} decision recorded date must be exactly 2026-07-10`);
      }
    }
    const registerStatuses = register.get(id) ?? [];
    if (registerStatuses.length === 0) diagnostics.push(`${id} missing decision register row`);
    if (registerStatuses.length > 1) diagnostics.push(`${id} duplicate decision register row`);
    if (status && registerStatuses[0] && registerStatuses[0] !== status) {
      diagnostics.push(
        `${id} decision register status ${registerStatuses[0]} does not match ${status}`,
      );
    }
    const amendmentBody = id === 'D-016' ? plan.slice(plan.indexOf('#### D-016 —')) : body;
    const amendments = [
      ...amendmentBody.matchAll(/^- \*\*Amended:\*\* (\d{4}-\d{2}-\d{2}) by (EWP-CF-\d{3})/gm),
    ];
    const expectedAmendments = expectedDecisionAmendments.get(id) ?? [];
    const actualAmendments = amendments.map(
      (amendment) => `${amendment[1] ?? ''}:${amendment[2] ?? ''}`,
    );
    if (JSON.stringify(actualAmendments) !== JSON.stringify(expectedAmendments)) {
      diagnostics.push(
        `${id} decision amendment history ${actualAmendments.join(',') || 'none'} does not match ${expectedAmendments.join(',') || 'none'}`,
      );
    }
    const actualAmendmentBodies = matchedFieldContents(amendmentBody, /^- \*\*Amended:\*\*/gm);
    const expectedAmendmentBodies = (expectedDecisionAmendmentBodies.get(id) ?? []).map(
      visibleText,
    );
    if (JSON.stringify(actualAmendmentBodies) !== JSON.stringify(expectedAmendmentBodies)) {
      diagnostics.push(`${id} decision amendment content does not match canonical history`);
    }
  }
  for (const id of register.keys()) {
    if (!expectedIds.decision.includes(id))
      diagnostics.push(`unexpected decision register row ${id}`);
  }
  for (const [id, bodies] of findingSections) {
    if (bodies.length > 1) diagnostics.push(`duplicate detailed finding heading ${id}`);
  }
  const byDefinition = occurrences(items.map((item) => `${item.kind}:${item.id}`));
  for (const [key, count] of byDefinition) {
    if (count > 1 && !key.startsWith('decision:') && !key.startsWith('finding:')) {
      diagnostics.push(`duplicate canonical definition ${key.split(':').slice(1).join(':')}`);
    }
  }
  diagnostics.push(...referenceGrammarDiagnostics(plan), ...identifierDiagnostics(plan));
  return diagnostics;
}

function validateTs06(plan: string, items: Definition[]): string[] {
  const diagnostics: string[] = [];
  const actual = counts(items);
  const coverageStart = plan.indexOf('> **Current coverage');
  const coverageEnd = plan.indexOf('\n\n', coverageStart);
  const coverage =
    coverageStart >= 0 && coverageEnd > coverageStart ? plan.slice(coverageStart, coverageEnd) : '';
  const declaredPatterns: Record<Kind, RegExp> = {
    recommendation: /(\d+) unique P0-P3 recommendations/,
    'phase-task': /(\d+) named phase tasks/,
    'phase-test': /(\d+) named phase tests/,
    'command-test': /(\d+) unique per-command test slices/,
    'option-gate': /(\d+) option-registry gates/,
    workflow: /(\d+) holistic workflows/,
    command: /\b(\d+) commands\b/,
    finding: /(\d+) accepted\s+>\s*consistency findings/,
    decision: /(\d+) resolved product decisions/,
  };
  for (const [kind, expected] of Object.entries(expectedCounts) as [Kind, number][]) {
    if (actual[kind] !== expected)
      diagnostics.push(`${kind} inventory count ${actual[kind]} does not match ${expected}`);
    const declarationSource = kind === 'command' ? plan : coverage;
    const declarationMatches = [
      ...declarationSource.matchAll(new RegExp(declaredPatterns[kind].source, 'g')),
    ];
    if (declarationMatches.length === 0) diagnostics.push(`missing declared ${kind} count`);
    for (const declaration of declarationMatches) {
      const value = Number(declaration[1]);
      if (value !== expected)
        diagnostics.push(`declared ${kind} count ${value} does not match ${expected}`);
    }
  }
  if (/pending decision\s*:/i.test(plan)) diagnostics.push('stale pending-decision marker');
  if (/\bTBD\s*:/i.test(plan)) diagnostics.push('out-of-template placeholder TBD');
  for (const match of plan.matchAll(/\bPhase\s+(\d+)(?:[AB])?\b/g)) {
    const phase = Number(match[1]);
    if (phase < 0 || phase > 7) diagnostics.push(`reference to nonexistent Phase ${phase}`);
  }
  const defined = new Set(items.map((item) => item.id));
  diagnostics.push(
    ...definitionSetDiagnostics(items),
    ...referenceGrammarDiagnostics(plan),
    ...identifierDiagnostics(plan),
  );
  const canonicalReferences =
    plan.match(
      /EWP-(?:P(?:0A|1|2|3A|3B|4A|4B|5|6)-(?:T|TS)\d{2}|CMD-[A-Z]+-TS\d{2}|OPT-TS\d{2}|CF-\d{3}|WF\d{2})/g,
    ) ?? [];
  for (const reference of canonicalReferences) {
    if (!defined.has(reference)) diagnostics.push(`undefined EWP reference ${reference}`);
  }
  for (const reference of expandValidationReferences(plan)) {
    if (!defined.has(reference)) diagnostics.push(`undefined EWP reference ${reference}`);
  }
  return [...new Set(diagnostics)];
}

function validateTs07(plan: string, items: Definition[]): string[] {
  const diagnostics: string[] = [];
  const detail = sections(plan, /^#### (EWP-CF-\d{3}) — .+$/gm);
  const indexRows = new Map<string, string[][]>();
  for (const line of plan.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const id = cells[1]?.match(/^EWP-CF-\d{3}$/)?.[0];
    if (id && cells.length === 7 && /^(?:accepted|accepted with \w+)$/.test(cells[5] ?? '')) {
      indexRows.set(id, [...(indexRows.get(id) ?? []), cells]);
    }
  }
  const traceStart = plan.indexOf('| Finding | Normative design retained in |');
  const traceEnd = plan.indexOf('\n#### EWP-CF-001', traceStart);
  const traceBody =
    traceStart >= 0 && traceEnd > traceStart ? plan.slice(traceStart, traceEnd) : '';
  const traceRows = new Map<string, string[][]>();
  for (const line of traceBody.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const id = cells[1]?.match(/^EWP-CF-\d{3}$/)?.[0];
    if (id) traceRows.set(id, [...(traceRows.get(id) ?? []), cells]);
  }
  const definedValidations = new Set(
    items
      .filter((item) =>
        ['phase-test', 'command-test', 'option-gate', 'workflow'].includes(item.kind),
      )
      .map((item) => item.id),
  );
  const expectedFindings = new Set(expectedIds.finding);
  for (const id of indexRows.keys()) {
    if (!expectedFindings.has(id)) diagnostics.push(`${id} unexpected accepted finding index row`);
  }
  for (const id of traceRows.keys()) {
    if (!expectedFindings.has(id)) diagnostics.push(`${id} unexpected traceability row`);
  }
  for (const id of detail.keys()) {
    if (!expectedFindings.has(id)) diagnostics.push(`${id} unexpected detailed finding section`);
  }
  for (const id of numbered('EWP-CF-', 44, 3)) {
    const indexes = indexRows.get(id) ?? [];
    const traces = traceRows.get(id) ?? [];
    const index = indexes[0];
    const trace = traces[0];
    if (indexes.length === 0) diagnostics.push(`${id} missing accepted finding index row`);
    if (indexes.length > 1) diagnostics.push(`${id} duplicate accepted finding index row`);
    if (traces.length === 0) diagnostics.push(`${id} missing traceability row`);
    if (traces.length > 1) diagnostics.push(`${id} duplicate traceability row`);
    const bodies = detail.get(id) ?? [];
    if (bodies.length === 0) {
      diagnostics.push(`${id} missing detailed finding section`);
      continue;
    }
    if (bodies.length > 1) diagnostics.push(`${id} has duplicate detailed finding sections`);
    const body = bodies[0] ?? '';
    for (const [field, pattern, markerPattern] of requiredFindingFields) {
      if (!pattern.test(body)) diagnostics.push(`${id} missing ${field}`);
      if ([...body.matchAll(markerPattern)].length > 1) {
        diagnostics.push(
          field === 'recorded date'
            ? `${id} has duplicate recorded dates`
            : `${id} has duplicate ${field} fields`,
        );
      }
      const content =
        field === 'recorded date'
          ? matchedFieldContent(body, /^- \*\*Recorded:\*\*/m)
          : matchedFieldContent(body, pattern);
      if (!isMeaningful(content)) {
        diagnostics.push(`${id} ${field} is empty or not meaningful`);
      }
    }
    const recordedDate = visibleText(matchedFieldContent(body, /^- \*\*Recorded:\*\*/m));
    const expectedRecordedDate = expectedFindingRecordedDates.get(id);
    if (recordedDate && recordedDate !== expectedRecordedDate) {
      diagnostics.push(
        `${id} recorded date ${recordedDate} does not match ${expectedRecordedDate}`,
      );
    }
    const references = expandValidationReferences(body);
    if (references.length === 0) diagnostics.push(`${id} missing named validation`);
    for (const reference of references) {
      if (!definedValidations.has(reference))
        diagnostics.push(`${id} references undefined validation ${reference}`);
    }
    const indexResolution = index?.[4] ?? '';
    if (index && !isMeaningful(indexResolution)) {
      diagnostics.push(`${id} accepted finding index resolution is not meaningful`);
    }
    if (index && !isLinked(indexResolution, body)) {
      diagnostics.push(`${id} accepted finding index resolution is not linked to its detail`);
    }
    if (trace) {
      const normative = trace[2] ?? '';
      const example = trace[3] ?? '';
      const ownership = trace[4] ?? '';
      if (!isMeaningful(normative)) {
        diagnostics.push(`${id} traceability normative contract is not meaningful`);
      }
      if (!isMeaningful(example)) {
        diagnostics.push(`${id} traceability example is not meaningful`);
      }
      if (!isLinked(normative, body)) {
        diagnostics.push(`${id} traceability normative contract is not linked to its detail`);
      }
      if (!isLinked(example, body)) {
        diagnostics.push(`${id} traceability example is not linked to its detail`);
      }
      const traceValidations = expandValidationReferences(ownership);
      if (traceValidations.length === 0)
        diagnostics.push(`${id} traceability row missing validation ownership`);
      for (const reference of traceValidations) {
        if (!definedValidations.has(reference)) {
          diagnostics.push(`${id} traceability row references undefined validation ${reference}`);
        } else if (!references.includes(reference)) {
          diagnostics.push(
            `${id} traceability validation ${reference} is absent from detailed finding`,
          );
        }
      }
    }
  }
  return [...new Set(diagnostics)];
}

export function validatePlanStructure(
  plan: string,
  only: readonly P17PlanValidation[] = ['EWP-P0A-TS01', 'EWP-P0A-TS06', 'EWP-P0A-TS07'],
): string[] {
  const items = definitions(plan);
  const diagnostics: string[] = [];
  if (only.includes('EWP-P0A-TS01')) diagnostics.push(...validateTs01(plan, items));
  if (only.includes('EWP-P0A-TS06')) diagnostics.push(...validateTs06(plan, items));
  if (only.includes('EWP-P0A-TS07')) diagnostics.push(...validateTs07(plan, items));
  return [...new Set(diagnostics)].sort();
}

if (import.meta.main) {
  if (!['--all', '--check'].includes(process.argv[2] ?? '') || process.argv.length !== 3) {
    console.error('usage: bun scripts/p17-plan-structure.ts --all|--check');
    process.exit(2);
  }
  const root = resolve(import.meta.dir, '..');
  const plan = readFileSync(
    resolve(root, 'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md'),
    'utf8',
  );
  const diagnostics = validatePlanStructure(plan);
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) console.error(diagnostic);
    process.exit(1);
  }
  console.log('valid: EWP-P0A-TS01, EWP-P0A-TS06, and EWP-P0A-TS07');
}
