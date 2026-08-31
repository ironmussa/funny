import { isAbsolute, join, win32 } from 'node:path';

export interface NativeAppDataInput {
  platform: string;
  environment: Readonly<Record<string, string | undefined>>;
}

export function resolveNativeAppDataDirectory(input: NativeAppDataInput): string {
  const environment = input.environment;
  let root: string | undefined;
  if (input.platform === 'darwin') {
    root = environment.HOME ? join(environment.HOME, 'Library', 'Application Support') : undefined;
  } else if (input.platform === 'linux') {
    root =
      environment.XDG_DATA_HOME ??
      (environment.HOME ? join(environment.HOME, '.local', 'share') : undefined);
  } else if (input.platform === 'win32') {
    root =
      environment.LOCALAPPDATA ??
      (environment.USERPROFILE
        ? win32.join(environment.USERPROFILE, 'AppData', 'Local')
        : undefined);
  }
  const pathApi = input.platform === 'win32' ? win32 : { isAbsolute, join };
  if (!root || !pathApi.isAbsolute(root)) {
    throw new Error(`Unable to resolve an absolute Funny data directory on ${input.platform}`);
  }
  return pathApi.join(root, 'funny', 'gpuix');
}
