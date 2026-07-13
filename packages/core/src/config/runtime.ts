import type { JournalPhase } from '../place/types.ts';
import type { ResolvedRuntimeConfiguration } from '../ports/types.ts';
import { configFromEnv } from './env.ts';

const JOURNAL_PHASES = new Set<JournalPhase>([
  'prepared',
  'staged',
  'backed-up',
  'live',
  'committed',
]);

const nonempty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

const broadBoolean = (value: string | undefined): boolean =>
  value !== undefined && value.length > 0 && value !== '0' && value.toLowerCase() !== 'false';

const exactTrue = (value: string | undefined): boolean => value === 'true';

const journalPauseFrom = (
  environment: Readonly<Record<string, string | undefined>>,
): JournalPhase | undefined => {
  if (environment.SKILLSMITH_E2E !== '1') return undefined;
  const phase = environment.SKILLSMITH_TEST_PAUSE_AT;
  return phase !== undefined && JOURNAL_PHASES.has(phase as JournalPhase)
    ? (phase as JournalPhase)
    : undefined;
};

export const resolveRuntimeConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedRuntimeConfiguration => {
  const decoded = configFromEnv(environment);
  const configLayer = Object.freeze({
    ...(decoded.tool !== undefined ? { tool: decoded.tool } : {}),
    ...(decoded.scope !== undefined ? { scope: decoded.scope } : {}),
    ...(decoded.path !== undefined ? { path: decoded.path } : {}),
    ...(decoded.registry?.default !== undefined
      ? { registry: Object.freeze({ default: decoded.registry.default }) }
      : {}),
  });

  return Object.freeze({
    configLayer,
    explicitConfigPath: nonempty(environment.SKILLSMITH_CONFIG),
    skillsmithHome: nonempty(environment.SKILLSMITH_HOME),
    claudeConfigDir: nonempty(environment.CLAUDE_CONFIG_DIR),
    claudePolicySkillsDisabled: broadBoolean(environment.CLAUDE_CODE_DISABLE_POLICY_SKILLS),
    claudeManagedSettingsPath: nonempty(environment.CLAUDE_CODE_MANAGED_SETTINGS_PATH),
    codexHome: nonempty(environment.CODEX_HOME),
    kiloExternalSkillsDisabled: exactTrue(environment.KILO_DISABLE_EXTERNAL_SKILLS),
    opencodeConfigDir: nonempty(environment.OPENCODE_CONFIG_DIR),
    opencodeClaudeSkillsDisabled: exactTrue(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS),
    forceColor: Boolean(nonempty(environment.FORCE_COLOR)),
    noColor: Boolean(nonempty(environment.NO_COLOR)),
    journalPause: journalPauseFrom(environment),
  });
};
