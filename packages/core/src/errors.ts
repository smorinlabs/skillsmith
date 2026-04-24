export type SkillSmithError =
  | { code: 'generic'; message: string; cause?: unknown }
  | { code: 'unknown-tool'; tool: string }
  | { code: 'config-error'; message: string; file?: string; line?: number };

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
