import type { ScanEnv } from '../../env/types.ts';
import { ok } from '../../result.ts';
import { extractVersionToken, modeVerdictFor, toolVerdictFor } from '../../verify/normalize.ts';
import { STATIC_TIMEOUT_MS, VERIFIED_AGAINST } from '../../verify/types.ts';
import type {
  ModeResult,
  ToolVerifier,
  ToolVerifyOptions,
  VerifyFinding,
  VerifyMode,
} from '../../verify/types.ts';
import { detect } from './detect.ts';

const MARKER_RE = /([✘⚠])\s*([^\s:]+):\s*(.*)/;
const VALIDATING_RE = /^Validating skill:\s*(.+)$/;

/** Pure. Parses `claude plugin validate` output into findings. targetPath strips file prefixes. */
export const parseClaudeValidateOutput = (output: string, targetPath: string): VerifyFinding[] => {
  const findings: VerifyFinding[] = [];
  let currentFile: string | null = null;
  const prefix = targetPath.endsWith('/') ? targetPath : `${targetPath}/`;

  for (const line of output.split('\n')) {
    if (/^\s/.test(line)) continue; // indented continuation line, ignored

    const validating = line.match(VALIDATING_RE);
    if (validating) {
      const rawFile = validating[1];
      if (rawFile !== undefined) {
        const file = rawFile.trim();
        currentFile = file.startsWith(prefix) ? file.slice(prefix.length) : file;
      }
      continue;
    }

    const marker = line.match(MARKER_RE);
    if (!marker) continue; // e.g. the bare "✘ Validation failed" summary line

    const [, markerChar, check, message] = marker;
    if (markerChar === undefined || check === undefined || message === undefined) continue;

    const toolSeverity: 'error' | 'warning' = markerChar === '✘' ? 'error' : 'warning';
    const isManifest = check === 'json' || check === 'name';

    findings.push({
      checkId: `claude.${check}`,
      toolSeverity,
      normalizedSeverity: toolSeverity,
      message,
      file: isManifest ? '.claude-plugin/plugin.json' : currentFile,
      subject: isManifest ? 'manifest' : 'skill',
      raw: line,
    });
  }

  return findings;
};

const runStaticMode = async (
  env: ScanEnv,
  binary: string,
  opts: ToolVerifyOptions,
): Promise<ModeResult> => {
  const args = ['plugin', 'validate', opts.path, ...(opts.strict ? ['--strict'] : [])];
  const command = `claude plugin validate ${opts.path}${opts.strict ? ' --strict' : ''}`;
  const coverage = { manifest: true, skills: true };

  const result = await env.exec(binary, args, {
    timeoutMs: STATIC_TIMEOUT_MS,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  if (result.timedOut) {
    return {
      mode: 'static',
      status: 'error',
      skipReason: 'timeout',
      coverage,
      verdict: null,
      command,
      findings: [],
    };
  }

  const findings = parseClaudeValidateOutput(`${result.stdout}\n${result.stderr}`, opts.path);

  if (findings.length === 0 && result.code !== 0) {
    return {
      mode: 'static',
      status: 'error',
      skipReason: 'exec-error',
      coverage,
      verdict: null,
      command,
      findings: [],
    };
  }

  return {
    mode: 'static',
    status: 'ran',
    skipReason: null,
    coverage,
    verdict: modeVerdictFor(findings, opts.strict),
    command,
    findings,
  };
};

type ModeRunner = (env: ScanEnv, binary: string, opts: ToolVerifyOptions) => Promise<ModeResult>;

// 'deep' is added by the next task; a requested 'deep' mode simply produces no ModeResult yet.
const MODE_RUNNERS: Partial<Record<VerifyMode, ModeRunner>> = {
  static: runStaticMode,
};

export const verifyClaudeCode: ToolVerifier = async (env, opts) => {
  const detected = await detect(env, opts.signal);
  if (!detected.ok) return detected;

  const [record] = detected.value;
  if (record === undefined) {
    return ok({
      tool: 'claude-code',
      available: false,
      toolVersion: null,
      versionDrift: false,
      skipReason: 'not-installed',
      verdict: 'inconclusive',
      modes: [],
    });
  }

  const binary = record.path;
  const toolVersion = extractVersionToken(record.version);
  const versionDrift = toolVersion !== null && toolVersion !== VERIFIED_AGAINST['claude-code'];

  const modes: ModeResult[] = [];
  for (const mode of opts.modes) {
    const runner = MODE_RUNNERS[mode];
    if (!runner) continue;
    modes.push(await runner(env, binary, opts));
  }

  if (versionDrift) {
    const firstRan = modes.find((m) => m.status === 'ran');
    if (firstRan) {
      firstRan.findings.push({
        checkId: 'claude.version-drift',
        toolSeverity: null,
        normalizedSeverity: 'info',
        message: `claude ${toolVersion} differs from verified ${VERIFIED_AGAINST['claude-code']}; parsing may be less reliable`,
        file: null,
        subject: 'plugin',
      });
    }
  }

  return ok({
    tool: 'claude-code',
    available: true,
    toolVersion,
    versionDrift,
    skipReason: null,
    verdict: toolVerdictFor(modes),
    modes,
  });
};
