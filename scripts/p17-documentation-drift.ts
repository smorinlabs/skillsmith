#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELP_TOPIC_NAMES, TOPICS } from '../packages/cli/src/help/topics';

const ROOT = resolve(import.meta.dir, '..');
const LEDGER_PATH = resolve(ROOT, 'projects/p17/reviews/P17-G0-04-documentation-drift.json');

type JsonObject = Record<string, unknown>;
type Authority = { path: string; anchor: string | null };
type SectionSpec = {
  id: string;
  selector: string;
  disposition: string;
  marker: string;
  authority: Authority | readonly Authority[];
  requiredText?: readonly string[];
  supersededText?: readonly string[];
  forbiddenText?: readonly string[];
};
type DocumentSpec = {
  path: string;
  documentClass: string;
  sections: SectionSpec[];
};

const PLAN = 'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md';
const section = (
  id: string,
  selector: string,
  disposition: string,
  marker: string,
  path: string,
  anchor: string | null = null,
  requiredText?: readonly string[],
): SectionSpec => ({
  id,
  selector,
  disposition,
  marker,
  authority: { path, anchor },
  ...(requiredText ? { requiredText } : {}),
});
const planSection = (
  id: string,
  selector: string,
  disposition: string,
  marker: string,
  anchor: string,
  requiredText?: readonly string[],
  supersededText?: readonly string[],
  forbiddenText?: readonly string[],
): SectionSpec => ({
  ...section(id, selector, disposition, marker, PLAN, anchor, requiredText),
  ...(supersededText ? { supersededText } : {}),
  ...(forbiddenText ? { forbiddenText } : {}),
});
const sectionAuthorities = (
  id: string,
  selector: string,
  disposition: string,
  marker: string,
  authority: readonly Authority[],
): SectionSpec => ({ id, selector, disposition, marker, authority });

