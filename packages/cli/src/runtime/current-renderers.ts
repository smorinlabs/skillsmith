import {
  type AgentsReport,
  type ApplyApplicationReport,
  CONFIG_KEYS,
  type CliMetadataReport,
  type CommandsReport,
  type ConfigGetReport,
  type ConfigListReport,
  type ConfigSetReport,
  type ConfigUnsetReport,
  type CurrentInstallReport,
  type CurrentUninstallReport,
  type DevApplicationReport,
  type ExportReport,
  type FlipReport,
  type HealthReport,
  type InitReport,
  type InstallApplicationReport,
  type ListReport,
  type PlanApplicationReport,
  type PromoteApplicationReport,
  type StatusApplicationReport,
  type UninstallApplicationReport,
  type VerifyApplicationReport,
  type VersionReport,
  getConfigValue,
  toolRegistry,
} from '@skillsmith/core';
import {
  toConfigGetV1Dto,
  toConfigListV1Dto,
  toConfigSetV1Dto,
  toConfigUnsetV1Dto,
} from '@skillsmith/core/contracts/v1';
import type { Command } from 'commander';
import { runCompletion } from '../completion/run.ts';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { HELP_TOPIC_NAMES, renderTopic } from '../help/topics.ts';
import { renderAgentsJson } from '../output/agents-json.ts';
import { renderAgentsMarkdown } from '../output/agents-markdown.ts';
import { renderApplyHuman } from '../output/apply-human.ts';
import { renderApplyJson } from '../output/apply-json.ts';
import { renderCommandsHuman } from '../output/commands-human.ts';
import { renderCommandsJson } from '../output/commands-json.ts';
import { renderDoctorHuman } from '../output/doctor-human.ts';
import { renderDoctorJson } from '../output/doctor-json.ts';
import { renderCliError } from '../output/error-boundary.ts';
import { renderExportHuman } from '../output/export-human.ts';
import { renderExportJson } from '../output/export-json.ts';
import { renderFlipHuman } from '../output/flip-human.ts';
import { renderFlipJson } from '../output/flip-json.ts';
import { renderInitHuman } from '../output/init-human.ts';
import { renderInitJson } from '../output/init-json.ts';
import {
  type InstallStaticNoticeResolver,
  renderInstallHuman,
  renderUninstallHuman,
} from '../output/install-human.ts';
import { renderInstallJson, renderUninstallJson } from '../output/install-json.ts';
import { renderListHuman } from '../output/list-human.ts';
import { renderListJson } from '../output/list-json.ts';
import { renderPlanHuman } from '../output/plan-human.ts';
import { renderPlanJson } from '../output/plan-json.ts';
import { renderStatusHuman } from '../output/status-human.ts';
import { renderStatusJson } from '../output/status-json.ts';
import {
  type VerifyDeepCoverageSuffixResolver,
  renderVerifyHuman,
} from '../output/verify-human.ts';
import { renderVerifyJson } from '../output/verify-json.ts';
import { encodeWire } from '../output/wire-codec.ts';
import type { RendererRegistry, RuntimeOutcome } from './adapter.ts';
import { exitCodeForClass } from './adapter.ts';

type RenderableOutcome<T> = RuntimeOutcome & { readonly report: T };

const report = <T>(outcome: RuntimeOutcome): T => (outcome as RenderableOutcome<T>).report;

const warningOutput = (outcome: RuntimeOutcome): string =>
  `${outcome.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'warning')
    .map(
      (diagnostic) =>
        `warning: ${diagnostic.message}${diagnostic.remediation ? `; ${diagnostic.remediation}` : ''}\n`,
    )
    .join('')}${outcome.deprecations
    .map(
      (item) =>
        `warning: ${item.message}; use ${item.replacement} (removal no earlier than ${item.removalVersion})\n`,
    )
    .join('')}`;

