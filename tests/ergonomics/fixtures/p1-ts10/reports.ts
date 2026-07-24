import type {
  ApplyReportV1Dto,
  GcReportV1Dto,
  PlanV1Dto,
  StatusV1Dto,
  SyncReportV1Dto,
  UpdateReportV1Dto,
} from '../../../../packages/core/src/contracts/v1/index.ts';
import type {
  AgentsReport,
  ArtifactDigest,
  CommandsReport,
  ConfigGetReport,
  ConfigListReport,
  ConfigSetReport,
  ConfigUnsetReport,
  CurrentInstallReport,
  CurrentUninstallReport,
  ExportReport,
  FlipReport,
  HealthReport,
  InitReport,
  InstallRecord,
  InstallReport,
  ListReport,
  NormalizedSeverity,
  SkillSmithError,
  StatusReport,
  SupportedTool,
  UndoReport,
  UninstallReport,
  VerifyReport,
} from '../../../../packages/core/src/index.ts';
import agentsV2Golden from '../g3a02-contracts/agents-base-v2.golden.json' with { type: 'json' };
import statusV1Golden from '../p3a-ts04/status-v1.golden.json' with { type: 'json' };

/** Stable characterization values shared by the G1-06 mapper, codec, and renderer tests. */
const CORE_ONLY_ERROR = {
  code: 'generic',
  message: 'fixture-only internal detail',
  cause: new Error('must never reach a mapper or wire codec'),
} satisfies SkillSmithError;

export const AGENTS_REPORT_FIXTURE = {
  detections: new Map<SupportedTool, readonly InstallRecord[]>([
    [
      'claude-code',
      [
        {
          path: '/fixture/bin/claude',
          version: '1.2.3',
          installMethod: 'native-installer',
        },
      ],
    ],
    [
      'codex',
      [
        {
          path: '/fixture/bin/codex',
          version: '4.5.6',
          installMethod: 'npm-global',
        },
      ],
    ],
  ]),
  format: 'json',
  detectedOnly: false,
  capabilities: agentsV2Golden.capabilities as NonNullable<AgentsReport['capabilities']>,
} satisfies AgentsReport;

export const HEALTH_REPORT_FIXTURE = {
  mode: 'check',
  result: {
    findings: [
      {
        checkId: 'fixture.paths',
        severity: 'warning',
        title: 'Fixture path needs attention',
        message: 'The fixture path is illustrative.',
        remediation: 'Use a real project path.',
        tool: 'codex',
        scope: 'project',
        path: '/fixture/project',
        operation: 'read',
        reason: 'fixture',
        scopeInUse: true,
      },
    ],
    counts: { ok: 2, warning: 1, error: 0 },
  },
} satisfies HealthReport;

export const COMMANDS_REPORT_FIXTURE = {
  long: true,
  selection: {
    source: 'bounded-default',
    tools: ['claude-code', 'codex', 'kilo-code', 'opencode'],
    scopes: ['user', 'project'],
    filters: { names: [], enabled: null },
    outcome: 'selected',
  },
  entries: [
    {
      name: 'fixture-command',
      path: '/fixture/project/commands/fixture-command.md',
      realpath: '/fixture/project/commands/fixture-command.md',
      tool: 'codex',
      scope: 'project',
      root: '/fixture/project/commands',
      frontmatter: {
        name: 'fixture-command',
        description: 'A deterministic command fixture',
        version: '1.0.0',
      },
      origin: {
        kind: 'plugin',
        pluginId: 'fixture.plugin',
        pluginVersion: '1.0.0',
        pluginScope: 'project',
      },
      enabled: 'on',
      description: 'A deterministic command fixture',
    },
  ],
} satisfies CommandsReport;

const CONFIG_LAYERS = {
  defaults: { tool: 'claude-code', scope: 'user' },
  system: {},
  user: { tool: 'codex' },
  project: { scope: 'project', path: './skills', registry: { default: 'team' } },
  'explicit-file': {},
  env: {},
  cli: {},
} satisfies ConfigListReport['layers'];

export const CONFIG_GET_UNSCOPED_REPORT_FIXTURE = {
  key: 'tool',
  value: 'codex',
  source: 'user',
} satisfies ConfigGetReport;

export const CONFIG_GET_SCOPED_REPORT_FIXTURE = {
  key: 'tool',
  value: 'codex',
  scope: 'project',
} satisfies ConfigGetReport;

export const CONFIG_LIST_UNSCOPED_REPORT_FIXTURE = {
  effective: {
    tool: 'codex',
    scope: 'project',
    path: './skills',
    registry: { default: 'team' },
  },
  sources: {
    tool: 'user',
    scope: 'project',
    path: 'project',
    'registry.default': 'project',
  },
  layers: CONFIG_LAYERS,
} satisfies ConfigListReport;

export const CONFIG_LIST_SCOPED_REPORT_FIXTURE = {
  scope: 'project',
  effective: CONFIG_LIST_UNSCOPED_REPORT_FIXTURE.effective,
  sources: CONFIG_LIST_UNSCOPED_REPORT_FIXTURE.sources,
  layers: CONFIG_LAYERS,
} satisfies ConfigListReport;

export const CONFIG_SET_REPORT_FIXTURE = {
  key: 'tool',
  value: 'codex',
  scope: 'user',
  file: '/fixture/config.toml',
} satisfies ConfigSetReport;

export const CONFIG_UNSET_REPORT_FIXTURE = {
  key: 'tool',
  scope: 'user',
  file: '/fixture/config.toml',
} satisfies ConfigUnsetReport;

