import type {
  InstallAction,
  InstallReport,
  InstallResult,
  UninstallAction,
  UninstallReport,
  UninstallResult,
} from '@skillsmith/core';
import { toolRegistry } from '@skillsmith/core';

// Column conventions measured against the mockups in `research/commands/install.md` /
// `uninstall.md`: a 2-space indent, a 9-wide label field ('verify   ', 'store    ',
// 'place    ', 'remove   '), and the action word right-aligned at column 66 from line start.
const LABEL_COL = 9;
const PLACE_COL = 66;
const NOTE_INDENT = ' '.repeat(2 + LABEL_COL);

const padLabel = (label: string): string => label.padEnd(LABEL_COL);
const padToCol = (label: string, col: number): string =>
  `${label}${' '.repeat(Math.max(2, col - label.length))}`;

/** `<ns>/<name>@<rev>` from a store path (`.../store/<ns>/<name>@<rev>/<skill>`). */
const storeLabel = (storePath: string): string => {
  const marker = '/store/';
  const idx = storePath.indexOf(marker);
  const after = idx >= 0 ? storePath.slice(idx + marker.length) : storePath;
  const segments = after.split('/');
  return segments.slice(0, -1).join('/') || after;
};

const placementLabel = (placement: 'symlink' | 'copy' | null): string =>
  placement === 'copy' ? 'store copy' : 'store symlink';

// ---------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------

const renderInstallToolBlock = (r: InstallResult): string[] => {
  const lines: string[] = [];
  const tool = r.tool ?? 'unknown';
  lines.push(`${tool.padEnd(12)} ${r.placementPath ?? '(no placement resolved)'}`);

  if (r.action === 'refused' || r.action === 'failed') {
    lines.push(`  ${r.action === 'failed' ? 'error' : 'refused'}  ${r.reason ?? r.action}`);
    return lines;
  }
  if (r.action === 'skipped') {
    lines.push(`  skipped  ${r.reason ?? 'fail-fast'}`);
    return lines;
  }

  if (r.verify) {
    const modeLabel = r.verify.mode ?? 'static';
    lines.push(`  ${padLabel('verify')}${modeLabel}: ${r.verify.verdict ?? r.verify.gate}`);
    const staticNotice =
      toolRegistry.get(tool)?.verification?.renderedFacts.installStaticNotice ?? null;
    if (r.verify.mode === 'static' && staticNotice !== null && r.skill !== null) {
      lines.push(`${NOTE_INDENT}note: ${staticNotice(r.skill)}`);
    }
  }

  if (r.store) {
    const tag = r.store.reused ? '(reused)' : '(new entry)';
    lines.push(`  ${padLabel('store')}${storeLabel(r.store.path)}  ${tag}`);
  }

  const placeLine = `  ${padLabel('place')}${placementLabel(r.placement)}`;
  lines.push(`${padToCol(placeLine, PLACE_COL)}${r.action}`);

  if (r.reason) lines.push(`${NOTE_INDENT}note: ${r.reason}`);

  return lines;
};

const INSTALL_BUCKET_LABEL: Record<InstallAction, string> = {
  installed: 'installed',
  updated: 'updated',
  repaired: 'repaired',
  noop: 'up to date',
  skipped: 'skipped',
  refused: 'refused',
  failed: 'failed',
};

/** Human-readable render of a `skillsmith.install` report (mockups in
 *  `research/commands/install.md`). Refusal/error detail blocks (ambiguity candidate lists,
 *  shadowing, legacy-root, local-path guidance) are written to stderr by the command action,
 *  not here — this renderer covers the per-source/per-tool report and the summary line. */
