import { basename, join } from 'node:path';
import { ok } from '../../result.ts';
import { extractVersionToken, modeVerdictFor, toolVerdictFor } from '../../verify/normalize.ts';
import { DEEP_TIMEOUT_MS, STATIC_TIMEOUT_MS, VERIFIED_AGAINST } from '../../verify/types.ts';
import type {
  ModeResult,
  ToolVerifier,
  ToolVerifyOptions,
  VerifyFinding,
  VerifyMode,
  VerifyPorts,
} from '../../verify/types.ts';
import { detect } from './detect.ts';

const MARKETPLACE_NAME = 'skillsmith-mkt';

const STATIC_COVERAGE_NOTICE: VerifyFinding = {
  checkId: 'codex.static-coverage',
  toolSeverity: null,
  normalizedSeverity: 'info',
  message: 'codex static checked the manifest only; run --deep for skill validation',
  file: null,
  subject: 'plugin',
};

/** Pure. Parses `codex plugin marketplace add` / `codex plugin add` output into findings. */
export const parseCodexInstallOutput = (stdout: string, stderr: string): VerifyFinding[] => {
  const lines = `${stdout}\n${stderr}`.split('\n');

  const marketplaceLine = lines.find((l) => l.includes('does not contain a supported manifest'));
  if (marketplaceLine !== undefined) {
    return [
      {
        checkId: 'codex.marketplace',
        toolSeverity: 'error',
        normalizedSeverity: 'error',
        message: marketplaceLine.trim(),
        file: null,
        subject: 'marketplace',
      },
    ];
  }

  const manifestLine = lines.find((l) => l.includes('failed to parse plugin.json'));
  if (manifestLine !== undefined) {
    const marker = 'failed to parse plugin.json: ';
    const idx = manifestLine.indexOf(marker);
    const message = idx >= 0 ? manifestLine.slice(idx + marker.length).trim() : manifestLine.trim();
    return [
      {
        checkId: 'codex.manifest',
        toolSeverity: 'error',
        normalizedSeverity: 'error',
        message,
        file: '.codex-plugin/plugin.json',
        subject: 'manifest',
        raw: manifestLine.trim(),
      },
    ];
  }

  return [];
};

const FAILED_TO_LOAD_RE = /failed to load skill (.+?): (.+)$/;
const STAGED_SKILLS_PREFIX = '.agents/skills/';

/**
 * Maps a staged skill path (relative to the throwaway deep-mode project, e.g.
 * `.agents/skills/<name>/SKILL.md`) back to the path the verified target actually has.
 * For a real plugin that's the plugin-relative `skills/<name>/SKILL.md`. For a wrapped
 * bare-skill target (a single synthesized `skills/<name>/` dir), the user never had a
 * `skills/` folder at all — collapse to the original bare `SKILL.md`.
 */
const mapStagedSkillPath = (file: string, targetKind: 'plugin' | 'skill'): string => {
  if (!file.startsWith(STAGED_SKILLS_PREFIX)) return file;
  const rest = file.slice(STAGED_SKILLS_PREFIX.length); // '<name>/SKILL.md'
  if (targetKind !== 'skill') return `skills/${rest}`;
  const slash = rest.indexOf('/');
  return slash >= 0 ? rest.slice(slash + 1) : `skills/${rest}`;
};

/** Pure. Extracts `failed to load skill` findings from codex exec stderr. projDir strips prefixes. */
export const parseCodexExecStderr = (
  stderr: string,
  projDir: string,
  targetKind: 'plugin' | 'skill' = 'plugin',
): VerifyFinding[] => {
  const findings: VerifyFinding[] = [];
  const prefix = projDir.endsWith('/') ? projDir : `${projDir}/`;

  for (const line of stderr.split('\n')) {
    const match = line.match(FAILED_TO_LOAD_RE);
    if (!match) continue;

    const [, rawFile, reason] = match;
    if (rawFile === undefined || reason === undefined) continue;

    const staged = rawFile.startsWith(prefix) ? rawFile.slice(prefix.length) : rawFile;

    findings.push({
      checkId: 'codex.skill-load',
      toolSeverity: 'error',
      normalizedSeverity: 'error',
      message: reason,
      file: mapStagedSkillPath(staged, targetKind),
      subject: 'skill',
      raw: line,
    });
  }

  return findings;
};

