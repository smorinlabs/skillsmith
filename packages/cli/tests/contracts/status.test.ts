import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { resolveRuntimeConfiguration } from '../../../core/src/config/runtime.ts';
import { redactSensitiveValue } from '../../../core/src/safety/redaction.ts';
import { parseSkillFrontmatter } from '../../../core/src/skills/frontmatter.ts';
import { selectExitCode } from '../../src/util/exit-codes.ts';

const ROOT = join(import.meta.dir, '../../../..');
const STATUS_GOLDEN_PATH = join(ROOT, 'tests/ergonomics/fixtures/p3a-ts04/status-v1.golden.json');
const STATUS_HUMAN_PATH = join(ROOT, 'tests/ergonomics/fixtures/p3a-ts04/status-human.golden.txt');
const FILTER_NOOP_REASON = 'valid selection was reduced to zero by active filters';

const FAMILY_ALLOCATION = Object.freeze({
  'EWP-CMD-STATUS-TS01': Object.freeze([
    'command grammar, option metadata, and application binding',
    'isolated portable and live partial products',
    'all-absent product and deterministic partial human identity',
    'legacy configuration-only migration and adjacent lock filtering',
  ]),
  'EWP-CMD-STATUS-TS02': Object.freeze([
    'total six-class live matrix',
    'closed broken-reason precedence',
    'SKILL file predicates and unreadable isolation',
  ]),
  'EWP-CMD-STATUS-TS03': Object.freeze([
    'converged desired-lock-ledger-live relationship',
    'independent dimensional facts and composite placement tuple',
    'recorded verification without verifier or process authority',
  ]),
  'EWP-CMD-STATUS-TS04': Object.freeze([
    'logical and legacy journal eligibility and precedence',
    'journal projection with unique-live before state',
    'retention gates and independent revision/content checks',
    'migration OR and repeated presentation byte identity',
  ]),
  'EWP-CMD-STATUS-TS05': Object.freeze([
    'selection narrowing and human/JSON provenance parity',
    'shadow winner, non-shadow, and duplicate rules',
    'project identity and readable artifact defaults',
    'exact/no-guess placement joins and logical paths',
    'unknown tool, orphan lock, artifact pair, and selector refusal bounds',
  ]),
  'EWP-CMD-STATUS-TS06': Object.freeze([
    'exit precedence, filter noop, and journal context isolation',
    'strict status@1 rejection and verbosity independence',
    'recursive credential canaries and rendering refusal',
    'focused no-write boundary and selected-root failure isolation',
  ]),
});

type UnknownRecord = Record<string, unknown>;
type ReadonlyUnknownRecord = Readonly<Record<string, unknown>>;
type Result<T> =
  | Readonly<{ readonly ok: true; readonly value: T }>
  | Readonly<{ readonly ok: false; readonly error: ReadonlyUnknownRecord }>;
type ReadStatus = (
  ports: ReadonlyUnknownRecord,
  request: ReadonlyUnknownRecord,
) => Promise<Result<ReadonlyUnknownRecord>>;
type RunStatusApplication = (
  request: ReadonlyUnknownRecord,
  context: ReadonlyUnknownRecord,
) => Promise<ReadonlyUnknownRecord>;
type SelectReadableArtifactContext = (
  paths: ReadonlyUnknownRecord,
  context: ReadonlyUnknownRecord,
  request: ReadonlyUnknownRecord,
) => ReadonlyUnknownRecord;
interface StatusCodec {
  readonly descriptor: ReadonlyUnknownRecord;
  validate(value: unknown): Result<UnknownRecord>;
  encode(value: UnknownRecord): Result<string>;
}
type RenderStatus = (dto: ReadonlyUnknownRecord) => string;
type FinalizeStatusApplicationReport = (report: ReadonlyUnknownRecord) => Result<UnknownRecord>;
type CreateDiagnosticObserver = (
  io: ReadonlyUnknownRecord,
  verbosity: 'debug',
) => Readonly<{ observe(event: ReadonlyUnknownRecord): void }>;
type NormalizeCliError = (
  error: unknown,
  fallback?: ReadonlyUnknownRecord,
) => Readonly<{ readonly code: string; readonly message: string; readonly exitCode: number }>;
type RenderCliError = (
  error: Readonly<{ readonly code: string; readonly message: string; readonly exitCode: number }>,
  format: 'human' | 'json',
) => string;
type StatusOutcomeRenderer = Readonly<{
  human(outcome: ReadonlyUnknownRecord): unknown;
  json(outcome: ReadonlyUnknownRecord): unknown;
}>;
type CreateCurrentRendererRegistry = (
  root: Command,
) => Readonly<{ readonly status: StatusOutcomeRenderer }>;

const golden = JSON.parse(readFileSync(STATUS_GOLDEN_PATH, 'utf8')) as UnknownRecord;
const humanGolden = readFileSync(STATUS_HUMAN_PATH, 'utf8');
const cloneGolden = (): UnknownRecord => structuredClone(golden);
const entriesOf = (dto: ReadonlyUnknownRecord): UnknownRecord[] => dto.entries as UnknownRecord[];
const placementsOf = (entry: ReadonlyUnknownRecord): UnknownRecord[] =>
  entry.placements as UnknownRecord[];
const placementAt = (entry: ReadonlyUnknownRecord, index: number, label: string): UnknownRecord => {
  const placement = placementsOf(entry)[index];
  expect(placement, `missing fixture placement ${label}`).toBeDefined();
  if (placement === undefined) throw new Error(`missing fixture placement ${label}`);
  return placement;
};
const entryNamed = (dto: ReadonlyUnknownRecord, name: string): UnknownRecord => {
  const found = entriesOf(dto).find((entry) => entry.name === name);
  expect(found, `missing fixture status entry ${name}`).toBeDefined();
  if (found === undefined) throw new Error(`missing fixture status entry ${name}`);
  return found;
};
const unwrap = <T>(result: Result<T>, label: string): T => {
  if (!result.ok) {
    const failure = result as Readonly<{
      readonly ok: false;
      readonly error: ReadonlyUnknownRecord;
    }>;
    expect(false, `${label}: ${JSON.stringify(failure.error)}`).toBeTrue();
    throw new Error(label);
  }
  expect(result.ok, label).toBeTrue();
  return result.value;
};

const renderedOutputText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';
  const output = value as ReadonlyUnknownRecord;
  return [output.stdout, output.stderr]
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .join('');
};

let readStatus: ReadStatus;
let runStatusApplication: RunStatusApplication;
let selectReadableArtifactContext: SelectReadableArtifactContext;
let statusV1Codec: StatusCodec;
let renderStatusHuman: RenderStatus;
let renderStatusJson: RenderStatus;
let finalizeStatusApplicationReport: FinalizeStatusApplicationReport;
let createDiagnosticObserver: CreateDiagnosticObserver;
let normalizeCliError: NormalizeCliError;
let renderCliError: RenderCliError;
let createCurrentRendererRegistry: CreateCurrentRendererRegistry;
let currentCommandSpecs: readonly ReadonlyUnknownRecord[];
let currentOptionRelations: readonly ReadonlyUnknownRecord[];
let currentReadApplications: ReadonlyUnknownRecord;
let currentWireCommandMappings: readonly ReadonlyUnknownRecord[];
let currentWireContractRegistry: ReadonlyUnknownRecord;

const validateDto = (dto: UnknownRecord, label: string): UnknownRecord =>
  unwrap(statusV1Codec.validate(dto), label);

const setLogicalPathFailure = (retention: UnknownRecord, state: 'missing' | 'unverified'): void => {
  retention.pathState = state;
  for (const checkName of ['repositoryRevision', 'contentHash'] as const) {
    const check = retention[checkName] as UnknownRecord;
    check.state = state;
    check.observed = null;
  }
  retention.state = state;
};

const statusRequest = (overrides: ReadonlyUnknownRecord = {}): ReadonlyUnknownRecord =>
  Object.freeze({
    projectContext: Object.freeze({
      invocationCwd: '/repo',
      effectiveCwd: '/repo',
      projectRoot: '/repo',
      projectIdentity: '/repo',
      projectKind: 'git',
      discoveredConfigPath: '/repo/skillsmith.toml',
      explicitConfigPath: null,
    }),
    projectPlacement: Object.freeze({
      state: 'selected',
      source: 'shared-project',
      root: '/repo',
      identity: '/repo',
    }),
    configuration: resolveRuntimeConfiguration({ SKILLSMITH_HOME: '/data' }),
    targets: Object.freeze([]),
    tools: Object.freeze(['codex']),
    toolSelectionSource: 'explicit',
    scopes: Object.freeze(['user']),
    scopeSelectionSource: 'explicit',
    selectionSource: 'bounded-default',
    artifactSelection: Object.freeze({
      state: 'selected',
      source: 'user-default',
      manifestPath: '/config/skillsmith/skillsmith.toml',
      lockPath: '/config/skillsmith/skillsmith.lock',
      lockSource: 'sibling',
    }),
    ...overrides,
  });