export const renderInstallHuman = (report: InstallReport, exitCode: number): string => {
  const lines: string[] = [];
  const bySource = new Map<string, InstallResult[]>();
  for (const r of report.results) {
    const list = bySource.get(r.source) ?? [];
    list.push(r);
    bySource.set(r.source, list);
  }

  for (const [source, results] of bySource) {
    const resolved = results.find((r) => r.skill !== null);
    const allNoop = results.length > 0 && results.every((r) => r.action === 'noop');
    const originResult = results.find((r) => r.origin !== null);

    if (allNoop && resolved) {
      const repoAtRev = originResult?.origin
        ? `${originResult.origin.repo}@${originResult.origin.refResolved.slice(0, 12)}`
        : source;
      lines.push(`${resolved.skill} is already installed at ${repoAtRev}`);
      for (const r of results) {
        lines.push(
          `  ${r.tool ?? 'unknown'}  ${r.placementPath ?? '(no placement resolved)'}   (${placementLabel(r.placement)})`,
        );
      }
      lines.push('Use --force to reinstall, or --ref <ref> to install a different revision.');
      lines.push('');
      continue;
    }

    if (resolved) {
      const header = originResult?.origin
        ? `Installing ${resolved.skill}  (${originResult.origin.repo} @ ${originResult.origin.refResolved.slice(0, 12)}, scope: ${resolved.scope})`
        : `Installing ${resolved.skill}  (scope: ${resolved.scope})`;
      lines.push(header);
      lines.push('');
      for (const r of results) {
        lines.push(...renderInstallToolBlock(r));
        lines.push('');
      }
      continue;
    }

    // Source-level failure: nothing ever resolved to a skill (parse/fetch/resolve failure).
    lines.push(`Installing ${source}`);
    for (const r of results) lines.push(`  ${r.action}  ${r.reason ?? r.action}`);
    lines.push('');
  }

  const buckets: InstallAction[] = [
    'installed',
    'updated',
    'repaired',
    'noop',
    'skipped',
    'refused',
    'failed',
  ];
  const parts = buckets
    .filter((b) => report.summary[b] > 0)
    .map((b) => `${report.summary[b]} ${INSTALL_BUCKET_LABEL[b]}`);
  const summaryLine = `${parts.length > 0 ? parts.join(', ') : 'nothing to do'}.  Exit code: ${exitCode}`;
  lines.push(summaryLine);

  return `${lines.join('\n')}\n`;
};

// ---------------------------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------------------------

const renderUninstallToolBlock = (r: UninstallResult): string[] => {
  const lines: string[] = [];
  const tool = r.tool ?? 'unknown';
  lines.push(`${tool.padEnd(12)} ${r.placementPath ?? '(no placement resolved)'}`);

  if (r.action === 'refused' || r.action === 'failed') {
    lines.push(`  ${r.action === 'failed' ? 'error' : 'refused'}  ${r.reason ?? r.action}`);
    return lines;
  }
  if (r.action === 'noop') {
    lines.push(`  ${r.reason ?? 'placement was already gone'}`);
    return lines;
  }

  const removeLine = `  ${padLabel('remove')}${placementLabel(r.before?.placement ?? null)}`;
  lines.push(`${padToCol(removeLine, PLACE_COL)}removed`);
  if (r.storeRetained) lines.push(`${NOTE_INDENT}store entry retained: ${r.storeRetained}`);
  if (r.backupKept) lines.push(`${NOTE_INDENT}backup kept: ${r.backupKept}`);
  if (r.reason) lines.push(`${NOTE_INDENT}note: ${r.reason}`);

  return lines;
};

const UNINSTALL_BUCKET_LABEL: Record<UninstallAction, string> = {
  removed: 'removed',
  noop: 'not installed',
  refused: 'refused',
  failed: 'failed',
};

/** Human-readable render of a `skillsmith.uninstall` report (mockups in
 *  `research/commands/uninstall.md`). Same stderr/stdout split as `renderInstallHuman`. */
export const renderUninstallHuman = (report: UninstallReport, exitCode: number): string => {
  const lines: string[] = [];
  const bySkill = new Map<string, UninstallResult[]>();
  for (const r of report.results) {
    const list = bySkill.get(r.skill) ?? [];
    list.push(r);
    bySkill.set(r.skill, list);
  }

  for (const [, results] of bySkill) {
    const resolved = results.filter((r) => r.tool !== null);

    // A U2 ambiguity refusal or a not-installed-anywhere noop: no per-tool block to show, just
    // the aggregate reason (candidate-scope list / not-installed notice come straight from core).
    if (resolved.length === 0) {
      for (const r of results) lines.push(r.reason ?? r.action);
      lines.push('');
      continue;
    }

    const scope = resolved[0]?.scope ?? 'user';
    lines.push(`Removing ${resolved[0]?.skill}  (scope: ${scope})`);
    lines.push('');
    for (const r of resolved) lines.push(...renderUninstallToolBlock(r));
    lines.push('');
  }

  const buckets: UninstallAction[] = ['removed', 'noop', 'refused', 'failed'];
  const parts = buckets
    .filter((b) => report.summary[b] > 0)
    .map((b) => `${report.summary[b]} ${UNINSTALL_BUCKET_LABEL[b]}`);
  const summaryLine = `${parts.length > 0 ? parts.join(', ') : 'nothing to do'}.  Exit code: ${exitCode}`;
  lines.push(summaryLine);

  return `${lines.join('\n')}\n`;
};