const errorOutput = (outcome: RuntimeOutcome, format: 'human' | 'json') => {
  const diagnostic = outcome.diagnostics.find((item) => item.severity === 'error');
  if (diagnostic === undefined) return null;
  const exitCode = exitCodeForClass(outcome.exitClass);
  const code =
    diagnostic.code === 'invalid-argument' ? 'commander.invalidArgument' : diagnostic.code;
  const rendered = renderCliError({ code, message: diagnostic.message, exitCode }, format);
  return format === 'human' ? { stderr: rendered } : { stdout: rendered };
};

const doctorHumanOutput = (value: HealthReport, outcome: RuntimeOutcome) => {
  const diagnostic = outcome.diagnostics.find((item) => item.severity === 'error');
  if (
    value.result === null &&
    outcome.exitClass === 'usage' &&
    diagnostic?.message.includes('--yes') === true
  ) {
    return {
      stdout: renderCliError(
        { code: diagnostic.code, message: diagnostic.message, exitCode: 2 },
        'human',
      ),
    };
  }
  return (
    errorOutput(outcome, 'human') ??
    withDiagnostics(outcome, value.result === null ? '' : renderDoctorHuman(value.result))
  );
};

const withDiagnostics = (
  outcome: RuntimeOutcome,
  stdout: string,
): { readonly stdout: string; readonly stderr?: string } => {
  const warnings = warningOutput(outcome);
  return warnings.length === 0 ? { stdout } : { stdout, stderr: warnings };
};

const guarded = <T>(
  renderHuman: (value: T, outcome: RuntimeOutcome) => string | { stdout?: string; stderr?: string },
  renderJson: (value: T, outcome: RuntimeOutcome) => string | { stdout?: string; stderr?: string },
) => ({
  human: (outcome: RuntimeOutcome) =>
    errorOutput(outcome, 'human') ?? renderHuman(report<T>(outcome), outcome),
  json: (outcome: RuntimeOutcome) =>
    errorOutput(outcome, 'json') ?? renderJson(report<T>(outcome), outcome),
});

const renderedLifecycleOutput = (stdout: string, stderr: string) =>
  stderr.length === 0 ? { stdout } : { stdout, stderr };

const currentInstallStaticNotice: InstallStaticNoticeResolver = (tool, skill) => {
  const notice = toolRegistry.get(tool)?.verification?.renderedFacts.installStaticNotice;
  return notice?.(skill) ?? null;
};

const currentDeepCoverageSuffix: VerifyDeepCoverageSuffixResolver = (tool) =>
  toolRegistry.get(tool)?.verification?.renderedFacts.deepSkillCoverageSuffix ?? null;

const itemLine = (level: 'error' | 'warning', label: string, reason: string): string => {
  const rendered = renderCliError(
    { code: 'lifecycle-item', message: `${label}: ${reason}`, exitCode: level === 'error' ? 1 : 0 },
    'human',
  );
  return level === 'error' ? rendered : rendered.replace(/^error:/, 'warning:');
};

const installStderr = (value: CurrentInstallReport): string =>
  value.results
    .map((item) => {
      const label = item.skill ? `${item.skill}${item.tool ? ` (${item.tool})` : ''}` : item.source;
      if (item.action === 'refused' || item.action === 'failed') {
        const candidates = item.candidates ?? [];
        return `${itemLine('error', label, item.reason ?? item.action)}${
          candidates.length === 0
            ? ''
            : `\n${candidates.map((candidate) => `  ${candidate}`).join('\n')}\n\nRe-run with one of the exact paths above.\n`
        }`;
      }
      return item.action !== 'noop' && item.reason ? itemLine('warning', label, item.reason) : '';
    })
    .join('');

const uninstallStderr = (value: CurrentUninstallReport): string =>
  value.results
    .map((item) => {
      const label = `${item.skill}${item.tool ? ` (${item.tool})` : ''}`;
      if (item.action === 'refused' || item.action === 'failed') {
        return itemLine('error', label, item.reason ?? item.action);
      }
      if (item.action === 'skipped') return '';
      return item.action !== 'noop' && item.reason ? itemLine('warning', label, item.reason) : '';
    })
    .join('');