const FLIP_CONTENT_HASH =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const FLIP_OPERATION_ID = 'operation:v1:fixture-skill-promote' as const;
const FLIP_GROUP_ID = 'group:v1:fixture-skill-promote' as const;
const FLIP_PAIR_ID = 'pair:v1:fixture-skill-codex-project' as const;
const FLIP_SOURCE = {
  kind: 'local-dev',
  path: '/fixture/source/fixture-skill',
  contentHash: FLIP_CONTENT_HASH,
} as const;
const FLIP_LIVE_RESOURCE = {
  kind: 'live',
  skill: 'fixture-skill',
  tool: 'codex',
  scope: 'project',
  projectRoot: { kind: 'machine-bound', path: '/fixture/project' },
  location: {
    kind: 'machine-bound',
    path: '/fixture/project/skills/fixture-skill',
  },
} as const;
const FLIP_BEFORE = {
  kind: 'placement',
  resource: FLIP_LIVE_RESOURCE,
  classification: 'dev',
  representation: 'symlink',
  linkTarget: { kind: 'machine-bound', path: '/fixture/source/fixture-skill' },
  dangling: false,
  source: FLIP_SOURCE,
  contentHash: FLIP_CONTENT_HASH,
} as const;
const FLIP_AFTER = {
  kind: 'placement',
  resource: FLIP_LIVE_RESOURCE,
  classification: 'pinned',
  representation: 'copy',
  linkTarget: null,
  dangling: false,
  source: FLIP_SOURCE,
  contentHash: FLIP_CONTENT_HASH,
} as const;
const FLIP_OPERATION = {
  operationId: FLIP_OPERATION_ID,
  groupId: FLIP_GROUP_ID,
  pairId: FLIP_PAIR_ID,
  kind: 'promote',
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: [],
  },
  skill: 'fixture-skill',
  source: FLIP_SOURCE,
  tool: 'codex',
  scope: 'project',
  before: FLIP_BEFORE,
  after: FLIP_AFTER,
  reason: { code: 'promote', message: 'promote fixture-skill' },
  selectionSource: 'explicit-targets',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: { kind: 'none', retentionResourceIds: [] as const },
  mutates: { live: true, manifest: false, lock: false, ledger: true },
  conflict: null,
} as const;
const FLIP_EXECUTION_RESULT = {
  operationId: FLIP_OPERATION_ID,
  outcome: 'succeeded',
  actualBefore: FLIP_BEFORE,
  actualAfter: FLIP_AFTER,
  force: null,
  error: null,
} as const;

export const FLIP_REPORT_FIXTURE = {
  op: 'promote',
  dryRun: false,
  requested: {
    targets: ['fixture-skill'],
    all: false,
    tools: ['codex'],
    explicitTools: true,
  },
  plan: {
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'promote',
    selection: {
      source: 'explicit-targets',
      outcome: 'selected',
      targets: ['fixture-skill'],
      all: false,
      tools: ['codex'],
      scopes: ['project'],
      groupIds: [FLIP_GROUP_ID],
    },
    batchPolicy: 'fail-fast',
    operations: [FLIP_OPERATION],
    checks: [],
    diagnostics: [],
  },
  executionResults: [FLIP_EXECUTION_RESULT],
  results: [
    {
      skill: 'fixture-skill',
      tool: 'codex',
      placementPath: '/fixture/project/skills/fixture-skill',
      action: 'flipped',
      reason: null,
      before: { mode: 'dev', symlinkTarget: '/fixture/source/fixture-skill' },
      after: { mode: 'pinned', storePath: '/fixture/store/fixture-skill' },
      store: {
        path: '/fixture/store/fixture-skill',
        rev: 'main',
        gitSha: '1111111111111111111111111111111111111111',
        dirty: false,
        reused: false,
      },
      verify: { gate: 'passed', verdict: 'pass' },
      error: CORE_ONLY_ERROR,
    },
  ],
  summary: {
    flipped: 1,
    updated: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
    rolledBack: 0,
    created: 0,
    adopted: 0,
  },
} satisfies FlipReport;

export const INSTALL_REPORT_FIXTURE = {
  dryRun: false,
  requested: {
    sources: ['fixture/repository//skills/fixture-skill'],
    tools: ['codex'],
    explicitTools: true,
    scope: 'project',
    explicitScope: true,
    ref: 'main',
    pin: true,
    direct: false,
    force: false,
    verify: 'static',
    deep: false,
  },
  results: [
    {
      source: 'fixture/repository//skills/fixture-skill',
      skill: 'fixture-skill',
      tool: 'codex',
      scope: 'project',
      placementPath: '/fixture/project/skills/fixture-skill',
      action: 'installed',
      reason: null,
      placement: 'symlink',
      store: {
        path: '/fixture/store/fixture-skill',
        rev: 'main',
        gitSha: '1111111111111111111111111111111111111111',
        reused: false,
      },
      origin: {
        host: 'github.com',
        repo: 'fixture/repository',
        skillPath: 'skills/fixture-skill',
        refRequested: 'main',
        refResolved: '1111111111111111111111111111111111111111',
        pin: true,
      },
      verify: { gate: 'passed', verdict: 'pass', mode: 'static' },
      candidates: null,
      error: CORE_ONLY_ERROR,
    },
  ],
  summary: {
    installed: 1,
    updated: 0,
    repaired: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
  },
} satisfies InstallReport;

export const LIST_REPORT_FIXTURE = {
  long: true,
  selection: {
    source: 'bounded-default',
    tools: ['claude-code', 'codex', 'kilo-code', 'opencode'],
    scopes: ['system', 'user', 'project', 'managed'],
    filters: {
      names: [],
      mode: null,
      source: null,
      revision: null,
      description: null,
      verification: null,
      enabled: null,
      duplicates: false,
    },
    outcome: 'selected',
  },
  entries: [
    {
      name: 'fixture-skill',
      path: '/fixture/project/skills/fixture-skill',
      realpath: '/fixture/store/fixture-skill',
      tool: 'codex',
      scope: 'project',
      root: '/fixture/project/skills',
      frontmatter: {
        name: 'fixture-skill',
        description: 'A deterministic skill fixture',
        version: '1.0.0',
      },
      origin: { kind: 'standalone' },
      enabled: 'on',
      mode: 'unmanaged',
      placement: 'unknown',
      source: null,
      revision: null,
      store: null,
      verification: 'unrecorded',
      description: 'A deterministic skill fixture',
      visibility: {
        state: 'unique',
        winner: null,
        members: [{ scope: 'project', path: '/fixture/project/skills/fixture-skill' }],
      },
    },
  ],
  collisionGroups: [],
} satisfies ListReport;

export const UNINSTALL_REPORT_FIXTURE = {
  dryRun: false,
  requested: {
    targets: ['fixture-skill'],
    tools: ['codex'],
    explicitTools: true,
    scope: 'project',
    allScopes: false,
    force: false,
  },
  results: [
    {
      skill: 'fixture-skill',
      tool: 'codex',
      scope: 'project',
      placementPath: '/fixture/project/skills/fixture-skill',
      action: 'removed',
      reason: null,
      before: {
        mode: 'pinned',
        placement: 'symlink',
        storePath: '/fixture/store/fixture-skill',
        symlinkTarget: '/fixture/store/fixture-skill',
      },
      storeRetained: '/fixture/store/fixture-skill',
      backupKept: null,
      error: CORE_ONLY_ERROR,
    },
  ],
  summary: { removed: 1, noop: 0, refused: 0, failed: 0 },
} satisfies UninstallReport;

const CURRENT_SOURCE_INPUT =
  'https://fixture-user:fixture-password@github.com/fixture/repository//skills/fixture-skill';
const CURRENT_SOURCE_REDACTED = 'https://github.com/fixture/repository//skills/fixture-skill';
const CURRENT_CONTENT_HASH =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const CURRENT_NO_CONFLICT_FORCE = {
  requested: false,
  applied: false,
  conflictType: null,
  target: null,
  normalBehavior: null,
  forcedBehavior: null,
  backup: null,
} as const;

