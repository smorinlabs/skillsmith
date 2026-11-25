import { basename, join } from 'node:path';
import { ok } from '../../result.ts';
import { parseSkillFrontmatter } from '../../skills/frontmatter.ts';
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
import { ANTIGRAVITY_VERIFIED_AGAINST } from './descriptor.ts';
import { detect } from './detect.ts';

export const ANTIGRAVITY_TARGET_MANIFEST = '.antigravity-plugin/plugin.json';

const NATIVE_MANIFESTS = [
  'plugin.json',
  '.antigravity-plugin/plugin.json',
  '.gemini-plugin/plugin.json',
] as const;

const UNSET_GOOGLE_AUTH_ENV = [
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'GEMINI_CLI_OAUTH_TOKEN',
] as const;

const isolatedEnv = (home: string): Record<string, string> => ({
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
});

const sanitizeDiagnostic = (value: string, privatePaths: readonly string[] = []): string => {
  let text = value
    .replace(/authorization["']?\s*[:=][^\r\n]*/gi, 'authorization: [redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /((?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  for (const path of privatePaths) {
    if (path.length > 0) text = text.replaceAll(path, '<tmp>');
  }
  return Array.from(text, (character) => (character.charCodeAt(0) < 32 ? ' ' : character))
    .join('')
    .slice(0, 2048);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const classifyCheckId = (subject: 'manifest' | 'skill', message: string): string => {
  if (subject === 'manifest') return 'antigravity.manifest';
  const lower = message.toLowerCase();
  if (
    lower.startsWith('no frontmatter') ||
    lower.includes('valid yaml') ||
    lower.includes('parse frontmatter')
  ) {
    return 'antigravity.frontmatter';
  }
  if (lower.startsWith('no description')) return 'antigravity.description';
  if (lower.includes("doesn't match its folder")) return 'antigravity.name-mismatch';
  return 'antigravity.validate';
};

const normalizeFilePath = (rawFile: string, kind: 'plugin' | 'skill'): string => {
  const normalized = rawFile.replaceAll('\\', '/');
  if (kind !== 'skill') return normalized;
  const match = /^skills\/[^/]+\/(.+)$/.exec(normalized);
  return match?.[1] ?? normalized;
};

type ValidateParse = { findings: VerifyFinding[] } | { execError: true };

/**
 * Pure. Parses one `agy plugin validate [--strict] --json <dir>` document.
 * When validating an ephemeral wrapper (`syntheticManifest: true`), advisory
 * manifest notes (e.g. `no logo`) emitted on the synthesized `.antigravity-plugin/plugin.json`
 * are filtered so callers only see diagnostics on their actual target files.
 */
export const parseAntigravityValidateOutput = (
  stdout: string,
  options: {
    readonly kind?: 'plugin' | 'skill';
    readonly syntheticManifest?: boolean;
    readonly privatePaths?: readonly string[];
  } = {},
): ValidateParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { execError: true };
  }
  if (!isRecord(parsed)) return { execError: true };
  if (parsed.findings !== undefined && !Array.isArray(parsed.findings)) {
    return { execError: true };
  }
  if (
    parsed.findings === undefined &&
    !isRecord(parsed.components) &&
    typeof parsed.dir !== 'string'
  ) {
    return { execError: true };
  }

  const kind = options.kind ?? 'plugin';
  const syntheticManifest = options.syntheticManifest ?? false;
  const privatePaths = options.privatePaths ?? [];
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings: VerifyFinding[] = [];

  for (const entry of rawFindings) {
    if (
      !isRecord(entry) ||
      typeof entry.severity !== 'string' ||
      typeof entry.message !== 'string'
    ) {
      return { execError: true };
    }
    const rawFile =
      typeof entry.file === 'string' && entry.file.length > 0
        ? entry.file.replaceAll('\\', '/')
        : null;
    const isManifestFile =
      rawFile === 'plugin.json' ||
      rawFile === '.antigravity-plugin/plugin.json' ||
      rawFile === '.gemini-plugin/plugin.json';
    if (syntheticManifest && isManifestFile && entry.severity !== 'error') continue;

    const subject: 'manifest' | 'skill' = isManifestFile ? 'manifest' : 'skill';
    const file = rawFile === null ? null : normalizeFilePath(rawFile, kind);
    const normalizedSeverity =
      entry.severity === 'error' ? 'error' : entry.severity === 'warning' ? 'warning' : 'info';
    findings.push({
      checkId: classifyCheckId(subject, entry.message),
      toolSeverity: entry.severity,
      normalizedSeverity,
      message: sanitizeDiagnostic(entry.message, privatePaths),
      file,
      subject,
      raw: sanitizeDiagnostic(JSON.stringify(entry), privatePaths),
    });
  }

  return { findings };
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

const hasNativeManifest = async (env: VerifyPorts, path: string): Promise<boolean> => {
  for (const candidate of NATIVE_MANIFESTS) {
    if (await env.fileExists(join(path, candidate))) return true;
  }
  return false;
};

const runStaticMode = async (
  env: VerifyPorts,
  binary: string,
  opts: ToolVerifyOptions,
): Promise<ModeResult> => {
  const kind = opts.kind ?? 'plugin';
  const nativeManifest = kind !== 'skill' && (await hasNativeManifest(env, opts.path));
  const needsWrapper = kind !== 'skill' && !nativeManifest;
  const syntheticManifest = kind === 'skill' || needsWrapper;
  const coverage = { manifest: nativeManifest, skills: true };

  let wrapperDir: string | null = null;
  const home = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('agy-home'));
  const privatePaths = [home];

  try {
    let targetPath = opts.path;
    if (needsWrapper) {
      const names = await enumerateSkills(env, opts.path);
      if (names.length === 0) {
        return {
          mode: 'static',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: false, skills: false },
          verdict: 'pass',
          command: '(skipped: no Antigravity manifest or skills)',
          findings: [
            {
              checkId: 'antigravity.no-manifest',
              toolSeverity: null,
              normalizedSeverity: 'info',
              message:
                'no plugin.json or skills found; antigravity plugin validation not applicable',
              file: null,
              subject: 'manifest',
            },
          ],
        };
      }
      wrapperDir = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('agy-wrapper'));
      privatePaths.push(wrapperDir);
      await env.makeDir(join(wrapperDir, '.antigravity-plugin'));
      await env.writeTextFile(
        join(wrapperDir, ANTIGRAVITY_TARGET_MANIFEST),
        JSON.stringify({
          name: basename(opts.path),
          description: 'skillsmith verify ephemeral wrapper',
          version: '0.0.0',
          author: { name: 'skillsmith' },
        }),
      );
      await env.makeDir(join(wrapperDir, 'skills'));
      for (const name of names) {
        await env.copyTree(join(opts.path, 'skills', name), join(wrapperDir, 'skills', name));
      }
      targetPath = wrapperDir;
    }

    await env.makeDir(home);
    const args = ['plugin', 'validate', ...(opts.strict ? ['--strict'] : []), '--json', targetPath];
    const displayTarget = needsWrapper ? '<skills-wrapper>' : opts.path;
    const command = `agy plugin validate ${opts.strict ? '--strict ' : ''}--json ${displayTarget}`;

    const result = await env.exec(binary, args, {
      env: isolatedEnv(home),
      unsetEnv: UNSET_GOOGLE_AUTH_ENV,
      timeoutMs: STATIC_TIMEOUT_MS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (result.timedOut) return errorResult('static', coverage, command, 'timeout');
    opts.signal?.throwIfAborted();

    const parsed = parseAntigravityValidateOutput(result.stdout, {
      kind,
      syntheticManifest,
      privatePaths,
    });
    if ('execError' in parsed) return errorResult('static', coverage, command, 'exec-error');

    const verdict = modeVerdictFor(parsed.findings, opts.strict);
    if (result.code !== 0 && verdict !== 'fail') {
      return errorResult('static', coverage, command, 'exec-error');
    }

    return {
      mode: 'static',
      status: 'ran',
      skipReason: null,
      coverage,
      verdict,
      command,
      findings: parsed.findings,
    };
  } finally {
    await env.removeTree(home);
    if (wrapperDir !== null) await env.removeTree(wrapperDir);
  }
};