export const renderFlipLifecycleStderr = (value: FlipReport): string =>
  value.results
    .map((item) => {
      const label = `${item.skill}${item.tool ? ` (${item.tool})` : ''}`;
      if (item.action === 'refused' || item.action === 'failed') {
        return itemLine('error', label, item.reason ?? item.action);
      }
      // Scheduling-only rows are already represented in the canonical result/summary. Retain the
      // historical warning behavior for every other non-error action carrying a reason.
      const schedulingOnly =
        item.action === 'skipped' && (item.reason === 'fail-fast' || item.reason === 'interrupted');
      return !schedulingOnly && item.action !== 'noop' && item.reason
        ? itemLine('warning', label, item.reason)
        : '';
    })
    .join('');

const lifecycleRenderer = <T>(
  human: (value: T, outcome: RuntimeOutcome) => string,
  json: (value: T) => string,
  stderr: (value: T) => string,
) => ({
  human: (outcome: RuntimeOutcome) => {
    const value = report<{ readonly value: T | null }>(outcome).value;
    return value === null
      ? (errorOutput(outcome, 'human') ?? '')
      : renderedLifecycleOutput(human(value, outcome), stderr(value));
  },
  json: (outcome: RuntimeOutcome) => {
    const value = report<{ readonly value: T | null }>(outcome).value;
    return value === null
      ? (errorOutput(outcome, 'json') ?? '')
      : renderedLifecycleOutput(json(value), stderr(value));
  },
});