export const CURRENT_INSTALL_REPORT_FIXTURE = {
  reportVersion: 2,
  dryRun: false,
  saveMode: 'desired-state',
  artifactPair: {
    manifestPath: '/fixture/project/skills.toml',
    lockPath: '/fixture/project/skills.lock',
    lockSource: 'sibling',
  },
  artifactSelection: { outcome: 'selected', selectedBy: 'selected-project-owner' },
  artifactEffects: [
    {
      groupId: 'group:v1:fixture-install',
      skill: 'fixture-skill',
      manifestAction: 'update',
      lockAction: 'update',
      migration: 'none',
      outcome: 'succeeded',
      reason: null,
    },
  ],
  requested: {
    sources: [CURRENT_SOURCE_INPUT],
    tools: ['codex'],
    explicitTools: true,
    scope: 'project',
    explicitScope: true,
    ref: 'main',
    pin: true,
    direct: false,
    force: false,
    verify: 'static',
    deep: false,
    batchPolicy: 'fail-fast',
    path: './skills',
  },
  results: [
    {
      source: CURRENT_SOURCE_INPUT,
      skill: 'fixture-skill',
      tool: 'codex',
      scope: 'project',
      placementPath: '/fixture/project/skills/fixture-skill',
      action: 'installed',
      reason: null,
      placement: 'symlink',
      store: null,
      origin: null,
      verify: null,
      candidates: null,
      requestIndex: 0,
      groupId: 'group:v1:fixture-install',
      pairId: 'pair:v1:fixture-codex-project',
      executionOutcome: 'succeeded',
      drift: { status: 'in-sync', futureApply: 'none', reason: null },
      force: CURRENT_NO_CONFLICT_FORCE,
      error: CORE_ONLY_ERROR,
    },
  ],
  summary: {
    installed: 1,
    updated: 0,
    repaired: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
    desiredState: { changed: 1, unchanged: 0, retained: 0, notWritten: 0, failed: 0 },
  },
} satisfies CurrentInstallReport;

export const CURRENT_UNINSTALL_REPORT_FIXTURE = {
  reportVersion: 2,
  dryRun: true,
  saveMode: 'live-only',
  artifactPair: null,
  artifactSelection: { outcome: 'none', reason: 'no-save' },
  artifactEffects: [
    {
      groupId: 'group:v1:fixture-uninstall',
      skill: 'fixture-skill',
      manifestAction: 'not-write',
      lockAction: 'not-write',
      migration: 'none',
      outcome: 'planned',
      reason: null,
    },
  ],
  requested: {
    targets: ['fixture-skill', 'later-skill'],
    tools: ['codex'],
    explicitTools: true,
    scope: 'project',
    allScopes: false,
    force: true,
    batchPolicy: 'fail-fast',
  },
  results: [
    {
      skill: 'fixture-skill',
      tool: 'codex',
      scope: 'project',
      placementPath: '/fixture/project/skills/fixture-skill',
      action: 'removed',
      reason: null,
      before: null,
      storeRetained: null,
      backupKept: null,
      requestIndex: 0,
      groupId: 'group:v1:fixture-uninstall',
      pairId: 'pair:v1:fixture-codex-project',
      executionOutcome: 'succeeded',
      drift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
      force: {
        requested: true,
        applied: false,
        conflictType: 'source-changed',
        target: { kind: 'store', contentHash: CURRENT_CONTENT_HASH },
        normalBehavior: 'refuse',
        forcedBehavior: 'replace',
        backup: 'none',
      },
      error: CORE_ONLY_ERROR,
    },
    {
      skill: 'later-skill',
      tool: 'codex',
      scope: 'project',
      placementPath: null,
      action: 'skipped',
      reason: 'skipped after an earlier group failed',
      before: null,
      storeRetained: null,
      backupKept: null,
      requestIndex: 1,
      groupId: 'group:v1:fixture-uninstall-later',
      pairId: 'pair:v1:fixture-codex-project',
      executionOutcome: 'skipped-after-failure',
      drift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
      force: CURRENT_NO_CONFLICT_FORCE,
    },
  ],
  summary: {
    removed: 1,
    noop: 0,
    refused: 0,
    failed: 0,
    desiredState: { changed: 0, unchanged: 0, retained: 0, notWritten: 2, failed: 0 },
  },
} satisfies CurrentUninstallReport;

export const VERIFY_REPORT_FIXTURE = {
  schemaVersion: 1,
  target: { path: '/fixture/project/skills/fixture-skill', kind: 'skill' },
  requested: {
    tools: ['codex'],
    modes: ['static', 'deep'],
    strict: true,
    explicitTools: true,
  },
  verifiedAgainst: { 'claude-code': '1.0.0', codex: '1.0.0' },
  summary: {
    verdict: 'warn',
    verified: ['codex'],
    failed: [],
    skipped: [],
    counts: { error: 0, warning: 1, info: 0 },
  },
  tools: [
    {
      tool: 'codex',
      available: true,
      toolVersion: '1.0.1',
      versionDrift: true,
      skipReason: null,
      verdict: 'warn',
      modes: [
        {
          mode: 'static',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict: 'warn',
          command: 'codex fixture verify',
          findings: [
            {
              checkId: 'fixture.frontmatter',
              toolSeverity: 'warning',
              normalizedSeverity: 'warning' as NormalizedSeverity,
              message: 'Fixture warning',
              file: 'SKILL.md',
              subject: 'skill',
              raw: 'fixture raw detail',
            },
          ],
        },
        {
          mode: 'deep',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict: 'pass',
          command: 'codex fixture verify --deep',
          findings: [],
        },
      ],
    },
  ],
} satisfies VerifyReport<'claude-code' | 'codex'>;

export const ERROR_FIXTURE = {
  code: 'fixture-error',
  message: 'Deterministic fixture failure',
  exitCode: 7,
} as const;

export const EXPORT_REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: 'skillsmith.export',
  reportVersion: 1,
  dryRun: true,
  requested: {
    tools: ['claude-code'],
    explicitTools: true,
    scope: 'user',
    explicitScope: true,
    strict: false,
    force: false,
  },
  artifactSelection: {
    outcome: 'none',
    reason: 'no-portable-candidates',
  },
  results: [],
  effects: [],
  summary: {
    observed: 0,
    portable: 0,
    skipped: 0,
    conflicts: 0,
    changed: 0,
    unchanged: 0,
  },
} satisfies ExportReport;

const initDigest = (character: string) => `sha256:${character.repeat(64)}` as ArtifactDigest;
const INIT_OPERATION_ID = `operation:v1:${'c'.repeat(64)}`;

