import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import drift from '../../../projects/p17/reviews/P17-G0-04-documentation-drift.json';
import { validateDocumentationDrift } from '../../../scripts/p17-documentation-drift';

type JsonObject = Record<string, unknown>;
const ROOT = resolve(import.meta.dir, '../../..');
const copy = (): JsonObject => structuredClone(drift) as JsonObject;
const rows = (value: JsonObject, key: string): JsonObject[] => value[key] as JsonObject[];
const document = (value: JsonObject, path: string): JsonObject => {
  const match = rows(value, 'documents').find((row) => row.path === path);
  if (!match) throw new Error(`missing test document ${path}`);
  return match;
};
const sections = (value: JsonObject, path: string): JsonObject[] =>
  document(value, path).sections as JsonObject[];
const section = (value: JsonObject, path: string, id: string): JsonObject => {
  const match = sections(value, path).find((row) => row.id === id);
  if (!match) throw new Error(`missing test section ${path}#${id}`);
  return match;
};
const mutate = (fn: (value: JsonObject) => void): string[] => {
  const value = copy();
  fn(value);
  return validateDocumentationDrift(value);
};
const mutateFile = (path: string, fn: (text: string) => string): string[] =>
  validateDocumentationDrift(copy(), {
    [path]: fn(readFileSync(resolve(ROOT, path), 'utf8')),
  });