const DEEP_COMMAND = 'agy acp --disable-telemetry (initialize; authenticate; session/new <proj>)';

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
      checkId: 'antigravity.deep-probe',
      toolSeverity: null,
      normalizedSeverity: 'info',
      message,
      file: null,
      subject: 'plugin',
    },
  ],
});

export interface ExpectedAntigravitySkill {
  readonly commandName: string;
  readonly folderName: string;
  readonly file: string;
}

type AcpAnalyzeResult = { findings: VerifyFinding[]; complete: boolean } | { error: string };

/**
 * Pure. Analyzes `agy acp` NDJSON stdout for `initialize` (1), `authenticate` (2),
 * `session/new` (3), and `session/update` (`available_commands_update`), then
 * checks presence of every staged skill's runtime command name.
 */
export const analyzeAntigravityAcpOutput = (
  stdout: string,
  expected: readonly ExpectedAntigravitySkill[],
): AcpAnalyzeResult => {
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { error: 'empty ACP output' };

  const messages: Record<string, unknown>[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { error: 'malformed ACP JSON line' };
    }
    if (!isRecord(parsed)) return { error: 'non-object ACP JSON line' };
    messages.push(parsed);
  }

  const replies = new Map<number, Record<string, unknown>>();
  let availableCommands: unknown[] | null = null;

  for (const message of messages) {
    if (Object.hasOwn(message, 'id') && typeof message.id === 'number') {
      if (Object.hasOwn(message, 'error') || !Object.hasOwn(message, 'result')) {
        return { error: `ACP request ${message.id} returned an error or missing result` };
      }
      replies.set(message.id, message);
      continue;
    }
    if (message.method === 'session/update' && isRecord(message.params)) {
      const update = message.params.update;
      if (
        isRecord(update) &&
        update.sessionUpdate === 'available_commands_update' &&
        Array.isArray(update.availableCommands)
      ) {
        availableCommands = update.availableCommands;
      }
    }
  }

  for (const requiredId of [1, 2, 3]) {
    if (!replies.has(requiredId)) {
      return { error: `missing ACP response for request ${requiredId}` };
    }
  }
  if (availableCommands === null) {
    return { error: 'missing available_commands_update notification' };
  }

  const loaded = new Set<string>();
  for (const command of availableCommands) {
    if (isRecord(command) && typeof command.name === 'string') {
      loaded.add(command.name);
    }
  }

  const findings: VerifyFinding[] = [];
  for (const target of expected) {
    if (loaded.has(target.commandName)) continue;
    findings.push({
      checkId: 'antigravity.load-presence',
      toolSeverity: null,
      normalizedSeverity: 'warning',
      message: `skill '${target.folderName}' did not load (reason unavailable at runtime — see static validate)`,
      file: target.file,
      subject: 'skill',
    });
  }

  return { findings, complete: true };
};

