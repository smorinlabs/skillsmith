import { type SkillSmithError, errorMessage, genericError } from '../errors.ts';
import type { DetectionPorts, InventoryReadPorts } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { Check, CheckRunContext, CheckRunResult, DoctorPorts, Finding } from './types.ts';

const bind = <Arguments extends readonly unknown[], Result>(
  operation: (...args: Arguments) => Result,
  receiver: object,
): ((...args: Arguments) => Result) => operation.bind(receiver);

/** Project the exact authority available to health checks at runtime, not only in their types. */
export const focusDoctorPorts = (ports: DoctorPorts): DoctorPorts => ({
  homeDir: ports.homeDir,
  executableSearchPath: ports.executableSearchPath,
  platform: ports.platform,
  xdg: ports.xdg,
  fileExists: bind(ports.fileExists, ports),
  pathKind: bind(ports.pathKind, ports),
  realpath: bind(ports.realpath, ports),
  listDir: bind(ports.listDir, ports),
  readText: bind(ports.readText, ports),
  readBytes: bind(ports.readBytes, ports),
  readLink: bind(ports.readLink, ports),
  isExecutable: bind(ports.isExecutable, ports),
  modifiedAt: bind(ports.modifiedAt, ports),
  assertWritableDirectory: bind(ports.assertWritableDirectory, ports),
  http: ports.http,
});

/** Detection checks need installation locations, not subprocess-backed version enrichment. */
export const detectionPortsWithoutVersionProbe = (ports: InventoryReadPorts): DetectionPorts => ({
  homeDir: ports.homeDir,
  executableSearchPath: ports.executableSearchPath,
  platform: ports.platform,
  xdg: ports.xdg,
  fileExists: bind(ports.fileExists, ports),
  pathKind: bind(ports.pathKind, ports),
  realpath: bind(ports.realpath, ports),
  listDir: bind(ports.listDir, ports),
  readText: bind(ports.readText, ports),
  readBytes: bind(ports.readBytes, ports),
  readLink: bind(ports.readLink, ports),
  isExecutable: bind(ports.isExecutable, ports),
  modifiedAt: bind(ports.modifiedAt, ports),
  runVersion: async () => 'unknown',
});

const tally = (findings: readonly Finding[]): CheckRunResult['counts'] => {
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const f of findings) {
    if (f.severity === 'error') counts.error++;
    else if (f.severity === 'warning') counts.warning++;
    else counts.ok++;
  }
  return counts;
};

export const runChecks = async (
  registry: readonly Check[],
  ctx: CheckRunContext,
): Promise<Result<CheckRunResult, SkillSmithError>> => {
  const observation = ctx.observation;
  const span =
    observation?.emitter.begin(observation.context, {
      kind: 'operation.started',
      operationKind: 'diagnostics',
    }) ?? null;
  try {
    const applicable = registry.filter(
      (check) =>
        check.runsIn.includes(ctx.mode) && (ctx.mode !== 'check' || check.severity === 'error'),
    );
    const findings: Finding[] = [];
    for (const check of applicable) {
      if (ctx.signal?.aborted) {
        observation?.emitter.complete(span, {
          outcome: 'cancelled',
          errorCode: 'cancelled',
          standaloneCount: null,
          bundledCount: null,
          resultCount: null,
        });
        return err(genericError('runChecks aborted'));
      }
      try {
        findings.push(...(await check.run(ctx)));
      } catch (e) {
        findings.push({
          checkId: check.id,
          severity: 'error',
          title: `check '${check.id}' threw`,
          message: errorMessage(e),
        });
      }
    }
    const result = { findings, counts: tally(findings) };
    observation?.emitter.complete(span, {
      outcome: 'success',
      errorCode: null,
      standaloneCount: null,
      bundledCount: null,
      resultCount: null,
    });
    return ok(result);
  } catch (error) {
    observation?.emitter.complete(span, {
      outcome: 'failure',
      errorCode: 'generic',
      standaloneCount: null,
      bundledCount: null,
      resultCount: null,
    });
    throw error;
  }
};
