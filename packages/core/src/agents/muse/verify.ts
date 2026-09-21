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
import { MUSE_VERIFIED_AGAINST } from './descriptor.ts';
import { detect } from './detect.ts';

// Target manifests describe plugin-shaped targets only. Muse ships no
// user-installable plugin format in 1.3.0 (`muse plugins` is unavailable),
// so verification validates skill directories instead; the manifest name is
// descriptive metadata that must never collide with a skill file.
export const MUSE_TARGET_MANIFEST = '.muse-plugin/plugin.json';

/** Every muse invocation runs offline: no self-update check, no shared state. */
const isolatedEnv = (home: string): Record<string, string> => ({
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  MUSE_NO_AUTO_UPDATE: '1',
});

const sanitizeDiagnostic = (value: string, privatePaths: readonly string[]): string => {
  let text = value;
  for (const path of privatePaths) {
    if (path.length > 0) text = text.replaceAll(path, '<tmp>');
  }
  return Array.from(text, (character) => (character.charCodeAt(0) < 32 ? ' ' : character))
    .join('')
    .slice(0, 2048);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const fileLabel = (name: string, kind: 'plugin' | 'skill'): string =>
  kind === 'skill' ? 'SKILL.md' : `skills/${name}/SKILL.md`;

const errorResult = (
  mode: VerifyMode,
  coverage: ModeResult['coverage'],
  command: string,
  skipReason: 'timeout' | 'exec-error',
): ModeResult => ({
  mode,
  status: 'error',
  skipReason,
  coverage,
  verdict: null,
  command,
  findings: [],
});

type ValidateParse = { findings: VerifyFinding[] } | { execError: true };

/**
 * Pure. Parses one `muse skills validate <dir> --json` document. Success
 * carries `valid: true` plus advisory diagnostics; every failure mode uses
 * the `{"error": {code, message}}` envelope on stdout (mirrored on stderr).
 */
export const parseMuseValidateOutput = (stdout: string, file: string): ValidateParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { execError: true };
  }
  if (!isRecord(parsed)) return { execError: true };
  if (isRecord(parsed.error)) {
    const code = typeof parsed.error.code === 'string' ? parsed.error.code : 'unknown-error';
    const message =
      typeof parsed.error.message === 'string'
        ? parsed.error.message
        : 'muse skill validation failed';
    return {
      findings: [
        {
          checkId: `muse.${code}`,
          toolSeverity: code,
          normalizedSeverity: 'error',
          message,
          file,
          subject: 'skill',
        },
      ],
    };
  }
  if (parsed.valid !== true) {
    if (parsed.valid !== false) return { execError: true };
    return {
      findings: [
        {
          checkId: 'muse.invalid',
          toolSeverity: null,
          normalizedSeverity: 'error',
          message: 'muse skill validation failed',
          file,
          subject: 'skill',
        },
        ...validateDiagnostics(parsed.diagnostics, file),
      ],
    };
  }
  const findings = validateDiagnostics(parsed.diagnostics, file);
  if (isRecord(parsed.compatibility)) {
    const unknownFields = stringList(parsed.compatibility.unknown_fields);
    if (unknownFields.length > 0) {
      findings.push({
        checkId: 'muse.unknown-fields',
        toolSeverity: null,
        normalizedSeverity: 'info',
        message: `unknown frontmatter fields (tolerated by muse): ${unknownFields.join(', ')}`,
        file,
        subject: 'skill',
      });
    }
    const unsupportedFields = stringList(parsed.compatibility.unsupported_fields);
    if (unsupportedFields.length > 0) {
      findings.push({
        checkId: 'muse.unsupported-fields',
        toolSeverity: null,
        normalizedSeverity: 'warning',
        message: `unsupported frontmatter fields: ${unsupportedFields.join(', ')}`,
        file,
        subject: 'skill',
      });
    }
  }
  return { findings };
};

