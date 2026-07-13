import { join } from 'node:path';
import { ok } from '../../result.ts';
import { DEEP_TIMEOUT_MS, STATIC_TIMEOUT_MS } from '../../verify/constants.ts';
import { extractVersionToken, modeVerdictFor, toolVerdictFor } from '../../verify/normalize.ts';
import type {
  ModeResult,
  ToolVerifier,
  ToolVerifyOptions,
  VerifyFinding,
  VerifyMode,
  VerifyPorts,
} from '../../verify/types.ts';
import { CLAUDE_CODE_VERIFIED_AGAINST } from './descriptor.ts';
import { detect } from './detect.ts';

// Real `claude plugin validate` output puts the marker alone on a summary line
// ("✘ Found N error(s):" / "⚠ Found N warning(s):"); the check/message that marker covers
// follows on a separate, indented continuation line ("  ❯ <checkId>: <message>"). The subject
// and file come from whichever "Validating skill: <path>" / "Validating plugin manifest: <path>"
// header line preceded the block.
const VALIDATING_SKILL_RE = /^Validating skill:\s*(.+)$/;
const VALIDATING_MANIFEST_RE = /^Validating plugin manifest:\s*(.+)$/;
const SUMMARY_RE = /^[✘⚠]\s*Found\s+\d+\s+(?:error|warning)s?:/;
const FINDING_RE = /^\s*❯\s*([^\s:]+):\s*(.*)$/;

/** Pure. Parses `claude plugin validate` output into findings. targetPath strips file prefixes. */
export const parseClaudeValidateOutput = (output: string, targetPath: string): VerifyFinding[] => {
  const findings: VerifyFinding[] = [];
  const prefix = targetPath.endsWith('/') ? targetPath : `${targetPath}/`;

  let currentFile: string | null = null;
  let currentSubject: 'skill' | 'manifest' = 'skill';
  let pendingSeverity: 'error' | 'warning' | null = null;

  const setCurrentFile = (rawFile: string | undefined): void => {
    if (rawFile === undefined) return;
    const file = rawFile.trim();
    currentFile = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  };

  for (const line of output.split('\n')) {
    const skillHeader = line.match(VALIDATING_SKILL_RE);
    if (skillHeader) {
      setCurrentFile(skillHeader[1]);
      currentSubject = 'skill';
      pendingSeverity = null;
      continue;
    }

    const manifestHeader = line.match(VALIDATING_MANIFEST_RE);
    if (manifestHeader) {
      setCurrentFile(manifestHeader[1]);
      currentSubject = 'manifest';
      pendingSeverity = null;
      continue;
    }

    if (SUMMARY_RE.test(line)) {
      pendingSeverity = line.trimStart().startsWith('✘') ? 'error' : 'warning';
      continue;
    }

    if (pendingSeverity === null) continue; // e.g. the bare "✘ Validation failed" summary line

    const finding = line.match(FINDING_RE);
    if (!finding) continue;

    const [, check, message] = finding;
    if (check === undefined || message === undefined) continue;

    findings.push({
      checkId: `claude.${check}`,
      toolSeverity: pendingSeverity,
      normalizedSeverity: pendingSeverity,
      message,
      file: currentFile,
      subject: currentSubject,
      raw: line.trim(),
    });
  }

  return findings;
};

const runStaticMode = async (
  env: VerifyPorts,
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

interface ClaudeInitEvent {
  type?: unknown;
  subtype?: unknown;
  plugins?: { name: string }[];
  skills?: string[];
}

/** Pure. First stream-json line with type==='system' && subtype==='init', or null if absent. */
export const parseClaudeInit = (stdout: string): { plugins: string[]; skills: string[] } | null => {
  for (const line of stdout.split('\n')) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // non-JSON junk line (stderr leakage, blank lines) — skip
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const event = obj as ClaudeInitEvent;
    if (event.type === 'system' && event.subtype === 'init') {
      return {
        plugins: (event.plugins ?? []).map((p) => p.name),
        skills: event.skills ?? [],
      };
    }
  }
  return null;
};

/** Subdirectories `n` of `<path>/skills/` where `<path>/skills/<n>/SKILL.md` exists. */
const getExpectedSkills = async (env: VerifyPorts, path: string): Promise<string[]> => {
  const skillsDir = join(path, 'skills');
  if (!(await env.fileExists(skillsDir))) return [];
  const entries = await env.listDir(skillsDir);
  const present: string[] = [];
  for (const n of entries) {
    if (await env.fileExists(join(skillsDir, n, 'SKILL.md'))) present.push(n);
  }
  return present;
};

/** Manifest plugin name, or null on any read/parse failure. */
const readPluginName = async (env: VerifyPorts, path: string): Promise<string | null> => {
  try {
    const parsed: unknown = JSON.parse(
      await env.readText(join(path, '.claude-plugin', 'plugin.json')),
    );
    const name = (parsed as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
};

const runDeepMode = async (
  env: VerifyPorts,
  binary: string,
  opts: ToolVerifyOptions,
): Promise<ModeResult> => {
  const coverage = { manifest: false, skills: true };
  const command = `CLAUDE_CONFIG_DIR=<tmp> claude --print --verbose --output-format stream-json --setting-sources "" --plugin-dir ${opts.path} "ok"`;

  const cfg = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('claude-config'));
  await env.makeDir(cfg);
  try {
    const result = await env.exec(
      binary,
      [
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--setting-sources',
        '',
        '--plugin-dir',
        opts.path,
        'ok',
      ],
      {
        env: { CLAUDE_CONFIG_DIR: cfg },
        timeoutMs: DEEP_TIMEOUT_MS,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
    );

    const init = parseClaudeInit(result.stdout);

    // Init received is the success signal: the authentication_failed tail + exit 1 is the
    // expected healthy ending of an isolated session and must not read as a failure.
    if (init === null) {
      return {
        mode: 'deep',
        status: 'error',
        skipReason: result.timedOut ? 'timeout' : 'exec-error',
        coverage,
        verdict: null,
        command,
        findings: [],
      };
    }

    const expected = await getExpectedSkills(env, opts.path);
    const pluginName = await readPluginName(env, opts.path);
    const loaded = new Set(init.skills);

    const findings: VerifyFinding[] = [];
    for (const n of expected) {
      if (loaded.has(`${pluginName}:${n}`)) continue;
      findings.push({
        checkId: 'claude.load-presence',
        toolSeverity: null,
        normalizedSeverity: 'warning',
        message: `skill '${n}' did not load (reason unavailable at runtime — see static validate)`,
        file: `skills/${n}/SKILL.md`,
        subject: 'skill',
      });
    }

    return {
      mode: 'deep',
      status: 'ran',
      skipReason: null,
      coverage,
      verdict: modeVerdictFor(findings, opts.strict),
      command,
      findings,
    };
  } finally {
    await env.removeTree(cfg);
  }
};

type ModeRunner = (
  env: VerifyPorts,
  binary: string,
  opts: ToolVerifyOptions,
) => Promise<ModeResult>;

const MODE_RUNNERS: Partial<Record<VerifyMode, ModeRunner>> = {
  static: runStaticMode,
  deep: runDeepMode,
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
  const versionDrift = toolVersion !== null && toolVersion !== CLAUDE_CODE_VERIFIED_AGAINST;

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
        message: `claude ${toolVersion} differs from verified ${CLAUDE_CODE_VERIFIED_AGAINST}; parsing may be less reliable`,
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