export const INIT_REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: 'skillsmith.init',
  reportVersion: 1,
  dryRun: true,
  requested: {
    tools: ['codex'],
    explicitTools: true,
    toolSource: 'explicit',
    scope: 'project',
    explicitScope: true,
    file: '/fixture/project/skillsmith.toml',
    force: false,
  },
  defaults: {
    tools: ['codex'],
    scope: 'project',
    path: null,
    registryDefault: null,
  },
  artifactSelection: {
    outcome: 'selected',
    selectedBy: 'explicit-file',
    manifestPath: '/fixture/project/skillsmith.toml',
    lockPath: '/fixture/project/skillsmith.lock',
    lockSource: 'sibling',
  },
  result: {
    action: 'create-manifest',
    operationId: INIT_OPERATION_ID,
    before: { state: 'absent', shape: null, byteHash: null, semanticHash: null },
    after: { state: 'canonical', byteHash: initDigest('a'), semanticHash: initDigest('b') },
  },
  force: {
    requested: false,
    applied: false,
    conflictType: null,
    target: null,
    normalBehavior: null,
    forcedBehavior: null,
    backup: null,
  },
  effects: [
    {
      role: 'manifest',
      action: 'create',
      operationId: INIT_OPERATION_ID,
      outcome: 'planned',
    },
    { role: 'lock', action: 'not-written', operationId: null, outcome: 'not-run' },
    { role: 'live', action: 'not-written', operationId: null, outcome: 'not-run' },
    { role: 'ledger', action: 'not-written', operationId: null, outcome: 'not-run' },
  ],
  summary: { changed: 1, unchanged: 0 },
} satisfies InitReport;

export const STATUS_V1_DTO_FIXTURE = statusV1Golden as unknown as StatusV1Dto;

export const STATUS_REPORT_FIXTURE = {
  selection: STATUS_V1_DTO_FIXTURE.selection,
  context: STATUS_V1_DTO_FIXTURE.context,
  artifacts: STATUS_V1_DTO_FIXTURE.artifacts,
  ledger: STATUS_V1_DTO_FIXTURE.ledger,
  journals: STATUS_V1_DTO_FIXTURE.journals,
  facts: STATUS_V1_DTO_FIXTURE.facts,
  entries: STATUS_V1_DTO_FIXTURE.entries,
  summary: STATUS_V1_DTO_FIXTURE.summary,
} satisfies StatusReport;

export const PLAN_REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: 'skillsmith.plan-report',
  command: 'plan',
  state: 'ready',
  artifactPair: {
    manifestPath: '/fixture/project/skillsmith.toml',
    lockPath: '/fixture/project/skillsmith.lock',
    lockSource: 'sibling',
    selectionSource: 'explicit',
  },
  project: {
    effectiveCwd: '/fixture/project',
    root: '/fixture/project',
    identity: 'fixture-project',
  },
  options: { locked: true, prune: false, check: false },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'selected',
    requestedTools: [],
    requestedScope: null,
    skills: [],
    tools: ['codex'],
    scopes: ['project'],
  },
  operations: [],
  checks: [],
  diagnostics: [],
  summary: {
    operations: 0,
    checks: 0,
    diagnostics: 0,
    drift: 0,
    refusals: 0,
    operationKinds: {
      install: 0,
      update: 0,
      remove: 0,
      'link-dev': 0,
      promote: 0,
      'move-scope': 0,
      adapt: 0,
      repair: 0,
      'write-manifest': 0,
      'write-lock': 0,
      'migrate-project-config': 0,
      'migrate-ledger': 0,
    },
    checkKinds: {
      'source-resolution': 0,
      capability: 0,
      'content-integrity': 0,
      verification: 0,
      'precondition-validation': 0,
    },
    diagnosticKinds: { noop: 0, skip: 0, refuse: 0, conflict: 0, warning: 0 },
  },
  savedOutput: null,
} satisfies PlanV1Dto;

export const APPLY_REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: 'skillsmith.apply-report',
  command: 'apply',
  mode: 'fresh-execute',
  state: 'completed',
  artifactPair: PLAN_REPORT_FIXTURE.artifactPair,
  savedPlan: null,
  project: PLAN_REPORT_FIXTURE.project,
  options: {
    locked: true,
    prune: false,
    check: false,
    dryRun: false,
    continueOnError: false,
  },
  selection: PLAN_REPORT_FIXTURE.selection,
  operations: PLAN_REPORT_FIXTURE.operations,
  checks: PLAN_REPORT_FIXTURE.checks,
  diagnostics: PLAN_REPORT_FIXTURE.diagnostics,
  approval: { required: false, outcome: 'not-required' },
  validation: { outcome: 'not-run', replanned: false },
  results: [],
  summary: {
    ...PLAN_REPORT_FIXTURE.summary,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    rolledBack: 0,
    skipped: 0,
  },
} satisfies ApplyReportV1Dto;

export const APPLY_HUMAN_GOLDEN = `Apply: fresh-execute (completed)
Manifest: /fixture/project/skillsmith.toml
Lock: /fixture/project/skillsmith.lock
Project: /fixture/project [fixture-project] cwd=/fixture/project
Options: locked=true prune=false check=false dry-run=false continue-on-error=false
Selection: codex / project (bounded-default; selected)
Selected skills: (none)
Approval: { outcome: 'not-required', required: false }
Validation: { outcome: 'not-run', replanned: false }
Summary: 0 operations, 0 succeeded, 0 failed, 0 cancelled, 0 rolled back, 0 skipped, 0 drift, 0 refusals
Summary exact: { cancelled: 0, checkKinds: { 'content-integrity': 0, 'precondition-validation': 0, 'source-resolution': 0, capability: 0, verification: 0 }, checks: 0, diagnosticKinds: { conflict: 0, noop: 0, refuse: 0, skip: 0, warning: 0 }, diagnostics: 0, drift: 0, failed: 0, operationKinds: { 'link-dev': 0, 'migrate-ledger': 0, 'migrate-project-config': 0, 'move-scope': 0, 'write-lock': 0, 'write-manifest': 0, adapt: 0, install: 0, promote: 0, remove: 0, repair: 0, update: 0 }, operations: 0, refusals: 0, rolledBack: 0, skipped: 0, succeeded: 0 }
`;