const DOCUMENTS: DocumentSpec[] = [
  {
    path: 'CLAUDE.md',
    documentClass: 'current-governance',
    sections: [
      planSection(
        'architectural-boundaries-enforced-by-eslint',
        '## Architectural boundaries — enforced by ESLint',
        'current-behavior',
        `P17 disposition: current behavior; authority: ${PLAN}#9-shared-application-and-planning-architecture`,
        '9-shared-application-and-planning-architecture',
        ['No CLI deps; core domain logic uses injected capability ports'],
        ['No CLI deps, no I/O side effects.'],
      ),
    ],
  },
  {
    path: 'README.md',
    documentClass: 'current-user-doc',
    sections: [
      section(
        'opening-status',
        '# Skillsmith',
        'current-behavior',
        'P17 disposition: current behavior; authority: packages/cli/src/program.ts',
        'packages/cli/src/program.ts',
      ),
      section(
        'install',
        '## Install',
        'current-behavior',
        'P17 disposition: current source-build behavior; authority: package.json',
        'package.json',
      ),
      section(
        'quickstart',
        '## Quickstart',
        'current-behavior',
        'P17 disposition: current examples; authority: packages/cli/src/program.ts',
        'packages/cli/src/program.ts',
      ),
      section(
        'packages',
        '## Packages',
        'current-behavior',
        'P17 disposition: current package boundary; authority: docs/architecture.md#core-cli-split',
        'docs/architecture.md',
        'core-cli-split',
        ['domain/application operations behind injected capability ports; zero CLI dependencies.'],
      ),
      section(
        'architecture-snapshot',
        '## Architecture snapshot',
        'current-behavior',
        'P17 disposition: current architecture; authority: docs/architecture.md#core-cli-split',
        'docs/architecture.md',
        'core-cli-split',
      ),
    ],
  },
  {
    path: 'docs/architecture.md',
    documentClass: 'current-architecture',
    sections: [
      planSection(
        'core--cli-split',
        '## Core / CLI split',
        'current-behavior',
        `P17 disposition: current behavior; authority: ${PLAN}#9-shared-application-and-planning-architecture`,
        '9-shared-application-and-planning-architecture',
        [
          'Core domain logic receives filesystem, process, clock, and observation capabilities through injected ports',
        ],
        ['no I/O side effects'],
      ),
    ],
  },
  {
    path: 'packages/core/README.md',
    documentClass: 'current-package-doc',
    sections: [
      section(
        'opening',
        '# @skillsmith/core',
        'current-behavior',
        'P17 disposition: current behavior; authority: docs/architecture.md#core-cli-split',
        'docs/architecture.md',
        'core-cli-split',
      ),
    ],
  },
  {
    path: 'packages/cli/README.md',
    documentClass: 'current-package-doc',
    sections: [
      section(
        'source-layout',
        'Source layout:',
        'current-behavior',
        'P17 disposition: current command layout; authority: packages/cli/src/program.ts',
        'packages/cli/src/program.ts',
      ),
    ],
  },
  {
    path: 'packages/cli/src/help/topics.ts',
    documentClass: 'current-help-source',
    sections: [
      planSection(
        'exit-codes',
        "'exit-codes':",
        'current-behavior',
        `P17 disposition: current behavior; target authority: ${PLAN}#811-global-exit-code-taxonomy-and-precedence`,
        '811-global-exit-code-taxonomy-and-precedence',
        [
          'Current shipped exit codes',
          'Historical shipped reference only: research/skillsmith-cli-design.md §6.1.',
        ],
        undefined,
        ['Full reference: research/skillsmith-cli-design.md §6.1'],
      ),
      sectionAuthorities(
        'environment',
        'environment:',
        'current-behavior',
        'P17 disposition: current behavior; authorities: packages/cli/src/util/color.ts, packages/core/src/config/env.ts, packages/core/src/place/paths.ts',
        [
          { path: 'packages/cli/src/util/color.ts', anchor: null },
          { path: 'packages/core/src/config/env.ts', anchor: null },
          { path: 'packages/core/src/place/paths.ts', anchor: null },
        ],
      ),
      planSection(
        'scopes',
        'scopes:',
        'current-behavior',
        `P17 disposition: current behavior; target authority: ${PLAN}#81-global`,
        '81-global',
      ),
      planSection(
        'manifest',
        'manifest:',
        'superseded-target',
        `P17 disposition: superseded target; authority: ${PLAN}#2-canonical-state-and-artifact-model`,
        '2-canonical-state-and-artifact-model',
      ),
      planSection(
        'sources',
        'sources:',
        'current-behavior',
        `P17 disposition: current behavior; future target authority: ${PLAN}#86-install`,
        '86-install',
      ),
      planSection(
        'formatting',
        'formatting:',
        'current-behavior',
        `P17 disposition: current behavior; target authority: ${PLAN}#p2-01-consistent-output-selection`,
        'p2-01-consistent-output-selection',
      ),
    ],
  },
  {
    path: 'projects/p17/EXECUTION.md',
    documentClass: 'current-execution-control',
    sections: [
      section(
        'opening-status',
        '# P17 execution map',
        'current-behavior',
        'P17 disposition: current execution state; authority: projects/p17/catalog.json',
        'projects/p17/catalog.json',
      ),
    ],
  },
  {
    path: 'research/skillsmith-phases.md',
    documentClass: 'superseded-roadmap',
    sections: [
      planSection(
        'opening',
        '# SkillSmith phases',
        'superseded-target',
        `P17 disposition: historical roadmap, superseded target; authority: ${PLAN}#10-named-implementation-phases-and-slices`,
        '10-named-implementation-phases-and-slices',
      ),
      planSection(
        '322-first-public-release',
        '**3.2.2 MVP-2b.2 — First public release**',
        'superseded-target',
        `P17 disposition: superseded 1.0 milestone; authority: ${PLAN}#phase-6-distribution-and-ux-polish`,
        'phase-6-distribution-and-ux-polish',
      ),
      planSection(
        '4-mvp-3--all-four-adapters',
        '## 4. MVP-3 — "All four adapters"',
        'superseded-target',
        `P17 disposition: superseded four-tool write roadmap; authority: ${PLAN}#phase-1-p0-cli-truthfulness`,
        'phase-1-p0-cli-truthfulness',
      ),
      planSection(
        '5-mvp-4--team-workflows',
        '## 5. MVP-4 — "Team workflows"',
        'superseded-target',
        `P17 disposition: superseded workflow phasing; authority: ${PLAN}#phase-4-desired-state-mutation-planner-and-apply`,
        'phase-4-desired-state-mutation-planner-and-apply',
      ),
      planSection(
        '9-phase-4--npm-publishing',
        '## 9. Phase 4 — npm publishing',
        'superseded-target',
        `P17 disposition: superseded publication phasing; authority: ${PLAN}#p1-12-distribution`,
        'p1-12-distribution',
      ),
    ],
  },
  {
    path: 'research/skillsmith-cli-design.md',
    documentClass: 'superseded-design',
    sections: [
      planSection(
        '051-tool-aware-install-with-scope-selection',
        '#### 0.5.1 Tool-aware install with scope selection',
        'superseded-target',
        `P17 disposition: current behavior is shipped but this target is superseded; authority: ${PLAN}#86-install`,
        '86-install',
      ),
      planSection(
        '052-content-addressed-store',
        '#### 0.5.2 Content-addressed store with symlinked entry points',
        'superseded-target',
        `P17 disposition: current store behavior retained as history, target superseded; authority: ${PLAN}#24-placementsjson-local-operational-state`,
        '24-placementsjson-local-operational-state',
      ),
      planSection(
        '058-manifest-driven-apply',
        '#### 0.5.8 Manifest-driven `apply` with drift detection',
        'superseded-target',
        `P17 disposition: superseded apply schema and flags; authority: ${PLAN}#814-apply`,
        '814-apply',
      ),
      planSection(
        '111-installation-model',
        '### 1.11 Installation model: content-addressed store + symlinks',
        'superseded-target',
        `P17 disposition: current store behavior retained as history, GC target superseded; authority: ${PLAN}#p2-03-gc`,
        'p2-03-gc',
      ),
      planSection(
        '2-command-tree',
        '## 2. Command tree',
        'superseded-target',
        `P17 disposition: superseded command tree; authority: ${PLAN}#820-normative-command-and-option-registry`,
        '820-normative-command-and-option-registry',
      ),
      planSection(
        '61-exit-codes',
        '### 6.1 Exit codes',
        'superseded-target',
        `P17 disposition: superseded exit-code target; authority: ${PLAN}#811-global-exit-code-taxonomy-and-precedence`,
        '811-global-exit-code-taxonomy-and-precedence',
      ),
      planSection(
        '64-config-file-locations',
        '### 6.4 Config file locations (XDG-compliant)',
        'superseded-target',
        `P17 disposition: superseded config and manifest identity; authority: ${PLAN}#ewp-cf-029-define-the-legacy-project-config-to-manifest-transition`,
        'ewp-cf-029-define-the-legacy-project-config-to-manifest-transition',
      ),
      planSection(
        '8-architecture-sketch',
        '## 8. Architecture sketch',
        'superseded-target',
        `P17 disposition: superseded architecture target; authority: ${PLAN}#9-shared-application-and-planning-architecture`,
        '9-shared-application-and-planning-architecture',
      ),
    ],
  },
  {
    path: 'research/skillsmith-v1-stack-summary.md',
    documentClass: 'superseded-design',
    sections: [
      planSection(
        'distribution',
        '## Runtime & build',
        'superseded-target',
        `P17 disposition: superseded distribution target; authority: ${PLAN}#p1-12-distribution`,
        'p1-12-distribution',
      ),
      planSection(
        'logging',
        '## Final dependency list (9 runtime)',
        'superseded-target',
        `P17 disposition: dependency list is historical and logging target is superseded; authority: ${PLAN}#ewp-cf-038-add-operation-scoped-structured-observability`,
        'ewp-cf-038-add-operation-scoped-structured-observability',
      ),
      planSection(
        'state',
        '## State management in practice',
        'superseded-target',
        `P17 disposition: superseded monolithic operation-log target; authority: ${PLAN}#92-planning-and-transaction-model`,
        '92-planning-and-transaction-model',
      ),
    ],
  },
  {
    path: 'research/commands/README.md',
    documentClass: 'current-command-index',
    sections: [
      planSection(
        'opening',
        '# SkillSmith command reference',
        'current-behavior',
        `P17 disposition: current page inventory; future target authority: ${PLAN}#321-canonical-help-and-documentation-groups`,
        '321-canonical-help-and-documentation-groups',
      ),
      planSection(
        'active-command-pages',
        '## Active command pages',
        'current-behavior',
        `P17 disposition: current shipped/draft status; future target authority: ${PLAN}#820-normative-command-and-option-registry`,
        '820-normative-command-and-option-registry',
      ),
    ],
  },
  {
    path: 'research/commands/agents.md',
    documentClass: 'shipped-command-reference',
    sections: [
      planSection(
        'opening',
        '# agents',
        'shipped-evidence',
        `P17 disposition: shipped command evidence, not future target authority; target: ${PLAN}#82-agents`,
        '82-agents',
      ),
    ],
  },
  {
    path: 'research/commands/apply.md',
    documentClass: 'superseded-command-spec',
    sections: [
      planSection(
        'opening',
        '# apply',
        'superseded-target',
        `P17 disposition: unimplemented superseded command draft; authority: ${PLAN}#814-apply`,
        '814-apply',
      ),
    ],
  },
  {
    path: 'research/commands/sync.md',
    documentClass: 'superseded-command-spec',
    sections: [
      planSection(
        'opening',
        '# sync',
        'superseded-target',
        `P17 disposition: unimplemented superseded command draft; authority: ${PLAN}#815-sync`,
        '815-sync',
      ),
    ],
  },
  {
    path: 'research/commands/doctor.md',
    documentClass: 'shipped-command-reference',
    sections: [
      planSection(
        'opening',
        '# doctor / check',
        'shipped-evidence',
        `P17 disposition: shipped command-family evidence; future target authority: ${PLAN}#810-doctor-check`,
        '810-doctor-check',
      ),
      planSection(
        'argument-order',
        '## Argument order',
        'shipped-evidence',
        `P17 disposition: shipped command shape; future target authority: ${PLAN}#810-doctor-check`,
        '810-doctor-check',
      ),
      planSection(
        'commands',
        '## Commands',
        'superseded-target',
        `P17 disposition: superseded check gating and option target; authority: ${PLAN}#810-doctor-check`,
        '810-doctor-check',
      ),
      planSection(
        'built-in-checks',
        '## Built-in checks',
        'superseded-target',
        `P17 disposition: superseded built-in check registry; authority: ${PLAN}#810-doctor-check`,
        '810-doctor-check',
      ),
      planSection(
        'plugin-contributed-healthchecks-p2',
        '## Plugin-contributed healthchecks (P2)',
        'superseded-target',
        `P17 disposition: superseded speculative plugin-healthcheck target; authority: ${PLAN}#810-doctor-check`,
        '810-doctor-check',
      ),
      planSection(
        'output-and-exit-behavior',
        '## Output and exit behavior',
        'superseded-target',
        `P17 disposition: superseded no-fix and check-exit target; authority: ${PLAN}#810-doctor-check`,
        '810-doctor-check',
      ),
      planSection(
        'feature-table',
        '## Feature table',
        'superseded-target',
        `P17 disposition: superseded feature phasing; authority: ${PLAN}#10-named-implementation-phases-and-slices`,
        '10-named-implementation-phases-and-slices',
      ),
      planSection(
        'flags',
        '## Flags',
        'superseded-target',
        `P17 disposition: superseded option registry; authority: ${PLAN}#820-normative-command-and-option-registry`,
        '820-normative-command-and-option-registry',
      ),
      planSection(
        'help-output',
        '## Help output',
        'shipped-evidence',
        `P17 disposition: shipped help evidence with superseded future surface; authority: ${PLAN}#810-doctor-check`,
        '810-doctor-check',
      ),
      planSection(
        'error-and-prompt-mockups',
        '## Error and prompt mockups',
        'superseded-target',
        `P17 disposition: historical output examples, superseded as target authority; authority: ${PLAN}#810-doctor-check`,
        '810-doctor-check',
      ),
    ],
  },
  {
    path: 'research/commands/install.md',
    documentClass: 'shipped-command-reference',
    sections: [
      planSection(
        'opening',
        '# install',
        'shipped-evidence',
        `P17 disposition: shipped current behavior; future target authority: ${PLAN}#86-install`,
        '86-install',
      ),
    ],
  },
  {
    path: 'research/commands/list.md',
    documentClass: 'shipped-command-reference',
    sections: [
      planSection(
        'opening',
        '# list',
        'shipped-evidence',
        `P17 disposition: shipped command evidence, not future target authority; target: ${PLAN}#83-list`,
        '83-list',
      ),
    ],
  },
  {
    path: 'research/commands/uninstall.md',
    documentClass: 'shipped-command-reference',
    sections: [
      planSection(
        'opening',
        '# uninstall',
        'shipped-evidence',
        `P17 disposition: shipped current behavior, not future GC authority; future target: ${PLAN}#87-uninstall`,
        '87-uninstall',
      ),
    ],
  },
  {
    path: 'research/commands/dev.md',
    documentClass: 'shipped-command-reference',
    sections: [
      planSection(
        'opening',
        '# dev',
        'shipped-evidence',
        `P17 disposition: shipped current behavior; future target authority: ${PLAN}#88-dev-promote`,
        '88-dev-promote',
      ),
    ],
  },
  {
    path: 'research/commands/promote.md',
    documentClass: 'shipped-command-reference',
    sections: [
      planSection(
        'opening',
        '# promote',
        'shipped-evidence',
        `P17 disposition: shipped current behavior; future target authority: ${PLAN}#88-dev-promote`,
        '88-dev-promote',
      ),
    ],
  },
  {
    path: 'research/commands/verify.md',
    documentClass: 'shipped-command-reference',
    sections: [
      planSection(
        'opening',
        '# verify',
        'shipped-evidence',
        `P17 disposition: shipped command evidence, not future target authority; target: ${PLAN}#89-verify`,
        '89-verify',
      ),
    ],
  },
  {
    path: 'docs/superpowers/specs/2026-07-07-p09-install-design.md',
    documentClass: 'shipped-project-record',
    sections: [
      planSection(
        'opening',
        '# SkillSmith P09 design',
        'shipped-evidence',
        `P17 disposition: shipped P09 evidence, not future target authority; target: ${PLAN}#86-install`,
        '86-install',
      ),
    ],
  },
  {
    path: 'docs/superpowers/plans/2026-07-07-p09-install-implementation.md',
    documentClass: 'shipped-project-record',
    sections: [
      planSection(
        'opening',
        '# SkillSmith P09 Implementation Plan',
        'shipped-evidence',
        `P17 disposition: shipped P09 implementation evidence, not an active plan; target: ${PLAN}#86-install`,
        '86-install',
      ),
    ],
  },
  {
    path: 'docs/superpowers/specs/2026-07-07-promote-dev-design.md',
    documentClass: 'shipped-project-record',
    sections: [
      planSection(
        'opening',
        '# SkillSmith P12 design',
        'shipped-evidence',
        `P17 disposition: shipped P12 evidence, not future target authority; target: ${PLAN}#88-dev-promote`,
        '88-dev-promote',
      ),
    ],
  },
  {
    path: 'docs/superpowers/plans/2026-07-07-promote-dev-implementation.md',
    documentClass: 'shipped-project-record',
    sections: [
      planSection(
        'opening',
        '# SkillSmith P12 Implementation Plan',
        'shipped-evidence',
        `P17 disposition: shipped P12 implementation evidence, not an active plan; target: ${PLAN}#88-dev-promote`,
        '88-dev-promote',
      ),
    ],
  },
  {
    path: 'docs/superpowers/specs/2026-07-10-p13-dev-source-prd.md',
    documentClass: 'shipped-project-record',
    sections: [
      planSection(
        'opening',
        '# P13 PRD',
        'shipped-evidence',
        `P17 disposition: shipped P13 evidence, not future target authority; target: ${PLAN}#88-dev-promote`,
        '88-dev-promote',
      ),
    ],
  },
  {
    path: 'docs/superpowers/plans/2026-07-10-p13-dev-source-plan.md',
    documentClass: 'shipped-project-record',
    sections: [
      planSection(
        'opening',
        '# P13 — `dev --source`',
        'shipped-evidence',
        `P17 disposition: shipped P13 implementation evidence, not an active plan; target: ${PLAN}#88-dev-promote`,
        '88-dev-promote',
      ),
    ],
  },
];

