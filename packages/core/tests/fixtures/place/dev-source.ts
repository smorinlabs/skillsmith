import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimePorts } from '../../../src/ports/types.ts';
import type { SkillSmithError } from '../../../src/errors.ts';
import type {
  FlipAction,
  FlipDeps,
  FlipOptions,
  FlipReport,
  FlipResult,
} from '../../../src/place/types.ts';
import type { Result } from '../../../src/result.ts';
import { ok } from '../../../src/result.ts';
import type { VerifyOptions } from '../../../src/verify/run.ts';
import type {
  ModeResult,
  ToolVerdict,
  VerifyOutcome,
  VerifyReport,
  VerifyTool,
} from '../../../src/verify/types.ts';

/** Codex default destination for CREATED placements (PRD D1: the modern convention).
 *  TODO(P13-T0): pinned by the location-verification spike — if T0's check against live Codex
 *  behavior and upstream docs lands on a different default (e.g. ~/.codex/skills), flip ONLY
 *  this constant; every dev --source test derives the expected create-target from it. */
export const CODEX_DEFAULT_SKILLS_DEST = '~/.agents/skills';

/** The CODEX_DEFAULT_SKILLS_DEST path materialized under a fixture fleet's fake $HOME. */
export const codexDefaultSkillsDestFor = (home: string): string =>
  join(home, ...CODEX_DEFAULT_SKILLS_DEST.slice('~/'.length).split('/'));

// -----------------------------------------------------------------------------------------------
// P13 contract surface (PRD D4): FlipReport schemaVersion 1 -> 2. New `action` values
// `created` / `adopted`; new `summary.created` / `summary.adopted` counters. Until T3 lands these
// on the core types, the failing-first suite reaches them through these widened views so it
// compiles against the P12 types while still asserting the v2 shape.
// -----------------------------------------------------------------------------------------------

export type FlipActionV2 = FlipAction | 'created' | 'adopted';

export type FlipSummaryV2 = FlipReport['summary'] & { created: number; adopted: number };

export type FlipResultV2 = Omit<FlipResult, 'action'> & { action: FlipActionV2 };

export type FlipReportV2 = Omit<FlipReport, 'results' | 'summary'> & {
  results: FlipResultV2[];
  summary: FlipSummaryV2;
};

export const summaryV2 = (report: FlipReport): FlipSummaryV2 => report.summary as FlipSummaryV2;

export const actionV2 = (r: FlipResult | undefined): FlipActionV2 | undefined =>
  r?.action as FlipActionV2 | undefined;

/** PRD CLI surface: `--dest <path>` overrides the default destination for the created placement
 *  (recorded placementPath must reflect it), so core FlipOptions grows `dest?: string` in T3. */
export type DevSourceFlipOptions = FlipOptions & { dest?: string };

// -----------------------------------------------------------------------------------------------
// fixture builders
// -----------------------------------------------------------------------------------------------

/** A minimal valid skill source dir (SKILL.md present) under <base>/srcs/<name>. Non-git. */
export const makeSkillSource = async (base: string, name: string): Promise<string> => {
  const dir = join(base, 'srcs', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: P13 dev --source fixture ${name}.\n---\n`,
  );
  return dir;
};

// -----------------------------------------------------------------------------------------------
// canned verify deps (pattern of core/tests/place/run.test.ts)
// -----------------------------------------------------------------------------------------------

export const DEV_SOURCE_NOW = '2026-07-10T00:00:00Z';

let txCounter = 0;
const nextTxId = (): string => (++txCounter).toString(16).padStart(8, '0');

const makeVerifyReport = (
  tool: VerifyTool,
  verdict: VerifyOutcome | 'inconclusive',
): VerifyReport => {
  const mode: ModeResult =
    verdict === 'inconclusive'
      ? {
          mode: 'static',
          status: 'error',
          skipReason: 'exec-error',
          coverage: { manifest: false, skills: false },
          verdict: null,
          command: 'fake',
          findings: [],
        }
      : {
          mode: 'static',
          status: 'ran',
          skipReason: null,
          coverage: { manifest: true, skills: true },
          verdict,
          command: 'fake',
          findings:
            verdict === 'fail'
              ? [
                  {
                    checkId: 'fake.check',
                    toolSeverity: 'error',
                    normalizedSeverity: 'error' as const,
                    message: 'boom',
                    file: null,
                    subject: 'skill' as const,
                  },
                ]
              : [],
        };
  const toolVerdict: ToolVerdict = {
    tool,
    available: true,
    toolVersion: '1.0.0',
    versionDrift: false,
    skipReason: verdict === 'inconclusive' ? 'exec-error' : null,
    verdict,
    modes: [mode],
  };
  return {
    schemaVersion: 1,
    target: { path: '/fake', kind: 'skill' },
    requested: { tools: [tool], modes: ['static'], strict: false, explicitTools: true },
    verifiedAgainst: { 'claude-code': '1.0.0', codex: '1.0.0', muse: '1.0.0' },
    summary: {
      verdict,
      verified: verdict === 'pass' || verdict === 'warn' ? [tool] : [],
      failed: verdict === 'fail' ? [tool] : [],
      skipped: verdict === 'inconclusive' ? [tool] : [],
      counts: { error: verdict === 'fail' ? 1 : 0, warning: 0, info: 0 },
    },
    tools: [toolVerdict],
  };
};

export const cannedFlipDeps = (
  verdict: VerifyOutcome | 'inconclusive',
  calls: VerifyOptions[] = [],
): FlipDeps => ({
  now: () => DEV_SOURCE_NOW,
  newTxId: nextTxId,
  verify: async (_env, opts: VerifyOptions) => {
    calls.push(opts);
    const tool = opts.tools?.[0] ?? 'claude-code';
    return ok(makeVerifyReport(tool, verdict)) as Result<VerifyReport, SkillSmithError>;
  },
});

export const passFlipDeps = (calls: VerifyOptions[] = []): FlipDeps =>
  cannedFlipDeps('pass', calls);
