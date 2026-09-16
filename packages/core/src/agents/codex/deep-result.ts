import type { VerifyFinding } from '../../verify/types.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Diagnostics are bounded and redact common credential forms; raw protocol output is never reported. */
export const sanitizeDeepDiagnostic = (
  value: string,
  privatePaths: readonly string[] = [],
): string => {
  let text = value
    .replace(/authorization["']?\s*[:=][^\r\n]*/gi, 'authorization: [redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /((?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  for (const path of privatePaths) if (path) text = text.replaceAll(path, '<tmp>');
  return Array.from(text, (character) => (character.charCodeAt(0) < 32 ? ' ' : character))
    .join('')
    .slice(0, 2048);
};

export interface ExpectedCodexSkill {
  path: string;
  file: string;
}

export const analyzeCodexSkills = (
  stdout: string,
  cwd: string,
  expected: readonly ExpectedCodexSkill[],
): { findings: VerifyFinding[]; complete: boolean } | { error: string } => {
  let messages: unknown[];
  try {
    messages = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return { error: 'malformed skills/list JSON' };
  }
  const messagesAsRecords = messages.filter(record);
  const replies = messagesAsRecords.filter((message) => Object.hasOwn(message, 'id'));
  const [initialized, listed] = replies;
  if (
    messagesAsRecords.length !== messages.length ||
    messagesAsRecords.some(
      (message) => !Object.hasOwn(message, 'id') && typeof message.method !== 'string',
    ) ||
    replies.length !== 2 ||
    initialized?.id !== 1 ||
    listed?.id !== 2 ||
    replies.some(
      (message) => Object.hasOwn(message, 'error') || Object.hasOwn(message, 'method'),
    ) ||
    !record(initialized.result) ||
    !record(listed.result)
  ) {
    return { error: 'missing or invalid initialization/skills/list response' };
  }
  const data = listed.result.data;
  if (!Array.isArray(data)) return { error: 'missing skills/list data' };
  const rows = data.filter((row): row is Record<string, unknown> => record(row) && row.cwd === cwd);
  if (rows.length !== 1) return { error: 'missing or ambiguous requested working directory' };
  const row = rows[0];
  if (
    !row ||
    !Array.isArray(row.skills) ||
    !Array.isArray(row.errors) ||
    !row.skills.every(
      (skill) =>
        record(skill) && typeof skill.path === 'string' && typeof skill.enabled === 'boolean',
    ) ||
    !row.errors.every(
      (error) =>
        record(error) && typeof error.path === 'string' && typeof error.message === 'string',
    )
  ) {
    return { error: 'invalid skills/list entries' };
  }
  const skills = row.skills as { path: string; enabled: boolean }[];
  const errors = row.errors as { path: string; message: string }[];
  const findings: VerifyFinding[] = [];
  let complete = true;
  for (const target of expected) {
    const failures = errors.filter((error) => error.path === target.path);
    if (failures.length > 0) {
      for (const failure of failures)
        findings.push({
          checkId: 'codex.skill-load',
          toolSeverity: 'error',
          normalizedSeverity: 'error',
          message: sanitizeDeepDiagnostic(failure.message, [cwd]),
          file: target.file,
          subject: 'skill',
        });
      continue;
    }
    const matches = skills.filter((skill) => skill.path === target.path);
    if (matches.length === 1 && matches[0]?.enabled) continue;
    complete = false;
    findings.push({
      checkId: 'codex.skill-presence',
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