const configListHuman = (value: ConfigListReport): string => {
  const lines: string[] = [];
  const appendLayer = (
    layer: ConfigListReport['layers'][keyof ConfigListReport['layers']],
    source?: string,
    canonicalTools = false,
  ): void => {
    const tools = layer.tools ?? (layer.tool === undefined ? undefined : [layer.tool]);
    if ((layer.tools !== undefined || canonicalTools) && tools !== undefined) {
      lines.push(
        `tools = ${JSON.stringify(tools)}${source === undefined ? '' : `    # source: ${source}`}`,
      );
    } else if (layer.tool !== undefined) {
      lines.push(
        `tool = ${JSON.stringify(layer.tool)}${source === undefined ? '' : `    # source: ${source}`}`,
      );
    }
    for (const key of CONFIG_KEYS) {
      if (key === 'tool') continue;
      const selected = getConfigValue(layer, key);
      if (selected !== undefined) {
        lines.push(
          `${key} = ${JSON.stringify(selected)}${source === undefined ? '' : `    # source: ${source}`}`,
        );
      }
    }
  };
  if (value.scope !== undefined) {
    appendLayer(value.layers[value.scope], undefined, value.scope === 'project');
  } else {
    const toolSource = value.sources.tool;
    if (toolSource !== undefined) {
      const layer = value.layers[toolSource];
      const tools = layer.tools ?? (layer.tool === undefined ? undefined : [layer.tool]);
      if (layer.tools !== undefined && tools !== undefined) {
        lines.push(`tools = ${JSON.stringify(tools)}    # source: ${toolSource}`);
      } else if (layer.tool !== undefined) {
        lines.push(`tool = ${JSON.stringify(layer.tool)}    # source: ${toolSource}`);
      }
    }
    for (const key of CONFIG_KEYS) {
      if (key === 'tool') continue;
      const source = value.sources[key];
      if (source === undefined) continue;
      const selected = getConfigValue(value.layers[source], key);
      if (selected !== undefined) {
        lines.push(`${key} = ${JSON.stringify(selected)}    # source: ${source}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
};

const metadataRenderer = (root: Command) =>
  guarded<CliMetadataReport>(
    (value) => {
      if (value.command === 'rootHelp') return root.helpInformation();
      if (value.command === 'configHelp')
        return (
          root.commands.find((command) => command.name() === 'config')?.helpInformation() ?? ''
        );
      if (value.command === 'completion') {
        const shell = value.request.arguments[0];
        return typeof shell === 'string'
          ? runCompletion(root, shell as 'bash' | 'zsh' | 'fish')
          : '';
      }
      const topic = value.request.arguments[0];
      if (typeof topic !== 'string') return root.helpInformation();
      if ((HELP_TOPIC_NAMES as readonly string[]).includes(topic)) {
        const rendered = renderTopic(topic);
        return rendered.ok ? `${rendered.value}\n` : '';
      }
      return root.commands.find((command) => command.name() === topic)?.helpInformation() ?? '';
    },
    (value) => JSON.stringify(value),
  );

export const createCurrentRendererRegistry = (root: Command): RendererRegistry => {
  const metadata = metadataRenderer(root);
  return {
    rootHelp: metadata,
    configHelp: metadata,
    completion: metadata,
    help: metadata,
    version: guarded<VersionReport>(
      (value) => `${value.version}\n`,
      (value) => `${JSON.stringify(value)}\n`,
    ),
    agents: guarded<AgentsReport>(
      (value, outcome) =>
        withDiagnostics(
          outcome,
          renderAgentsMarkdown(value.detections as Map<never, never>, {
            detectedOnly: value.detectedOnly,
            ...(value.showCapabilities === undefined
              ? {}
              : { capabilities: value.showCapabilities }),
            ...(value.capabilities === undefined ? {} : { capabilitySnapshot: value.capabilities }),
          }),
        ),
      (value) => renderAgentsJson(value),
    ),
    apply: {
      human: (outcome) => {
        const value = report<ApplyApplicationReport>(outcome).result;
        return value === null
          ? (errorOutput(outcome, 'human') ?? '')
          : withDiagnostics(outcome, renderApplyHuman(value));
      },
      json: (outcome) => {
        const value = report<ApplyApplicationReport>(outcome).result;
        return value === null
          ? (errorOutput(outcome, 'json') ?? '')
          : renderApplyJson(value, currentWireCodecs.apply);
      },
    },
    configGet: guarded<ConfigGetReport>(
      (value, outcome) => withDiagnostics(outcome, `${value.value ?? ''}\n`),
      (value, outcome) =>
        withDiagnostics(outcome, encodeWire(currentWireCodecs.configGet, toConfigGetV1Dto(value))),
    ),
    configSet: guarded<ConfigSetReport>(
      (value) => ({
        stderr: `${value.operation === 'migrate-project-config' ? 'migrated project config and wrote' : 'wrote'} ${value.file ?? ''}\n`,
      }),
      (value) => encodeWire(currentWireCodecs.configSet, toConfigSetV1Dto(value)),
    ),
    configList: guarded<ConfigListReport>(
      (value, outcome) => withDiagnostics(outcome, configListHuman(value)),
      (value, outcome) =>
        withDiagnostics(
          outcome,
          encodeWire(currentWireCodecs.configList, toConfigListV1Dto(value)),
        ),
    ),
    configUnset: guarded<ConfigUnsetReport>(
      (value) => ({
        stderr: `${value.operation === 'migrate-project-config' ? 'migrated project config and updated' : 'updated'} ${value.file ?? ''}\n`,
      }),
      (value) => encodeWire(currentWireCodecs.configUnset, toConfigUnsetV1Dto(value)),
    ),
    list: guarded<ListReport>(
      (value, outcome) =>
        withDiagnostics(
          outcome,
          renderListHuman(value.entries, {
            long: value.long,
            ...(value.selection === undefined ? {} : { outcome: value.selection.outcome }),
            ...(value.selection?.filters.duplicates === true ? { duplicates: true } : {}),
            ...(value.collisionGroups === undefined
              ? {}
              : { collisionGroups: value.collisionGroups }),
          }),
        ),
      (value) => renderListJson(value),
    ),
    commands: guarded<CommandsReport>(
      (value, outcome) =>
        withDiagnostics(
          outcome,
          renderCommandsHuman(value.entries, {
            long: value.long,
            ...(value.selection === undefined ? {} : { outcome: value.selection.outcome }),
          }),
        ),
      (value) => renderCommandsJson(value),
    ),
    doctor: {
      human: (outcome) => doctorHumanOutput(report<HealthReport>(outcome), outcome),
      json: (outcome) => {
        const value = report<HealthReport>(outcome);
        return value.result === null
          ? (errorOutput(outcome, 'json') ?? '')
          : renderDoctorJson(value.result, outcome.deprecations, currentWireCodecs.doctor);
      },
    },
    check: guarded<HealthReport>(
      (value, outcome) =>
        withDiagnostics(outcome, value.result === null ? '' : renderDoctorHuman(value.result)),
      (value, outcome) =>
        value.result === null
          ? (errorOutput(outcome, 'json') ?? '')
          : renderDoctorJson(value.result, outcome.deprecations, currentWireCodecs.check),
    ),
    status: guarded<StatusApplicationReport>(
      (value, outcome) =>
        value.result === null
          ? (errorOutput(outcome, 'human') ?? '')
          : withDiagnostics(outcome, renderStatusHuman(value.result)),
      (value, outcome) =>
        value.result === null
          ? (errorOutput(outcome, 'json') ?? '')
          : renderStatusJson(value.result),
    ),
    verify: guarded<VerifyApplicationReport>(
      (value, outcome) =>
        value.result === null
          ? (errorOutput(outcome, 'human') ?? '')
          : renderVerifyHuman(
              value.result,
              exitCodeForClass(outcome.exitClass),
              currentDeepCoverageSuffix,
            ),
      (value, outcome) =>
        value.result === null
          ? (errorOutput(outcome, 'json') ?? '')
          : renderVerifyJson(value.result),
    ),
    export: {
      human: (outcome) => {
        const value = report<ExportReport>(outcome);
        if (value.artifactSelection.outcome !== 'refused') {
          return withDiagnostics(outcome, renderExportHuman(value));
        }
        const failure = errorOutput(outcome, 'human');
        if (value.results.length === 0 && value.effects.length === 0) return failure ?? '';
        return {
          stdout: renderExportHuman(value),
          ...(failure?.stderr === undefined ? {} : { stderr: failure.stderr }),
        };
      },
      json: (outcome) => {
        const value = report<ExportReport>(outcome);
        return value.artifactSelection.outcome === 'refused' &&
          value.results.length === 0 &&
          value.effects.length === 0
          ? (errorOutput(outcome, 'json') ?? '')
          : withDiagnostics(outcome, renderExportJson(value));
      },
    },
    init: guarded<InitReport | null>(
      (value, outcome) =>
        value === null
          ? (errorOutput(outcome, 'human') ?? '')
          : withDiagnostics(outcome, renderInitHuman(value)),
      (value, outcome) =>
        value === null
          ? (errorOutput(outcome, 'json') ?? '')
          : withDiagnostics(outcome, renderInitJson(value as InitReport, currentWireCodecs.init)),
    ),
    plan: {
      human: (outcome) => {
        const value = report<PlanApplicationReport>(outcome).result;
        return value === null
          ? (errorOutput(outcome, 'human') ?? '')
          : withDiagnostics(outcome, renderPlanHuman(value));
      },
      json: (outcome) => {
        const value = report<PlanApplicationReport>(outcome).result;
        return value === null
          ? (errorOutput(outcome, 'json') ?? '')
          : renderPlanJson(value, currentWireCodecs.plan);
      },
    },
    install: lifecycleRenderer<NonNullable<InstallApplicationReport['value']>>(
      (value, outcome) =>
        renderInstallHuman(value, exitCodeForClass(outcome.exitClass), currentInstallStaticNotice),
      renderInstallJson,
      installStderr,
    ),
    uninstall: lifecycleRenderer<NonNullable<UninstallApplicationReport['value']>>(
      (value, outcome) => renderUninstallHuman(value, exitCodeForClass(outcome.exitClass)),
      renderUninstallJson,
      uninstallStderr,
    ),
    dev: lifecycleRenderer<NonNullable<DevApplicationReport['value']>>(
      (value, outcome) => renderFlipHuman(value, exitCodeForClass(outcome.exitClass)),
      (value) => renderFlipJson(value, currentWireCodecs.dev),
      renderFlipLifecycleStderr,
    ),
    promote: lifecycleRenderer<NonNullable<PromoteApplicationReport['value']>>(
      (value, outcome) => renderFlipHuman(value, exitCodeForClass(outcome.exitClass)),
      (value) => renderFlipJson(value, currentWireCodecs.promote),
      renderFlipLifecycleStderr,
    ),
  };
};