beforeAll(async () => {
  // Allocation and literal shape guards intentionally precede all planned-authority imports.
  expect(Object.keys(FAMILY_ALLOCATION)).toEqual([
    'EWP-CMD-STATUS-TS01',
    'EWP-CMD-STATUS-TS02',
    'EWP-CMD-STATUS-TS03',
    'EWP-CMD-STATUS-TS04',
    'EWP-CMD-STATUS-TS05',
    'EWP-CMD-STATUS-TS06',
  ]);
  expect(Object.values(FAMILY_ALLOCATION).flat()).toHaveLength(23);
  expect(new Set(Object.values(FAMILY_ALLOCATION).flat()).size).toBe(23);
  expect(golden).toMatchObject({
    schemaVersion: 1,
    kind: 'skillsmith.status',
    selection: {
      source: 'bounded-default',
      toolSource: 'unbounded-default',
      scopeSource: 'unbounded-default',
      outcome: 'selected',
    },
    summary: { entries: 14, converged: 2, drifting: 12, migrationPending: false },
  });
  expect(entriesOf(golden)).toHaveLength(14);
  expect(entriesOf(golden).flatMap(placementsOf)).toHaveLength(15);
  expect(humanGolden.endsWith('\n')).toBeTrue();

  const [
    statusModule,
    discoveryModule,
    applicationModule,
    contractModule,
    registryModule,
    wireModule,
    humanModule,
    jsonModule,
    diagnosticsModule,
    errorBoundaryModule,
    currentRenderersModule,
  ] = await Promise.all([
    import('../../../core/src/status/index.ts').catch(() => null),
    import('../../../core/src/artifacts/discovery.ts').catch(() => null),
    import('../../../core/src/application/read-services.ts').catch(() => null),
    import('../../../core/src/contracts/v1/status.ts').catch(() => null),
    import('../../src/spec/registry.ts').catch(() => null),
    import('../../src/contracts/wire-contracts.ts').catch(() => null),
    import('../../src/output/status-human.ts').catch(() => null),
    import('../../src/output/status-json.ts').catch(() => null),
    import('../../src/runtime/diagnostics.ts').catch(() => null),
    import('../../src/output/error-boundary.ts').catch(() => null),
    import('../../src/runtime/current-renderers.ts').catch(() => null),
  ]);
  if (
    statusModule === null ||
    typeof statusModule.readStatus !== 'function' ||
    discoveryModule === null ||
    typeof discoveryModule.selectReadableArtifactContext !== 'function' ||
    applicationModule === null ||
    typeof applicationModule.runStatusApplication !== 'function' ||
    typeof applicationModule.finalizeStatusApplicationReport !== 'function' ||
    typeof applicationModule.CURRENT_READ_APPLICATIONS !== 'object' ||
    contractModule === null ||
    typeof contractModule.toStatusV1Dto !== 'function' ||
    typeof contractModule.statusV1Codec !== 'object' ||
    registryModule === null ||
    !Array.isArray(registryModule.CURRENT_COMMAND_SPECS) ||
    !Array.isArray(registryModule.CURRENT_OPTION_RELATIONS) ||
    wireModule === null ||
    !Array.isArray(wireModule.currentWireCommandMappings) ||
    typeof wireModule.currentWireContractRegistry !== 'object' ||
    humanModule === null ||
    typeof humanModule.renderStatusHuman !== 'function' ||
    jsonModule === null ||
    typeof jsonModule.renderStatusJson !== 'function' ||
    diagnosticsModule === null ||
    typeof diagnosticsModule.createCliDiagnosticObserver !== 'function' ||
    errorBoundaryModule === null ||
    typeof errorBoundaryModule.normalizeCliError !== 'function' ||
    typeof errorBoundaryModule.renderCliError !== 'function' ||
    currentRenderersModule === null ||
    typeof currentRenderersModule.createCurrentRendererRegistry !== 'function'
  ) {
    throw new Error('missing G3A-01 status authority');
  }
  readStatus = statusModule.readStatus as unknown as ReadStatus;
  selectReadableArtifactContext =
    discoveryModule.selectReadableArtifactContext as unknown as SelectReadableArtifactContext;
  runStatusApplication = applicationModule.runStatusApplication as unknown as RunStatusApplication;
  currentReadApplications = applicationModule.CURRENT_READ_APPLICATIONS as ReadonlyUnknownRecord;
  statusV1Codec = contractModule.statusV1Codec as unknown as StatusCodec;
  currentCommandSpecs = registryModule.CURRENT_COMMAND_SPECS as readonly ReadonlyUnknownRecord[];
  currentOptionRelations =
    registryModule.CURRENT_OPTION_RELATIONS as readonly ReadonlyUnknownRecord[];
  currentWireCommandMappings =
    wireModule.currentWireCommandMappings as readonly ReadonlyUnknownRecord[];
  currentWireContractRegistry =
    wireModule.currentWireContractRegistry as unknown as ReadonlyUnknownRecord;
  renderStatusHuman = humanModule.renderStatusHuman as unknown as RenderStatus;
  renderStatusJson = jsonModule.renderStatusJson as unknown as RenderStatus;
  finalizeStatusApplicationReport =
    applicationModule.finalizeStatusApplicationReport as unknown as FinalizeStatusApplicationReport;
  createDiagnosticObserver =
    diagnosticsModule.createCliDiagnosticObserver as unknown as CreateDiagnosticObserver;
  normalizeCliError = errorBoundaryModule.normalizeCliError as unknown as NormalizeCliError;
  renderCliError = errorBoundaryModule.renderCliError as unknown as RenderCliError;
  createCurrentRendererRegistry =
    currentRenderersModule.createCurrentRendererRegistry as unknown as CreateCurrentRendererRegistry;
});

describe('EWP-CMD-STATUS-TS01', () => {
  test('family 1: command grammar, option metadata, and application binding', () => {
    const spec = currentCommandSpecs.find((candidate) => candidate.path === 'skillsmith status');
    expect(spec).toMatchObject({
      name: 'skillsmith status',
      path: 'skillsmith status',
      aliases: [],
      group: 'discover',
      primaryQuestion: 'How do desired, locked, ledger, and live states relate?',
      application: 'status',
      reportKind: 'status',
      examples: ['skillsmith status', 'skillsmith status review --tool codex --check'],
    });
    if (spec === undefined) return;
    expect(spec.arguments).toEqual([
      expect.objectContaining({ name: 'skill', required: false, variadic: true }),
    ]);
    const options = spec.options as readonly ReadonlyUnknownRecord[];
    expect(options.map((option) => option.long)).toEqual([
      '--file',
      '--lockfile',
      '--tool',
      '--scope',
      '--system',
      '--user',
      '--project',
      '--managed',
      '--check',
      '--json',
    ]);
    expect(options.find((option) => option.long === '--tool')).toMatchObject({
      short: '-t',
      repeatable: true,
      allowedValues: ['claude-code', 'codex', 'kilo-code', 'opencode'],
    });
    expect(options.find((option) => option.long === '--scope')).toMatchObject({
      short: '-s',
      repeatable: false,
      allowedValues: ['system', 'user', 'project', 'managed'],
    });
    expect(spec.exitCodes).toEqual([
      { code: 0, meaning: expect.any(String) },
      { code: 1, meaning: expect.any(String) },
      { code: 2, meaning: expect.any(String) },
      { code: 3, meaning: expect.any(String) },
      { code: 4, meaning: expect.any(String) },
      { code: 5, meaning: expect.any(String) },
      { code: 6, meaning: expect.any(String) },
      { code: 7, meaning: expect.any(String) },
      { code: 130, meaning: expect.any(String) },
    ]);
    expect(currentReadApplications.status).toBe(runStatusApplication);
    expect(currentWireCommandMappings).toContainEqual({
      commandPath: 'skillsmith status',
      contractId: 'status',
      version: 1,
    });
    const registry = currentWireContractRegistry as {
      forCommand(path: string): { readonly descriptor: ReadonlyUnknownRecord } | undefined;
    };
    expect(registry.forCommand('skillsmith status')?.descriptor).toMatchObject({
      id: 'status',
      version: 1,
    });
  });

  test('family 2: isolated canonical manifest-only, lock-only, ledger-only, and untracked dev/store-link products', () => {
    const manifestOnly = entryNamed(golden, 'manifest-only');
    const lockOnly = entryNamed(golden, 'lock-only');
    const ledgerOnly = entryNamed(golden, 'ledger-only');
    const dev = entryNamed(golden, 'clean-dev');
    const storeLink = entryNamed(golden, 'clean-store-link');
    expect((manifestOnly.facts as UnknownRecord[]).map((fact) => fact.code)).toContain(
      'manifest-only',
    );
    expect((lockOnly.facts as UnknownRecord[]).map((fact) => fact.code)).toEqual(['lock-only']);
    expect(
      placementsOf(ledgerOnly).flatMap((row) =>
        (row.facts as UnknownRecord[]).map((fact) => fact.code),
      ),
    ).toContain('ledger-only');
    expect(placementsOf(dev)[0]).toMatchObject({ classification: 'dev' });
    expect(placementsOf(storeLink)[0]).toMatchObject({ classification: 'store-linked' });
    for (const isolated of [manifestOnly, lockOnly, ledgerOnly, dev, storeLink]) {
      const dto = cloneGolden();
      dto.entries = [structuredClone(isolated)];
      dto.summary = {
        entries: 1,
        converged: isolated.convergence === 'converged' ? 1 : 0,
        drifting: isolated.convergence === 'drift' ? 1 : 0,
        migrationPending: false,
      };
      validateDto(dto, `isolated ${String(isolated.name)}`);
    }
  });

  test('family 3: all-absent product and deterministic partial-product human identity', () => {
    const empty = cloneGolden();
    const artifacts = empty.artifacts as UnknownRecord;
    artifacts.manifest = { state: 'absent' };
    artifacts.lock = { state: 'absent' };
    artifacts.relationship = { state: 'none' };
    empty.ledger = {
      state: 'absent',
      path: '/home/test/.local/share/skillsmith/placements.json',
      sourceVersion: null,
      currentVersion: 2,
      migrationPending: false,
    };
    empty.entries = [];
    empty.summary = { entries: 0, converged: 0, drifting: 0, migrationPending: false };
    const validEmpty = validateDto(empty, 'all-absent status');
    expect(renderStatusJson(validEmpty)).toBe(renderStatusJson(validEmpty));
    expect(renderStatusHuman(validEmpty)).toBe(renderStatusHuman(validEmpty));

    for (const name of ['manifest-only', 'lock-only', 'ledger-only', 'live-only-unmanaged']) {
      const partial = cloneGolden();
      partial.entries = [structuredClone(entryNamed(golden, name))];
      partial.summary = { entries: 1, converged: 0, drifting: 1, migrationPending: false };
      const rendered = renderStatusHuman(validateDto(partial, `partial ${name}`));
      expect(rendered).toContain(name);
      expect(rendered).toBe(renderStatusHuman(validateDto(partial, `repeat ${name}`)));
    }
  });

  test('family 4: legacy configuration-only migration without desired/missing-lock drift and adjacent-lock filtering provenance', () => {
    const dto = cloneGolden();
    dto.selection = {
      source: 'bounded-default',
      targets: [],
      tools: ['codex'],
      toolSource: 'effective-config',
      scopes: ['user'],
      scopeSource: 'explicit',
      outcome: 'selected',
      reason: null,
    };
    const artifacts = dto.artifacts as UnknownRecord;
    artifacts.manifest = {
      state: 'present',
      sourceVersion: 'legacy',
      currentVersion: 1,
      byteRevision: 'sha256:legacy-bytes',
      semanticRevision: 'sha256:legacy-semantic',
      canonical: false,
      migrationPending: true,
    };
    artifacts.lock = { state: 'absent' };
    artifacts.relationship = { state: 'none' };
    dto.entries = [];
    dto.facts = [];
    dto.summary = { entries: 0, converged: 0, drifting: 0, migrationPending: true };
    const valid = validateDto(dto, 'legacy configuration-only status');
    expect(valid).toMatchObject({
      selection: { tools: ['codex'], toolSource: 'effective-config', scopes: ['user'] },
      artifacts: {
        manifest: { sourceVersion: 'legacy', migrationPending: true },
        relationship: { state: 'none' },
      },
      entries: [],
      facts: [],
    });
  });
});

describe('EWP-CMD-STATUS-TS02', () => {
  test('family 5: total dev/pinned/store-linked/unmanaged/broken/absent classification matrix', () => {
    const classes = new Set(
      entriesOf(golden)
        .flatMap(placementsOf)
        .map((placement) => placement.classification),
    );
    expect([...classes].sort()).toEqual(
      ['dev', 'pinned', 'store-linked', 'unmanaged', 'broken', 'absent'].sort(),
    );
    for (const placement of entriesOf(golden).flatMap(placementsOf)) {
      expect(placement.brokenReason === null).toBe(placement.classification !== 'broken');
    }
  });

  test('family 6: broken-reason precedence covers dangling, recorded absence, node kind, SKILL state, and mode contradiction', () => {
    const precedence = [
      'ledger-recorded-absence',
      'dangling-link',
      'wrong-node-kind',
      'skill-file-missing',
      'skill-file-invalid',
      'ledger-mode-contradiction',
    ] as const;
    const base = structuredClone(
      placementAt(entryNamed(golden, 'ledger-recorded-broken-link'), 0, 'broken link'),
    );
    for (const reason of precedence) {
      const dto = cloneGolden();
      const row = structuredClone(base);
      row.brokenReason = reason;
      row.facts = [
        {
          code: 'broken-live',
          impact: 'drift',
          subject: 'live',
          expected: 'valid',
          actual: reason,
        },
        {
          code: 'verify-skipped',
          impact: 'info',
          subject: 'verification',
          expected: 'recorded',
          actual: 'skipped',
        },
      ];
      const entry = structuredClone(entryNamed(golden, 'ledger-recorded-broken-link'));
      entry.placements = [row];
      dto.entries = [entry];
      dto.summary = { entries: 1, converged: 0, drifting: 1, migrationPending: false };
      validateDto(dto, `broken reason ${reason}`);
    }
    expect(precedence).toEqual([
      'ledger-recorded-absence',
      'dangling-link',
      'wrong-node-kind',
      'skill-file-missing',
      'skill-file-invalid',
      'ledger-mode-contradiction',
    ]);
  });

  test('family 7: SKILL file/symlink-to-file, frontmatter, UTF-8, directory-node, and unreadable isolation contract', () => {
    expect(parseSkillFrontmatter('# no frontmatter required').ok).toBeTrue();
    expect(parseSkillFrontmatter('---\ndescription: partial\n---\n').ok).toBeTrue();
    expect(parseSkillFrontmatter('---\nname: sample\n---\n').ok).toBeTrue();
    expect(parseSkillFrontmatter('---\nname: [\n---\n').ok).toBeFalse();
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])),
    ).toThrow();

    const liveStates = ['valid', 'missing', 'invalid'] as const;
    for (const skillFile of liveStates) {
      const dto = cloneGolden();
      const entry = structuredClone(entryNamed(golden, 'clean-pinned-copy'));
      const row = placementAt(entry, 0, `SKILL.md ${skillFile}`);
      (row.live as UnknownRecord).value = {
        ...((row.live as UnknownRecord).value as UnknownRecord),
        skillFile,
      };
      if (skillFile !== 'valid') {
        const brokenReason = skillFile === 'missing' ? 'skill-file-missing' : 'skill-file-invalid';
        row.classification = 'broken';
        row.brokenReason = brokenReason;
        row.facts = [
          {
            code: 'broken-live',
            impact: 'drift',
            subject: 'live',
            expected: 'valid',
            actual: brokenReason,
          },
          {
            code: 'verify-passed',
            impact: 'info',
            subject: 'verification',
            expected: 'recorded',
            actual: 'passed',
          },
        ];
        entry.convergence = 'drift';
      }
      dto.entries = [entry];
      dto.summary = {
        entries: 1,
        converged: skillFile === 'valid' ? 1 : 0,
        drifting: skillFile === 'valid' ? 0 : 1,
        migrationPending: false,
      };
      validateDto(dto, `SKILL.md state ${skillFile}`);
    }
    expect(['file', 'symlink-to-file']).not.toContain('directory-named-SKILL.md');
  });
});

