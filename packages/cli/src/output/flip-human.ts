import type { FlipAction, FlipReport, FlipResult } from '@skillsmith/core';

const SWAP_COL = 60;

const padSwap = (label: string): string => {
  const pad = Math.max(2, SWAP_COL - label.length);
  return `${label}${' '.repeat(pad)}`;
};

/** `<ns>/<name>@<rev>` from a store path (`.../store/<ns>/<name>@<rev>/<skill>`). */
const storeLabel = (storePath: string): string => {
  const marker = '/store/';
  const idx = storePath.indexOf(marker);
  const after = idx >= 0 ? storePath.slice(idx + marker.length) : storePath;
  const segments = after.split('/');
  return segments.slice(0, -1).join('/') || after;
};

const headerFor = (op: FlipReport['op'], skill: string, tools: string[]): string => {
  const toolsStr = tools.join(', ');
  if (op === 'dev') return `Flipping ${skill} to dev mode  (tools: ${toolsStr})`;
  if (op === 'rollback') return `Rolling back ${skill}  (tools: ${toolsStr})`;
  return `Promoting ${skill}  (tools: ${toolsStr})`;
};

const renderPair = (op: FlipReport['op'], r: FlipResult): string[] => {
  const lines: string[] = [];
  const tool = r.tool ?? 'unknown';
  lines.push(`${tool.padEnd(12)} ${r.placementPath ?? '(no placement resolved)'}`);

  if (r.action === 'refused' || r.action === 'failed') {
    lines.push(`  ${r.action === 'failed' ? 'error' : 'refused'}  ${r.reason ?? r.action}`);
    return lines;
  }

  if (r.before?.mode === 'dev' && op === 'promote' && r.reason) {
    lines.push(`  note     ${r.reason}`);
  }

  if (r.verify) {
    // BF-7b: render the ACTUAL gate mode. `dev --source` create/adopt always gates STATIC (PRD D2),
    // even for codex — only promote runs codex deep. Labeling create/adopt "deep" was a lie.
    const modeLabel = tool === 'codex' && op === 'promote' ? 'deep' : 'static';
    lines.push(`  verify   ${modeLabel}: ${r.verify.verdict ?? r.verify.gate}`);
  }

  if (r.store) {
    const tag = r.store.reused ? '(reused)' : '(new store entry)';
    lines.push(`  snapshot ${storeLabel(r.store.path)}  ${tag}`);
  }

  const isCreateAdopt = r.action === 'created' || r.action === 'adopted';
  if (op === 'dev' && r.action !== 'noop' && r.after?.symlinkTarget) {
    // A dev-CREATED/adopted placement's source is the --source the user gave, not something
    // "recorded at promote" (a fresh create has never been promoted).
    const provenance = isCreateAdopt ? '(dev source)' : '(recorded at promote)';
    lines.push(`  source   ${r.after.symlinkTarget}  ${provenance}`);
  }

  const swapLabel =
    op === 'dev'
      ? r.action === 'created'
        ? 'new dev symlink'
        : r.action === 'adopted'
          ? 'adopt dev symlink (record only)'
          : 'pinned copy -> dev symlink'
      : op === 'rollback'
        ? 'restoring prior state'
        : 'dev symlink -> pinned copy';
  lines.push(`  swap     ${padSwap(swapLabel)}${r.action}`);

  if (op === 'dev' && r.store) {
    lines.push(`           pin retained: ${storeLabel(r.store.path)}`);
  }
  if (op !== 'promote' && r.reason) {
    lines.push(`  note     ${r.reason}`);
  }

  return lines;
};

const ACTION_LABEL: Record<FlipAction, string> = {
  flipped: 'flipped',
  updated: 'updated',
  noop: 'noop',
  skipped: 'skipped',
  refused: 'refused',
  failed: 'failed',
  'rolled-back': 'rolled back',
  created: 'created',
  adopted: 'adopted',
};

/** Human-readable render of a `skillsmith.flip` report (mockups in `research/commands/{promote,dev}.md`). */
export const renderFlipHuman = (report: FlipReport, exitCode: number): string => {
  const lines: string[] = [];
  const bySkill = new Map<string, FlipResult[]>();
  for (const r of report.results) {
    const list = bySkill.get(r.skill) ?? [];
    list.push(r);
    bySkill.set(r.skill, list);
  }

  for (const [skill, results] of bySkill) {
    const tools = [...new Set(results.map((r) => r.tool ?? 'unknown'))];
    lines.push(headerFor(report.op, skill, tools));
    lines.push('');
    for (const r of results) {
      lines.push(...renderPair(report.op, r));
      lines.push('');
    }
  }

  const counts: [FlipAction, number][] = [
    ['created', report.summary.created],
    ['adopted', report.summary.adopted],
    ['flipped', report.summary.flipped],
    ['updated', report.summary.updated],
    ['noop', report.summary.noop],
    ['skipped', report.summary.skipped],
    ['refused', report.summary.refused],
    ['failed', report.summary.failed],
    ['rolled-back', report.summary.rolledBack],
  ];
  const warnings = report.results.filter(
    (r) =>
      (r.action === 'flipped' ||
        r.action === 'updated' ||
        r.action === 'rolled-back' ||
        r.action === 'created' ||
        r.action === 'adopted') &&
      r.reason,
  ).length;

  const parts = counts
    .filter(([, n]) => n > 0)
    .map(([action, n]) => `${n} ${ACTION_LABEL[action]}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  const summaryLine = `${parts.length > 0 ? parts.join(', ') : 'nothing to do'}.  Exit code: ${exitCode}`;
  lines.push(summaryLine);

  return `${lines.join('\n')}\n`;
};
