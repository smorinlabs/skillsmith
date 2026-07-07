export type SkillSmithError =
  | { code: 'generic'; message: string; cause?: unknown }
  | { code: 'unknown-tool'; tool: string }
  | { code: 'config-error'; message: string; file?: string; line?: number }
  | { code: 'skill-parse-error'; message: string; file: string }
  | { code: 'placement-not-found'; message: string }
  | { code: 'source-unresolvable'; message: string }
  | { code: 'ledger-error'; message: string; file?: string }
  | { code: 'permission-denied'; message: string; path?: string }
  | { code: 'flip-refused'; message: string }
  | { code: 'flip-failed'; message: string };

export const genericError = (message: string, cause?: unknown): SkillSmithError => ({
  code: 'generic',
  message,
  ...(cause !== undefined ? { cause } : {}),
});

export const unknownToolError = (tool: string): SkillSmithError => ({
  code: 'unknown-tool',
  tool,
});

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const configError = (
  message: string,
  opts: { file?: string; line?: number } = {},
): SkillSmithError => ({
  code: 'config-error',
  message,
  ...(opts.file !== undefined ? { file: opts.file } : {}),
  ...(opts.line !== undefined ? { line: opts.line } : {}),
});

export const skillParseError = (message: string, file: string): SkillSmithError => ({
  code: 'skill-parse-error',
  message,
  file,
});

export const placementNotFoundError = (message: string): SkillSmithError => ({
  code: 'placement-not-found',
  message,
});

export const sourceUnresolvableError = (message: string): SkillSmithError => ({
  code: 'source-unresolvable',
  message,
});

export const ledgerError = (message: string, file?: string): SkillSmithError => ({
  code: 'ledger-error',
  message,
  ...(file !== undefined ? { file } : {}),
});

export const permissionDeniedError = (message: string, path?: string): SkillSmithError => ({
  code: 'permission-denied',
  message,
  ...(path !== undefined ? { path } : {}),
});

export const flipRefusedError = (message: string): SkillSmithError => ({
  code: 'flip-refused',
  message,
});

export const flipFailedError = (message: string): SkillSmithError => ({
  code: 'flip-failed',
  message,
});
