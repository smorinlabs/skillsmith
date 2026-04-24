export type SkillSmithError =
  | { code: 'generic'; message: string; cause?: unknown }
  | { code: 'unknown-tool'; tool: string };

export const genericError = (message: string, cause?: unknown): SkillSmithError => ({
  code: 'generic',
  message,
  ...(cause !== undefined ? { cause } : {}),
});

export const unknownToolError = (tool: string): SkillSmithError => ({
  code: 'unknown-tool',
  tool,
});