const STALE_CLAIMS = [
  [
    'four-tool-write-roadmap',
    'research/skillsmith-phases.md',
    '4-mvp-3--all-four-adapters',
    'No new commands. The MVP-1 and MVP-2 commands extend across all four supported agents.',
    'classified',
    null,
  ],
  [
    'mvp-2b-public-1.0',
    'research/skillsmith-phases.md',
    '322-first-public-release',
    'First public release',
    'classified',
    null,
  ],
  [
    'repeatable-file-apply',
    'research/skillsmith-cli-design.md',
    '058-manifest-driven-apply',
    '`--file` is repeatable',
    'classified',
    null,
  ],
  [
    'imperative-only-install',
    'research/skillsmith-cli-design.md',
    '051-tool-aware-install-with-scope-selection',
    'Given a source reference, a target tool, and a scope, place the skill',
    'classified',
    null,
  ],
  [
    'immortal-no-gc-target',
    'research/commands/uninstall.md',
    'opening',
    'Store entries are immortal',
    'classified',
    null,
  ],
  [
    'stale-schema-flags',
    'research/skillsmith-cli-design.md',
    '2-command-tree',
    'skillsmith apply [<manifest>]',
    'classified',
    null,
  ],
  [
    'absolute-no-io',
    'CLAUDE.md',
    'architectural-boundaries-enforced-by-eslint',
    'No CLI deps, no I/O side effects.',
    'corrected',
    'No CLI deps; core domain logic uses injected capability ports',
  ],
] as const;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const objects = (value: unknown): JsonObject[] =>
  Array.isArray(value) && value.every(isObject) ? value : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : [];