/** Manifest plugin name, or null on any read/parse failure. */
const readManifestName = async (env: VerifyPorts, manifestPath: string): Promise<string | null> => {
  try {
    const parsed: unknown = JSON.parse(await env.readText(manifestPath));
    const name = (parsed as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
};

const errorResult = (
  coverage: ModeResult['coverage'],
  command: string,
  skipReason: 'timeout' | 'exec-error',
): ModeResult => ({
  mode: 'static',
  status: 'error',
  skipReason,
  coverage,
  verdict: null,
  command,
  findings: [],
});

const runStaticMode = async (
  env: VerifyPorts,
  binary: string,
  opts: ToolVerifyOptions,
): Promise<ModeResult> => {
  const manifestPath = join(opts.path, '.codex-plugin', 'plugin.json');

  if (!(await env.fileExists(manifestPath))) {
    return {
      mode: 'static',
      status: 'ran',
      skipReason: null,
      coverage: { manifest: false, skills: false },
      verdict: 'pass',
      command: '(skipped: no .codex-plugin/plugin.json)',
      findings: [
        {
          checkId: 'codex.no-manifest',
          toolSeverity: null,
          normalizedSeverity: 'info',
          message: 'no .codex-plugin/plugin.json found; codex manifest check not applicable',
          file: null,
          subject: 'manifest',
        },
      ],
    };
  }

  const name = (await readManifestName(env, manifestPath)) ?? basename(opts.path);
  const coverage = { manifest: true, skills: false };
  const command = `codex plugin marketplace add <root> && codex plugin add ${name}@<mkt>`;

  const root = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('codex-root'));
  const home = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('codex-home'));
  try {
    await env.makeDir(join(root, '.agents', 'plugins'));
    await env.makeDir(home);
    await env.writeTextFile(
      join(root, '.agents', 'plugins', 'marketplace.json'),
      `${JSON.stringify(
        {
          name: MARKETPLACE_NAME,
          plugins: [{ name, source: { source: 'local', path: `./plugins/${name}` } }],
        },
        null,
        2,
      )}\n`,
    );
    await env.copyTree(opts.path, join(root, 'plugins', name));

    const execOpts = {
      env: { CODEX_HOME: home },
      timeoutMs: STATIC_TIMEOUT_MS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };

    const mktResult = await env.exec(binary, ['plugin', 'marketplace', 'add', root], execOpts);
    if (mktResult.timedOut) return errorResult(coverage, command, 'timeout');

    const mktFindings = parseCodexInstallOutput(mktResult.stdout, mktResult.stderr);
    if (mktFindings.length > 0) {
      return {
        mode: 'static',
        status: 'ran',
        skipReason: null,
        coverage,
        verdict: modeVerdictFor(mktFindings, opts.strict),
        command,
        findings: mktFindings,
      };
    }
    if (mktResult.code !== 0) return errorResult(coverage, command, 'exec-error');

    const addResult = await env.exec(
      binary,
      ['plugin', 'add', `${name}@${MARKETPLACE_NAME}`],
      execOpts,
    );
    if (addResult.timedOut) return errorResult(coverage, command, 'timeout');

    const addFindings = parseCodexInstallOutput(addResult.stdout, addResult.stderr);
    if (addFindings.length > 0) {
      const findings = [...addFindings, STATIC_COVERAGE_NOTICE];
      return {
        mode: 'static',
        status: 'ran',
        skipReason: null,
        coverage,
        verdict: modeVerdictFor(findings, opts.strict),
        command,
        findings,
      };
    }
    if (!`${addResult.stdout}\n${addResult.stderr}`.includes('Added plugin')) {
      return errorResult(coverage, command, 'exec-error');
    }

    const listResult = await env.exec(binary, ['plugin', 'list', '--json'], execOpts);
    if (listResult.timedOut) return errorResult(coverage, command, 'timeout');

    let parsedList: unknown;
    try {
      parsedList = JSON.parse(listResult.stdout);
    } catch {
      parsedList = null;
    }
    const installedList = (parsedList as { installed?: { name?: unknown }[] } | null)?.installed;
    const found = Array.isArray(installedList) && installedList.some((p) => p?.name === name);
    if (!found) return errorResult(coverage, command, 'exec-error');

    const findings = [STATIC_COVERAGE_NOTICE];
    return {
      mode: 'static',
      status: 'ran',
      skipReason: null,
      coverage,
      verdict: modeVerdictFor(findings, opts.strict),
      command,
      findings,
    };
  } finally {
    await env.removeTree(root);
    await env.removeTree(home);
  }
};