const expectedSkillCommandName = async (
  env: VerifyPorts,
  skillMdPath: string,
  folderName: string,
): Promise<string> => {
  try {
    const text = await env.readText(skillMdPath);
    const parsed = parseSkillFrontmatter(text, skillMdPath);
    if (parsed.ok && typeof parsed.value.name === 'string' && parsed.value.name.trim() !== '') {
      return parsed.value.name.trim();
    }
  } catch {
    // Fall back to folder name when frontmatter cannot be read or parsed.
  }
  return folderName;
};

const runDeepMode = async (
  env: VerifyPorts,
  binary: string,
  opts: ToolVerifyOptions,
): Promise<ModeResult> => {
  const names = await enumerateSkills(env, opts.path);
  if (names.length === 0) {
    return {
      mode: 'deep',
      status: 'ran',
      skipReason: null,
      coverage: { manifest: false, skills: false },
      verdict: 'pass',
      command: '(skipped: no skills to load)',
      findings: [],
    };
  }

  const proj = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('agy-project'));
  const home = join(env.xdg.cache, 'skillsmith', 'verify', env.nextId('agy-home'));
  const privatePaths = [proj, home];

  try {
    await env.makeDir(join(proj, '.agents', 'skills'));
    await env.makeDir(home);

    const kind = opts.kind ?? 'plugin';
    const expected: ExpectedAntigravitySkill[] = [];
    for (const name of names) {
      const src = join(opts.path, 'skills', name);
      await env.copyTree(src, join(proj, '.agents', 'skills', name));
      const commandName = await expectedSkillCommandName(env, join(src, 'SKILL.md'), name);
      expected.push({
        commandName,
        folderName: name,
        file: kind === 'skill' ? 'SKILL.md' : `skills/${name}/SKILL.md`,
      });
    }

    const realProj = await env.realpath(proj);
    privatePaths.push(realProj);

    const result = await env.exec(binary, ['acp', '--disable-telemetry'], {
      cwd: realProj,
      env: {
        ...isolatedEnv(home),
        GEMINI_API_KEY: 'skillsmith-offline-probe',
      },
      unsetEnv: UNSET_GOOGLE_AUTH_ENV,
      timeoutMs: DEEP_TIMEOUT_MS,
      jsonRpc: [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {} },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'authenticate',
          params: { methodId: 'gemini-api-key' },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'session/new',
          params: { cwd: realProj, mcpServers: [] },
        },
      ],
      jsonRpcUntilNotification: {
        method: 'session/update',
        path: ['params', 'update', 'sessionUpdate'],
        equals: 'available_commands_update',
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    opts.signal?.throwIfAborted();
    if (result.timedOut || result.code !== 0 || result.protocolError) {
      return deepErrorResult(
        result.timedOut ? 'timeout' : 'exec-error',
        sanitizeDiagnostic(
          `executable=${binary}; phase=acp-loader; exit=${result.code}; timeout=${result.timedOut}; ${result.protocolError ?? ''}; stderr: ${result.stderr}`,
          privatePaths,
        ),
      );
    }

    const analyzed = analyzeAntigravityAcpOutput(result.stdout, expected);
    if ('error' in analyzed) return deepErrorResult('exec-error', analyzed.error);

    return {
      mode: 'deep',
      status: 'ran',
      skipReason: null,
      coverage: { manifest: false, skills: analyzed.complete },
      verdict: modeVerdictFor(analyzed.findings, opts.strict),
      command: DEEP_COMMAND,
      findings: analyzed.findings,
    };
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    return deepErrorResult('exec-error', 'ACP loader staging or execution failed');
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

export const verifyAntigravity: ToolVerifier<'antigravity'> = async (env, opts) => {
  const detected = await detect(env, opts.signal);
  if (!detected.ok) return detected;

  const [record] = detected.value;
  if (record === undefined) {
    return ok({
      tool: 'antigravity',
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
  const versionDrift = toolVersion !== null && toolVersion !== ANTIGRAVITY_VERIFIED_AGAINST;

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
        checkId: 'antigravity.version-drift',
        toolSeverity: null,
        normalizedSeverity: 'info',
        message: `agy ${toolVersion} differs from verified ${ANTIGRAVITY_VERIFIED_AGAINST}; parsing may be less reliable`,
        file: null,
        subject: 'plugin',
      });
    }
  }

  return ok({
    tool: 'antigravity',
    available: true,
    toolVersion,
    versionDrift,
    skipReason: null,
    verdict: toolVerdictFor(modes),
    modes,
  });
};
