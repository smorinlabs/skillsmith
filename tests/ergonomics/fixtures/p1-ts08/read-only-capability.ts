import type { PortError } from '../../../../packages/core/src/ports/errors.ts';
import type {
  ClockPort,
  FileReadPort,
  FileWritePort,
  GitPort,
  HttpPort,
  IdPort,
  LockPort,
  PlatformPaths,
  ProcessPort,
  ResolvedRuntimeConfiguration,
  RuntimePorts,
} from '../../../../packages/core/src/ports/types.ts';
import type { listSkills } from '../../../../packages/core/src/scan/list-skills.ts';

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false;
type Assert<Value extends true> = Value;

type _PlatformPaths = Assert<
  Equal<keyof PlatformPaths, 'homeDir' | 'executableSearchPath' | 'platform' | 'xdg'>
>;
type _FileReadPort = Assert<
  Equal<
    keyof FileReadPort,
    | 'fileExists'
    | 'pathKind'
    | 'realpath'
    | 'listDir'
    | 'readText'
    | 'readBytes'
    | 'readLink'
    | 'isExecutable'
    | 'modifiedAt'
  >
>;
type _FileWritePort = Assert<
  Equal<
    keyof FileWritePort,
    | 'makeDir'
    | 'writeTextFile'
    | 'makeSymlink'
    | 'rename'
    | 'copyTree'
    | 'removeTree'
    | 'fsyncFile'
    | 'fsyncDir'
  >
>;
type _LockPort = Assert<Equal<keyof LockPort, 'withFileLock'>>;
type _ProcessPort = Assert<Equal<keyof ProcessPort, 'exec' | 'runVersion'>>;
type _GitPort = Assert<
  Equal<
    keyof GitPort,
    | 'findRepositoryRoot'
    | 'inspectWorktree'
    | 'resolveRemoteRef'
    | 'initializeFetch'
    | 'fetchRef'
    | 'listTree'
    | 'readBlob'
    | 'materializeTree'
  >
>;
type _HttpPort = Assert<Equal<keyof HttpPort, 'request'>>;
type _ClockPort = Assert<
  Equal<keyof ClockPort, 'wallNowIso' | 'epochMilliseconds' | 'monotonicMilliseconds'>
>;
type _IdPort = Assert<Equal<keyof IdPort, 'nextId'>>;
type _ResolvedRuntimeConfiguration = Assert<
  Equal<
    keyof ResolvedRuntimeConfiguration,
    | 'configLayer'
    | 'explicitConfigPath'
    | 'skillsmithHome'
    | 'claudeConfigDir'
    | 'claudePolicySkillsDisabled'
    | 'claudeManagedSettingsPath'
    | 'codexHome'
    | 'kiloExternalSkillsDisabled'
    | 'opencodeConfigDir'
    | 'opencodeClaudeSkillsDisabled'
    | 'forceColor'
    | 'noColor'
    | 'journalPause'
  >
>;
type RuntimePortKeys =
  | keyof PlatformPaths
  | keyof FileReadPort
  | keyof FileWritePort
  | keyof LockPort
  | keyof ProcessPort
  | keyof ClockPort
  | keyof IdPort
  | 'git'
  | 'http';
type _RuntimePorts = Assert<Equal<keyof RuntimePorts, RuntimePortKeys>>;
type _PortErrorCode = Assert<
  Equal<
    PortError['code'],
    | 'not-found'
    | 'permission'
    | 'unavailable'
    | 'timeout'
    | 'cancelled'
    | 'conflict'
    | 'invalid'
    | 'io'
  >
>;
type _PortErrorFields = Assert<
  Equal<Pick<PortError, 'capability' | 'operation' | 'code' | 'message' | 'context'>, PortError>
>;

type InventoryReadPorts = PlatformPaths & FileReadPort;
type ListSkillsPorts = Parameters<typeof listSkills>[0];

declare const readOnly: ListSkillsPorts;

const inventoryRead: InventoryReadPorts = readOnly;
void inventoryRead;

void readOnly.homeDir;
void readOnly.executableSearchPath;
void readOnly.fileExists('/skills/review/SKILL.md');
void readOnly.listDir('/skills');
void readOnly.readText('/skills/review/SKILL.md');

// @ts-expect-error read-only inventory cannot write files
void readOnly.writeTextFile('/skills/review/SKILL.md', 'changed');
// @ts-expect-error read-only inventory cannot remove trees
void readOnly.removeTree('/skills/review');
// @ts-expect-error read-only inventory cannot acquire locks
void readOnly.withFileLock('/skills.lock', async () => undefined);
// @ts-expect-error read-only inventory cannot execute arbitrary processes
void readOnly.exec('sh', ['-c', 'echo forbidden']);