describe('EWP-CMD-STATUS-TS03', () => {
  test('family 8: converged desired, lock, ledger, and live relationship', () => {
    const clean = entryNamed(golden, 'clean-pinned-copy');
    expect(clean).toMatchObject({
      desired: { state: 'present' },
      locked: { state: 'present' },
      convergence: 'converged',
    });
    expect(placementsOf(clean)[0]).toMatchObject({
      ledger: { state: 'present' },
      live: { state: 'present' },
      classification: 'pinned',
      facts: [{ code: 'verify-passed', impact: 'info', subject: 'verification' }],
    });
    expect((golden.artifacts as UnknownRecord).relationship).toEqual({ state: 'current' });
  });

  test('family 9: independent revision/content/source facts, subgroup tuple, and one composite placement fact', () => {
    const factsFor = (name: string) =>
      placementsOf(entryNamed(golden, name)).flatMap(
        (row) => row.facts as readonly UnknownRecord[],
      );
    expect(factsFor('revision-drift')).toContainEqual(
      expect.objectContaining({ code: 'revision-drift', subject: 'ledger' }),
    );
    expect(factsFor('content-drift')).toContainEqual(
      expect.objectContaining({ code: 'content-drift', subject: 'ledger' }),
    );
    const sourceFact = factsFor('source-drift').find((fact) => fact.code === 'source-drift');
    expect(JSON.parse(String(sourceFact?.expected))).toEqual([
      'github.com',
      'skillsmith/status-fixtures',
      'source-drift',
    ]);
    const placementFacts = factsFor('placement-drift').filter(
      (fact) => fact.code === 'placement-drift',
    );
    expect(placementFacts).toHaveLength(1);
    expect(JSON.parse(String(placementFacts[0]?.expected))).toEqual([
      'copy',
      'pinned',
      '/repo/.kilo/skills/placement-drift',
    ]);
    expect(JSON.parse(String(placementFacts[0]?.actual))).toEqual([
      'symlink',
      'dev',
      '/repo/.kilo/skills/placement-drift',
    ]);
  });

  test('family 10: passed/warned/skipped/unrecorded verification is recorded without verifier or process', () => {
    const verifications = new Set(
      entriesOf(golden)
        .flatMap(placementsOf)
        .map((row) => row.verification),
    );
    expect([...verifications].sort()).toEqual(['passed', 'warned', 'skipped', 'unrecorded'].sort());
    for (const row of entriesOf(golden).flatMap(placementsOf)) {
      const facts = row.facts as readonly UnknownRecord[];
      expect(facts.filter((fact) => String(fact.code).startsWith('verify-'))).toEqual([
        {
          code: `verify-${String(row.verification)}`,
          impact: 'info',
          subject: 'verification',
          expected: 'recorded',
          actual: row.verification,
        },
      ]);
    }

    for (const [label, mutate] of [
      [
        'unknown fact code',
        (fact: UnknownRecord) => {
          fact.code = 'unknown-fact';
        },
      ],
      [
        'wrong fact subject',
        (fact: UnknownRecord) => {
          fact.subject = 'live';
        },
      ],
      [
        'wrong fact impact',
        (fact: UnknownRecord) => {
          fact.impact = 'drift';
        },
      ],
    ] as const) {
      const invalid = cloneGolden();
      const row = placementsOf(entryNamed(invalid, 'clean-pinned-copy'))[0];
      const fact = (row?.facts as UnknownRecord[] | undefined)?.[0];
      if (fact === undefined) throw new Error(`missing verification fact for ${label}`);
      mutate(fact);
      expect(statusV1Codec.validate(invalid).ok, label).toBeFalse();
    }
  });
});