export const SYNC_REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: 'skillsmith.sync',
  command: 'sync',
  mode: 'dry-run',
  state: 'ready',
  endpoints: {
    from: { kind: 'user', scope: 'user', selectedInput: 'user', projectRoot: null },
    to: {
      kind: 'project',
      scope: 'project',
      selectedInput: 'project',
      projectRoot: '/fixture/project',
    },
  },
  artifactPair: null,
  options: { force: false, delete: false, save: false, dryRun: true, continueOnError: false },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'filter-noop',
    targets: [],
    skills: [],
    tools: [],
    groupIds: [],
    sourceMembers: 0,
    destinationMembers: 0,
  },
  operations: [],
  checks: [],
  diagnostics: [],
  approval: { required: false, outcome: 'not-required' },
  groups: [],
  effects: [],
  summary: {
    groups: 0,
    pairs: 0,
    planned: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notRun: 0,
    changed: 0,
    unchanged: 0,
    effects: 0,
    drift: 0,
    refusals: 0,
  },
} satisfies SyncReportV1Dto;

export const UNDO_REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: 'skillsmith.undo',
  command: 'undo',
  mode: 'dry-run',
  state: 'ready',
  project: {
    effectiveCwd: '/fixture/project',
    root: '/fixture/project',
    identity: 'fixture-project',
  },
  selection: {
    source: 'explicit-all',
    outcome: 'filter-zero',
    targets: [],
    all: true,
    tools: ['codex'],
    scopes: ['project'],
    groupIds: [],
    batchPolicy: 'fail-fast',
  },
  approval: { required: false, outcome: 'not-required' },
  groups: [],
  operations: [],
  checks: [],
  results: [],
  effects: [],
  diagnostics: [],
  summary: {
    selected: 0,
    actionable: 0,
    alreadyReversed: 0,
    planned: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notRun: 0,
    effects: 0,
    refusals: 0,
  },
} satisfies UndoReport;

export const UPDATE_REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: 'skillsmith.update',
  command: 'update',
  mode: 'check',
  state: 'current',
  artifactPair: {
    manifestPath: '/fixture/project/skillsmith.toml',
    lockPath: '/fixture/project/skillsmith.lock',
    lockSource: 'sibling',
    selectionSource: 'discovered-project',
  },
  options: { all: false, ref: null, pin: false, strict: false, continueOnError: false },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'filter-noop',
    targets: [],
    skills: [],
    tools: [],
    groupIds: [],
  },
  candidates: [],
  operations: [],
  checks: [],
  diagnostics: [],
  approval: { required: false, outcome: 'not-required' },
  groups: [],
  effects: [],
  summary: {
    groups: 0,
    candidates: 0,
    current: 0,
    available: 0,
    skippedFixed: 0,
    candidateFailed: 0,
    planned: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notRun: 0,
    effects: 0,
    artifactDrift: 0,
    liveDrift: 0,
    refusals: 0,
  },
} satisfies UpdateReportV1Dto;

export const GC_REPORT_FIXTURE = {
  schemaVersion: 1,
  kind: 'skillsmith.gc',
  command: 'gc',
  mode: 'execute',
  state: 'no-op',
  planId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  selectionSource: 'bounded-default',
  project: {
    effectiveCwd: '/fixture/project',
    root: '/fixture/project',
    identity: '/fixture/project',
  },
  migration: { sourceVersion: 2, action: 'none', outcome: 'not-required' },
  olderThan: null,
  approval: { required: false, outcome: 'not-required' },
  recovery: { state: 'none', phase: null },
  projects: [],
  objects: [],
  actions: [],
  results: [],
  checks: [
    { code: 'inventory-safe', outcome: 'passed', message: 'configured store inventory is safe' },
    { code: 'ledger-readable', outcome: 'passed', message: 'placement ledger is readable' },
  ],
  diagnostics: [],
  summary: {
    observedItems: 0,
    protectedItems: 0,
    ageFilteredItems: 0,
    eligibleItems: 0,
    eligibleBytes: 0,
    forgottenProjects: 0,
    reclaimedItems: 0,
    reclaimedBytes: 0,
    refusedItems: 0,
    failedItems: 0,
  },
} satisfies GcReportV1Dto;

export const REPORT_FIXTURES = {
  agents: AGENTS_REPORT_FIXTURE,
  apply: APPLY_REPORT_FIXTURE,
  health: HEALTH_REPORT_FIXTURE,
  commands: COMMANDS_REPORT_FIXTURE,
  configGetUnscoped: CONFIG_GET_UNSCOPED_REPORT_FIXTURE,
  configGetScoped: CONFIG_GET_SCOPED_REPORT_FIXTURE,
  configListUnscoped: CONFIG_LIST_UNSCOPED_REPORT_FIXTURE,
  configListScoped: CONFIG_LIST_SCOPED_REPORT_FIXTURE,
  configSet: CONFIG_SET_REPORT_FIXTURE,
  configUnset: CONFIG_UNSET_REPORT_FIXTURE,
  flip: FLIP_REPORT_FIXTURE,
  install: INSTALL_REPORT_FIXTURE,
  currentInstall: CURRENT_INSTALL_REPORT_FIXTURE,
  list: LIST_REPORT_FIXTURE,
  plan: PLAN_REPORT_FIXTURE,
  status: STATUS_REPORT_FIXTURE,
  sync: SYNC_REPORT_FIXTURE,
  undo: UNDO_REPORT_FIXTURE,
  update: UPDATE_REPORT_FIXTURE,
  uninstall: UNINSTALL_REPORT_FIXTURE,
  currentUninstall: CURRENT_UNINSTALL_REPORT_FIXTURE,
  verify: VERIFY_REPORT_FIXTURE,
  error: ERROR_FIXTURE,
  export: EXPORT_REPORT_FIXTURE,
  init: INIT_REPORT_FIXTURE,
  gc: GC_REPORT_FIXTURE,
} as const;

/** Report values in the shape consumed by the shared current renderer registry. */
export const CURRENT_RENDERER_REPORTS = {
  agents: REPORT_FIXTURES.agents,
  apply: { result: REPORT_FIXTURES.apply },
  health: REPORT_FIXTURES.health,
  commands: REPORT_FIXTURES.commands,
  configGetUnscoped: REPORT_FIXTURES.configGetUnscoped,
  configGetScoped: REPORT_FIXTURES.configGetScoped,
  configListUnscoped: REPORT_FIXTURES.configListUnscoped,
  configListScoped: REPORT_FIXTURES.configListScoped,
  configSet: REPORT_FIXTURES.configSet,
  configUnset: REPORT_FIXTURES.configUnset,
  flip: { value: REPORT_FIXTURES.flip },
  install: { value: REPORT_FIXTURES.currentInstall },
  list: REPORT_FIXTURES.list,
  plan: { result: REPORT_FIXTURES.plan },
  status: { result: STATUS_V1_DTO_FIXTURE },
  sync: { result: REPORT_FIXTURES.sync },
  undo: { result: REPORT_FIXTURES.undo },
  update: { result: REPORT_FIXTURES.update },
  uninstall: { value: REPORT_FIXTURES.currentUninstall },
  verify: { result: REPORT_FIXTURES.verify },
  export: REPORT_FIXTURES.export,
  init: REPORT_FIXTURES.init,
  gc: { result: REPORT_FIXTURES.gc },
} as const;