const validateDiagnostics = (value: unknown, file: string): VerifyFinding[] => {
  if (!Array.isArray(value)) return [];
  const findings: VerifyFinding[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const code = typeof entry.code === 'string' ? entry.code : 'diagnostic';
    const severity = typeof entry.severity === 'string' ? entry.severity : 'info';
    findings.push({
      checkId: `muse.${code}`,
      toolSeverity: code,
      normalizedSeverity:
        severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info',
      message:
        typeof entry.message === 'string' ? entry.message : `muse reported a ${code} diagnostic`,
      file,
      subject: 'skill',
      raw: JSON.stringify(entry),
    });
  }
  return findings;
};

const enumerateSkills = async (env: VerifyPorts, path: string): Promise<string[]> => {
  const skillsDir = join(path, 'skills');
  if (!(await env.fileExists(skillsDir))) return [];
  const names: string[] = [];
  for (const name of await env.listDir(skillsDir)) {
    if (name.startsWith('.')) continue;
    if (!(await env.fileExists(join(skillsDir, name, 'SKILL.md')))) continue;
    names.push(name);
  }
  return names.sort();
};

const runStaticMode = async (
  env: VerifyPorts,
  binary: string,
  opts: ToolVerifyOptions,
): Promise<ModeResult> => {
  const names = await enumerateSkills(env, opts.path);
  const coverage = { manifest: false, skills: true };
  if (names.length === 0) {
    return {
      mode: 'static',
      status: 'ran',
      skipReason: null,
      coverage: { manifest: false, skills: false },
      verdict: 'pass',
      command: '(skipped: no skills to validate)',
      findings: [
        {
          checkId: 'muse.no-skills',
          toolSeverity: null,
          normalizedSeverity: 'info',
          message: 'no skills found; muse skill validation not applicable',
          file: null,
          subject: 'skill',
        },
      ],
    };
  }
  const command = `muse skills validate ${names.length} skill dir(s) --json`;
  const home = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('muse-home'));
  const findings: VerifyFinding[] = [];
  try {
    await env.makeDir(home);
    const kind = opts.kind ?? 'plugin';
    for (const name of names) {
      const skillDir = join(opts.path, 'skills', name);
      const file = fileLabel(name, kind);
      const result = await env.exec(binary, ['skills', 'validate', skillDir, '--json'], {
        env: isolatedEnv(home),
        timeoutMs: STATIC_TIMEOUT_MS,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (result.timedOut) return errorResult('static', coverage, command, 'timeout');
      opts.signal?.throwIfAborted();
      const parsed = parseMuseValidateOutput(result.stdout, file);
      if ('execError' in parsed) return errorResult('static', coverage, command, 'exec-error');
      findings.push(...parsed.findings);
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
  } finally {
    await env.removeTree(home);
  }
};

const DEEP_COMMAND =
  'muse skills list --source user --json && muse skills list --source project --workspace <proj> --trust-workspace --json';

const deepErrorResult = (
  skipReason: 'timeout' | 'exec-error',
  message: string,
  findings: VerifyFinding[] = [],
): ModeResult => ({
  mode: 'deep',
  status: 'error',
  skipReason,
  coverage: { manifest: false, skills: false },
  verdict: null,
  command: DEEP_COMMAND,
  findings: [
    ...findings,
    {
      checkId: 'muse.deep-probe',
      toolSeverity: null,
      normalizedSeverity: 'info',
      message,
      file: null,
      subject: 'plugin',
    },
  ],
});

export interface ExpectedMuseSkill {
  doc: string;
  rel: string;
  file: string;
}

interface ListSkillEntry {
  path: string;
  scope: string;
  activation: string;
}

const isListSkill = (entry: unknown): entry is ListSkillEntry =>
  isRecord(entry) &&
  typeof entry.path === 'string' &&
  typeof entry.scope === 'string' &&
  typeof entry.activation === 'string';

interface ListDiagnosticEntry {
  code: string;
  message: string;
  path: string;
  scope: string;
}

const isListDiagnostic = (entry: unknown): entry is ListDiagnosticEntry =>
  isRecord(entry) &&
  typeof entry.code === 'string' &&
  typeof entry.message === 'string' &&
  typeof entry.path === 'string' &&
  typeof entry.scope === 'string';

const expandListPath = (path: string, home: string): string =>
  path
    .replaceAll('$CONFIG_DIR', join(home, '.config', 'muse'))
    .replaceAll('$HOME', home)
    .replaceAll('\\', '/');

type ListParse = { findings: VerifyFinding[]; complete: boolean } | { error: string };

/**
 * Pure. Matches one `muse skills list --json` document against staged skills by
 * (scope, document) and joins loader diagnostics by path: two staged skills may
 * share one frontmatter id, but their documents are distinct.
 */
export const analyzeMuseList = (
  stdout: string,
  expected: readonly ExpectedMuseSkill[],
  loader: { scope: 'user' | 'project'; home: string; privatePaths: readonly string[] },
): ListParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { error: 'malformed skills list JSON' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.skills)) {
    return { error: 'missing skills list entries' };
  }
  const skills = parsed.skills.filter(isListSkill);
  if (skills.length !== parsed.skills.length) {
    return { error: 'invalid skills list entries' };
  }
  const rawDiagnostics = Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [];
  const diagnostics = rawDiagnostics.filter(isListDiagnostic);
  if (diagnostics.length !== rawDiagnostics.length) {
    return { error: 'invalid skills list diagnostics' };
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === 'project-skills-untrusted')) {
    return { error: 'project skills reported untrusted despite --trust-workspace' };
  }
  const matchesDoc = (
    loaderPath: string,
    loaderScope: string,
    target: ExpectedMuseSkill,
  ): boolean => {
    if (loaderScope !== loader.scope) return false;
    if (loader.scope === 'project') return loaderPath.replaceAll('\\', '/') === target.rel;
    return expandListPath(loaderPath, loader.home) === target.doc;
  };
  const findings: VerifyFinding[] = [];
  let complete = true;
  for (const target of expected) {
    const failures = diagnostics.filter((diagnostic) =>
      matchesDoc(diagnostic.path, diagnostic.scope, target),
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        findings.push({
          checkId: `muse.${failure.code}`,
          toolSeverity: failure.code,
          normalizedSeverity: 'error',
          message: sanitizeDiagnostic(failure.message, loader.privatePaths),
          file: target.file,
          subject: 'skill',
          raw: sanitizeDiagnostic(JSON.stringify(failure), loader.privatePaths),
        });
      }
      continue;
    }
    const matches = skills.filter((skill) => matchesDoc(skill.path, skill.scope, target));
    if (matches.length === 1 && matches[0]?.activation !== 'off') continue;
    complete = false;
    findings.push({
      checkId: 'muse.skill-presence',
      toolSeverity: null,
      normalizedSeverity: 'warning',
      message:
        matches.length === 1
          ? 'expected skill was returned disabled'
          : matches.length === 0
            ? 'expected skill was not returned by the loader'
            : 'loader returned ambiguous target entries',
      file: target.file,
      subject: 'skill',
    });
  }
  return { findings, complete };
};