describe('EWP-CMD-STATUS-TS04', () => {
  test('family 11: logical/v1 phase-before eligibility, pending precedence, and journal-only targets', () => {
    const pending = structuredClone(
      placementAt(entryNamed(golden, 'shadowed-fleet'), 1, 'pending project journal').journal,
    ) as UnknownRecord;
    const phases = ['prepared', 'staged', 'backed-up', 'live'] as const;
    for (const phase of phases) {
      const dto = cloneGolden();
      const journalOnly = structuredClone(entryNamed(golden, 'declared-locked-absent'));
      journalOnly.name = `journal-only-${phase}`;
      journalOnly.desired = { state: 'absent' };
      journalOnly.locked = { state: 'absent' };
      journalOnly.facts = [];
      const row = placementAt(journalOnly, 0, `journal-only ${phase}`);
      row.ledger = { state: 'absent' };
      row.live = { state: 'absent' };
      row.journal = { ...structuredClone(pending), phase, before: 'absent' };
      const identity = row.identity as UnknownRecord;
      identity.path = `/home/test/.agents/skills/journal-only-${phase}`;
      ((row.journal as UnknownRecord).remediation as UnknownRecord).abort = [
        'skillsmith',
        'undo',
        identity.path,
        '--tool',
        identity.tool,
        '--scope',
        identity.scope,
      ];
      row.facts = [
        {
          code: 'journal-pending',
          impact: 'drift',
          subject: 'journal',
          expected: 'committed',
          actual: phase,
        },
        {
          code: 'verify-unrecorded',
          impact: 'info',
          subject: 'verification',
          expected: 'recorded',
          actual: 'unrecorded',
        },
      ];
      dto.entries = [journalOnly];
      dto.summary = { entries: 1, converged: 0, drifting: 1, migrationPending: false };
      validateDto(dto, `logical pending ${phase} from absent`);
    }

    type PendingPhase = 'prepared' | 'staged' | 'backed-up' | 'live';
    type PendingBefore = 'dev' | 'pinned' | 'absent' | 'multi-resource';
    type RetentionState = 'satisfied' | 'missing' | 'unverified';
    const logicalGateScenario = (
      phase: PendingPhase,
      before: PendingBefore,
      eligibility:
        | 'eligible'
        | 'not-reversible'
        | 'retention-incomplete'
        | 'retention-missing'
        | 'retention-unverified',
      retentionState: RetentionState,
    ): UnknownRecord => {
      const dto = cloneGolden();
      const row = placementAt(entryNamed(dto, 'shadowed-fleet'), 1, 'logical gate scenario');
      const journal = row.journal as UnknownRecord;
      journal.phase = phase;
      journal.before = before;
      journal.abortEligibility = eligibility;
      const retention = (journal.retention as UnknownRecord[])[0];
      if (retention === undefined) throw new Error('missing logical gate retention');
      if (retentionState !== 'satisfied') setLogicalPathFailure(retention, retentionState);
      const remediation = journal.remediation as UnknownRecord;
      remediation.abort = eligibility === 'eligible' ? remediation.abort : null;
      const facts = row.facts as UnknownRecord[];
      const journalFact = facts.find((fact) => fact.code === 'journal-pending');
      if (journalFact !== undefined) journalFact.actual = phase;
      row.facts = facts.filter((fact) => !String(fact.code).startsWith('retention-'));
      if (eligibility === 'retention-incomplete') {
        (row.facts as UnknownRecord[]).push({
          code: 'retention-incomplete',
          impact: 'drift',
          subject: 'journal',
          expected: 'complete',
          actual: 'incomplete',
        });
      } else if (eligibility === 'retention-missing' || eligibility === 'retention-unverified') {
        (row.facts as UnknownRecord[]).push({
          code: eligibility,
          impact: 'drift',
          subject: 'journal',
          expected: '["retained-live","/data/skillsmith/backups/shadowed-fleet"]',
          actual: retentionState,
        });
      }
      return dto;
    };

    for (const phase of phases) {
      for (const retentionState of ['missing', 'unverified'] as const) {
        const dto = logicalGateScenario(phase, 'absent', 'eligible', retentionState);
        const decoded = validateDto(dto, `${phase} absent with incidental ${retentionState}`);
        const row = placementAt(
          entryNamed(decoded, 'shadowed-fleet'),
          1,
          `${phase} absent decoded retention`,
        );
        expect((row.journal as UnknownRecord).abortEligibility).toBe('eligible');
        expect(((row.journal as UnknownRecord).retention as UnknownRecord[])[0]).toMatchObject({
          state: retentionState,
        });
        expect(((row.journal as UnknownRecord).remediation as UnknownRecord).abort).toEqual([
          'skillsmith',
          'undo',
          '/repo/.agents/skills/shadowed-fleet',
          '--tool',
          'codex',
          '--scope',
          'project',
        ]);
      }
    }
    for (const phase of ['prepared', 'staged'] as const) {
      for (const before of ['dev', 'pinned'] as const) {
        for (const retentionState of ['missing', 'unverified'] as const) {
          validateDto(
            logicalGateScenario(phase, before, 'eligible', retentionState),
            `${phase} ${before} with incidental ${retentionState}`,
          );
        }
      }
    }

    for (const [label, dto] of [
      [
        'absent pending cannot report retention failure',
        logicalGateScenario('live', 'absent', 'retention-missing', 'missing'),
      ],
      [
        'absent pending cannot be not-reversible',
        logicalGateScenario('prepared', 'absent', 'not-reversible', 'satisfied'),
      ],
      [
        'early dev pending cannot report incomplete retention',
        logicalGateScenario('prepared', 'dev', 'retention-incomplete', 'satisfied'),
      ],
      [
        'early pinned pending cannot report retention failure',
        logicalGateScenario('staged', 'pinned', 'retention-unverified', 'unverified'),
      ],
      [
        'multi-resource pending must be not-reversible',
        logicalGateScenario('backed-up', 'multi-resource', 'eligible', 'satisfied'),
      ],
      [
        'multi-resource pending cannot report retention failure',
        logicalGateScenario('live', 'multi-resource', 'retention-missing', 'missing'),
      ],
      [
        'later dev pending requires satisfied eligible retention',
        logicalGateScenario('backed-up', 'dev', 'eligible', 'missing'),
      ],
      [
        'later pinned pending requires satisfied eligible retention',
        logicalGateScenario('live', 'pinned', 'eligible', 'unverified'),
      ],
    ] as const) {
      expect(statusV1Codec.validate(dto).ok, label).toBeFalse();
    }
    validateDto(
      logicalGateScenario('prepared', 'dev', 'not-reversible', 'unverified'),
      'early dev intent-gate not-reversible',
    );
    validateDto(
      logicalGateScenario('live', 'multi-resource', 'not-reversible', 'missing'),
      'multi-resource intent-gate not-reversible',
    );

    const committedLogical = logicalGateScenario('backed-up', 'pinned', 'eligible', 'missing');
    const committedLogicalRow = placementAt(
      entryNamed(committedLogical, 'shadowed-fleet'),
      1,
      'committed logical retention gate',
    );
    const pendingLogicalJournal = committedLogicalRow.journal as UnknownRecord;
    const pendingLogicalRemediation = pendingLogicalJournal.remediation as UnknownRecord;
    committedLogicalRow.journal = {
      state: 'committed',
      transactionId: pendingLogicalJournal.transactionId,
      phase: 'committed',
      before: pendingLogicalJournal.before,
      retention: pendingLogicalJournal.retention,
      reverseEligibility: 'eligible',
      remediation: { reverse: pendingLogicalRemediation.abort },
      format: 'logical',
      operation: pendingLogicalJournal.operation,
    };
    expect(
      statusV1Codec.validate(committedLogical).ok,
      'committed logical eligible requires satisfied retention',
    ).toBeFalse();

    const committedMultiResource = cloneGolden();
    const committedMultiResourceRow = placementAt(
      entryNamed(committedMultiResource, 'shadowed-fleet'),
      1,
      'committed logical multi-resource',
    );
    const pendingMultiResourceJournal = committedMultiResourceRow.journal as UnknownRecord;
    const pendingMultiResourceRemediation =
      pendingMultiResourceJournal.remediation as UnknownRecord;
    committedMultiResourceRow.journal = {
      state: 'committed',
      transactionId: pendingMultiResourceJournal.transactionId,
      phase: 'committed',
      before: 'multi-resource',
      retention: pendingMultiResourceJournal.retention,
      reverseEligibility: 'not-reversible',
      remediation: { reverse: null },
      format: 'logical',
      operation: pendingMultiResourceJournal.operation,
    };
    validateDto(committedMultiResource, 'committed logical multi-resource is not-reversible');
    const invalidCommittedMultiResource = structuredClone(committedMultiResource);
    const invalidCommittedMultiResourceRow = placementAt(
      entryNamed(invalidCommittedMultiResource, 'shadowed-fleet'),
      1,
      'eligible committed logical multi-resource',
    );
    const invalidCommittedMultiResourceJournal =
      invalidCommittedMultiResourceRow.journal as UnknownRecord;
    invalidCommittedMultiResourceJournal.reverseEligibility = 'eligible';
    (invalidCommittedMultiResourceJournal.remediation as UnknownRecord).reverse =
      pendingMultiResourceRemediation.abort;
    expect(
      statusV1Codec.validate(invalidCommittedMultiResource).ok,
      'committed logical multi-resource cannot be eligible',
    ).toBeFalse();

    const legacyEarly = logicalGateScenario('prepared', 'absent', 'eligible', 'satisfied');
    const legacyEarlyRow = placementAt(
      entryNamed(legacyEarly, 'shadowed-fleet'),
      1,
      'legacy pre-retention lookalike',
    );
    const legacyEarlyJournal = legacyEarlyRow.journal as UnknownRecord;
    legacyEarlyJournal.format = 'legacy-pair';
    legacyEarlyJournal.operation = 'promote';
    legacyEarlyJournal.retention = [
      {
        format: 'legacy-pair',
        resourceId: null,
        retainUntil: null,
        structural: {
          state: 'unverified',
          expected: { kind: 'symlink', linkTarget: '/fixture/source' },
          observed: null,
        },
        repositoryRevision: {
          state: 'not-recorded',
          domain: null,
          expected: null,
          observed: null,
        },
        contentHash: {
          state: 'not-recorded',
          domain: null,
          expected: null,
          observed: null,
        },
        role: 'backup',
        sourceRole: 'live',
        path: '/data/skillsmith/backups/legacy-early',
        pathState: 'satisfied',
        state: 'unverified',
      },
    ];
    expect(
      statusV1Codec.validate(legacyEarly).ok,
      'legacy eligible still requires satisfied retention',
    ).toBeFalse();
    expect(['pending-logical', 'pending-legacy', 'committed-logical', 'committed-legacy']).toEqual([
      'pending-logical',
      'pending-legacy',
      'committed-logical',
      'committed-legacy',
    ]);
  });

  test('family 12: transaction, phase, unique-live before, retention, and literal human/status@1 projection', () => {
    const shadowed = entryNamed(golden, 'shadowed-fleet');
    const project = placementAt(shadowed, 1, 'shadow winner');
    expect(project.journal).toMatchObject({
      state: 'pending',
      format: 'logical',
      operation: 'update',
      transactionId: 'tx-shadowed-fleet',
      phase: 'backed-up',
      before: 'pinned',
      abortEligibility: 'eligible',
      retention: [
        {
          resourceId: 'retained-live',
          pathState: 'satisfied',
          state: 'satisfied',
        },
      ],
    });
    expect(renderStatusJson(validateDto(cloneGolden(), 'mixed journal golden'))).toBe(
      readFileSync(STATUS_GOLDEN_PATH, 'utf8'),
    );
    expect(renderStatusHuman(validateDto(cloneGolden(), 'mixed human golden'))).toBe(humanGolden);
  });

  test('family 13: logical gates, resource/deadline, dual checks, EACCES, nullable argv, and duplicate-path disambiguation', () => {
    const source = placementAt(entryNamed(golden, 'shadowed-fleet'), 1, 'retention source');
    const requirement = (source.journal as UnknownRecord).retention as UnknownRecord[];
    expect(requirement[0]).toMatchObject({
      resourceId: 'retained-live',
      retainUntil: '2026-08-01T00:00:00.000Z',
      pathState: 'satisfied',
      repositoryRevision: {
        state: 'satisfied',
        expected: { kind: 'resource', digest: 'sha256:retained-revision' },
      },
      contentHash: {
        state: 'satisfied',
        domain: 'source-content',
        expected: 'sha256:retained-content',
      },
    });
    const states = [
      ['retention-missing', 'missing'],
      ['retention-mismatch', 'mismatch'],
      ['retention-unverified', 'unverified'],
      ['retention-incomplete', 'incomplete'],
    ] as const;
    for (const [eligibility, observed] of states) {
      const dto = cloneGolden();
      const row = placementAt(entryNamed(dto, 'shadowed-fleet'), 1, eligibility);
      const journal = row.journal as UnknownRecord;
      journal.abortEligibility = eligibility;
      (journal.remediation as UnknownRecord).abort = null;
      const retention = (journal.retention as UnknownRecord[])[0] as UnknownRecord;
      if (eligibility === 'retention-missing') {
        setLogicalPathFailure(retention, 'missing');
      } else if (eligibility === 'retention-mismatch') {
        const contentHash = retention.contentHash as UnknownRecord;
        contentHash.state = 'mismatch';
        contentHash.observed = 'sha256:different-retained-content';
        retention.state = 'mismatch';
      } else if (eligibility === 'retention-unverified') {
        const contentHash = retention.contentHash as UnknownRecord;
        contentHash.state = 'unverified';
        contentHash.observed = null;
        retention.state = 'unverified';
      }
      const existingFacts = row.facts as UnknownRecord[];
      const verification = existingFacts.find((fact) => String(fact.code).startsWith('verify-'));
      row.facts = [
        ...existingFacts.filter((fact) => !String(fact.code).startsWith('verify-')),
        {
          code: eligibility,
          impact: 'drift',
          subject: 'journal',
          expected:
            eligibility === 'retention-incomplete'
              ? 'complete'
              : '["retained-live","/data/skillsmith/backups/shadowed-fleet"]',
          actual: observed,
        },
        ...(verification === undefined ? [] : [verification]),
      ];
      validateDto(dto, eligibility);
    }

    const retentionScenario = (
      requirements: readonly ('missing' | 'mismatch' | 'unverified')[],
    ): UnknownRecord => {
      const dto = cloneGolden();
      const row = placementAt(entryNamed(dto, 'shadowed-fleet'), 1, 'retention multiset');
      const journal = row.journal as UnknownRecord;
      const source = (journal.retention as UnknownRecord[])[0] as UnknownRecord;
      const retention = requirements.map((state, index) => {
        const requirement = structuredClone(source);
        requirement.resourceId = `retained-${String.fromCharCode(97 + index)}`;
        requirement.path = `/retained/${String.fromCharCode(97 + index)}`;
        requirement.state = state;
        if (state === 'missing') {
          setLogicalPathFailure(requirement, 'missing');
        } else if (state === 'unverified') {
          setLogicalPathFailure(requirement, 'unverified');
        } else {
          const contentHash = requirement.contentHash as UnknownRecord;
          contentHash.state = state;
          contentHash.observed = state === 'mismatch' ? `sha256:different-${index}` : null;
        }
        return requirement;
      });
      journal.retention = retention;
      journal.abortEligibility = requirements.includes('missing')
        ? 'retention-missing'
        : requirements.includes('mismatch')
          ? 'retention-mismatch'
          : 'retention-unverified';
      (journal.remediation as UnknownRecord).abort = null;
      const factRank = { missing: 0, mismatch: 1, unverified: 2 } as const;
      const retentionFacts = retention
        .map((requirement) => ({
          code: `retention-${String(requirement.state)}`,
          impact: 'drift',
          subject: 'journal',
          expected: JSON.stringify([requirement.resourceId, requirement.path]),
          actual: requirement.state,
        }))
        .sort(
          (left, right) =>
            factRank[left.actual as keyof typeof factRank] -
              factRank[right.actual as keyof typeof factRank] ||
            String(left.expected).localeCompare(String(right.expected)),
        );
      const existingFacts = row.facts as UnknownRecord[];
      const verification = existingFacts.find((fact) => String(fact.code).startsWith('verify-'));
      row.facts = [
        ...existingFacts.filter((fact) => !String(fact.code).startsWith('verify-')),
        ...retentionFacts,
        ...(verification === undefined ? [] : [verification]),
      ];
      return dto;
    };

    const sameState = retentionScenario(['mismatch', 'mismatch']);
    validateDto(sameState, 'same-state retention fact multiset');
    const mixedState = retentionScenario(['unverified', 'missing', 'mismatch']);
    validateDto(mixedState, 'mixed multi-resource retention fact multiset');
    const mixedRow = placementAt(entryNamed(mixedState, 'shadowed-fleet'), 1, 'mixed facts');
    const mixedFacts = (mixedRow.facts as UnknownRecord[]).filter((fact) =>
      String(fact.code).startsWith('retention-'),
    );
    expect(mixedFacts.map((fact) => fact.code)).toEqual([
      'retention-missing',
      'retention-mismatch',
      'retention-unverified',
    ]);
    for (const [label, mutateFacts] of [
      ['missing fact', (facts: UnknownRecord[]) => facts.splice(1, 1)],
      [
        'duplicate fact',
        (facts: UnknownRecord[]) => {
          const duplicate = facts[0];
          if (duplicate !== undefined) facts.push(structuredClone(duplicate));
        },
      ],
      [
        'wrong fact tuple',
        (facts: UnknownRecord[]) => {
          if (facts[0] !== undefined) facts[0].expected = '["wrong","/retained/path"]';
        },
      ],
      ['unsorted facts', (facts: UnknownRecord[]) => facts.reverse()],
    ] as const) {
      const invalid = structuredClone(mixedState);
      const row = placementAt(entryNamed(invalid, 'shadowed-fleet'), 1, label);
      const facts = (row.facts as UnknownRecord[]).filter((fact) =>
        String(fact.code).startsWith('retention-'),
      );
      mutateFacts(facts);
      row.facts = [
        ...(row.facts as UnknownRecord[]).filter(
          (fact) => !String(fact.code).startsWith('retention-'),
        ),
        ...facts,
      ];
      expect(statusV1Codec.validate(invalid).ok, label).toBeFalse();
    }
    for (const eligibility of ['eligible', 'not-reversible'] as const) {
      const invalid = cloneGolden();
      const row = placementAt(entryNamed(invalid, 'shadowed-fleet'), 1, eligibility);
      const journal = row.journal as UnknownRecord;
      journal.abortEligibility = eligibility;
      (journal.remediation as UnknownRecord).abort =
        eligibility === 'eligible' ? (journal.remediation as UnknownRecord).abort : null;
      (row.facts as UnknownRecord[]).push({
        code: 'retention-missing',
        impact: 'drift',
        subject: 'journal',
        expected: '["retained-live","/data/skillsmith/backups/shadowed-fleet"]',
        actual: 'missing',
      });
      expect(statusV1Codec.validate(invalid).ok, `${eligibility} retention facts`).toBeFalse();
    }

    const rejected = (label: string, mutate: (row: UnknownRecord) => void): void => {
      const dto = cloneGolden();
      const row = placementAt(entryNamed(dto, 'shadowed-fleet'), 1, label);
      mutate(row);
      expect(statusV1Codec.validate(dto).ok, label).toBeFalse();
    };
    const rejectedLogicalPathCoherence = (
      label: string,
      state: 'missing' | 'mismatch' | 'unverified',
      mutate: (retention: UnknownRecord) => void,
    ): void => {
      const dto = cloneGolden();
      const row = placementAt(entryNamed(dto, 'shadowed-fleet'), 1, label);
      const journal = row.journal as UnknownRecord;
      const retention = (journal.retention as UnknownRecord[])[0];
      if (retention === undefined) throw new Error(`missing logical retention for ${label}`);
      mutate(retention);
      retention.state = state;
      journal.abortEligibility = `retention-${state}`;
      (journal.remediation as UnknownRecord).abort = null;
      (row.facts as UnknownRecord[]).push({
        code: `retention-${state}`,
        impact: 'drift',
        subject: 'journal',
        expected: '["retained-live","/data/skillsmith/backups/shadowed-fleet"]',
        actual: state,
      });
      expect(statusV1Codec.validate(dto).ok, label).toBeFalse();
    };
    rejectedLogicalPathCoherence('missing path with present checks', 'missing', (retention) => {
      retention.pathState = 'missing';
    });
    rejectedLogicalPathCoherence(
      'unverified path with present checks',
      'unverified',
      (retention) => {
        retention.pathState = 'unverified';
      },
    );
    rejectedLogicalPathCoherence('satisfied path with missing revision', 'missing', (retention) => {
      retention.repositoryRevision = {
        ...(retention.repositoryRevision as UnknownRecord),
        state: 'missing',
        observed: null,
      };
    });
    rejectedLogicalPathCoherence(
      'observed checks on an unverified path',
      'mismatch',
      (retention) => {
        retention.pathState = 'unverified';
        const revision = retention.repositoryRevision as UnknownRecord;
        revision.state = 'mismatch';
        revision.observed = {
          ...(revision.expected as UnknownRecord),
          digest: 'sha256:different-retained-revision',
        };
        const content = retention.contentHash as UnknownRecord;
        content.state = 'mismatch';
        content.observed = 'sha256:different-retained-content';
      },
    );
    rejected('satisfied revision equality', (row) => {
      const retention = ((row.journal as UnknownRecord).retention as UnknownRecord[])[0];
      if (retention === undefined) throw new Error('missing logical retention');
      ((retention.repositoryRevision as UnknownRecord).observed as UnknownRecord).digest =
        'sha256:different-retained-revision';
    });
    rejected('revision representation coherence', (row) => {
      const retention = ((row.journal as UnknownRecord).retention as UnknownRecord[])[0];
      if (retention === undefined) throw new Error('missing logical retention');
      ((retention.repositoryRevision as UnknownRecord).observed as UnknownRecord).kind =
        'artifact-bytes';
    });
    rejected('satisfied content equality', (row) => {
      const retention = ((row.journal as UnknownRecord).retention as UnknownRecord[])[0];
      if (retention === undefined) throw new Error('missing logical retention');
      (retention.contentHash as UnknownRecord).observed = 'sha256:different-retained-content';
    });
    rejected('aggregate retention state', (row) => {
      const retention = ((row.journal as UnknownRecord).retention as UnknownRecord[])[0];
      if (retention === undefined) throw new Error('missing logical retention');
      retention.state = 'mismatch';
    });
    rejected('journal retention format', (row) => {
      const journal = row.journal as UnknownRecord;
      journal.format = 'legacy-pair';
      journal.operation = 'promote';
    });
    rejected('eligible remediation required', (row) => {
      ((row.journal as UnknownRecord).remediation as UnknownRecord).abort = null;
    });
    rejected('eligible remediation exact placement argv', (row) => {
      const abort = ((row.journal as UnknownRecord).remediation as UnknownRecord).abort as string[];
      abort[2] = '/wrong/placement';
    });
    rejected('eligible retention aggregate', (row) => {
      const retention = ((row.journal as UnknownRecord).retention as UnknownRecord[])[0];
      if (retention === undefined) throw new Error('missing logical retention');
      retention.pathState = 'missing';
      retention.state = 'missing';
    });
    rejected('noneligible remediation forbidden', (row) => {
      const journal = row.journal as UnknownRecord;
      journal.abortEligibility = 'retention-incomplete';
      (row.facts as UnknownRecord[]).push({
        code: 'retention-incomplete',
        impact: 'drift',
        subject: 'journal',
        expected: 'complete',
        actual: 'incomplete',
      });
    });
    for (const checkName of ['repositoryRevision', 'contentHash'] as const) {
      rejected(`${checkName} mismatch equality`, (row) => {
        const journal = row.journal as UnknownRecord;
        const retention = (journal.retention as UnknownRecord[])[0] as UnknownRecord;
        const check = retention[checkName] as UnknownRecord;
        check.state = 'mismatch';
        retention.state = 'mismatch';
        journal.abortEligibility = 'retention-mismatch';
        (journal.remediation as UnknownRecord).abort = null;
        (row.facts as UnknownRecord[]).push({
          code: 'retention-mismatch',
          impact: 'drift',
          subject: 'journal',
          expected: 'satisfied',
          actual: 'mismatch',
        });
      });
    }

    const ranked = cloneGolden();
    const rankedRow = placementAt(entryNamed(ranked, 'shadowed-fleet'), 1, 'aggregate rank');
    const rankedJournal = rankedRow.journal as UnknownRecord;
    const rankedRetention = (rankedJournal.retention as UnknownRecord[])[0] as UnknownRecord;
    setLogicalPathFailure(rankedRetention, 'missing');
    rankedJournal.abortEligibility = 'retention-missing';
    (rankedJournal.remediation as UnknownRecord).abort = null;
    (rankedRow.facts as UnknownRecord[]).push({
      code: 'retention-missing',
      impact: 'drift',
      subject: 'journal',
      expected: '["retained-live","/data/skillsmith/backups/shadowed-fleet"]',
      actual: 'missing',
    });
    validateDto(ranked, 'missing path carries coherent missing checks');

    const legacy = cloneGolden();
    const legacyRow = placementAt(entryNamed(legacy, 'shadowed-fleet'), 1, 'legacy retention');
    legacyRow.journal = {
      state: 'pending',
      transactionId: 'tx-legacy-retention',
      phase: 'backed-up',
      before: 'pinned',
      retention: [
        {
          format: 'legacy-pair',
          resourceId: null,
          retainUntil: null,
          structural: {
            state: 'satisfied',
            expected: { kind: 'symlink', linkTarget: '/fixture/source' },
            observed: { kind: 'symlink', linkTarget: '/fixture/source' },
          },
          repositoryRevision: {
            state: 'not-recorded',
            domain: null,
            expected: null,
            observed: null,
          },
          contentHash: {
            state: 'not-recorded',
            domain: null,
            expected: null,
            observed: null,
          },
          role: 'backup',
          sourceRole: 'live',
          path: '/data/skillsmith/backups/legacy-shadowed-fleet',
          pathState: 'satisfied',
          state: 'satisfied',
        },
      ],
      abortEligibility: 'eligible',
      remediation: {
        resume: 'rerun the same operation',
        abort: [
          'skillsmith',
          'undo',
          '/repo/.agents/skills/shadowed-fleet',
          '--tool',
          'codex',
          '--scope',
          'project',
        ],
      },
      format: 'legacy-pair',
      operation: 'promote',
    };
    const validLegacy = validateDto(legacy, 'legacy structural retention');
    const renderedLegacy = renderStatusHuman(validLegacy);
    expect(renderedLegacy).toContain(
      'structural: satisfied; expected symlink -> "/fixture/source"; observed symlink -> "/fixture/source"',
    );
    expect(renderedLegacy).toContain(
      'repository revision: not-recorded; expected null; observed null',
    );
    expect(renderedLegacy).toContain(
      'content hash: not-recorded; domain null; expected null; observed null',
    );

    const recordedSymlink = structuredClone(legacy);
    const recordedSymlinkRow = placementAt(
      entryNamed(recordedSymlink, 'shadowed-fleet'),
      1,
      'recorded legacy symlink content',
    );
    const recordedSymlinkRetention = (
      (recordedSymlinkRow.journal as UnknownRecord).retention as UnknownRecord[]
    )[0] as UnknownRecord;
    recordedSymlinkRetention.contentHash = {
      state: 'satisfied',
      domain: 'source-content',
      expected: 'sha256:legacy-source-content',
      observed: 'sha256:legacy-source-content',
    };
    expect(
      statusV1Codec.validate(recordedSymlink).ok,
      'literal legacy symlink cannot carry recorded content',
    ).toBeFalse();

    const recordedLegacy = structuredClone(legacy);
    const recordedLegacyRow = placementAt(
      entryNamed(recordedLegacy, 'shadowed-fleet'),
      1,
      'recorded legacy content',
    );
    const recordedRetention = (
      (recordedLegacyRow.journal as UnknownRecord).retention as UnknownRecord[]
    )[0] as UnknownRecord;
    recordedRetention.structural = {
      state: 'satisfied',
      expected: { kind: 'directory', linkTarget: null },
      observed: { kind: 'directory', linkTarget: null },
    };
    recordedRetention.contentHash = {
      state: 'satisfied',
      domain: 'source-content',
      expected: 'sha256:legacy-source-content',
      observed: 'sha256:legacy-source-content',
    };
    validateDto(recordedLegacy, 'source-content legacy retention');

    const legacyFailureScenario = (
      label: string,
      state: 'missing' | 'unverified',
      mutate: (retention: UnknownRecord) => void,
    ): UnknownRecord => {
      const dto = structuredClone(recordedLegacy);
      const row = placementAt(entryNamed(dto, 'shadowed-fleet'), 1, label);
      const journal = row.journal as UnknownRecord;
      const retention = (journal.retention as UnknownRecord[])[0];
      if (retention === undefined) throw new Error(`missing legacy retention for ${label}`);
      mutate(retention);
      retention.state = state;
      journal.abortEligibility = `retention-${state}`;
      (journal.remediation as UnknownRecord).abort = null;
      (row.facts as UnknownRecord[]).push({
        code: `retention-${state}`,
        impact: 'drift',
        subject: 'journal',
        expected: '[null,"/data/skillsmith/backups/legacy-shadowed-fleet"]',
        actual: state,
      });
      return dto;
    };
    const coherentLegacyMissing = legacyFailureScenario(
      'coherent missing legacy directory',
      'missing',
      (retention) => {
        retention.pathState = 'missing';
        retention.structural = {
          state: 'missing',
          expected: { kind: 'directory', linkTarget: null },
          observed: { kind: 'absent', linkTarget: null },
        };
        retention.contentHash = {
          ...(retention.contentHash as UnknownRecord),
          state: 'missing',
          observed: null,
        };
      },
    );
    validateDto(coherentLegacyMissing, 'coherent missing legacy directory');
    const coherentLegacyUnverified = legacyFailureScenario(
      'coherent unverified legacy directory',
      'unverified',
      (retention) => {
        retention.pathState = 'unverified';
        retention.structural = {
          state: 'unverified',
          expected: { kind: 'directory', linkTarget: null },
          observed: null,
        };
        retention.contentHash = {
          ...(retention.contentHash as UnknownRecord),
          state: 'unverified',
          observed: null,
        };
      },
    );
    validateDto(coherentLegacyUnverified, 'coherent unverified legacy directory');

    const directoryWithoutRecordedContent = structuredClone(recordedLegacy);
    const directoryWithoutRecordedContentRow = placementAt(
      entryNamed(directoryWithoutRecordedContent, 'shadowed-fleet'),
      1,
      'directory without recorded content',
    );
    const directoryWithoutRecordedContentRetention = (
      (directoryWithoutRecordedContentRow.journal as UnknownRecord).retention as UnknownRecord[]
    )[0] as UnknownRecord;
    directoryWithoutRecordedContentRetention.contentHash = {
      state: 'not-recorded',
      domain: null,
      expected: null,
      observed: null,
    };
    validateDto(
      directoryWithoutRecordedContent,
      'legacy structural-only directory without recorded content',
    );

    for (const [label, dto] of [
      [
        'legacy missing structural state with satisfied path',
        legacyFailureScenario('missing structural satisfied path', 'missing', (retention) => {
          retention.structural = {
            state: 'missing',
            expected: { kind: 'directory', linkTarget: null },
            observed: { kind: 'absent', linkTarget: null },
          };
          retention.contentHash = {
            ...(retention.contentHash as UnknownRecord),
            state: 'unverified',
            observed: null,
          };
        }),
      ],
      [
        'legacy unverified structural state with satisfied path',
        legacyFailureScenario('unverified structural satisfied path', 'unverified', (retention) => {
          retention.structural = {
            state: 'unverified',
            expected: { kind: 'directory', linkTarget: null },
            observed: null,
          };
          retention.contentHash = {
            ...(retention.contentHash as UnknownRecord),
            state: 'unverified',
            observed: null,
          };
        }),
      ],
      [
        'legacy satisfied structural state with unverified path',
        legacyFailureScenario('satisfied structural unverified path', 'unverified', (retention) => {
          retention.pathState = 'unverified';
          retention.contentHash = {
            state: 'not-recorded',
            domain: null,
            expected: null,
            observed: null,
          };
        }),
      ],
      [
        'legacy missing path with unverified content',
        legacyFailureScenario('missing path unverified content', 'missing', (retention) => {
          retention.pathState = 'missing';
          retention.structural = {
            state: 'missing',
            expected: { kind: 'directory', linkTarget: null },
            observed: { kind: 'absent', linkTarget: null },
          };
          retention.contentHash = {
            ...(retention.contentHash as UnknownRecord),
            state: 'unverified',
            observed: null,
          };
        }),
      ],
      [
        'legacy unverified path with missing content',
        legacyFailureScenario('unverified path missing content', 'missing', (retention) => {
          retention.pathState = 'unverified';
          retention.structural = {
            state: 'unverified',
            expected: { kind: 'directory', linkTarget: null },
            observed: null,
          };
          retention.contentHash = {
            ...(retention.contentHash as UnknownRecord),
            state: 'missing',
            observed: null,
          };
        }),
      ],
      [
        'legacy satisfied path with missing content',
        legacyFailureScenario('satisfied path missing content', 'missing', (retention) => {
          retention.contentHash = {
            ...(retention.contentHash as UnknownRecord),
            state: 'missing',
            observed: null,
          };
        }),
      ],
    ] as const) {
      expect(statusV1Codec.validate(dto).ok, label).toBeFalse();
    }

    const wrongLegacyDomain = structuredClone(recordedLegacy);
    const wrongDomainRow = placementAt(
      entryNamed(wrongLegacyDomain, 'shadowed-fleet'),
      1,
      'wrong legacy content domain',
    );
    const wrongDomainRetention = (
      (wrongDomainRow.journal as UnknownRecord).retention as UnknownRecord[]
    )[0] as UnknownRecord;
    (wrongDomainRetention.contentHash as UnknownRecord).domain = 'resource';
    expect(statusV1Codec.validate(wrongLegacyDomain).ok).toBeFalse();

    const impossibleLegacyContent = structuredClone(recordedLegacy);
    const impossibleContentRow = placementAt(
      entryNamed(impossibleLegacyContent, 'shadowed-fleet'),
      1,
      'impossible legacy content',
    );
    const impossibleRetention = (
      (impossibleContentRow.journal as UnknownRecord).retention as UnknownRecord[]
    )[0] as UnknownRecord;
    impossibleRetention.structural = {
      state: 'satisfied',
      expected: { kind: 'absent', linkTarget: null },
      observed: { kind: 'absent', linkTarget: null },
    };
    expect(statusV1Codec.validate(impossibleLegacyContent).ok).toBeFalse();

    const unobservedLegacyNode = structuredClone(recordedLegacy);
    const unobservedNodeRow = placementAt(
      entryNamed(unobservedLegacyNode, 'shadowed-fleet'),
      1,
      'unobserved legacy node with digest',
    );
    const unobservedNodeJournal = unobservedNodeRow.journal as UnknownRecord;
    const unobservedNodeRetention = (
      unobservedNodeJournal.retention as UnknownRecord[]
    )[0] as UnknownRecord;
    unobservedNodeRetention.structural = {
      state: 'unverified',
      expected: { kind: 'directory', linkTarget: null },
      observed: null,
    };
    unobservedNodeRetention.state = 'unverified';
    unobservedNodeJournal.abortEligibility = 'retention-unverified';
    (unobservedNodeJournal.remediation as UnknownRecord).abort = null;
    (unobservedNodeRow.facts as UnknownRecord[]).push({
      code: 'retention-unverified',
      impact: 'drift',
      subject: 'journal',
      expected: '[null,"/data/skillsmith/backups/legacy-shadowed-fleet"]',
      actual: 'unverified',
    });
    expect(statusV1Codec.validate(unobservedLegacyNode).ok).toBeFalse();

    const invalidLegacy = structuredClone(legacy);
    const invalidLegacyRow = placementAt(
      entryNamed(invalidLegacy, 'shadowed-fleet'),
      1,
      'invalid legacy target',
    );
    const invalidLegacyRetention = (
      (invalidLegacyRow.journal as UnknownRecord).retention as UnknownRecord[]
    )[0] as UnknownRecord;
    const invalidLegacyObserved = (invalidLegacyRetention.structural as UnknownRecord)
      .observed as UnknownRecord;
    invalidLegacyObserved.linkTarget = '/fixture/different-source';
    expect(statusV1Codec.validate(invalidLegacy).ok).toBeFalse();

    const equalLegacyMismatch = structuredClone(legacy);
    const equalLegacyRow = placementAt(
      entryNamed(equalLegacyMismatch, 'shadowed-fleet'),
      1,
      'equal legacy mismatch',
    );
    const equalLegacyJournal = equalLegacyRow.journal as UnknownRecord;
    const equalLegacyRetention = (
      equalLegacyJournal.retention as UnknownRecord[]
    )[0] as UnknownRecord;
    (equalLegacyRetention.structural as UnknownRecord).state = 'mismatch';
    equalLegacyRetention.state = 'mismatch';
    equalLegacyJournal.abortEligibility = 'retention-mismatch';
    (equalLegacyJournal.remediation as UnknownRecord).abort = null;
    (equalLegacyRow.facts as UnknownRecord[]).push({
      code: 'retention-mismatch',
      impact: 'drift',
      subject: 'journal',
      expected: 'satisfied',
      actual: 'mismatch',
    });
    expect(statusV1Codec.validate(equalLegacyMismatch).ok).toBeFalse();

    const committed = structuredClone(legacy);
    const committedRow = placementAt(
      entryNamed(committed, 'shadowed-fleet'),
      1,
      'committed remediation',
    );
    const pendingLegacy = committedRow.journal as UnknownRecord;
    committedRow.journal = {
      state: 'committed',
      transactionId: pendingLegacy.transactionId,
      phase: 'committed',
      before: pendingLegacy.before,
      retention: pendingLegacy.retention,
      reverseEligibility: 'eligible',
      remediation: { reverse: (pendingLegacy.remediation as UnknownRecord).abort },
      format: pendingLegacy.format,
      operation: pendingLegacy.operation,
    };
    validateDto(committed, 'committed exact reverse argv');
    const invalidCommitted = structuredClone(committed);
    const invalidCommittedRow = placementAt(
      entryNamed(invalidCommitted, 'shadowed-fleet'),
      1,
      'invalid committed remediation',
    );
    ((invalidCommittedRow.journal as UnknownRecord).remediation as UnknownRecord).reverse = null;
    expect(statusV1Codec.validate(invalidCommitted).ok).toBeFalse();

    const committedStore = structuredClone(recordedLegacy);
    const committedStoreRow = placementAt(
      entryNamed(committedStore, 'shadowed-fleet'),
      1,
      'committed pinned dev store reversal',
    );
    const pendingStoreJournal = committedStoreRow.journal as UnknownRecord;
    const pendingStoreRetention = (pendingStoreJournal.retention as UnknownRecord[])[0];
    if (pendingStoreRetention === undefined) throw new Error('missing committed store retention');
    pendingStoreRetention.role = 'store';
    pendingStoreRetention.sourceRole = null;
    committedStoreRow.journal = {
      state: 'committed',
      transactionId: pendingStoreJournal.transactionId,
      phase: 'committed',
      before: 'pinned',
      retention: pendingStoreJournal.retention,
      reverseEligibility: 'eligible',
      remediation: { reverse: (pendingStoreJournal.remediation as UnknownRecord).abort },
      format: 'legacy-pair',
      operation: 'dev',
    };
    validateDto(committedStore, 'committed pinned dev store reversal');
    const committedDevBackup = structuredClone(committedStore);
    const committedDevBackupRow = placementAt(
      entryNamed(committedDevBackup, 'shadowed-fleet'),
      1,
      'committed pinned dev backup fallback',
    );
    const committedDevBackupRetention = (
      (committedDevBackupRow.journal as UnknownRecord).retention as UnknownRecord[]
    )[0] as UnknownRecord;
    committedDevBackupRetention.role = 'backup';
    committedDevBackupRetention.sourceRole = 'live';
    validateDto(committedDevBackup, 'committed pinned dev backup fallback');

    for (const [label, mutate] of [
      [
        'legacy journal cannot omit retention',
        (row: UnknownRecord) => {
          (row.journal as UnknownRecord).retention = [];
        },
      ],
      [
        'legacy journal cannot duplicate retention',
        (row: UnknownRecord) => {
          const journal = row.journal as UnknownRecord;
          const retention = journal.retention as UnknownRecord[];
          journal.retention = [...retention, structuredClone(retention[0])];
        },
      ],
      [
        'pending legacy journal cannot retain a store',
        (row: UnknownRecord) => {
          const retention = ((row.journal as UnknownRecord).retention as UnknownRecord[])[0];
          if (retention === undefined) throw new Error('missing pending legacy retention');
          retention.role = 'store';
          retention.sourceRole = null;
        },
      ],
      [
        'legacy journal cannot use multi-resource before',
        (row: UnknownRecord) => {
          (row.journal as UnknownRecord).before = 'multi-resource';
        },
      ],
      [
        'legacy journal cannot report incomplete retention',
        (row: UnknownRecord) => {
          const journal = row.journal as UnknownRecord;
          journal.abortEligibility = 'retention-incomplete';
          (journal.remediation as UnknownRecord).abort = null;
          (row.facts as UnknownRecord[]).push({
            code: 'retention-incomplete',
            impact: 'drift',
            subject: 'journal',
            expected: 'complete',
            actual: 'incomplete',
          });
        },
      ],
      [
        'legacy backup must identify live as its source role',
        (row: UnknownRecord) => {
          const retention = ((row.journal as UnknownRecord).retention as UnknownRecord[])[0];
          if (retention === undefined) throw new Error('missing legacy source-role retention');
          retention.sourceRole = null;
        },
      ],
    ] as const) {
      const invalid = structuredClone(legacy);
      const row = placementAt(entryNamed(invalid, 'shadowed-fleet'), 1, label);
      mutate(row);
      expect(statusV1Codec.validate(invalid).ok, label).toBeFalse();
    }
    const invalidCommittedStore = structuredClone(committedStore);
    const invalidCommittedStoreRow = placementAt(
      entryNamed(invalidCommittedStore, 'shadowed-fleet'),
      1,
      'committed promote store retention',
    );
    (invalidCommittedStoreRow.journal as UnknownRecord).operation = 'promote';
    expect(
      statusV1Codec.validate(invalidCommittedStore).ok,
      'legacy store retention is exclusive to committed pinned dev',
    ).toBeFalse();
    const invalidCommittedLegacyMulti = structuredClone(committed);
    const invalidCommittedLegacyMultiRow = placementAt(
      entryNamed(invalidCommittedLegacyMulti, 'shadowed-fleet'),
      1,
      'committed legacy multi-resource before',
    );
    (invalidCommittedLegacyMultiRow.journal as UnknownRecord).before = 'multi-resource';
    expect(
      statusV1Codec.validate(invalidCommittedLegacyMulti).ok,
      'committed legacy journal cannot be multi-resource',
    ).toBeFalse();

    expect(placementsOf(entryNamed(golden, 'placement-drift')).map((row) => row.identity)).toEqual([
      expect.objectContaining({ path: '/repo/.kilo/skills/placement-drift' }),
      expect.objectContaining({ path: '/repo/.agents/skills/placement-drift' }),
    ]);
  });

  test('family 14: manifest/ledger migration OR plus repeated human/JSON/check byte identity', () => {
    const dto = cloneGolden();
    const artifacts = dto.artifacts as UnknownRecord;
    artifacts.manifest = {
      state: 'present',
      sourceVersion: 'legacy',
      currentVersion: 1,
      byteRevision: 'sha256:legacy-bytes',
      semanticRevision: 'sha256:legacy-semantic',
      canonical: false,
      migrationPending: true,
    };
    dto.ledger = {
      state: 'present',
      path: '/data/placements.json',
      sourceVersion: 1,
      currentVersion: 2,
      byteRevision: 'sha256:ledger-v1-bytes',
      semanticRevision: 'sha256:ledger-v1-semantic',
      migrationPending: true,
    };
    dto.summary = { ...(dto.summary as UnknownRecord), migrationPending: true };
    dto.facts = [
      {
        code: 'ledger-migration-pending',
        impact: 'info',
        subject: 'ledger',
        expected: 'current-v2',
        actual: 'source-v1',
      },
    ];
    const valid = validateDto(dto, 'dual migration pending');
    const json = renderStatusJson(valid);
    const human = renderStatusHuman(valid);
    expect(renderStatusJson(valid)).toBe(json);
    expect(renderStatusHuman(valid)).toBe(human);
    expect(JSON.parse(json).summary.migrationPending).toBeTrue();
    expect(human).toContain('migration pending');
  });
});

