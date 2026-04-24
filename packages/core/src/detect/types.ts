export type InstallMethod =
  | 'brew'
  | 'npm-global'
  | 'bun-global'
  | 'native-installer'
  | 'app-bundle'
  | 'unknown';

export interface InstallRecord {
  path: string;
  version: string;
  installMethod: InstallMethod;
}