/**
 * These are populated from the live current renderer registry and deliberately retain its mixed
 * terminal-LF policy. A later codec must reproduce the strings byte-for-byte.
 */
export const HISTORICAL_JSON_GOLDENS = {
  agents:
    '{\n  "schemaVersion": 1,\n  "experimental": true,\n  "tools": {\n    "claude-code": [\n      {\n        "path": "/fixture/bin/claude",\n        "version": "1.2.3",\n        "installMethod": "native-installer"\n      }\n    ],\n    "codex": [\n      {\n        "path": "/fixture/bin/codex",\n        "version": "4.5.6",\n        "installMethod": "npm-global"\n      }\n    ]\n  }\n}\n',
  health:
    '{\n  "schemaVersion": 1,\n  "experimental": true,\n  "findings": [\n    {\n      "checkId": "fixture.paths",\n      "severity": "warning",\n      "title": "Fixture path needs attention",\n      "message": "The fixture path is illustrative.",\n      "remediation": "Use a real project path.",\n      "tool": "codex",\n      "scope": "project",\n      "path": "/fixture/project",\n      "operation": "read",\n      "reason": "fixture",\n      "scopeInUse": true\n    }\n  ],\n  "counts": {\n    "ok": 2,\n    "warning": 1,\n    "error": 0\n  }\n}',
  commands:
    '{\n  "schemaVersion": 1,\n  "experimental": true,\n  "commands": [\n    {\n      "name": "fixture-command",\n      "path": "/fixture/project/commands/fixture-command.md",\n      "realpath": "/fixture/project/commands/fixture-command.md",\n      "tool": "codex",\n      "scope": "project",\n      "root": "/fixture/project/commands",\n      "frontmatter": {\n        "name": "fixture-command",\n        "description": "A deterministic command fixture",\n        "version": "1.0.0"\n      },\n      "origin": {\n        "kind": "plugin",\n        "pluginId": "fixture.plugin",\n        "pluginVersion": "1.0.0",\n        "pluginScope": "project"\n      },\n      "enabled": "on"\n    }\n  ]\n}',
  configGetUnscoped: '{\n  "key": "tool",\n  "value": "codex",\n  "source": "user"\n}\n',
  configGetScoped: '{\n  "key": "tool",\n  "value": "codex"\n}\n',
  configListUnscoped:
    '{\n  "effective": {\n    "tool": "codex",\n    "scope": "project",\n    "path": "./skills",\n    "registry": {\n      "default": "team"\n    }\n  },\n  "sources": {\n    "tool": "user",\n    "scope": "project",\n    "path": "project",\n    "registry.default": "project"\n  },\n  "layers": {\n    "defaults": {\n      "tool": "claude-code",\n      "scope": "user"\n    },\n    "system": {},\n    "user": {\n      "tool": "codex"\n    },\n    "project": {\n      "scope": "project",\n      "path": "./skills",\n      "registry": {\n        "default": "team"\n      }\n    },\n    "explicit-file": {},\n    "env": {},\n    "cli": {}\n  }\n}',
  configListScoped:
    '{\n  "scope": "project",\n  "path": "./skills",\n  "registry": {\n    "default": "team"\n  }\n}',
  configSet: '{"key":"tool","value":"codex","scope":"user","file":"/fixture/config.toml"}\n',
  configUnset: '{"key":"tool","scope":"user","file":"/fixture/config.toml"}\n',
  flip: '{\n  "schemaVersion": 2,\n  "kind": "skillsmith.flip",\n  "op": "promote",\n  "dryRun": false,\n  "requested": {\n    "targets": [\n      "fixture-skill"\n    ],\n    "all": false,\n    "tools": [\n      "codex"\n    ],\n    "explicitTools": true\n  },\n  "results": [\n    {\n      "skill": "fixture-skill",\n      "tool": "codex",\n      "placementPath": "/fixture/project/skills/fixture-skill",\n      "action": "flipped",\n      "reason": null,\n      "before": {\n        "mode": "dev",\n        "symlinkTarget": "/fixture/source/fixture-skill"\n      },\n      "after": {\n        "mode": "pinned",\n        "storePath": "/fixture/store/fixture-skill"\n      },\n      "store": {\n        "path": "/fixture/store/fixture-skill",\n        "rev": "main",\n        "gitSha": "1111111111111111111111111111111111111111",\n        "dirty": false,\n        "reused": false\n      },\n      "verify": {\n        "gate": "passed",\n        "verdict": "pass"\n      }\n    }\n  ],\n  "summary": {\n    "flipped": 1,\n    "updated": 0,\n    "noop": 0,\n    "skipped": 0,\n    "refused": 0,\n    "failed": 0,\n    "rolledBack": 0,\n    "created": 0,\n    "adopted": 0\n  }\n}',
  install:
    '{\n  "schemaVersion": 1,\n  "kind": "skillsmith.install",\n  "dryRun": false,\n  "requested": {\n    "sources": [\n      "fixture/repository//skills/fixture-skill"\n    ],\n    "tools": [\n      "codex"\n    ],\n    "explicitTools": true,\n    "scope": "project",\n    "explicitScope": true,\n    "ref": "main",\n    "pin": true,\n    "direct": false,\n    "force": false,\n    "verify": "static",\n    "deep": false\n  },\n  "results": [\n    {\n      "source": "fixture/repository//skills/fixture-skill",\n      "skill": "fixture-skill",\n      "tool": "codex",\n      "scope": "project",\n      "placementPath": "/fixture/project/skills/fixture-skill",\n      "action": "installed",\n      "reason": null,\n      "placement": "symlink",\n      "store": {\n        "path": "/fixture/store/fixture-skill",\n        "rev": "main",\n        "gitSha": "1111111111111111111111111111111111111111",\n        "reused": false\n      },\n      "origin": {\n        "host": "github.com",\n        "repo": "fixture/repository",\n        "skillPath": "skills/fixture-skill",\n        "refRequested": "main",\n        "refResolved": "1111111111111111111111111111111111111111",\n        "pin": true\n      },\n      "verify": {\n        "gate": "passed",\n        "verdict": "pass",\n        "mode": "static"\n      },\n      "candidates": null\n    }\n  ],\n  "summary": {\n    "installed": 1,\n    "updated": 0,\n    "repaired": 0,\n    "noop": 0,\n    "skipped": 0,\n    "refused": 0,\n    "failed": 0\n  }\n}',
  list: '{\n  "schemaVersion": 2,\n  "experimental": true,\n  "skills": [\n    {\n      "name": "fixture-skill",\n      "path": "/fixture/project/skills/fixture-skill",\n      "realpath": "/fixture/store/fixture-skill",\n      "tool": "codex",\n      "scope": "project",\n      "root": "/fixture/project/skills",\n      "frontmatter": {\n        "name": "fixture-skill",\n        "description": "A deterministic skill fixture",\n        "version": "1.0.0"\n      },\n      "origin": {\n        "kind": "standalone"\n      },\n      "enabled": "on"\n    }\n  ]\n}',
  status: `${JSON.stringify(STATUS_V1_DTO_FIXTURE, null, 2)}\n`,
  uninstall:
    '{\n  "schemaVersion": 1,\n  "kind": "skillsmith.uninstall",\n  "dryRun": false,\n  "requested": {\n    "targets": [\n      "fixture-skill"\n    ],\n    "tools": [\n      "codex"\n    ],\n    "explicitTools": true,\n    "scope": "project",\n    "allScopes": false,\n    "force": false\n  },\n  "results": [\n    {\n      "skill": "fixture-skill",\n      "tool": "codex",\n      "scope": "project",\n      "placementPath": "/fixture/project/skills/fixture-skill",\n      "action": "removed",\n      "reason": null,\n      "before": {\n        "mode": "pinned",\n        "placement": "symlink",\n        "storePath": "/fixture/store/fixture-skill",\n        "symlinkTarget": "/fixture/store/fixture-skill"\n      },\n      "storeRetained": "/fixture/store/fixture-skill",\n      "backupKept": null\n    }\n  ],\n  "summary": {\n    "removed": 1,\n    "noop": 0,\n    "refused": 0,\n    "failed": 0\n  }\n}',
  verify:
    '{\n  "schemaVersion": 1,\n  "kind": "skillsmith.verify",\n  "target": {\n    "path": "/fixture/project/skills/fixture-skill",\n    "kind": "skill"\n  },\n  "requested": {\n    "tools": [\n      "codex"\n    ],\n    "modes": [\n      "static",\n      "deep"\n    ],\n    "strict": true,\n    "explicitTools": true\n  },\n  "verifiedAgainst": {\n    "claude-code": "1.0.0",\n    "codex": "1.0.0"\n  },\n  "summary": {\n    "verdict": "warn",\n    "verified": [\n      "codex"\n    ],\n    "failed": [],\n    "skipped": [],\n    "counts": {\n      "error": 0,\n      "warning": 1,\n      "info": 0\n    }\n  },\n  "tools": [\n    {\n      "tool": "codex",\n      "available": true,\n      "toolVersion": "1.0.1",\n      "versionDrift": true,\n      "skipReason": null,\n      "verdict": "warn",\n      "modes": [\n        {\n          "mode": "static",\n          "status": "ran",\n          "skipReason": null,\n          "coverage": {\n            "manifest": true,\n            "skills": true\n          },\n          "verdict": "warn",\n          "command": "codex fixture verify",\n          "findings": [\n            {\n              "checkId": "fixture.frontmatter",\n              "toolSeverity": "warning",\n              "normalizedSeverity": "warning",\n              "message": "Fixture warning",\n              "file": "SKILL.md",\n              "subject": "skill",\n              "raw": "fixture raw detail"\n            }\n          ]\n        },\n        {\n          "mode": "deep",\n          "status": "ran",\n          "skipReason": null,\n          "coverage": {\n            "manifest": true,\n            "skills": true\n          },\n          "verdict": "pass",\n          "command": "codex fixture verify --deep",\n          "findings": []\n        }\n      ]\n    }\n  ]\n}',
  error:
    '{"schemaVersion":1,"kind":"error","code":"fixture-error","message":"Deterministic fixture failure","exitCode":7}\n',
} as const;