const stageSkills = async (
  env: VerifyPorts,
  path: string,
  proj: string,
  home: string,
): Promise<string[]> => {
  const names = await enumerateSkills(env, path);
  if (names.length === 0) return names;
  await env.makeDir(join(proj, '.agents', 'skills'));
  await env.makeDir(join(home, '.config', 'muse', 'skills'));
  for (const name of names) {
    const src = join(path, 'skills', name);
    await env.copyTree(src, join(proj, '.agents', 'skills', name));
    await env.copyTree(src, join(home, '.config', 'muse', 'skills', name));
  }
  return names;
};

const runDeepMode = async (
  env: VerifyPorts,
  binary: string,
  opts: ToolVerifyOptions,
): Promise<ModeResult> => {
  const proj = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('muse-project'));
  const home = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('muse-home'));
  const privatePaths = [proj, home];
  try {
    await env.makeDir(proj);
    await env.makeDir(home);
    const kind = opts.kind ?? 'plugin';
    const names = await stageSkills(env, opts.path, proj, home);
    const expected: ExpectedMuseSkill[] = names.map((name) => ({
      doc: join(home, '.config', 'muse', 'skills', name, 'SKILL.md').replaceAll('\\', '/'),
      rel: `.agents/skills/${name}/SKILL.md`,
      file: fileLabel(name, kind),
    }));
    const execOpts = {
      cwd: proj,
      env: isolatedEnv(home),
      timeoutMs: DEEP_TIMEOUT_MS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };
    const userResult = await env.exec(
      binary,
      ['skills', 'list', '--source', 'user', '--json'],
      execOpts,
    );
    const projectResult = await env.exec(
      binary,
      ['skills', 'list', '--source', 'project', '--workspace', proj, '--trust-workspace', '--json'],
      execOpts,
    );
    opts.signal?.throwIfAborted();
    const userAnalyzed = analyzeMuseList(userResult.stdout, expected, {
      scope: 'user',
      home,
      privatePaths,
    });
    const projectAnalyzed = analyzeMuseList(projectResult.stdout, expected, {
      scope: 'project',
      home,
      privatePaths,
    });
    const executionFailed =
      userResult.timedOut ||
      projectResult.timedOut ||
      userResult.code !== 0 ||
      projectResult.code !== 0;
    if (executionFailed) {
      const diagnostic = deepErrorResult(
        userResult.timedOut || projectResult.timedOut ? 'timeout' : 'exec-error',
        sanitizeDiagnostic(
          `executable=${binary}; phase=local-loader; userExit=${userResult.code}; projectExit=${projectResult.code}; timeout=${userResult.timedOut || projectResult.timedOut}; userStderr: ${userResult.stderr}; projectStderr: ${projectResult.stderr}`,
          privatePaths,
        ),
      );
      // A validated exact-target rejection remains a failure even if a loader
      // leg misbehaves. A successful-looking transcript still cannot establish
      // pass after execution failure.
      const errorFindings = [userAnalyzed, projectAnalyzed].flatMap((analyzed) =>
        'error' in analyzed
          ? []
          : analyzed.findings.filter((finding) => finding.normalizedSeverity === 'error'),
      );
      if (errorFindings.length > 0) {
        const complete =
          !('error' in userAnalyzed) &&
          !('error' in projectAnalyzed) &&
          userAnalyzed.complete &&
          projectAnalyzed.complete;
        return {
          mode: 'deep',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: false, skills: complete },
          verdict: 'fail',
          command: DEEP_COMMAND,
          findings: [...errorFindings, ...diagnostic.findings],
        };
      }
      return diagnostic;
    }
    if ('error' in userAnalyzed) return deepErrorResult('exec-error', userAnalyzed.error);
    if ('error' in projectAnalyzed) return deepErrorResult('exec-error', projectAnalyzed.error);
    const findings = [...userAnalyzed.findings, ...projectAnalyzed.findings];
    const complete = userAnalyzed.complete && projectAnalyzed.complete;
    const hasFailure = findings.some((finding) => finding.normalizedSeverity === 'error');
    if (!complete && !hasFailure) {
      return deepErrorResult(
        'exec-error',
        'local loader did not verify every expected enabled target',
        findings,
      );
    }
    return {
      mode: 'deep',
      status: 'ran',
      skipReason: null,
      coverage: { manifest: false, skills: complete },
      verdict: modeVerdictFor(findings, opts.strict),
      command: DEEP_COMMAND,
      findings,
    };
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    return deepErrorResult('exec-error', 'local loader staging or execution failed');
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

export const verifyMuse: ToolVerifier<'muse'> = async (env, opts) => {
  const detected = await detect(env, opts.signal);
  if (!detected.ok) return detected;

  const [record] = detected.value;
  if (record === undefined) {
    return ok({
      tool: 'muse',
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
  const versionDrift = toolVersion !== null && toolVersion !== MUSE_VERIFIED_AGAINST;

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
        checkId: 'muse.version-drift',
        toolSeverity: null,
        normalizedSeverity: 'info',
        message: `muse ${toolVersion} differs from verified ${MUSE_VERIFIED_AGAINST}; parsing may be less reliable`,
        file: null,
        subject: 'plugin',
      });
    }
  }

  return ok({
    tool: 'muse',
    available: true,
    toolVersion,
    versionDrift,
    skipReason: null,
    verdict: toolVerdictFor(modes),
    modes,
  });
};
