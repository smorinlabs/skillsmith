import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TOOL_OPERATIONS, VERIFIED_AGAINST, VERSION, toolRegistry } from '@skillsmith/core';
import { renderCommandReference as renderReference } from '../packages/cli/src/help/reference.ts';
import { COMMAND_GROUP_HEADINGS } from '../packages/cli/src/help/render.ts';
import { CURRENT_COMMAND_SPECS } from '../packages/cli/src/spec/index.ts';

const ROOT = resolve(import.meta.dir, '..');
const REFERENCE_PATH = resolve(ROOT, 'docs/commands.md');
const README_PATH = resolve(ROOT, 'README.md');
const INDEX_START = '<!-- skillsmith-command-index:start -->';
const INDEX_END = '<!-- skillsmith-command-index:end -->';
const CAPABILITY_START = '<!-- skillsmith-capability-matrix:start -->';
const CAPABILITY_END = '<!-- skillsmith-capability-matrix:end -->';

const occurrences = (value: string, needle: string): number => value.split(needle).length - 1;

export const validateReadmeCommandIndex = (readme: string): readonly string[] => {
  const startCount = occurrences(readme, INDEX_START);
  const endCount = occurrences(readme, INDEX_END);
  if (startCount === 0 && endCount === 0) return [];
  if (startCount !== 1 || endCount !== 1)
    return ['README command index must have exactly one start marker and one end marker'];
  return readme.indexOf(INDEX_START) < readme.indexOf(INDEX_END)
    ? []
    : ['README command-index markers are reversed'];
};

export const validateReadmeCapabilityMatrix = (readme: string): readonly string[] => {
  const startCount = occurrences(readme, CAPABILITY_START);
  const endCount = occurrences(readme, CAPABILITY_END);
  if (startCount === 0 && endCount === 0) return [];
  if (startCount !== 1 || endCount !== 1)
    return ['README capability matrix must have exactly one start marker and one end marker'];
  return readme.indexOf(CAPABILITY_START) < readme.indexOf(CAPABILITY_END)
    ? []
    : ['README capability-matrix markers are reversed'];
};

export const renderCommandReference = (): string => `${renderReference().trimEnd()}\n`;

export const renderReadmeCommandIndex = (): string => {
  const publicSpecs = CURRENT_COMMAND_SPECS.filter(
    (spec) => spec.path.split(' ').length === 2,
  ).toSorted((left, right) => left.helpOrder - right.helpOrder);
  const groups = ['discover', 'manage', 'develop', 'declarative', 'maintain'] as const;
  const rows = groups.flatMap((group) => {
    const commands = publicSpecs.filter((spec) => spec.group === group);
    return commands.map((spec, index) => {
      const command = spec.path.slice('skillsmith '.length);
      const groupCell = index === 0 ? COMMAND_GROUP_HEADINGS[group].replace(/:$/u, '') : '';
      return `| ${groupCell} | \`${command}\` | ${spec.primaryQuestion} |`;
    });
  });
  return [
    INDEX_START,
    '## Command orientation',
    '',
    'Choose a command by the question you need answered. This table and the full ' +
      '[command reference](docs/commands.md) are generated from the live CLI registry.',
    '',
    '| Group | Command | Primary question |',
    '|---|---|---|',
    ...rows,
    INDEX_END,
  ].join('\n');
};

const capabilityCell = (
  fact: Readonly<{ supported: boolean; scopes: readonly string[] }>,
): string => {
  if (!fact.supported) return '—';
  return fact.scopes.length === 0 ? 'yes' : fact.scopes.join(', ');
};

