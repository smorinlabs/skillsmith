import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

/** Manifest plugin name, or null on any read/parse failure. */
const readManifestName = async (env: ScanEnv, manifestPath: string): Promise<string | null> => {
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
  env: ScanEnv,
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

  const root = await mkdtemp(join(tmpdir(), 'skillsmith-codex-root-'));
  const home = await mkdtemp(join(tmpdir(), 'skillsmith-codex-home-'));
  try {
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true });
    await writeFile(
      join(root, '.agents', 'plugins', 'marketplace.json'),
      `${JSON.stringify(
        {
          name: MARKETPLACE_NAME,
          plugins: [{ source: { source: 'local', path: `./plugins/${name}` } }],
        },
        null,
        2,
      )}\n`,
    );
    await cp(opts.path, join(root, 'plugins', name), { recursive: true });

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
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
};

type ModeRunner = (env: ScanEnv, binary: string, opts: ToolVerifyOptions) => Promise<ModeResult>;

const MODE_RUNNERS: Partial<Record<VerifyMode, ModeRunner>> = {
  static: runStaticMode,
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