describe('EWP-CMD-STATUS-TS05', () => {
  test('family 15: target/tool/scope narrowing has human/JSON parity for provenance and outcomes', () => {
    const cases = [
      {
        source: 'explicit-targets',
        targets: ['clean-dev'],
        tools: ['codex'],
        toolSource: 'explicit',
        scopes: ['project'],
        scopeSource: 'explicit',
        outcome: 'selected',
        reason: null,
      },
      {
        source: 'bounded-default',
        targets: [],
        tools: ['codex'],
        toolSource: 'effective-config',
        scopes: ['user'],
        scopeSource: 'unbounded-default',
        outcome: 'selected',
        reason: null,
      },
      {
        source: 'explicit-targets',
        targets: ['filtered-name'],
        tools: ['codex'],
        toolSource: 'explicit',
        scopes: ['user'],
        scopeSource: 'explicit',
        outcome: 'filter-noop',
        reason: FILTER_NOOP_REASON,
      },
    ];
    for (const selection of cases) {
      const dto = cloneGolden();
      dto.selection = selection;
      const valid = validateDto(dto, `selection ${selection.outcome}/${selection.toolSource}`);
      const parsed = JSON.parse(renderStatusJson(valid));
      expect(parsed.selection).toEqual(selection);
      const human = renderStatusHuman(valid);
      for (const value of [
        selection.source,
        selection.toolSource,
        selection.scopeSource,
        selection.outcome,
      ]) {
        expect(human).toContain(value);
      }
      if (selection.reason !== null) expect(human).toContain(selection.reason);
    }
  });

  test('family 16: same-tool shadow, absent/different-tool non-shadow, and duplicate live roots', () => {
    const rows = placementsOf(entryNamed(golden, 'shadowed-fleet'));
    expect(rows[0]?.shadow).toEqual({
      state: 'shadowed',
      winner: '/repo/.agents/skills/shadowed-fleet',
    });
    expect(rows[1]?.shadow).toEqual({
      state: 'winner',
      shadows: ['/home/test/.agents/skills/shadowed-fleet'],
    });
    expect(placementsOf(entryNamed(golden, 'declared-locked-absent'))[0]?.shadow).toEqual({
      state: 'none',
    });
    expect(
      entriesOf(golden)
        .filter((entry) => entry.name !== 'shadowed-fleet')
        .flatMap(placementsOf)
        .every((row) => (row.shadow as UnknownRecord).state === 'none'),
    ).toBeTrue();
    const duplicate = structuredClone(
      placementAt(entryNamed(golden, 'shadowed-fleet'), 0, 'duplicate source'),
    );
    duplicate.shadow = { state: 'duplicate', winner: null };
    const duplicateFacts = duplicate.facts as UnknownRecord[];
    const duplicateVerification = duplicateFacts.find((fact) =>
      String(fact.code).startsWith('verify-'),
    );
    duplicate.facts = [
      ...duplicateFacts.filter(
        (fact) => fact.code !== 'shadowed' && !String(fact.code).startsWith('verify-'),
      ),
      {
        code: 'duplicate-live',
        impact: 'drift',
        subject: 'shadow',
        expected: 'unique',
        actual: 'duplicate',
      },
      ...(duplicateVerification === undefined ? [] : [duplicateVerification]),
    ];
    const dto = cloneGolden();
    const entry = structuredClone(entryNamed(golden, 'shadowed-fleet'));
    entry.placements = [duplicate];
    dto.entries = [entry];
    dto.summary = { entries: 1, converged: 0, drifting: 1, migrationPending: false };
    validateDto(dto, 'duplicate live roots');
  });

  test('family 17: root/nested/-C/symlink identity and project/user/non-Git readable defaults', () => {
    const xdg = { xdg: { config: '/config', data: '/data', cache: '/cache' } };
    const context = (overrides: ReadonlyUnknownRecord = {}) => ({
      invocationCwd: '/invoke',
      effectiveCwd: '/repo/nested',
      projectRoot: '/repo',
      projectIdentity: '/real/repo',
      projectKind: 'git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
      ...overrides,
    });
    expect(
      selectReadableArtifactContext(xdg, context(), { explicitFile: 'portable.toml', scope: null }),
    ).toEqual({
      state: 'selected',
      source: 'explicit',
      file: '/repo/nested/portable.toml',
    });
    expect(
      selectReadableArtifactContext(
        xdg,
        context({ discoveredConfigPath: '/repo/nested/skillsmith.toml' }),
        { scope: null },
      ),
    ).toEqual({
      state: 'selected',
      source: 'discovered-project',
      file: '/repo/nested/skillsmith.toml',
    });
    expect(selectReadableArtifactContext(xdg, context(), { scope: 'project' })).toEqual({
      state: 'selected',
      source: 'project-default',
      file: '/repo/skillsmith.toml',
    });
    expect(selectReadableArtifactContext(xdg, context(), { scope: 'user' })).toEqual({
      state: 'selected',
      source: 'user-default',
      file: '/config/skillsmith/skillsmith.toml',
    });
    for (const scope of ['system', 'managed']) {
      expect(selectReadableArtifactContext(xdg, context(), { scope })).toEqual({
        state: 'unselected',
        reason: 'live-only-scope',
      });
    }
    const outside = context({
      effectiveCwd: '/outside',
      projectRoot: null,
      projectIdentity: null,
      projectKind: 'non-git',
    });
    expect(selectReadableArtifactContext(xdg, outside, { scope: null })).toEqual({
      state: 'selected',
      source: 'user-default',
      file: '/config/skillsmith/skillsmith.toml',
    });
    expect(selectReadableArtifactContext(xdg, outside, { scope: 'project' })).toEqual({
      state: 'selected',
      source: 'project-default',
      file: '/outside/skillsmith.toml',
    });
  });

  test('family 18: exact/null/mismatched/ambiguous joins preserve logical paths and never guess', () => {
    const rows = placementsOf(entryNamed(golden, 'placement-drift'));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.identity as UnknownRecord).path)).toEqual([
      '/repo/.kilo/skills/placement-drift',
      '/repo/.agents/skills/placement-drift',
    ]);
    const firstLive = (rows[0]?.live as UnknownRecord).value as UnknownRecord;
    expect(firstLive.path).toBe('/repo/.kilo/skills/placement-drift');
    expect(firstLive.realpath).toBe('/targets/placement-drift');
    const journal = placementsOf(entryNamed(golden, 'shadowed-fleet'))[1]?.journal as UnknownRecord;
    expect((journal.remediation as UnknownRecord).abort).toEqual([
      'skillsmith',
      'undo',
      '/repo/.agents/skills/shadowed-fleet',
      '--tool',
      'codex',
      '--scope',
      'project',
    ]);
    expect(
      (placementsOf(entryNamed(golden, 'declared-locked-absent'))[0]?.identity as UnknownRecord)
        .path,
    ).toBeNull();
  });

  test('family 19: unknown tool/orphan bounds, sibling/custom pair paths, and selector refusals', async () => {
    const unknown = cloneGolden();
    const row = structuredClone(placementAt(entryNamed(golden, 'ledger-only'), 0, 'unknown tool'));
    (row.identity as UnknownRecord).tool = 'future-tool';
    const entry = structuredClone(entryNamed(golden, 'ledger-only'));
    entry.placements = [row];
    unknown.entries = [entry];
    unknown.summary = { entries: 1, converged: 0, drifting: 1, migrationPending: false };
    (unknown.selection as UnknownRecord).toolSource = 'unbounded-default';
    validateDto(unknown, 'unknown v2 tool under unbounded default');

    const relations = currentOptionRelations.filter(
      (relation) => relation.command === 'skillsmith status',
    );
    expect(relations).toContainEqual(
      expect.objectContaining({ kind: 'requires', option: '--lockfile', requiredOption: '--file' }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({ kind: 'scope-consistency', scopeOption: '--scope' }),
    );
    expect(relations).toContainEqual(
      expect.objectContaining({
        kind: 'exclusive-group',
        options: ['--system', '--user', '--project', '--managed'],
      }),
    );

    const touched: string[] = [];
    const poisoned = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(String(property));
          throw new Error(`invalid selector touched context ${String(property)}`);
        },
      },
    );
    for (const options of [
      { lockfile: 'custom.lock' },
      { tool: ['unknown-tool'] },
      { scope: 'unknown-scope' },
    ]) {
      const outcome = await runStatusApplication({ arguments: [], options }, poisoned);
      expect(outcome).toMatchObject({
        report: { result: null },
        exitClass: 'usage',
        mutation: { kind: 'none' },
      });
    }
    expect(touched).toEqual([]);
  });
});