const DEEP_COVERAGE = { manifest: false, skills: true };
const DEEP_COMMAND =
  'codex exec -C <proj> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "ok"';

const deepErrorResult = (skipReason: 'timeout' | 'exec-error'): ModeResult => ({
  mode: 'deep',
  status: 'error',
  skipReason,
  coverage: DEEP_COVERAGE,
  verdict: null,
  command: DEEP_COMMAND,
  findings: [],
});

/** Copy each `<path>/skills/<n>/` (with SKILL.md) into `<proj>/.agents/skills/<n>/`. */
const stageSkills = async (env: VerifyPorts, path: string, proj: string): Promise<void> => {
  const skillsDir = join(path, 'skills');
  if (!(await env.fileExists(skillsDir))) return; // no skills dir ⇒ nothing to stage
  await env.makeDir(join(proj, '.agents', 'skills'));
  for (const n of await env.listDir(skillsDir)) {
    const src = join(skillsDir, n);
    if (!(await env.fileExists(join(src, 'SKILL.md')))) continue;
    await env.copyTree(src, join(proj, '.agents', 'skills', n));
  }
};

const runDeepMode = async (
  env: VerifyPorts,
  binary: string,
  opts: ToolVerifyOptions,
): Promise<ModeResult> => {
  const proj = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('codex-project'));
  const home = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('codex-home'));
  try {
    await env.makeDir(proj);
    await env.makeDir(home);
    await stageSkills(env, opts.path, proj);

    const result = await env.exec(
      binary,
      [
        'exec',
        '-C',
        proj,
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        'ok',
      ],
      {
        env: { CODEX_HOME: home },
        timeoutMs: DEEP_TIMEOUT_MS,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
    );

    if (result.timedOut) return deepErrorResult('timeout');

    // codex reports paths under the *canonicalized* project dir (e.g. macOS resolves
    // /var -> /private/var), which can differ from the mkdtemp()-returned logical path;
    // strip using the resolved form so the prefix actually matches.
    let realProj = proj;
    try {
      realProj = await env.realpath(proj);
    } catch {
      // keep the logical path; best-effort prefix strip in parseCodexExecStderr
    }

    const findings = parseCodexExecStderr(result.stderr, realProj, opts.kind ?? 'plugin');

    // The load phase runs before any auth/model call. It demonstrably ran when the session
    // exits clean, when a per-skill load failure was scraped, or when the isolated session
    // reached its expected unauthenticated 401 tail. A non-zero exit with none of that
    // evidence is an exec failure, never a pass.
    const loadPhaseRan =
      result.code === 0 || findings.length > 0 || result.stderr.includes('401 Unauthorized');
    if (!loadPhaseRan) return deepErrorResult('exec-error');

    return {
      mode: 'deep',
      status: 'ran',
      skipReason: null,
      coverage: DEEP_COVERAGE,
      verdict: modeVerdictFor(findings, opts.strict),
      command: DEEP_COMMAND,
      findings,
    };
  } finally {
    await env.removeTree(proj);
    await env.removeTree(home);
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

export const verifyCodex: ToolVerifier = async (env, opts) => {
  const detected = await detect(env, opts.signal);
  if (!detected.ok) return detected;

  const [record] = detected.value;
  if (record === undefined) {
    return ok({
      tool: 'codex',
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
  const versionDrift = toolVersion !== null && toolVersion !== VERIFIED_AGAINST.codex;

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
        checkId: 'codex.version-drift',
        toolSeverity: null,
        normalizedSeverity: 'info',
        message: `codex ${toolVersion} differs from verified ${VERIFIED_AGAINST.codex}; parsing may be less reliable`,
        file: null,
        subject: 'plugin',
      });
    }
  }

  return ok({
    tool: 'codex',
    available: true,
    toolVersion,
    versionDrift,
    skipReason: null,
    verdict: toolVerdictFor(modes),
    modes,
  });
};
