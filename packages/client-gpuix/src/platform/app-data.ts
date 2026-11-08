import { posix, win32 } from 'node:path';

export interface NativeAppDataInput {
  platform: string;
  environment: Readonly<Record<string, string | undefined>>;
}

export function resolveNativeAppDataDirectory(input: NativeAppDataInput): string {
  const environment = input.environment;
  // Pick the target platform's path rules, not the host's: `node:path` on a
  // Windows host would join Linux/macOS roots with backslashes.
  const pathApi = input.platform === 'win32' ? win32 : posix;
  let root: string | undefined;
  if (input.platform === 'darwin') {
    root = environment.HOME
      ? pathApi.join(environment.HOME, 'Library', 'Application Support')
      : undefined;
  } else if (input.platform === 'linux') {
    root =
      environment.XDG_DATA_HOME ??
      (environment.HOME ? pathApi.join(environment.HOME, '.local', 'share') : undefined);
  } else if (input.platform === 'win32') {
    root =
      environment.LOCALAPPDATA ??
      (environment.USERPROFILE
        ? pathApi.join(environment.USERPROFILE, 'AppData', 'Local')
        : undefined);
  }
  if (!root || !pathApi.isAbsolute(root)) {
    throw new Error(`Unable to resolve an absolute Funny data directory on ${input.platform}`);
  }
  return pathApi.join(root, 'funny', 'gpuix');
}