describe('EWP-CMD-STATUS-TS06', () => {
  test('family 20: success/drift/error precedence, fixed filter-noop exit 0, and journal context isolation', () => {
    expect(selectExitCode([7, 1])).toBe(1);
    expect(selectExitCode([1, 2, 3, 4, 5, 6, 7])).toBe(6);
    expect(selectExitCode([7, 0])).toBe(7);
    expect(selectExitCode([7, 6, 130])).toBe(130);
    const dto = cloneGolden();
    dto.selection = {
      source: 'explicit-targets',
      targets: ['filtered'],
      tools: ['codex'],
      toolSource: 'explicit',
      scopes: ['user'],
      scopeSource: 'explicit',
      outcome: 'filter-noop',
      reason: FILTER_NOOP_REASON,
    };
    dto.entries = [];
    dto.journals = [];
    dto.facts = [];
    dto.summary = { entries: 0, converged: 0, drifting: 0, migrationPending: false };
    const valid = validateDto(dto, 'filter noop');
    expect(valid.selection).toMatchObject({ outcome: 'filter-noop', reason: FILTER_NOOP_REASON });
    expect(selectExitCode([0])).toBe(0);
    expect(renderStatusHuman(valid)).toContain(FILTER_NOOP_REASON);
  });

  test('family 21: strict status@1 rejects recursion/impossible unions and ignores human verbosity', () => {
    const nestedUnknown = cloneGolden();
    (
      ((entryNamed(nestedUnknown, 'clean-dev').desired as UnknownRecord).value as UnknownRecord)
        .source as UnknownRecord
    ).rawUrl = 'forbidden';
    expect(statusV1Codec.validate(nestedUnknown).ok).toBeFalse();

    const impossibleManifest = cloneGolden();
    ((impossibleManifest.artifacts as UnknownRecord).manifest as UnknownRecord).sourceVersion = 2;
    expect(statusV1Codec.validate(impossibleManifest).ok).toBeFalse();

    for (const [format, operation] of [
      ['logical', 'uninstall'],
      ['legacy-pair', 'update'],
    ] as const) {
      const impossibleJournal = cloneGolden();
      const journal = placementsOf(entryNamed(impossibleJournal, 'shadowed-fleet'))[1]
        ?.journal as UnknownRecord;
      journal.format = format;
      journal.operation = operation;
      expect(statusV1Codec.validate(impossibleJournal).ok).toBeFalse();
    }

    const valid = validateDto(cloneGolden(), 'verbosity-independent DTO');
    expect((renderStatusHuman as (...args: unknown[]) => string)(valid, { verbose: 0 })).toBe(
      (renderStatusHuman as (...args: unknown[]) => string)(valid, { verbose: 3 }),
    );
    expect((renderStatusJson as (...args: unknown[]) => string)(valid, { verbose: 0 })).toBe(
      (renderStatusJson as (...args: unknown[]) => string)(valid, { verbose: 3 }),
    );
  });

  test('family 22: recursive credential canaries are redacted across human, JSON, debug, error, and refusal paths', async () => {
    const canary = 'sk-statusCanary123456789';
    const candidate = cloneGolden();
    (candidate.context as UnknownRecord).effectiveCwd = `/repo/token=${canary}`;
    (candidate.selection as UnknownRecord).targets = [`authorization=Bearer ${canary}`];
    (
      (
        (entryNamed(candidate, 'source-drift').placements as UnknownRecord[])[0]
          ?.live as UnknownRecord
      ).value as UnknownRecord
    ).linkTarget = `https://user:${canary}@example.test/repo`;
    const redacted = redactSensitiveValue(candidate);
    expect(JSON.stringify(redacted)).not.toContain(canary);
    const valid = validateDto(redacted as UnknownRecord, 'redacted status candidate');
    expect(renderStatusHuman(valid)).not.toContain(canary);
    expect(renderStatusJson(valid)).not.toContain(canary);

    const poisonedDiscriminator = cloneGolden();
    poisonedDiscriminator.kind = `skillsmith.status token=${canary}`;
    const safe = redactSensitiveValue(poisonedDiscriminator);
    expect(statusV1Codec.validate(safe).ok).toBeFalse();
    expect(JSON.stringify(safe)).not.toContain(canary);
    expect(
      JSON.stringify(redactSensitiveValue({ debug: { error: new Error(canary) } })),
    ).not.toContain(canary);

    const diagnosticWrites: string[] = [];
    const diagnosticObserver = createDiagnosticObserver(
      {
        stdout: { write: (_value: string) => undefined },
        stderr: { write: (value: string) => diagnosticWrites.push(value) },
        exit: (_code: number) => undefined,
      },
      'debug',
    );
    diagnosticObserver.observe({
      kind: 'command.completed',
      operationId: 'status-op',
      parentOperationId: null,
      command: `skillsmith status authorization=Bearer ${canary}`,
      workflow: 'status',
      groupId: null,
      pairId: null,
      attempt: 1,
      occurredAt: '2026-07-14T00:00:00.000Z',
      monotonicMilliseconds: 1,
      outcome: 'failure',
      exitClass: 'failure',
      errorCode: `status-token=${canary}`,
      durationMilliseconds: 1,
    });
    const diagnosticOutput = diagnosticWrites.join('');
    expect(diagnosticOutput).toStartWith('debug: ');
    expect(diagnosticOutput).not.toContain(canary);
    expect(diagnosticOutput).toContain('[REDACTED]');

    const normalized = normalizeCliError(
      { code: 'generic', message: `status authorization=Bearer ${canary}` },
      { code: 'status-error', message: 'status failed', exitCode: 1 },
    );
    const boundaryHuman = renderCliError(normalized, 'human');
    const boundaryJson = renderCliError(normalized, 'json');
    for (const output of [boundaryHuman, boundaryJson]) {
      expect(output).not.toContain(canary);
      expect(output).not.toContain('skillsmith.status');
      expect(output).not.toContain('"entries"');
    }

    const refused = await runStatusApplication(
      {
        arguments: [],
        options: { tool: [`future-tool authorization=Bearer ${canary}`], json: true },
      },
      new Proxy(
        {},
        {
          get: (_target, property) => {
            throw new Error(`refused status touched context ${String(property)} token=${canary}`);
          },
        },
      ),
    );
    expect(refused).toMatchObject({
      report: { result: null },
      exitClass: 'usage',
      mutation: { kind: 'none' },
    });
    expect(JSON.stringify(refused)).not.toContain(canary);
    const renderer = createCurrentRendererRegistry(new Command()).status;
    const refusedOutputs = [
      renderedOutputText(renderer.human(refused)),
      renderedOutputText(renderer.json(refused)),
    ];
    for (const output of refusedOutputs) {
      expect(output).not.toContain(canary);
      expect(output).not.toContain('skillsmith.status');
      expect(output).not.toContain('"entries"');
    }

    const invalidReport = cloneGolden();
    const poisonedDesired = entryNamed(invalidReport, 'clean-pinned-copy').desired as UnknownRecord;
    (poisonedDesired.value as UnknownRecord).scope = `project authorization=Bearer ${canary}`;
    const finalized = finalizeStatusApplicationReport(invalidReport);
    expect(finalized).toEqual({
      ok: false,
      error: {
        code: 'status-rendering-failed',
        message: 'status report could not be rendered safely',
        exitClass: 'failure',
      },
    });
    expect(JSON.stringify(finalized)).not.toContain(canary);
    const finalizedError = (finalized as Readonly<{ error: UnknownRecord }>).error;
    const fixedOutcome = {
      report: { result: null },
      diagnostics: [
        {
          code: finalizedError.code,
          message: finalizedError.message,
          severity: 'error',
        },
      ],
      exitClass: finalizedError.exitClass,
      mutation: { kind: 'none' },
      deprecations: [],
    };
    for (const output of [
      renderedOutputText(renderer.human(fixedOutcome)),
      renderedOutputText(renderer.json(fixedOutcome)),
    ]) {
      expect(output).toContain('status report could not be rendered safely');
      expect(output).not.toContain(canary);
      expect(output).not.toContain('skillsmith.status');
      expect(output).not.toContain('"entries"');
      expect(output).not.toContain('Summary —');
    }
  });

  test('family 23: no-write canaries, selected-root failure, and unreadable unselected Claude isolation', async () => {
    const selectedRoot = '/home/test/.agents/skills';
    const unselectedClaudeManaged = '/etc/claude-code/.claude/skills';
    const selectedCalls: string[] = [];
    const unselectedCalls: string[] = [];
    const forbiddenCalls: string[] = [];
    const readPorts: UnknownRecord = {
      homeDir: '/home/test',
      executableSearchPath: [],
      platform: 'linux',
      xdg: { config: '/config', data: '/data', cache: '/cache' },
      fileExists: async (path: string) => {
        if (path === unselectedClaudeManaged) unselectedCalls.push(path);
        return path === selectedRoot;
      },
      pathKind: async (path: string) => {
        if (path === selectedRoot) {
          selectedCalls.push(path);
          throw new Error('selected status root cannot be observed');
        }
        if (path === unselectedClaudeManaged) unselectedCalls.push(path);
        return 'absent';
      },
      realpath: async (path: string) => path,
      listDir: async (path: string) => {
        if (path === selectedRoot) {
          selectedCalls.push(path);
          throw new Error('selected status root cannot be listed');
        }
        if (path === unselectedClaudeManaged) unselectedCalls.push(path);
        return [];
      },
      readText: async () => '',
      readBytes: async () => new Uint8Array(),
      readLink: async () => '',
      isExecutable: async () => false,
      modifiedAt: async () => null,
      readFileMetadata: async () => ({ kind: 'absent', mode: null, identity: null }),
    };
    const ports = new Proxy(readPorts, {
      get: (target, property, receiver) => {
        if (
          [
            'makeDir',
            'writeTextFile',
            'makeSymlink',
            'rename',
            'copyTree',
            'removeTree',
            'fsyncFile',
            'fsyncDir',
            'withFileLock',
            'exec',
            'runVersion',
            'git',
            'http',
            'wallNowIso',
            'epochMilliseconds',
            'monotonicMilliseconds',
            'nextId',
          ].includes(String(property))
        ) {
          forbiddenCalls.push(String(property));
          throw new Error(`status read touched forbidden capability ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await readStatus(ports, statusRequest());
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'status-read', reason: 'observation-failed', exitClass: 'failure' },
    });
    expect(selectedCalls.length).toBeGreaterThan(0);
    expect(unselectedCalls).toEqual([]);
    expect(forbiddenCalls).toEqual([]);
  });
});