const AGENTS_V2_DTO = {
  schemaVersion: 2,
  kind: 'skillsmith.agents',
  detections: [
    {
      tool: 'claude-code',
      installations: [
        {
          path: '/fixture/bin/claude',
          version: '1.2.3',
          installMethod: 'native-installer',
        },
      ],
    },
    {
      tool: 'codex',
      installations: [
        {
          path: '/fixture/bin/codex',
          version: '4.5.6',
          installMethod: 'npm-global',
        },
      ],
    },
  ],
  capabilities: agentsV2Golden.capabilities,
} as const;

const COMMANDS_V2_DTO = {
  schemaVersion: 2,
  kind: 'skillsmith.commands',
  selection: COMMANDS_REPORT_FIXTURE.selection,
  summary: { total: 1 },
  entries: [
    {
      name: 'fixture-command',
      tool: 'codex',
      scope: 'project',
      path: '/fixture/project/commands/fixture-command.md',
      realpath: '/fixture/project/commands/fixture-command.md',
      root: '/fixture/project/commands',
      frontmatter: {
        name: 'fixture-command',
        description: 'A deterministic command fixture',
        version: '1.0.0',
      },
      origin: {
        kind: 'plugin',
        pluginId: 'fixture.plugin',
        pluginVersion: '1.0.0',
        pluginScope: 'project',
      },
      enabled: 'on',
      description: 'A deterministic command fixture',
    },
  ],
} as const;

const LIST_V3_DTO = {
  schemaVersion: 3,
  kind: 'skillsmith.list',
  selection: LIST_REPORT_FIXTURE.selection,
  summary: { total: 1, collisionGroups: 0 },
  entries: [
    {
      name: 'fixture-skill',
      tool: 'codex',
      scope: 'project',
      mode: 'unmanaged',
      placement: 'unknown',
      path: '/fixture/project/skills/fixture-skill',
      realpath: '/fixture/store/fixture-skill',
      root: '/fixture/project/skills',
      frontmatter: {
        name: 'fixture-skill',
        description: 'A deterministic skill fixture',
        version: '1.0.0',
      },
      origin: { kind: 'standalone' },
      enabled: 'on',
      source: null,
      revision: null,
      store: null,
      verification: 'unrecorded',
      description: 'A deterministic skill fixture',
      visibility: {
        state: 'unique',
        winner: null,
        members: [{ scope: 'project', path: '/fixture/project/skills/fixture-skill' }],
      },
    },
  ],
  collisionGroups: LIST_REPORT_FIXTURE.collisionGroups,
} as const;

const FLIP_V3_DTO = {
  schemaVersion: 3,
  kind: 'skillsmith.flip',
  op: 'promote',
  dryRun: false,
  summary: FLIP_REPORT_FIXTURE.summary,
  selection: {
    source: 'explicit-targets',
    outcome: 'selected',
    targets: ['fixture-skill'],
    all: false,
    tools: ['codex'],
    scopes: ['project'],
    groupIds: [FLIP_GROUP_ID],
    batchPolicy: 'fail-fast',
  },
  operations: [FLIP_OPERATION],
  checks: [],
  diagnostics: [],
  results: [FLIP_EXECUTION_RESULT],
} as const;

