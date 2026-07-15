import type { StatusV1Dto } from '../../../../packages/core/src/contracts/v1/index.ts';
import type {
  AgentsReport,
  CommandsReport,
  ConfigGetReport,
  ConfigListReport,
  ConfigSetReport,
  ConfigUnsetReport,
  FlipReport,
  HealthReport,
  InstallRecord,
  InstallReport,
  ListReport,
  NormalizedSeverity,
  SkillSmithError,
  StatusReport,
  SupportedTool,
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

export const FLIP_REPORT_FIXTURE = {
  op: 'promote',
  dryRun: false,
  requested: {
    targets: ['fixture-skill'],
    all: false,
    tools: ['codex'],
    explicitTools: true,
  },
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

export const REPORT_FIXTURES = {
  agents: AGENTS_REPORT_FIXTURE,
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
  list: LIST_REPORT_FIXTURE,
  status: STATUS_REPORT_FIXTURE,
  uninstall: UNINSTALL_REPORT_FIXTURE,
  verify: VERIFY_REPORT_FIXTURE,
  error: ERROR_FIXTURE,
} as const;

/** Report values in the shape consumed by the shared current renderer registry. */
export const CURRENT_RENDERER_REPORTS = {
  agents: REPORT_FIXTURES.agents,
  health: REPORT_FIXTURES.health,
  commands: REPORT_FIXTURES.commands,
  configGetUnscoped: REPORT_FIXTURES.configGetUnscoped,
  configGetScoped: REPORT_FIXTURES.configGetScoped,
  configListUnscoped: REPORT_FIXTURES.configListUnscoped,
  configListScoped: REPORT_FIXTURES.configListScoped,
  configSet: REPORT_FIXTURES.configSet,
  configUnset: REPORT_FIXTURES.configUnset,
  flip: { value: REPORT_FIXTURES.flip },
  install: { value: REPORT_FIXTURES.install },
  list: REPORT_FIXTURES.list,
  status: { result: STATUS_V1_DTO_FIXTURE },
  uninstall: { value: REPORT_FIXTURES.uninstall },
  verify: { result: REPORT_FIXTURES.verify },
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

export const CURRENT_JSON_GOLDENS = {
  ...HISTORICAL_JSON_GOLDENS,
  agents: `${JSON.stringify(AGENTS_V2_DTO, null, 2)}\n`,
  commands: `${JSON.stringify(COMMANDS_V2_DTO, null, 2)}\n`,
  list: `${JSON.stringify(LIST_V3_DTO, null, 2)}\n`,
} as const;

export const GOLDEN_TERMINAL_LF = {
  agents: true,
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
  status: true,
  uninstall: false,
  verify: false,
  error: true,
} as const;