describe('EWP-P0A-TS05 active documentation authority boundary', () => {
  test('EWP-P0A-TS05 accepts the exact reviewed active-document inventory', () => {
    expect(validateDocumentationDrift(copy())).toEqual([]);
  });

  test('EWP-P0A-TS05 covers every active research command page and omitted help topic', () => {
    const commandPaths = rows(copy(), 'documents')
      .map((row) => row.path)
      .filter(
        (path): path is string => typeof path === 'string' && path.startsWith('research/commands/'),
      );
    expect(commandPaths).toEqual([
      'research/commands/README.md',
      'research/commands/agents.md',
      'research/commands/apply.md',
      'research/commands/sync.md',
      'research/commands/doctor.md',
      'research/commands/install.md',
      'research/commands/list.md',
      'research/commands/uninstall.md',
      'research/commands/dev.md',
      'research/commands/promote.md',
      'research/commands/verify.md',
    ]);
    expect(sections(copy(), 'packages/cli/src/help/topics.ts').map((row) => row.id)).toEqual([
      'exit-codes',
      'environment',
      'scopes',
      'manifest',
      'sources',
      'formatting',
    ]);
    for (const path of [
      'research/commands/README.md',
      'research/commands/agents.md',
      'research/commands/doctor.md',
      'research/commands/list.md',
      'research/commands/verify.md',
    ]) {
      expect(
        mutate((value) => {
          value.documents = rows(value, 'documents').filter((row) => row.path !== path);
        }),
      ).toContain('documents must contain the exact active-document inventory');
    }
  });

  test('EWP-P0A-TS05 binds reviewed inventories to live command files and executable help topics', () => {
    const commandPaths = rows(copy(), 'documents')
      .map((row) => row.path)
      .filter(
        (path): path is string => typeof path === 'string' && path.startsWith('research/commands/'),
      );
    expect(
      validateDocumentationDrift(
        copy(),
        {},
        {
          commandPaths: [...commandPaths, 'research/commands/new-command.md'],
        },
      ),
    ).toContain('research command documents must equal sorted filesystem discovery');
    expect(
      validateDocumentationDrift(
        copy(),
        {},
        {
          commandPaths: commandPaths.map((path) =>
            path === 'research/commands/verify.md' ? 'research/commands/new-command.md' : path,
          ),
        },
      ),
    ).toContain('research command documents must equal sorted filesystem discovery');
    const helpIds = sections(copy(), 'packages/cli/src/help/topics.ts').map((row) =>
      String(row.id),
    );
    expect(
      validateDocumentationDrift(
        copy(),
        {},
        {
          helpTopicNames: [...helpIds, 'new-topic'],
          helpTopicKeys: [...helpIds, 'new-topic'],
        },
      ),
    ).toContain('help sections must equal the executable HELP_TOPIC_NAMES and TOPICS inventory');
    expect(
      validateDocumentationDrift(
        copy(),
        {},
        {
          helpTopicNames: [...helpIds, 'new-topic'],
          helpTopicKeys: helpIds,
        },
      ),
    ).toContain('HELP_TOPIC_NAMES and TOPICS must expose the same executable inventory');
  });

  test('EWP-P0A-TS05 rejects missing, duplicate, and comment-only document rows', () => {
    expect(mutate((value) => rows(value, 'documents').pop())).toContain(
      'documents must contain the exact active-document inventory',
    );
    expect(
      mutate((value) => {
        rows(value, 'documents')[1].path = rows(value, 'documents')[0].path;
      }),
    ).toContain('documents must contain the exact active-document inventory');
    expect(
      mutate((value) => {
        rows(value, 'documents')[0].summary = '<!-- reviewed -->';
      }),
    ).toContain('document CLAUDE.md summary must contain visible text');
  });

  test('EWP-P0A-TS05 rejects junk members in every governed array', () => {
    const mutations: Array<[string, (value: JsonObject) => void]> = [
      ['dispositionEnum must be exactly', (value) => (value.dispositionEnum as unknown[]).push({})],
      [
        'documents must contain the exact active-document inventory',
        (value) => (value.documents as unknown[]).push('junk'),
      ],
      [
        'document README.md sections must equal its reviewed inventory',
        (value) => (document(value, 'README.md').sections as unknown[]).push('junk'),
      ],
      [
        'architectureDriftClosure must contain exact IDs',
        (value) => (value.architectureDriftClosure as unknown[]).push('junk'),
      ],
      [
        'knownStaleClaims must contain the exact stale-claim families',
        (value) => (value.knownStaleClaims as unknown[]).push('junk'),
      ],
      [
        'downstreamCoverage must remain exactly',
        (value) => (value.downstreamCoverage as unknown[]).push({}),
      ],
    ];
    for (const [error, mutation] of mutations) {
      expect(mutate(mutation).some((message) => message.includes(error))).toBe(true);
    }
  });

  test('EWP-P0A-TS05 rejects shifted sections, generic notices, and noncanonical pointers', () => {
    expect(
      mutate((value) => {
        section(value, 'research/skillsmith-phases.md', 'opening').selector = '## MVP roadmap';
      }),
    ).toContain(
      'document research/skillsmith-phases.md sections must equal its reviewed inventory',
    );
    expect(
      mutate((value) => {
        section(value, 'research/skillsmith-phases.md', 'opening').marker =
          'This old material may be stale.';
      }),
    ).toContain('section research/skillsmith-phases.md#opening marker must be exact and visible');
    expect(
      mutate((value) => {
        const authority = section(
          value,
          'research/skillsmith-cli-design.md',
          '051-tool-aware-install-with-scope-selection',
        ).authority as JsonObject;
        authority.path = 'PROJECTS.md';
      }),
    ).toContain(
      'section research/skillsmith-cli-design.md#051-tool-aware-install-with-scope-selection authority must be canonical',
    );
  });

  test('EWP-P0A-TS05 structurally verifies every textual authority', () => {
    expect(
      mutate((value) => {
        const authorities = section(value, 'packages/cli/src/help/topics.ts', 'environment')
          .authority as JsonObject[];
        authorities.pop();
      }),
    ).toContain('section packages/cli/src/help/topics.ts#environment authority must be canonical');
    expect(
      mutate((value) => {
        section(value, 'README.md', 'packages').marker =
          'P17 disposition: current package boundary; authority: docs/architecture.md#core-cli-split and packages/core/package.json';
      }),
    ).toContain('section README.md#packages marker must be exact and visible');
  });

  test('EWP-P0A-TS05 bounds markers and stale claims to their reviewed sections', () => {
    const marker = String(
      section(copy(), 'research/skillsmith-phases.md', '4-mvp-3--all-four-adapters').marker,
    );
    expect(
      mutateFile('research/skillsmith-phases.md', (text) =>
        text.replace(`> ${marker}\n`, '').replace('## 5. MVP-4', `## 5. MVP-4\n\n> ${marker}`),
      ),
    ).toContain(
      'section research/skillsmith-phases.md#4-mvp-3--all-four-adapters marker is not visible at its section',
    );
    const stale =
      'No new commands. The MVP-1 and MVP-2 commands extend across all four supported agents.';
    expect(
      mutateFile('research/skillsmith-phases.md', (text) =>
        text
          .replace(stale, 'This sentence moved.')
          .replace('## 5. MVP-4', `## 5. MVP-4\n\n${stale}`),
      ),
    ).toContain(
      'known stale claim four-tool-write-roadmap classified text is absent from its reviewed section',
    );
  });

  test('EWP-P0A-TS05 rejects unresolved dispositions and false current-behavior prose', () => {
    expect(
      mutate((value) => {
        section(value, 'research/skillsmith-v1-stack-summary.md', 'distribution').disposition =
          'review-later';
      }),
    ).toContain(
      'section research/skillsmith-v1-stack-summary.md#distribution disposition is invalid',
    );
    expect(
      mutateFile('README.md', (text) =>
        text.replace(
          'domain/application operations behind injected capability ports; zero CLI dependencies.',
          'pure detection library with zero side effects.',
        ),
      ),
    ).toContain('section README.md#packages required current-behavior text is absent');
  });

  test('EWP-P0A-TS05 content-binds both G0-03 architecture corrections', () => {
    expect(
      mutateFile('CLAUDE.md', (text) =>
        text.replace(
          'No CLI deps; core domain logic uses injected capability ports, with no direct CLI output or process policy.',
          'No CLI deps, no I/O side effects.',
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'section CLAUDE.md#architectural-boundaries-enforced-by-eslint required current-behavior text is absent',
        'section CLAUDE.md#architectural-boundaries-enforced-by-eslint stale authority is present',
      ]),
    );
    expect(
      mutateFile('docs/architecture.md', (text) =>
        text.replace(
          'Core domain logic receives filesystem, process, clock, and observation capabilities through injected ports; it does not directly print, exit, prompt, or own CLI policy.',
          'Core is pure and has no I/O side effects.',
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'section docs/architecture.md#core--cli-split required current-behavior text is absent',
        'section docs/architecture.md#core--cli-split stale authority is present',
      ]),
    );
  });

  test('EWP-P0A-TS05 keeps current exit codes separate from the canonical P17 target', () => {
    expect(
      mutateFile('packages/cli/src/help/topics.ts', (text) =>
        text.replace(
          'Historical shipped reference only: research/skillsmith-cli-design.md §6.1. The canonical future taxonomy is the P17 target linked above.',
          'Full reference: research/skillsmith-cli-design.md §6.1',
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'section packages/cli/src/help/topics.ts#exit-codes required current-behavior text is absent',
        'section packages/cli/src/help/topics.ts#exit-codes forbidden text is present',
      ]),
    );
  });

  test('EWP-P0A-TS05 rejects contradictory extra fields in closure and stale-claim rows', () => {
    expect(
      mutate((value) => {
        rows(value, 'architectureDriftClosure')[0].status = 'open';
      }),
    ).toContain('architecture drift P17-G0-03-D01 fields are invalid');
    expect(
      mutate((value) => {
        rows(value, 'knownStaleClaims')[0].status = 'open';
      }),
    ).toContain('known stale claim four-tool-write-roadmap fields are invalid');
    expect(
      mutate((value) => {
        const corrected = rows(value, 'knownStaleClaims').find(
          (row) => row.id === 'absolute-no-io',
        );
        if (!corrected) throw new Error('missing corrected stale claim');
        corrected.status = 'open';
      }),
    ).toContain('known stale claim absolute-no-io fields are invalid');
  });

  test('EWP-P0A-TS05 explicitly classifies doctor/check conflicts by section', () => {
    expect(
      sections(copy(), 'research/commands/doctor.md').map((row) => [row.id, row.disposition]),
    ).toEqual([
      ['opening', 'shipped-evidence'],
      ['argument-order', 'shipped-evidence'],
      ['commands', 'superseded-target'],
      ['built-in-checks', 'superseded-target'],
      ['plugin-contributed-healthchecks-p2', 'superseded-target'],
      ['output-and-exit-behavior', 'superseded-target'],
      ['feature-table', 'superseded-target'],
      ['flags', 'superseded-target'],
      ['help-output', 'shipped-evidence'],
      ['error-and-prompt-mockups', 'superseded-target'],
    ]);
    expect(
      mutate((value) => sections(value, 'research/commands/doctor.md').splice(2, 1)),
    ).toContain('document research/commands/doctor.md sections must equal its reviewed inventory');
  });

  test('EWP-P0A-TS05 binds execution prose to live catalog status and gates', () => {
    expect(
      mutateFile('projects/p17/EXECUTION.md', (text) =>
        text.replace('Phase 0 is `approved`', 'Phase 0 is `ready`'),
      ),
    ).toContain('projects/p17/EXECUTION.md status must match live catalog phase and gate facts');
    expect(
      mutateFile('projects/p17/EXECUTION.md', (text) =>
        text.replace('Phase 1 is `approved`', 'Phase 1 is `planned`'),
      ),
    ).toContain('projects/p17/EXECUTION.md status must match live catalog phase and gate facts');
    expect(
      mutateFile('projects/p17/EXECUTION.md', (text) =>
        text.replace('Phase 2 is `approved`', 'Phase 2 is `planned`'),
      ),
    ).toContain('projects/p17/EXECUTION.md status must match live catalog phase and gate facts');
    expect(
      mutateFile('projects/p17/EXECUTION.md', (text) =>
        text.replace('Phase 3 is `active`', 'Phase 3 is `planned`'),
      ),
    ).toContain('projects/p17/EXECUTION.md status must match live catalog phase and gate facts');
    expect(
      mutateFile('projects/p17/EXECUTION.md', (text) =>
        text.replace(
          '**Status:**',
          '**Status:** Phase 0 is `planned` and G0-05 is not signed.\n\n**Status:**',
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'projects/p17/EXECUTION.md must contain exactly one opening Status block',
        'projects/p17/EXECUTION.md status must match live catalog phase and gate facts',
      ]),
    );
    expect(
      mutateFile(
        'projects/p17/EXECUTION.md',
        (text) => `**Status:** Phase 0 is \`planned\` and G0-05 is not signed.\n\n${text}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'projects/p17/EXECUTION.md H1 must be the first visible content',
        'projects/p17/EXECUTION.md must contain exactly one opening Status block',
        'projects/p17/EXECUTION.md status must match live catalog phase and gate facts',
      ]),
    );
    const catalog = JSON.parse(
      readFileSync(resolve(ROOT, 'projects/p17/catalog.json'), 'utf8'),
    ) as JsonObject;
    const group = (catalog.groups as JsonObject[]).find((row) => row.id === 'P17-G0-05');
    if (!group) throw new Error('missing P17-G0-05 catalog group');
    const gates = group.gates as JsonObject;
    (gates['traceability-closure'] as JsonObject).status = 'failed';
    expect(
      validateDocumentationDrift(copy(), {
        'projects/p17/catalog.json': JSON.stringify(catalog),
      }),
    ).toEqual(
      expect.arrayContaining([
        'projects/p17/catalog.json Phase 0 cannot claim all group lifecycle gates passed',
        'projects/p17/EXECUTION.md status must match live catalog phase and gate facts',
      ]),
    );

    const futureCatalog = JSON.parse(
      readFileSync(resolve(ROOT, 'projects/p17/catalog.json'), 'utf8'),
    ) as JsonObject;
    const phases = futureCatalog.phases as JsonObject[];
    const phase3 = phases.find((row) => row.id === '3');
    const phase4 = phases.find((row) => row.id === '4');
    if (!phase3 || !phase4) throw new Error('missing future phase catalog rows');
    phase3.status = 'approved';
    (phase3.review as JsonObject).status = 'passed';
    (phase3.approval as JsonObject).status = 'passed';
    (phase3.exit as JsonObject).status = 'passed';
    phase4.status = 'active';
    (phase4.entry as JsonObject).status = 'passed';
    const futureExecution = readFileSync(
      resolve(ROOT, 'projects/p17/EXECUTION.md'),
      'utf8',
    ).replace(
      'Phase 3 is `active`; its entry gate is passed.',
      'Phase 3 is `approved`; its entry, whole-phase review, standing approval, and exit are passed. Phase 4 is `active`; its entry gate is passed.',
    );
    expect(
      validateDocumentationDrift(copy(), {
        'projects/p17/catalog.json': JSON.stringify(futureCatalog),
        'projects/p17/EXECUTION.md': futureExecution,
      }),
    ).toEqual([]);
  });

  test('EWP-P0A-TS05 closes architecture drift, stale families, and downstream deferral', () => {
    expect(mutate((value) => rows(value, 'architectureDriftClosure').pop())).toContain(
      'architectureDriftClosure must contain exact IDs: P17-G0-03-D01, P17-G0-03-D02',
    );
    expect(mutate((value) => rows(value, 'knownStaleClaims').pop())).toContain(
      'knownStaleClaims must contain the exact stale-claim families',
    );
    expect(
      mutate((value) => {
        value.downstreamCoverage = ['EWP-P1-TS05'];
      }),
    ).toContain('downstreamCoverage must remain exactly EWP-P1-TS05, EWP-WF16');
    expect(
      mutate((value) => {
        value.downstreamStatus = 'active';
      }),
    ).toContain('downstreamStatus must remain deferred');
  });
});