const FLIP_V4_DTO = {
  ...FLIP_V3_DTO,
  schemaVersion: 4,
} as const;

const INSTALL_V2_DTO = {
  schemaVersion: 2,
  kind: 'skillsmith.install',
  dryRun: false,
  saveMode: 'desired-state',
  artifactPair: {
    manifestPath: '/fixture/project/skills.toml',
    lockPath: '/fixture/project/skills.lock',
    lockSource: 'sibling',
  },
  artifactSelection: { outcome: 'selected', selectedBy: 'selected-project-owner' },
  artifactEffects: [
    {
      groupId: 'group:v1:fixture-install',
      skill: 'fixture-skill',
      manifestAction: 'update',
      lockAction: 'update',
      migration: 'none',
      outcome: 'succeeded',
      reason: null,
    },
  ],
  requested: {
    sources: [CURRENT_SOURCE_REDACTED],
    tools: ['codex'],
    explicitTools: true,
    scope: 'project',
    explicitScope: true,
    ref: 'main',
    pin: true,
    direct: false,
    force: false,
    verify: 'static',
    deep: false,
    batchPolicy: 'fail-fast',
    path: './skills',
  },
  results: [
    {
      source: CURRENT_SOURCE_REDACTED,
      skill: 'fixture-skill',
      tool: 'codex',
      scope: 'project',
      placementPath: '/fixture/project/skills/fixture-skill',
      action: 'installed',
      reason: null,
      placement: 'symlink',
      store: null,
      origin: null,
      verify: null,
      candidates: null,
      requestIndex: 0,
      groupId: 'group:v1:fixture-install',
      pairId: 'pair:v1:fixture-codex-project',
      executionOutcome: 'succeeded',
      drift: { status: 'in-sync', futureApply: 'none', reason: null },
      force: CURRENT_NO_CONFLICT_FORCE,
    },
  ],
  summary: {
    installed: 1,
    updated: 0,
    repaired: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
    desiredState: { changed: 1, unchanged: 0, retained: 0, notWritten: 0, failed: 0 },
  },
} as const;

const UNINSTALL_V2_DTO = {
  schemaVersion: 2,
  kind: 'skillsmith.uninstall',
  dryRun: true,
  saveMode: 'live-only',
  artifactPair: null,
  artifactSelection: { outcome: 'none', reason: 'no-save' },
  artifactEffects: [
    {
      groupId: 'group:v1:fixture-uninstall',
      skill: 'fixture-skill',
      manifestAction: 'not-write',
      lockAction: 'not-write',
      migration: 'none',
      outcome: 'planned',
      reason: null,
    },
  ],
  requested: {
    targets: ['fixture-skill', 'later-skill'],
    tools: ['codex'],
    explicitTools: true,
    scope: 'project',
    allScopes: false,
    force: true,
    batchPolicy: 'fail-fast',
  },
  results: [
    {
      skill: 'fixture-skill',
      tool: 'codex',
      scope: 'project',
      placementPath: '/fixture/project/skills/fixture-skill',
      action: 'removed',
      reason: null,
      before: null,
      storeRetained: null,
      backupKept: null,
      requestIndex: 0,
      groupId: 'group:v1:fixture-uninstall',
      pairId: 'pair:v1:fixture-codex-project',
      executionOutcome: 'succeeded',
      drift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
      force: {
        requested: true,
        applied: false,
        conflictType: 'source-changed',
        target: { kind: 'store', contentHash: CURRENT_CONTENT_HASH },
        normalBehavior: 'refuse',
        forcedBehavior: 'replace',
        backup: 'none',
      },
    },
    {
      skill: 'later-skill',
      tool: 'codex',
      scope: 'project',
      placementPath: null,
      action: 'skipped',
      reason: 'skipped after an earlier group failed',
      before: null,
      storeRetained: null,
      backupKept: null,
      requestIndex: 1,
      groupId: 'group:v1:fixture-uninstall-later',
      pairId: 'pair:v1:fixture-codex-project',
      executionOutcome: 'skipped-after-failure',
      drift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
      force: CURRENT_NO_CONFLICT_FORCE,
    },
  ],
  summary: {
    removed: 1,
    noop: 0,
    refused: 0,
    failed: 0,
    desiredState: { changed: 0, unchanged: 0, retained: 0, notWritten: 2, failed: 0 },
  },
} as const;

export const HISTORICAL_FLIP_V3_GOLDEN = JSON.stringify(FLIP_V3_DTO, null, 2);

export const CURRENT_LIFECYCLE_V2_GOLDENS = {
  install: JSON.stringify(INSTALL_V2_DTO, null, 2),
  uninstall: JSON.stringify(UNINSTALL_V2_DTO, null, 2),
} as const;

export const CURRENT_JSON_GOLDENS = {
  ...HISTORICAL_JSON_GOLDENS,
  agents: `${JSON.stringify(AGENTS_V2_DTO, null, 2)}\n`,
  apply: `${JSON.stringify(APPLY_REPORT_FIXTURE, null, 2)}\n`,
  commands: `${JSON.stringify(COMMANDS_V2_DTO, null, 2)}\n`,
  flip: JSON.stringify(FLIP_V4_DTO, null, 2),
  install: CURRENT_LIFECYCLE_V2_GOLDENS.install,
  list: `${JSON.stringify(LIST_V3_DTO, null, 2)}\n`,
  plan: `${JSON.stringify(PLAN_REPORT_FIXTURE, null, 2)}\n`,
  sync: `${JSON.stringify(SYNC_REPORT_FIXTURE, null, 2)}\n`,
  undo: `${JSON.stringify(UNDO_REPORT_FIXTURE, null, 2)}\n`,
  update: `${JSON.stringify(UPDATE_REPORT_FIXTURE, null, 2)}\n`,
  uninstall: CURRENT_LIFECYCLE_V2_GOLDENS.uninstall,
  export: `${JSON.stringify(EXPORT_REPORT_FIXTURE, null, 2)}\n`,
  init: `${JSON.stringify(INIT_REPORT_FIXTURE, null, 2)}\n`,
  gc: `${JSON.stringify(GC_REPORT_FIXTURE, null, 2)}\n`,
} as const;

export const GOLDEN_TERMINAL_LF = {
  agents: true,
  apply: true,
  health: false,
  commands: true,
  configGetUnscoped: true,
  configGetScoped: true,
  configListUnscoped: false,
  configListScoped: false,
  configSet: true,
  configUnset: true,
  flip: false,
  install: false,
  list: true,
  plan: true,
  status: true,
  sync: true,
  undo: true,
  update: true,
  uninstall: false,
  verify: false,
  error: true,
  export: true,
  init: true,
  gc: true,
} as const;