const visibleText = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
const exactKeys = (value: JsonObject, expected: string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const exactStrings = (actual: unknown, expected: readonly string[]): boolean =>
  JSON.stringify(strings(actual)) === JSON.stringify(expected);
const occurrenceCount = (text: string, needle: string): number => text.split(needle).length - 1;
const authorityRows = (value: unknown): JsonObject[] => {
  if (isObject(value)) return [value];
  return objects(value);
};
const authorityPointer = (authority: Authority): string =>
  `${authority.path}${authority.anchor ? `#${authority.anchor}` : ''}`;
const markerPointers = (marker: string): string[] =>
  marker.match(
    /[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+)*(?:\.md|\.json|\.ts|package\.json)(?:#[a-z0-9-]+)?/g,
  ) ?? [];
const nextMarkdownHeading = (tail: string, maxLevel = 6): number | null => {
  let offset = 0;
  let fenced = false;
  for (const line of tail.split(/(?<=\n)/)) {
    const bareLine = line.replace(/\r?\n$/, '');
    if (/^\s*(?:```|~~~)/.test(bareLine)) {
      fenced = !fenced;
    } else if (!fenced) {
      const heading = bareLine.match(/^(#{1,6})\s+/);
      if (heading && heading[1].length <= maxLevel) return offset;
    }
    offset += line.length;
  }
  return null;
};
const sectionText = (text: string, selector: string, path: string): string => {
  const selectorStart = text.indexOf(selector);
  if (selectorStart < 0) return '';
  const lineStart = text.lastIndexOf('\n', selectorStart - 1) + 1;
  const lineEnd = text.indexOf('\n', selectorStart);
  const selectorLine = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const heading = selectorLine.match(/^(#{1,6})\s+/);
  const helpTopic = path.endsWith('.ts') && /^\s{2}(?:'[^']+'|[a-z][a-z-]*):/.test(selectorLine);
  const tailStart = lineEnd < 0 ? text.length : lineEnd + 1;
  const tail = text.slice(tailStart);
  let end = text.length;
  if (heading) {
    const nextHeading = nextMarkdownHeading(tail, heading[1].length);
    if (nextHeading !== null) end = tailStart + nextHeading;
  } else if (helpTopic) {
    const nextTopic = /^\s{2}(?:'[^']+'|[a-z][a-z-]*):/gm.exec(tail);
    if (nextTopic) end = tailStart + nextTopic.index;
  } else {
    const nextHeading = nextMarkdownHeading(tail);
    if (nextHeading !== null) end = tailStart + nextHeading;
  }
  return text.slice(lineStart, end);
};
const markdownAnchorExists = (text: string, anchor: string): boolean => {
  const slugs = text
    .split('\n')
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .trim()
        .toLowerCase()
        .replace(/[`*_]/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-'),
    );
  return slugs.includes(anchor);
};

export const validateDocumentationDrift = (
  value: unknown,
  fileOverrides: Readonly<Record<string, string>> = {},
  inventoryOverrides: {
    commandPaths?: readonly string[];
    helpTopicNames?: readonly string[];
    helpTopicKeys?: readonly string[];
  } = {},
): string[] => {
  const errors: string[] = [];
  const readRepoFile = (path: string): string =>
    Object.hasOwn(fileOverrides, path)
      ? (fileOverrides[path] ?? '')
      : readFileSync(resolve(ROOT, path), 'utf8');
  if (!isObject(value)) return ['documentation drift ledger must be an object'];
  const rootFields = [
    'schemaVersion',
    'kind',
    'groupId',
    'dispositionEnum',
    'documents',
    'architectureDriftClosure',
    'knownStaleClaims',
    'downstreamCoverage',
    'downstreamStatus',
  ];
  if (!exactKeys(value, rootFields))
    errors.push(`documentation drift fields must equal: ${rootFields.join(', ')}`);
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (value.kind !== 'skillsmith.p17.documentation-drift')
    errors.push('kind must be skillsmith.p17.documentation-drift');
  if (value.groupId !== 'P17-G0-04') errors.push('groupId must be P17-G0-04');
  if (
    !exactStrings(value.dispositionEnum, [
      'current-behavior',
      'superseded-target',
      'shipped-evidence',
    ])
  )
    errors.push(
      'dispositionEnum must be exactly current-behavior, superseded-target, shipped-evidence',
    );

  const docs = objects(value.documents);
  const actualPaths = docs.map((doc) => doc.path);
  const expectedPaths = DOCUMENTS.map((doc) => doc.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
    errors.push('documents must contain the exact active-document inventory');
  const discoveredCommandPaths = [
    ...(inventoryOverrides.commandPaths ??
      readdirSync(resolve(ROOT, 'research/commands'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => `research/commands/${entry.name}`)),
  ].sort();
  const reviewedCommandPaths = actualPaths
    .filter(
      (path): path is string =>
        typeof path === 'string' && path.startsWith('research/commands/') && path.endsWith('.md'),
    )
    .sort();
  if (JSON.stringify(reviewedCommandPaths) !== JSON.stringify(discoveredCommandPaths))
    errors.push('research command documents must equal sorted filesystem discovery');
  const executableHelpNames = [
    ...(inventoryOverrides.helpTopicNames ?? HELP_TOPIC_NAMES),
  ] as readonly string[];
  const executableHelpKeys = [
    ...(inventoryOverrides.helpTopicKeys ?? Object.keys(TOPICS)),
  ] as readonly string[];
  if (JSON.stringify(executableHelpNames) !== JSON.stringify(executableHelpKeys))
    errors.push('HELP_TOPIC_NAMES and TOPICS must expose the same executable inventory');
  const helpDocument = docs.find((doc) => doc.path === 'packages/cli/src/help/topics.ts');
  const reviewedHelpIds = helpDocument ? objects(helpDocument.sections).map((row) => row.id) : [];
  if (JSON.stringify(reviewedHelpIds) !== JSON.stringify(executableHelpNames))
    errors.push('help sections must equal the executable HELP_TOPIC_NAMES and TOPICS inventory');

  for (const expected of DOCUMENTS) {
    const matches = docs.filter((doc) => doc.path === expected.path);
    if (matches.length !== 1) continue;
    const doc = matches[0];
    if (!exactKeys(doc, ['path', 'documentClass', 'summary', 'sections']))
      errors.push(`document ${expected.path} fields are invalid`);
    if (doc.documentClass !== expected.documentClass)
      errors.push(`document ${expected.path} class must be ${expected.documentClass}`);
    if (!visibleText(doc.summary))
      errors.push(`document ${expected.path} summary must contain visible text`);
    const actualSections = objects(doc.sections);
    if (
      JSON.stringify(actualSections.map((entry) => entry.id)) !==
      JSON.stringify(expected.sections.map((entry) => entry.id))
    )
      errors.push(`document ${expected.path} sections must equal its reviewed inventory`);
    const filePath = resolve(ROOT, expected.path);
    if (!existsSync(filePath)) {
      errors.push(`document ${expected.path} does not exist`);
      continue;
    }
    const fileText = readRepoFile(expected.path);
    for (const expectedSection of expected.sections) {
      const sectionRows = actualSections.filter((entry) => entry.id === expectedSection.id);
      if (sectionRows.length !== 1) continue;
      const actual = sectionRows[0];
      if (!exactKeys(actual, ['id', 'selector', 'disposition', 'marker', 'authority']))
        errors.push(`section ${expected.path}#${expectedSection.id} fields are invalid`);
      if (actual.selector !== expectedSection.selector)
        errors.push(`document ${expected.path} sections must equal its reviewed inventory`);
      if (
        !['current-behavior', 'superseded-target', 'shipped-evidence'].includes(
          String(actual.disposition),
        )
      )
        errors.push(`section ${expected.path}#${expectedSection.id} disposition is invalid`);
      else if (actual.disposition !== expectedSection.disposition)
        errors.push(
          `section ${expected.path}#${expectedSection.id} disposition contradicts its review`,
        );
      if (actual.marker !== expectedSection.marker || !visibleText(actual.marker))
        errors.push(
          `section ${expected.path}#${expectedSection.id} marker must be exact and visible`,
        );
      if (occurrenceCount(fileText, expectedSection.selector) !== 1) {
        errors.push(
          `section ${expected.path}#${expectedSection.id} selector must occur exactly once`,
        );
      } else {
        const local = visibleText(sectionText(fileText, expectedSection.selector, expected.path));
        if (!local.includes(visibleText(expectedSection.marker)))
          errors.push(
            `section ${expected.path}#${expectedSection.id} marker is not visible at its section`,
          );
      }
      const expectedAuthorities = Array.isArray(expectedSection.authority)
        ? expectedSection.authority
        : [expectedSection.authority];
      const actualAuthorities = authorityRows(actual.authority);
      if (JSON.stringify(actualAuthorities) !== JSON.stringify(expectedAuthorities))
        errors.push(`section ${expected.path}#${expectedSection.id} authority must be canonical`);
      const structuredPointers = expectedAuthorities.map(authorityPointer).sort();
      if (
        JSON.stringify([...markerPointers(expectedSection.marker)].sort()) !==
        JSON.stringify(structuredPointers)
      )
        errors.push(
          `section ${expected.path}#${expectedSection.id} textual authorities must be structurally verified`,
        );
      for (const authority of expectedAuthorities) {
        const authorityPath = resolve(ROOT, authority.path);
        if (!existsSync(authorityPath)) {
          errors.push(
            `section ${expected.path}#${expectedSection.id} authority path does not exist`,
          );
        } else if (authority.anchor) {
          const authorityText = readRepoFile(authority.path);
          if (!markdownAnchorExists(authorityText, authority.anchor))
            errors.push(
              `section ${expected.path}#${expectedSection.id} authority anchor does not exist`,
            );
        }
      }
      const localSection = sectionText(fileText, expectedSection.selector, expected.path);
      for (const requiredText of expectedSection.requiredText ?? []) {
        if (!localSection.includes(requiredText))
          errors.push(
            `section ${expected.path}#${expectedSection.id} required current-behavior text is absent`,
          );
      }
      for (const staleText of expectedSection.supersededText ?? []) {
        const authoritativeStaleLine = localSection
          .split('\n')
          .find((line) => line.includes(staleText) && !/\b(?:supersedes|replaces)\b/i.test(line));
        if (authoritativeStaleLine)
          errors.push(`section ${expected.path}#${expectedSection.id} stale authority is present`);
      }
      for (const forbiddenText of expectedSection.forbiddenText ?? []) {
        if (localSection.includes(forbiddenText))
          errors.push(`section ${expected.path}#${expectedSection.id} forbidden text is present`);
      }
    }
  }

  const catalogValue = JSON.parse(readRepoFile('projects/p17/catalog.json')) as unknown;
  if (!isObject(catalogValue)) {
    errors.push('projects/p17/catalog.json must remain an object');
  } else {
    const phases = objects(catalogValue.phases);
    const groups = objects(catalogValue.groups);
    const phase0 = phases.find((phase) => phase.id === '0');
    const signedGroups = ['P17-G0-01', 'P17-G0-02', 'P17-G0-03'].map((id) =>
      groups.find((group) => group.id === id),
    );
    const activeGroup = groups.find((group) => group.id === 'P17-G0-04');
    const gates = activeGroup && isObject(activeGroup.gates) ? activeGroup.gates : {};
    const gateRows = Object.entries(gates).filter((entry): entry is [string, JsonObject] =>
      isObject(entry[1]),
    );
    const lifecycleGateNames = [
      'mapped',
      'ready',
      'test-first',
      'minimal-implementation',
      'targeted-green',
      'impacted-green',
      'refactor',
      'adversarial-review',
      'traceability-closure',
      'signed-off',
    ];
    const hasExactLifecycleGates =
      JSON.stringify(gateRows.map(([name]) => name)) === JSON.stringify(lifecycleGateNames);
    const allLifecycleGatesPassed =
      hasExactLifecycleGates && gateRows.every(([, gate]) => gate.status === 'passed');
    if (!hasExactLifecycleGates)
      errors.push('projects/p17/catalog.json G0-04 lifecycle gate set is invalid');
    const lastPassedGate = gateRows.filter(([, gate]) => gate.status === 'passed').at(-1)?.[0];
    const nextPendingGate = gateRows.find(([, gate]) => gate.status === 'pending')?.[0];
    if (!nextPendingGate && !allLifecycleGatesPassed)
      errors.push('projects/p17/catalog.json G0-04 cannot claim all lifecycle gates passed');
    const executionText = visibleText(
      sectionText(
        readRepoFile('projects/p17/EXECUTION.md'),
        '# P17 execution map',
        'projects/p17/EXECUTION.md',
      ),
    );
    const groupProgress = nextPendingGate
      ? `\`P17-G0-04\` is \`${String(activeGroup?.status)}\`: its last passed gate is ` +
        `\`${String(lastPassedGate)}\`, and \`${nextPendingGate}\` remains pending.`
      : allLifecycleGatesPassed
        ? `\`P17-G0-04\` is \`${String(activeGroup?.status)}\`: all lifecycle gates are passed.`
        : `\`P17-G0-04\` is \`${String(activeGroup?.status)}\`: no lifecycle gate is pending, but not all lifecycle gates are passed.`;
    const expectedExecutionStatus = visibleText(
      `**Status:** Phase 0 is \`${String(phase0?.status)}\`. ` +
        `\`P17-G0-01\` through \`P17-G0-03\` are \`${
          signedGroups.every((group) => group?.status === 'signed-off')
            ? 'signed-off'
            : 'not-all-signed-off'
        }\`. ${groupProgress}`,
    );
    if (!executionText.includes(expectedExecutionStatus))
      errors.push('projects/p17/EXECUTION.md status must match live catalog phase and gate facts');
  }

  const closures = objects(value.architectureDriftClosure);
  if (
    JSON.stringify(closures.map((row) => row.id)) !==
    JSON.stringify(['P17-G0-03-D01', 'P17-G0-03-D02'])
  )
    errors.push('architectureDriftClosure must contain exact IDs: P17-G0-03-D01, P17-G0-03-D02');
  const closureTargets = [
    ['P17-G0-03-D01', 'CLAUDE.md', 'architectural-boundaries-enforced-by-eslint'],
    ['P17-G0-03-D02', 'docs/architecture.md', 'core--cli-split'],
  ];
  for (const [id, path, sectionId] of closureTargets) {
    const matches = closures.filter((row) => row.id === id);
    if (matches.length === 1 && !exactKeys(matches[0], ['id', 'path', 'sectionId', 'disposition']))
      errors.push(`architecture drift ${id} fields are invalid`);
    if (
      matches.length !== 1 ||
      matches[0].path !== path ||
      matches[0].sectionId !== sectionId ||
      matches[0].disposition !== 'closed-by-P17-G0-04'
    )
      errors.push(`architecture drift ${id} must be closed by P17-G0-04`);
  }

  const claims = objects(value.knownStaleClaims);
  if (
    JSON.stringify(claims.map((row) => row.id)) !==
    JSON.stringify(STALE_CLAIMS.map((row) => row[0]))
  )
    errors.push('knownStaleClaims must contain the exact stale-claim families');
  for (const [id, path, sectionId, staleText, resolution, replacementText] of STALE_CLAIMS) {
    const matches = claims.filter((row) => row.id === id);
    if (matches.length !== 1) continue;
    const row = matches[0];
    const expectedClaimKeys = [
      'id',
      'family',
      'path',
      'sectionId',
      'staleText',
      'resolution',
      'disposition',
      ...(resolution === 'corrected' ? ['replacementText'] : []),
    ];
    if (!exactKeys(row, expectedClaimKeys))
      errors.push(`known stale claim ${id} fields are invalid`);
    if (
      row.family !== id ||
      row.path !== path ||
      row.sectionId !== sectionId ||
      row.staleText !== staleText ||
      row.resolution !== resolution
    )
      errors.push(`known stale claim ${id} no longer identifies its stale text`);
    if (row.disposition !== 'visibly-closed')
      errors.push(`known stale claim ${id} must be visibly closed`);
    const fileText = readRepoFile(path);
    const expectedDocument = DOCUMENTS.find((document) => document.path === path);
    const expectedSection = expectedDocument?.sections.find((section) => section.id === sectionId);
    const reviewedSection = expectedSection
      ? sectionText(fileText, expectedSection.selector, path)
      : '';
    if (resolution === 'classified' && !reviewedSection.includes(staleText))
      errors.push(`known stale claim ${id} classified text is absent from its reviewed section`);
    if (resolution === 'corrected') {
      const staleLine = fileText.split('\n').find((line) => line.includes(staleText));
      if (staleLine && !/\b(?:supersedes|replaces)\b/i.test(staleLine)) {
        errors.push(`known stale claim ${id} remains authoritative`);
      }
      if (
        row.replacementText !== replacementText ||
        !replacementText ||
        !reviewedSection.includes(replacementText)
      )
        errors.push(`known stale claim ${id} correction is not present`);
    } else if ('replacementText' in row) {
      errors.push(`known stale claim ${id} must not invent replacement text`);
    }
  }

  if (!exactStrings(value.downstreamCoverage, ['EWP-P1-TS05', 'EWP-WF16']))
    errors.push('downstreamCoverage must remain exactly EWP-P1-TS05, EWP-WF16');
  if (value.downstreamStatus !== 'deferred') errors.push('downstreamStatus must remain deferred');
  return [...new Set(errors)];
};

const runCli = (): void => {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== '--check' && args[0] !== '--all')) {
    process.stderr.write('usage: bun scripts/p17-documentation-drift.ts --check|--all\n');
    process.exit(2);
  }
  const value = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as unknown;
  const errors = validateDocumentationDrift(value);
  if (errors.length > 0) {
    process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`P17-G0-04 documentation drift valid (${DOCUMENTS.length} documents)\n`);
};

if (import.meta.main) runCli();