export const renderReadmeCapabilityMatrix = (): string => {
  const adapters = toolRegistry.adapters;
  const toolRows = adapters.map((adapter) => {
    const id = adapter.descriptor.id;
    const verified = VERIFIED_AGAINST[id as keyof typeof VERIFIED_AGAINST] ?? 'not applicable';
    return `| \`${id}\` | capability v${adapter.descriptor.capabilityVersion} | ${verified} |`;
  });
  const operationRows = TOOL_OPERATIONS.map(
    (operation) =>
      `| ${[
        `\`${operation}\``,
        ...adapters.map((adapter) => capabilityCell(adapter.descriptor.operations[operation])),
      ].join(' | ')} |`,
  );
  return [
    CAPABILITY_START,
    '## Capability and version matrix',
    '',
    `Generated from the live tool registry for Skillsmith ${VERSION}. A scope list means the operation is supported in those scopes; “yes” means the operation is supported without a scope; “—” means it is not supported.`,
    '',
    '| Tool | Capability contract | Verifier baseline |',
    '|---|---|---|',
    ...toolRows,
    '',
    `| Operation | ${adapters.map((adapter) => `\`${adapter.descriptor.id}\``).join(' | ')} |`,
    `|---|${adapters.map(() => '---').join('|')}|`,
    ...operationRows,
    CAPABILITY_END,
  ].join('\n');
};

const replaceReadmeIndex = (readme: string, index: string): string => {
  const start = readme.indexOf(INDEX_START);
  const end = readme.indexOf(INDEX_END);
  if (start >= 0 && end > start) {
    return `${readme.slice(0, start)}${index}${readme.slice(end + INDEX_END.length)}`;
  }
  const anchor = '\n## Example output';
  const anchorIndex = readme.indexOf(anchor);
  if (anchorIndex < 0) throw new Error('README command-index insertion anchor is missing');
  return `${readme.slice(0, anchorIndex)}\n\n${index}${readme.slice(anchorIndex)}`;
};

const replaceReadmeCapabilityMatrix = (readme: string, matrix: string): string => {
  const start = readme.indexOf(CAPABILITY_START);
  const end = readme.indexOf(CAPABILITY_END);
  if (start >= 0 && end > start) {
    return `${readme.slice(0, start)}${matrix}${readme.slice(end + CAPABILITY_END.length)}`;
  }
  const anchor = '\n## Supported tools';
  const anchorIndex = readme.indexOf(anchor);
  if (anchorIndex < 0) throw new Error('README capability-matrix insertion anchor is missing');
  return `${readme.slice(0, anchorIndex)}\n\n${matrix}${readme.slice(anchorIndex)}`;
};

export const checkCommandReference = async (): Promise<readonly string[]> => {
  const [reference, readme] = await Promise.all([
    readFile(REFERENCE_PATH, 'utf8'),
    readFile(README_PATH, 'utf8'),
  ]);
  const errors = [...validateReadmeCommandIndex(readme), ...validateReadmeCapabilityMatrix(readme)];
  if (reference !== renderCommandReference()) errors.push('docs/commands.md is stale');
  const generatedReadme = replaceReadmeCapabilityMatrix(
    replaceReadmeIndex(readme, renderReadmeCommandIndex()),
    renderReadmeCapabilityMatrix(),
  );
  if (errors.length === 0 && readme !== generatedReadme)
    errors.push('README.md command index is stale');
  return errors;
};

const writeCommandReference = async (): Promise<void> => {
  const readme = await readFile(README_PATH, 'utf8');
  const markerErrors = [
    ...validateReadmeCommandIndex(readme),
    ...validateReadmeCapabilityMatrix(readme),
  ];
  if (markerErrors.length > 0) throw new Error(markerErrors.join('; '));
  const generatedReadme = replaceReadmeCapabilityMatrix(
    replaceReadmeIndex(readme, renderReadmeCommandIndex()),
    renderReadmeCapabilityMatrix(),
  );
  await Promise.all([
    writeFile(REFERENCE_PATH, renderCommandReference()),
    writeFile(README_PATH, generatedReadme),
  ]);
};

if (import.meta.main) {
  if (process.argv.includes('--write')) {
    await writeCommandReference();
  } else {
    const errors = await checkCommandReference();
    if (errors.length > 0) {
      for (const error of errors) console.error(error);
      process.exitCode = 1;
    }
  }
}
